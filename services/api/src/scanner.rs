//! Only authenticated, hash/nonce/generation-bound real engine results enter DB.
use crate::auth::{ApiError, App};
use axum::http::StatusCode;
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;
use uuid::Uuid;
#[derive(Deserialize)]
pub struct Scan {
    pub nonce: Uuid,
    pub sha256: String,
    pub verdict: String,
    pub engine_version: String,
    pub generation_id: Uuid,
    pub databases: Value,
    pub last_successful_check: f64,
    pub update_ok: bool,
}
fn failed() -> ApiError {
    crate::business::error(
        StatusCode::SERVICE_UNAVAILABLE,
        "SCANNER_UNAVAILABLE",
        "安全性検査を完了できません。しばらくして再試行してください。",
    )
}
fn valid(s: &Scan) -> bool {
    let age = Utc::now().timestamp() as f64 - s.last_successful_check;
    s.update_ok
        && (0.0..=86400.0).contains(&age)
        && s.engine_version == "1.5.4"
        && s.databases.as_object().is_some_and(|m| {
            m.len() == 3
                && ["main", "daily", "bytecode"].iter().all(|k| {
                    m.get(*k).is_some_and(|v| {
                        v["version"].as_i64().is_some_and(|n| n > 0)
                            && v["sha256"].as_str().is_some_and(|h| {
                                h.len() == 64 && h.bytes().all(|c| c.is_ascii_hexdigit())
                            })
                    })
                })
        })
}
pub async fn scan(app: &App, data: Vec<u8>, hash: &str) -> Result<Scan, ApiError> {
    let nonce = Uuid::new_v4();
    let r = app
        .http
        .post("http://scan:8080/internal/scan")
        .header("X-Scan-Key", &app.scan_key)
        .header("X-Scan-Nonce", nonce.to_string())
        .header("Content-Type", "application/octet-stream")
        .timeout(Duration::from_secs(23))
        .body(data)
        .send()
        .await
        .map_err(|_| failed())?;
    if !r.status().is_success() {
        return Err(failed());
    }
    let s: Scan =
        serde_json::from_slice(&r.bytes().await.map_err(|_| failed())?).map_err(|_| failed())?;
    if s.nonce != nonce
        || s.sha256 != hash
        || !["clean", "blocked"].contains(&s.verdict.as_str())
        || !valid(&s)
    {
        return Err(failed());
    }
    Ok(s)
}
pub async fn current(app: &App, s: &Scan) -> Result<(), ApiError> {
    let r = app
        .http
        .get("http://scan:8080/internal/scan/state")
        .header("X-Scan-Key", &app.scan_key)
        .send()
        .await
        .map_err(|_| failed())?;
    if !r.status().is_success() {
        return Err(failed());
    }
    let v: Value =
        serde_json::from_slice(&r.bytes().await.map_err(|_| failed())?).map_err(|_| failed())?;
    let age =
        Utc::now().timestamp() as f64 - v["last_successful_check"].as_f64().ok_or_else(failed)?;
    if v["generation_id"] != s.generation_id.to_string()
        || v["databases"] != s.databases
        || v["engine_version"] != s.engine_version
        || v["update_ok"] != true
        || !(0.0..=86400.0).contains(&age)
    {
        return Err(failed());
    }
    Ok(())
}
