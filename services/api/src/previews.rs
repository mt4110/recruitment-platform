//! Read-only demo notifications and invoice previews, under ordinary tenant RLS.
use crate::auth::{self, ApiError, App, Identity};
use crate::business::{begin, db_error, invalid, missing};
use axum::{
    Json, Router,
    extract::{Path, Query, RawQuery, State},
    http::HeaderMap,
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
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
        .route("/api/v1/applications/{id}/invoice-view", get(metadata))
        .route("/api/v1/applications/{id}/invoice-preview", get(metadata))
        .route(
            "/api/v1/applications/{id}/invoice-preview.pdf",
            get(crate::views::gone),
        )
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
