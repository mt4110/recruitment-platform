//! Internal S2 control plane. No unwrapped key or plaintext document enters here.
use crate::auth::{ApiError, App};
use crate::business::{db_error, error, invalid};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hmac::{Hmac, KeyInit, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;
fn denied() -> ApiError {
    error(
        StatusCode::CONFLICT,
        "WORKER_DENIED",
        "処理権限または検査状態を確認できません。",
    )
}
fn check(h: &HeaderMap) -> Result<(), ApiError> {
    let key = std::fs::read("/run/broker-auth").map_err(|_| denied())?;
    if key.len() != 32 {
        return Err(denied());
    }
    let token = h
        .get("X-Worker-Auth")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| B64.decode(v).ok())
        .ok_or_else(denied)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| denied())?;
    mac.update(b"document-worker-v1");
    mac.verify_slice(&token).map_err(|_| denied())
}
pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/claim", post(claim))
        .route("/jobs/{id}/{op}", post(operation))
        .layer(DefaultBodyLimit::max(12582912))
}
async fn control(
    app: &App,
    op: &str,
    id: Option<Uuid>,
    token: Option<Uuid>,
    p: Value,
) -> Result<Value, ApiError> {
    let r: Option<Value> = sqlx::query_scalar("SELECT document_worker($1,$2,$3,$4)")
        .bind(op)
        .bind(id)
        .bind(token)
        .bind(p)
        .fetch_one(&app.db)
        .await
        .map_err(db_error)?;
    r.ok_or_else(denied)
}
async fn claim(State(app): State<Arc<App>>, h: HeaderMap) -> Result<Response, ApiError> {
    check(&h)?;
    let v: Option<Value> = sqlx::query_scalar("SELECT document_worker('claim',NULL,NULL,'{}')")
        .fetch_one(&app.db)
        .await
        .map_err(db_error)?;
    Ok(match v {
        Some(v) => Json(v).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    lease_token: Uuid,
    #[serde(default)]
    result: Value,
}
async fn operation(
    State(app): State<Arc<App>>,
    Path((id, op)): Path<(Uuid, String)>,
    h: HeaderMap,
    Json(body): Json<Input>,
) -> Result<Response, ApiError> {
    check(&h)?;
    if ![
        "authorize",
        "ciphertext",
        "commit",
        "artifact",
        "reject",
        "retry",
    ]
    .contains(&op.as_str())
    {
        return Err(denied());
    }
    let authority = control(
        &app,
        "authorize",
        Some(id),
        Some(body.lease_token),
        json!({}),
    )
    .await?;
    if op == "authorize" {
        return Ok(Json(json!({"authorized":true})).into_response());
    }
    if op == "ciphertext" {
        let stage: Uuid = authority["staging_key"]
            .as_str()
            .ok_or_else(denied)?
            .parse()
            .map_err(|_| denied())?;
        let path = format!("/data/resumes/encrypted/{stage}.cipher");
        let metadata = fs::metadata(&path).await.map_err(|_| denied())?;
        if metadata.len() > 10489876 {
            return Err(denied());
        }
        let bytes = fs::read(path).await.map_err(|_| denied())?;
        control(
            &app,
            "authorize",
            Some(id),
            Some(body.lease_token),
            json!({}),
        )
        .await?;
        return Ok((
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            Body::from(bytes),
        )
            .into_response());
    }
    let mut result = body.result;
    if op == "commit" || op == "artifact" {
        let is_manifest = op == "commit";
        if is_manifest {
            let scan: crate::scanner::Scan =
                serde_json::from_value(result["checks"]["scan"].clone()).map_err(|_| invalid())?;
            if scan.verdict != "clean"
                || result["sha256"] != scan.sha256
                || result["checks"]["format"]["ok"] != true
                || result["checks"]["format"]["sha256"] != scan.sha256
            {
                return Err(denied());
            }
            crate::scanner::current(&app, &scan).await?;
        }
        if (is_manifest && result["artifact_id"] != authority["artifact_id"])
            || result["generation"] != authority["generation"]
            || result["artifact_envelope"]["org_id"] != authority["org_id"]
        {
            return Err(denied());
        }
        let artifact: Uuid = result["artifact_id"]
            .as_str()
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?;
        let raw = B64
            .decode(result["artifact_bytes"].as_str().ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        if raw.len() < 17
            || raw.len()
                > if is_manifest {
                    262160
                } else if result["artifact_envelope"]["kind"] == "page" {
                    8388624
                } else {
                    1048592
                }
            || result["artifact_size"] != raw.len()
            || result["artifact_hash"]
                != Sha256::digest(&raw)
                    .iter()
                    .map(|v| format!("{v:02x}"))
                    .collect::<String>()
        {
            return Err(invalid());
        }
        let envelope = &result["artifact_envelope"];
        if envelope["schema"] != 1
            || (is_manifest && envelope["kind"] != "manifest")
            || (!is_manifest
                && !["page", "text", "table"].contains(&envelope["kind"].as_str().unwrap_or("")))
            || envelope["key_version"] != authority["artifact_version"]
            || (envelope["kind"] == "page"
                && !envelope["page"]
                    .as_i64()
                    .is_some_and(|n| (1..=20).contains(&n)))
            || (envelope["kind"] != "page" && envelope["page"] != Value::Null)
            || envelope["generation"] != result["generation"]
        {
            return Err(invalid());
        }
        let expected = json!([
            "rp-artifact-v1",
            envelope["org_id"],
            id,
            result["sha256"],
            "safe-view-v1",
            result["generation"],
            artifact,
            envelope["kind"],
            envelope["page"],
            authority["artifact_version"]
        ])
        .to_string();
        if envelope["aad"] != expected
            || envelope["document_id"] != id.to_string()
            || envelope["wrapped_dek"]
                .as_str()
                .and_then(|s| B64.decode(s).ok())
                .is_none_or(|v| v.len() != 384)
            || envelope["nonce"]
                .as_str()
                .and_then(|s| B64.decode(s).ok())
                .is_none_or(|v| v.len() != 12)
        {
            return Err(invalid());
        }
        if !is_manifest {
            let mut reservation = result.clone();
            reservation
                .as_object_mut()
                .ok_or_else(invalid)?
                .remove("artifact_bytes");
            control(
                &app,
                "reserve_artifact",
                Some(id),
                Some(body.lease_token),
                reservation,
            )
            .await?;
        }
        // UUID names and create_new preserve unreferenced output after a lost commit.
        fs::create_dir_all("/data/resumes/encrypted/artifacts")
            .await
            .map_err(|_| denied())?;
        let path = format!("/data/resumes/encrypted/artifacts/{artifact}.cipher");
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(mut file) => {
                file.write_all(&raw).await.map_err(|_| denied())?;
                file.sync_all().await.map_err(|_| denied())?;
                fs::File::open("/data/resumes/encrypted/artifacts")
                    .await
                    .map_err(|_| denied())?
                    .sync_all()
                    .await
                    .map_err(|_| denied())?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if fs::read(path).await.map_err(|_| denied())? != raw {
                    return Err(denied());
                }
            }
            Err(_) => return Err(denied()),
        }
        result
            .as_object_mut()
            .ok_or_else(invalid)?
            .remove("artifact_bytes");
    }
    let v = control(&app, &op, Some(id), Some(body.lease_token), result).await?;
    Ok(Json(v).into_response())
}
