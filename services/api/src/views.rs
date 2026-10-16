//! Authenticated derivative delivery. Original ciphertext/key never enters the viewer.
use crate::auth::{self, ApiError, App, Identity};
use crate::business::{begin, db_error, invalid, missing};
use axum::{
    Json, Router,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;
static VIEWS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/v1/documents/{id}/view", get(own))
        .route("/api/v1/documents/{id}/view/pages/{page}", get(own_page))
        .route(
            "/api/v1/applications/{application}/documents/{id}/view",
            get(shared),
        )
        .route(
            "/api/v1/applications/{application}/documents/{id}/view/pages/{page}",
            get(shared_page),
        )
}
pub async fn gone() -> Response {
    (
        StatusCode::GONE,
        [("cache-control", "no-store")],
        axum::body::Body::empty(),
    )
        .into_response()
}
async fn authority(app: &App, u: &Identity, id: Uuid, a: Option<Uuid>) -> Result<Value, ApiError> {
    let mut tx = begin(app, u).await?;
    let v: Option<Value> = sqlx::query_scalar("SELECT safe_document_view($1,$2)")
        .bind(id)
        .bind(a)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    v.ok_or_else(missing)
}
async fn decrypt(app: &App, v: &Value, item: &Value) -> Result<Vec<u8>, ApiError> {
    let id: Uuid = item["id"]
        .as_str()
        .ok_or_else(missing)?
        .parse()
        .map_err(|_| missing())?;
    let size = item["size"].as_u64().ok_or_else(missing)?;
    if !(17..=8388624).contains(&size) {
        return Err(missing());
    }
    let path = format!("/data/resumes/encrypted/artifacts/{id}.cipher");
    if tokio::fs::metadata(&path)
        .await
        .map_err(|_| missing())?
        .len()
        != size
    {
        return Err(missing());
    }
    let raw = tokio::fs::read(path).await.map_err(|_| missing())?;
    let hash = Sha256::digest(&raw)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if item["hash"] != hash {
        return Err(missing());
    }
    let key = tokio::fs::read("/run/viewer-auth")
        .await
        .map_err(|_| missing())?;
    if key.len() != 32 {
        return Err(missing());
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| missing())?;
    mac.update(b"artifact-view-v1");
    let mut response=app.http.post("http://artifact-viewer:8080/decrypt").header("X-View-Auth",B64.encode(mac.finalize().into_bytes())).header("Content-Type","application/json").body(serde_json::to_vec(&json!({"id":id,"document_id":v["document_id"],"org_id":v["org_id"],"generation":v["generation"],"original_hash":v["original_hash"],"public_spki":v["public_spki"],"envelope":item["envelope"],"bytes":B64.encode(raw),"hash":item["hash"],"size":size})).map_err(|_|missing())?).send().await.map_err(|_|missing())?;
    if response.status() != StatusCode::OK {
        return Err(missing());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| missing())? {
        if bytes.len() + chunk.len() > 8388608 {
            return Err(missing());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn deliver(
    app: &App,
    h: HeaderMap,
    raw: String,
    a: Option<String>,
    page: Option<u32>,
    q: Option<String>,
) -> Result<Response, ApiError> {
    if q.is_some() || page.is_some_and(|n| !(1..=20).contains(&n)) {
        return Err(invalid());
    }
    let id = Uuid::parse_str(&raw).map_err(|_| invalid())?;
    let a = a
        .map(|s| Uuid::parse_str(&s))
        .transpose()
        .map_err(|_| invalid())?;
    let u = auth::authorize(app, &h, false).await?;
    let _permit = VIEWS.try_acquire().map_err(|_| {
        crate::business::error(
            StatusCode::SERVICE_UNAVAILABLE,
            "VIEW_BUSY",
            "閲覧が混み合っています。しばらくして再試行してください。",
        )
    })?;
    let v = authority(app, &u, id, a).await?;
    let scan: crate::scanner::Scan =
        serde_json::from_value(v["scan"].clone()).map_err(|_| missing())?;
    crate::scanner::current(app, &scan).await?;
    let artifacts = v["artifacts"].as_array().ok_or_else(missing)?;
    let manifest_item = artifacts
        .iter()
        .find(|x| x["envelope"]["kind"] == "manifest")
        .ok_or_else(missing)?;
    let manifest: Value =
        serde_json::from_slice(&decrypt(app, &v, manifest_item).await?).map_err(|_| missing())?;
    if manifest["document_id"] != v["document_id"]
        || manifest["generation"] != v["generation"]
        || manifest["original_hash"] != v["original_hash"]
        || manifest["phase"] != "ready"
    {
        return Err(missing());
    }
    let selected = if let Some(n) = page {
        artifacts
            .iter()
            .find(|x| x["envelope"]["kind"] == "page" && x["envelope"]["page"] == n)
    } else {
        artifacts
            .iter()
            .find(|x| ["text", "table"].contains(&x["envelope"]["kind"].as_str().unwrap_or("")))
    }
    .ok_or_else(missing)?;
    if !manifest["view"]["artifacts"]
        .as_array()
        .ok_or_else(missing)?
        .iter()
        .any(|x| {
            x["id"] == selected["id"]
                && x["ciphertext_hash"] == selected["hash"]
                && x["plaintext_hash"] == selected["envelope"]["plaintext_hash"]
                && x["kind"] == selected["envelope"]["kind"]
                && x["page"] == selected["envelope"]["page"]
        })
    {
        return Err(missing());
    }
    let bytes = decrypt(app, &v, selected).await?;
    // Finish crypto first, then repeat current session/share/key/AV checks before returning any bytes.
    let current = auth::authorize(app, &h, false).await?;
    if authority(app, &current, id, a).await? != v {
        return Err(missing());
    }
    crate::scanner::current(app, &scan).await?;
    if page.is_some() {
        return Ok((
            [("content-type", "image/png"), ("cache-control", "no-store")],
            bytes,
        )
            .into_response());
    }
    let content: Value = serde_json::from_slice(&bytes).map_err(|_| missing())?;
    Ok(Json(json!({"format":manifest["file_format"],"pages":manifest["view"]["pages"],"content":content,"notice":"原本ではなく、安全な閲覧用に変換した表示です。"})).into_response())
}
async fn own(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
    h: HeaderMap,
    RawQuery(q): RawQuery,
) -> Result<Response, ApiError> {
    deliver(&app, h, id, None, None, q).await
}
async fn own_page(
    State(app): State<Arc<App>>,
    Path((id, page)): Path<(String, u32)>,
    h: HeaderMap,
    RawQuery(q): RawQuery,
) -> Result<Response, ApiError> {
    deliver(&app, h, id, None, Some(page), q).await
}
async fn shared(
    State(app): State<Arc<App>>,
    Path((a, id)): Path<(String, String)>,
    h: HeaderMap,
    RawQuery(q): RawQuery,
) -> Result<Response, ApiError> {
    deliver(&app, h, id, Some(a), None, q).await
}
async fn shared_page(
    State(app): State<Arc<App>>,
    Path((a, id, page)): Path<(String, String, u32)>,
    h: HeaderMap,
    RawQuery(q): RawQuery,
) -> Result<Response, ApiError> {
    deliver(&app, h, id, Some(a), Some(page), q).await
}
