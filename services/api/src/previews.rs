//! Read-only demo notifications and invoice previews, under ordinary tenant RLS.
use crate::auth::{self, ApiError, App, Identity};
use crate::business::{begin, db_error, error, invalid, missing};
use axum::{
    Json, Router,
    extract::{Path, Query, RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Search {
    cursor: Option<String>,
    limit: Option<i64>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    org: Uuid,
    at: DateTime<Utc>,
    id: Uuid,
    limit: i64,
}
pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/v1/notifications", get(notifications))
        .route("/api/v1/applications/{id}/invoice-preview", get(metadata))
        .route("/api/v1/applications/{id}/invoice-preview.pdf", get(pdf))
}
async fn notifications(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    query: Result<Query<Search>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let u = auth::authorize(&app, &headers, false).await?;
    let s = query.map_err(|_| invalid())?.0;
    let limit = s.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(invalid());
    }
    let c = if let Some(v) = s.cursor {
        if v.len() > 1024 {
            return Err(invalid());
        }
        let c: Cursor = serde_json::from_slice(&B64.decode(v).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        if c.org != u.organization_id || c.limit != limit {
            return Err(invalid());
        }
        Some(c)
    } else {
        None
    };
    let mut tx = begin(&app, &u).await?;
    #[derive(sqlx::FromRow, Serialize)]
    struct Notice {
        id: Uuid,
        application_id: Uuid,
        subject: String,
        body: String,
        created_at: DateTime<Utc>,
    }
    let mut rows:Vec<Notice>=sqlx::query_as("SELECT id,application_id,subject,body,created_at FROM notification_previews WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1,$2)) ORDER BY created_at DESC,id DESC LIMIT $3")
 .bind(c.as_ref().map(|v|v.at)).bind(c.as_ref().map(|v|v.id)).bind(limit+1).fetch_all(&mut *tx).await.map_err(db_error)?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next = if more {
        let n = rows.last().unwrap();
        Some(
            B64.encode(
                serde_json::to_vec(&Cursor {
                    org: u.organization_id,
                    at: n.created_at,
                    id: n.id,
                    limit,
                })
                .map_err(|_| invalid())?,
            ),
        )
    } else {
        None
    };
    tx.commit().await.map_err(db_error)?;
    Ok(Json(
        json!({"items":rows,"next_cursor":next,"delivery":"demo_unsent","notice":"未送信のデモです。実際のメールは送信しません。"}),
    ))
}
async fn invoice(app: &App, u: &Identity, id: Uuid) -> Result<Value, ApiError> {
    let mut tx = begin(app, u).await?;
    #[derive(sqlx::FromRow)]
    struct Invoice {
        id: Uuid,
        decided_on: String,
        demo_fee_yen: i64,
        agency_name_snapshot: String,
        employer_name_snapshot: String,
    }
    let r:Invoice=sqlx::query_as("SELECT p.id,to_char(p.decided_at AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD') AS decided_on,p.demo_fee_yen,a.agency_name_snapshot,a.employer_name_snapshot FROM placements p JOIN applications a ON a.id=p.application_id WHERE a.id=$1 AND a.status='hired' AND ((a.agency_org_id=rp_org() AND rp_kind()='agency') OR (a.employer_org_id=rp_org() AND rp_kind()='employer' AND a.share_revoked_at IS NULL))")
 .bind(id).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(missing)?;
    tx.commit().await.map_err(db_error)?;
    Ok(
        json!({"placement_id":r.id,"invoice_number":format!("DEMO-{}",r.id),"decided_on":r.decided_on,"issuer":r.agency_name_snapshot,"recipient":r.employer_name_snapshot,"amount_yen":r.demo_fee_yen,"tax_label":"未計算","demo_notice":"デモ用・実際の請求には使用できません。"}),
    )
}
async fn metadata(
    State(app): State<Arc<App>>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let u = auth::authorize(&app, &headers, false).await?;
    if q.is_some() {
        return Err(invalid());
    }
    Ok(Json(
        invoice(&app, &u, Uuid::parse_str(&raw).map_err(|_| invalid())?).await?,
    ))
}
async fn pdf(
    State(app): State<Arc<App>>,
    Path(raw): Path<String>,
    headers: HeaderMap,
    RawQuery(q): RawQuery,
) -> Result<Response, ApiError> {
    let u = auth::authorize(&app, &headers, false).await?;
    if q.is_some() {
        return Err(invalid());
    }
    let id = Uuid::parse_str(&raw).map_err(|_| invalid())?;
    let data = invoice(&app, &u, id).await?;
    let unavailable = || {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "PDF_UNAVAILABLE",
            "PDFを生成できません。しばらくしてから再試行してください。",
        )
    };
    let response = app
        .http
        .post("http://pdf-renderer:8080/internal/pdf/render-invoice")
        .header("X-PDF-Key", &app.pdf_key)
        .timeout(Duration::from_secs(10))
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&data).map_err(|_| unavailable())?)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "PDF_TIMEOUT",
                    "PDFの生成が時間内に完了しませんでした。再試行してください。",
                )
            } else {
                unavailable()
            }
        })?;
    if !response.status().is_success() {
        let code = response
            .bytes()
            .await
            .ok()
            .and_then(|v| serde_json::from_slice::<Value>(&v).ok());
        return Err(
            if code
                .as_ref()
                .and_then(|v| v.get("code"))
                .and_then(Value::as_str)
                == Some("PDF_LAYOUT_ERROR")
            {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "PDF_LAYOUT_ERROR",
                    "PDFを1ページに配置できませんでした。再試行してください。",
                )
            } else {
                unavailable()
            },
        );
    }
    if response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        != Some("application/pdf")
        || response.content_length().is_none_or(|n| n > 524288)
    {
        return Err(unavailable());
    }
    let bytes = response.bytes().await.map_err(|_| unavailable())?;
    if bytes.len() > 524288 || !bytes.starts_with(b"%PDF-") {
        return Err(unavailable());
    }
    // Rendering happens outside a DB transaction. Recheck auth and sharing before delivery.
    let current = auth::authorize(&app, &headers, false).await?;
    if invoice(&app, &current, id).await? != data {
        return Err(unavailable());
    }
    tracing::info!(event="invoice_preview",application_id=%id,request_id=%Uuid::new_v4());
    Ok((
        [
            ("content-type", "application/pdf"),
            (
                "content-disposition",
                "inline; filename=\"demo-invoice.pdf\"",
            ),
        ],
        bytes,
    )
        .into_response())
}
