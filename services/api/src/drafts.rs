//! Personal, authenticated server drafts. File bytes and confirmations are never drafts.
use crate::{
    auth::{self, ApiError, App, Identity},
    business::{begin, db_error, error, fields, invalid, lock, lock_key, missing},
};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Query, Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use std::sync::Arc;
use uuid::Uuid;
fn conflict(code: &'static str) -> ApiError {
    error(
        StatusCode::CONFLICT,
        code,
        match code {
            "DRAFT_VERSION_CONFLICT" => {
                "別の画面で下書きが更新されています。入力を保持して比較してください。"
            }
            "DRAFT_CONTEXT_CHANGED" => {
                "対象の状態や版が変わっています。最新情報を確認してください。"
            }
            "DRAFT_EXPIRED" => "下書きの保存期限が切れています。",
            "DRAFT_TERMINAL" => "この下書きは確定または破棄済みです。",
            "DRAFT_KEY_REVOKED" => "復元用の鍵は失効しています。",
            "DRAFT_SCHEMA_UNSUPPORTED" => "対応していない下書きの形式です。",
            "OPERATION_RESULT_EXPIRED" => {
                "結果照合の7日間を過ぎています。再実行せず一覧を確認してください。"
            }
            "IDEMPOTENCY_MISMATCH" => "同じ操作キーの内容が変わっています。",
            _ => "下書きを保存できません。入力を保持してください。",
        },
    )
}
fn crypto_error() -> ApiError {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "DRAFT_CRYPTO_FAILED",
        "下書きを復元できません。暗号文を保持し、鍵と設定を確認してください。",
    )
}
pub fn master_key() -> anyhow::Result<[u8; 32]> {
    B64.decode(std::env::var("DRAFT_MASTER_KEY")?)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("draft key length"))
}
// RFC 5869 HKDF-SHA256, fixed 32-byte output (one expand block).
fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; 32] {
    let mut extract = <Hmac<Sha256> as KeyInit>::new_from_slice(salt).expect("HMAC key");
    extract.update(ikm);
    let prk = extract.finalize().into_bytes();
    let mut expand = <Hmac<Sha256> as KeyInit>::new_from_slice(&prk).expect("HMAC key");
    expand.update(info);
    expand.update(&[1]);
    expand.finalize().into_bytes().into()
}
fn derive(app: &App, purpose: &[u8]) -> [u8; 32] {
    hkdf(&app.draft_key, b"recruitment-platform/drafts/v1", purpose)
}
fn seal(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let nonce = rand::random::<[u8; 12]>();
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| crypto_error())?;
    let encrypted = cipher
        .encrypt(&Nonce::from(nonce), Payload { msg: plain, aad })
        .map_err(|_| crypto_error())?;
    Ok((encrypted, nonce.to_vec()))
}
fn open(key: &[u8; 32], aad: &[u8], cipher: &[u8], nonce: &[u8]) -> Result<Vec<u8>, ApiError> {
    let n: [u8; 12] = nonce.try_into().map_err(|_| crypto_error())?;
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| crypto_error())?
        .decrypt(&Nonce::from(n), Payload { msg: cipher, aad })
        .map_err(|_| crypto_error())
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Save {
    pub revision: i64,
    pub form_type: String,
    pub target_id: Option<Uuid>,
    pub context_id: Option<Uuid>,
    pub schema_version: i32,
    pub base_resource_version: Option<i32>,
    pub payload: Value,
    pub mutation_id: Uuid,
}
#[derive(FromRow)]
struct Draft {
    id: Uuid,
    org_id: Uuid,
    user_id: Uuid,
    form_type: String,
    target_id: Option<Uuid>,
    context_id: Option<Uuid>,
    schema_version: i32,
    base_resource_version: Option<i32>,
    revision: i64,
    encrypted_payload: Option<Vec<u8>>,
    nonce: Option<Vec<u8>>,
    key_version: i32,
    plaintext_bytes: i32,
    state: String,
    updated_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}
impl Draft {
    fn aad(&self, app: &App) -> Vec<u8> {
        serde_json::to_vec(&json!([
            app.config.origin,
            self.org_id,
            self.user_id,
            self.id,
            self.form_type,
            self.target_id,
            self.context_id,
            self.schema_version,
            self.base_resource_version,
            self.revision,
            self.key_version
        ]))
        .expect("metadata")
    }
    fn plaintext(&self, app: &App) -> Result<Value, ApiError> {
        serde_json::from_slice(&open(
            &derive(app, b"server-payload"),
            &self.aad(app),
            self.encrypted_payload
                .as_deref()
                .ok_or_else(|| conflict("DRAFT_TERMINAL"))?,
            self.nonce.as_deref().ok_or_else(crypto_error)?,
        )?)
        .map_err(|_| crypto_error())
    }
    fn live(&self) -> Result<(), ApiError> {
        if self.state != "active" {
            return Err(conflict("DRAFT_TERMINAL"));
        }
        if self.expires_at <= Utc::now() {
            return Err(conflict("DRAFT_EXPIRED"));
        }
        if self.schema_version != 1 {
            return Err(conflict("DRAFT_SCHEMA_UNSUPPORTED"));
        }
        Ok(())
    }
    fn metadata(&self) -> Value {
        json!({"id":self.id,"form_type":self.form_type,"target_id":self.target_id,"context_id":self.context_id,"schema_version":self.schema_version,"base_resource_version":self.base_resource_version,"revision":self.revision,"updated_at":self.updated_at,"expires_at":self.expires_at,"state":self.state})
    }
}
const TYPES: &[&str] = &[
    "job_new",
    "job_edit",
    "candidate_new",
    "candidate_edit",
    "application_new",
    "application_reason",
    "application_submit",
    "selection_note",
    "document_upload",
    "job_filters",
    "candidate_filters",
    "application_filters",
];
fn payload_check(kind: &str, p: &Value) -> Result<(), ApiError> {
    let specs: &[(&str, &str, usize)] = match kind {
        "job_new" | "job_edit" => &[
            ("title", "s", 200),
            ("description", "s", 10000),
            ("location", "s", 200),
            ("employment_type", "employment", 20),
        ],
        "candidate_new" | "candidate_edit" => &[("name", "s", 100), ("summary", "s", 10000)],
        "application_new" => &[
            ("candidate_id", "uuid", 0),
            ("reason", "s", 2000),
            ("query", "s", 100),
        ],
        "application_reason" => &[("reason", "s", 2000)],
        "application_submit" => &[
            ("document_ids", "ids", 100),
            ("candidate_version", "n", i32::MAX as usize),
            ("job_version", "n", i32::MAX as usize),
        ],
        "selection_note" => &[
            ("action", "action", 30),
            ("to_status", "status", 20),
            ("reason", "s", 500),
        ],
        "document_upload" => &[
            ("document_kind", "kind", 20),
            ("operations", "uploads", 10),
            ("encrypted_transport", "b", 0),
        ],
        "job_filters" => &[
            ("q", "s", 100),
            ("location", "s", 100),
            ("employment_type", "filter_employment", 20),
            ("favorited", "b", 0),
            ("archived", "b", 0),
            ("cursor", "s", 2048),
        ],
        "candidate_filters" => &[
            ("q", "s", 100),
            ("archived", "b", 0),
            ("location", "s", 100),
            ("employment_type", "filter_employment", 20),
            ("favorited", "b", 0),
            ("cursor", "s", 2048),
        ],
        "application_filters" => &[
            ("status", "filter_status", 20),
            ("cursor", "s", 2048),
            ("query", "s", 100),
        ],
        _ => return Err(invalid()),
    };
    let obj = p.as_object().ok_or_else(invalid)?;
    for (k, v) in obj {
        if k == "view" {
            fields(v, &["field", "start", "end", "scroll"], &[])?;
            for (k, v) in v.as_object().ok_or_else(invalid)? {
                if k == "field" {
                    let s = v.as_str().ok_or_else(invalid)?;
                    if !specs.iter().any(|x| x.0 == s) && s != "document_kind" {
                        return Err(invalid());
                    }
                } else if v.as_u64().is_none_or(|n| n > 10000000) {
                    return Err(invalid());
                }
            }
            continue;
        }
        let (_, ty, max) = specs.iter().find(|x| x.0 == k).ok_or_else(invalid)?;
        match *ty {
            "s" => {
                let s = v.as_str().ok_or_else(invalid)?;
                if s.chars().count() > *max
                    || s.contains('\0')
                    || s.contains('<')
                    || s.contains('>')
                {
                    return Err(invalid());
                }
            }
            "uuid" => {
                if !v.is_null() {
                    Uuid::parse_str(v.as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
                }
            }
            "ids" => {
                let a = v.as_array().ok_or_else(invalid)?;
                if a.len() > *max {
                    return Err(invalid());
                }
                let mut seen = std::collections::HashSet::new();
                for v in a {
                    let id =
                        Uuid::parse_str(v.as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
                    if !seen.insert(id) {
                        return Err(invalid());
                    }
                }
            }
            "b" => {
                if !v.is_boolean() {
                    return Err(invalid());
                }
            }
            "n" => {
                if v.as_u64().is_none_or(|n| n < 1 || n > *max as u64) {
                    return Err(invalid());
                }
            }
            "employment" | "filter_employment" => {
                let s = v.as_str().ok_or_else(invalid)?;
                if !(["full_time", "contract", "part_time"].contains(&s)
                    || s.is_empty() && *ty == "filter_employment")
                {
                    return Err(invalid());
                }
            }
            "action" => {
                if !["transition", "revoke-sharing"].contains(&v.as_str().ok_or_else(invalid)?) {
                    return Err(invalid());
                }
            }
            "status" | "filter_status" => {
                if ![
                    "",
                    "draft",
                    "submitted",
                    "screening",
                    "rejected",
                    "hired",
                    "withdrawn",
                ]
                .contains(&v.as_str().ok_or_else(invalid)?)
                {
                    return Err(invalid());
                }
            }
            "kind" => {
                if !["resume", "career_history", "other"].contains(&v.as_str().ok_or_else(invalid)?)
                {
                    return Err(invalid());
                }
            }
            "uploads" => {
                let a = v.as_array().ok_or_else(invalid)?;
                if a.len() > 10 {
                    return Err(invalid());
                }
                let mut seen = std::collections::HashSet::new();
                for o in a {
                    fields(
                        o,
                        &["key", "kind", "name", "hash", "document_id", "state"],
                        &["key", "kind", "name", "hash", "state"],
                    )?;
                    let key = Uuid::parse_str(o["key"].as_str().ok_or_else(invalid)?)
                        .map_err(|_| invalid())?;
                    if !seen.insert(key)
                        || !["resume", "career_history", "other"]
                            .contains(&o["kind"].as_str().ok_or_else(invalid)?)
                    {
                        return Err(invalid());
                    }
                    let name = o["name"].as_str().ok_or_else(invalid)?;
                    let hash = o["hash"].as_str().ok_or_else(invalid)?;
                    if name.chars().count() > 255
                        || name.contains(['\0', '/', '\\', '<', '>'])
                        || hash.len() != 64
                        || !hash.bytes().all(|c| c.is_ascii_hexdigit())
                    {
                        return Err(invalid());
                    }
                    if ![
                        "waiting",
                        "sending",
                        "checking",
                        "pending",
                        "complete",
                        "rejected",
                        "uncertain",
                        "unrecorded",
                        "expired",
                    ]
                    .contains(&o["state"].as_str().ok_or_else(invalid)?)
                    {
                        return Err(invalid());
                    }
                    if !o["document_id"].is_null() {
                        Uuid::parse_str(o["document_id"].as_str().ok_or_else(invalid)?)
                            .map_err(|_| invalid())?;
                    }
                }
            }
            _ => return Err(invalid()),
        }
    }
    if serde_json::to_vec(p).map_err(|_| invalid())?.len() > 65536 {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "DRAFT_TOO_LARGE",
            "下書きは64KiB以内です。",
        ));
    }
    Ok(())
}
async fn exists(tx: &mut PgConnection, q: &'static str, id: Uuid) -> Result<(), ApiError> {
    if !sqlx::query_scalar::<_, bool>(q)
        .bind(id)
        .fetch_one(tx)
        .await
        .map_err(db_error)?
    {
        return Err(missing());
    }
    Ok(())
}
type WrappedKeyRow = (i32, Vec<u8>, Vec<u8>, Option<DateTime<Utc>>);
type OperationRow = (Uuid, i64, String, String, Vec<u8>, String, Uuid, i32, bool);
struct DraftContext<'a> {
    kind: &'a str,
    target: Option<Uuid>,
    ctx: Option<Uuid>,
    base: Option<i32>,
}
async fn context(
    tx: &mut PgConnection,
    u: &Identity,
    scope: DraftContext<'_>,
    p: &Value,
    check_version: bool,
) -> Result<(), ApiError> {
    let DraftContext {
        kind,
        target,
        ctx,
        base,
    } = scope;
    if !TYPES.contains(&kind) {
        return Err(invalid());
    }
    let agency = u.organization_kind == "agency";
    if (kind.starts_with("candidate_")
        || kind.starts_with("application_") && kind != "application_filters"
        || kind == "document_upload")
        && !agency
    {
        return Err(missing());
    }
    if (kind == "job_new" || kind == "job_edit") && agency {
        return Err(missing());
    }
    let targeted = matches!(
        kind,
        "job_edit"
            | "candidate_edit"
            | "application_reason"
            | "application_submit"
            | "selection_note"
            | "document_upload"
    );
    if targeted != target.is_some() || (kind == "application_new") != ctx.is_some() {
        return Err(invalid());
    }
    if targeted && kind != "document_upload" && base.is_none() {
        return Err(invalid());
    }
    if !targeted && base.is_some() {
        return Err(invalid());
    }
    if let Some(id) = target {
        let (v, valid): (i32, bool) = if kind == "job_edit" {
            sqlx::query_as("SELECT version,status<>'closed' FROM jobs WHERE id=$1 AND employer_org_id=rp_org()").bind(id).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(missing)?
        } else if kind == "candidate_edit" || kind == "document_upload" {
            sqlx::query_as("SELECT version,archived_at IS NULL FROM candidates WHERE id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_error)?
                .ok_or_else(missing)?
        } else {
            let a:Option<(i32,String,bool)>=sqlx::query_as("SELECT version,status,share_revoked_at IS NULL AND submitted_at IS NOT NULL FROM applications WHERE id=$1").bind(id).fetch_optional(&mut *tx).await.map_err(db_error)?;
            let (v, s, shared) = a.ok_or_else(missing)?;
            let valid = if kind == "selection_note" {
                if !agency && !shared {
                    return Err(missing());
                }
                if agency {
                    s != "draft" && shared
                } else {
                    ["submitted", "screening"].contains(&s.as_str()) && shared
                }
            } else {
                s == "draft"
            };
            (v, valid)
        };
        if check_version && kind != "document_upload" && (!valid || base != Some(v)) {
            return Err(conflict("DRAFT_CONTEXT_CHANGED"));
        }
    }
    if let Some(job) = ctx {
        exists(
            tx,
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND status='published')",
            job,
        )
        .await?;
    }
    if let Some(candidate) = p.get("candidate_id").and_then(Value::as_str) {
        let id = Uuid::parse_str(candidate).map_err(|_| invalid())?;
        exists(
            tx,
            "SELECT EXISTS(SELECT 1 FROM candidates WHERE id=$1 AND archived_at IS NULL)",
            id,
        )
        .await?;
    }
    if kind == "application_submit" {
        let (cv,jv,open):(i32,i32,bool)=sqlx::query_as("SELECT c.version,j.version,c.archived_at IS NULL AND j.status='published' FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE a.id=$1").bind(target).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(missing)?;
        if !open
            || p.get("candidate_version")
                .is_some_and(|v| v.as_i64() != Some(cv as i64))
            || p.get("job_version")
                .is_some_and(|v| v.as_i64() != Some(jv as i64))
        {
            return Err(conflict("DRAFT_CONTEXT_CHANGED"));
        }
    }
    if let Some(ids) = p.get("document_ids").and_then(Value::as_array) {
        let app = target.ok_or_else(invalid)?;
        for id in ids {
            let id = Uuid::parse_str(id.as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
            let available:Option<bool>=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM document_checks c WHERE c.document_id=d.id AND c.sha256=d.sha256 AND c.verdict='clean') AND NOT EXISTS(SELECT 1 FROM document_checks c WHERE c.document_id=d.id AND c.verdict='blocked') FROM documents d JOIN applications a ON a.candidate_id=d.candidate_id WHERE d.id=$1 AND a.id=$2 AND d.status='ready' AND d.validated_at IS NOT NULL").bind(id).bind(app).fetch_optional(&mut *tx).await.map_err(db_error)?;
            if available != Some(true) {
                return Err(conflict("DRAFT_CONTEXT_CHANGED"));
            }
        }
    }
    if let Some(ops) = p.get("operations").and_then(Value::as_array) {
        for op in ops {
            if let Some(id) = op["document_id"].as_str() {
                let id = Uuid::parse_str(id).map_err(|_| invalid())?;
                let ok:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM documents WHERE id=$1 AND candidate_id=$2 AND created_by=rp_user())").bind(id).bind(target).fetch_one(&mut *tx).await.map_err(db_error)?;
                if !ok {
                    return Err(missing());
                }
            }
        }
    }
    Ok(())
}
pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/v1/drafts", get(handle))
        .route("/api/v1/drafts/key", post(handle))
        .route("/api/v1/drafts/{id}", get(handle).put(handle))
        .route("/api/v1/drafts/{id}/discard", post(handle))
        .route("/api/v1/drafts/{id}/outcome", get(handle))
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Search {
    form_type: Option<String>,
    target_id: Option<Uuid>,
    context_id: Option<Uuid>,
    limit: Option<i64>,
    operation_id: Option<Uuid>,
}
async fn handle(State(app): State<Arc<App>>, request: Request) -> Result<Response, ApiError> {
    let method = request.method().clone();
    let u = auth::authorize(&app, request.headers(), method != Method::GET).await?;
    let path = request.uri().path().to_owned();
    let search = Query::<Search>::try_from_uri(request.uri())
        .map_err(|_| invalid())?
        .0;
    let header_key = request
        .headers()
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok());
    let body = if method == Method::GET {
        json!({})
    } else {
        if request
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| v.split(';').next() != Some("application/json"))
        {
            return Err(invalid());
        }
        serde_json::from_slice::<Value>(&to_bytes(request.into_body(), 98304).await.map_err(
            |_| {
                error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "BODY_TOO_LARGE",
                    "入力が大きすぎます。",
                )
            },
        )?)
        .map_err(|_| invalid())?
    };
    let mut tx = begin(&app, &u).await?;
    if path.ends_with("/key") {
        fields(&body, &["key_version"], &[])?;
        let requested = body
            .get("key_version")
            .map(|v| {
                v.as_i64()
                    .filter(|v| *v > 0 && *v <= i32::MAX as i64)
                    .ok_or_else(invalid)
            })
            .transpose()?;
        lock(
            &mut tx,
            lock_key(
                "draft-key",
                &[u.organization_id.to_string(), u.user_id.to_string()],
            ),
        )
        .await?;
        let row: Option<WrappedKeyRow> = if let Some(v) = requested {
            sqlx::query_as("SELECT key_version,wrapped_key,nonce,revoked_at FROM draft_keys WHERE key_version=$1").bind(v as i32).fetch_optional(&mut *tx).await.map_err(db_error)?
        } else {
            sqlx::query_as("SELECT key_version,wrapped_key,nonce,revoked_at FROM draft_keys ORDER BY key_version DESC LIMIT 1").fetch_optional(&mut *tx).await.map_err(db_error)?
        };
        let (version, key) = if let Some((v, c, n, revoke)) = row {
            if revoke.is_some() {
                return Err(conflict("DRAFT_KEY_REVOKED"));
            }
            let aad =
                serde_json::to_vec(&json!([app.config.origin, u.organization_id, u.user_id, v]))
                    .map_err(|_| invalid())?;
            (v, open(&derive(&app, b"key-wrap"), &aad, &c, &n)?)
        } else {
            if requested.is_some() {
                return Err(missing());
            }
            let raw = rand::random::<[u8; 32]>();
            let aad =
                serde_json::to_vec(&json!([app.config.origin, u.organization_id, u.user_id, 1]))
                    .map_err(|_| invalid())?;
            let (c, n) = seal(&derive(&app, b"key-wrap"), &aad, &raw)?;
            sqlx::query("INSERT INTO draft_keys(org_id,user_id,key_version,wrapped_key,nonce) VALUES($1,$2,1,$3,$4)").bind(u.organization_id).bind(u.user_id).bind(c).bind(n).execute(&mut *tx).await.map_err(db_error)?;
            (1, raw.to_vec())
        };
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(
            json!({"key_version":version,"key":B64.encode(key),"server_time":Utc::now()}),
        )
        .into_response());
    }
    let parts: Vec<_> = path.split('/').collect();
    let id = parts
        .get(4)
        .map(|v| Uuid::parse_str(v).map_err(|_| invalid()))
        .transpose()?;
    if id.is_none() {
        let limit = search.limit.unwrap_or(20);
        if !(1..=50).contains(&limit) {
            return Err(invalid());
        }
        let rows:Vec<Draft>=sqlx::query_as("SELECT * FROM form_drafts WHERE state='active' AND expires_at>now() AND ($1::text IS NULL OR form_type=$1) AND ($2::uuid IS NULL OR target_id=$2) AND ($3::uuid IS NULL OR context_id=$3) ORDER BY updated_at DESC,id LIMIT $4").bind(&search.form_type).bind(search.target_id).bind(search.context_id).bind(limit).fetch_all(&mut *tx).await.map_err(db_error)?;
        let mut items = vec![];
        for d in rows {
            if context(
                &mut tx,
                &u,
                DraftContext {
                    kind: &d.form_type,
                    target: d.target_id,
                    ctx: d.context_id,
                    base: d.base_resource_version,
                },
                &json!({}),
                false,
            )
            .await
            .is_ok()
            {
                items.push(d.metadata());
            }
        }
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(json!({"items":items,"server_time":Utc::now()})).into_response());
    }
    let id = id.ok_or_else(invalid)?;
    if path.ends_with("/outcome") {
        let d: Draft = sqlx::query_as("SELECT * FROM form_drafts WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?
            .ok_or_else(missing)?;
        context(
            &mut tx,
            &u,
            DraftContext {
                kind: &d.form_type,
                target: d.target_id,
                ctx: d.context_id,
                base: d.base_resource_version,
            },
            &json!({}),
            false,
        )
        .await?;
        let op = search.operation_id.ok_or_else(invalid)?;
        let result:Option<(String,Uuid,i32,bool)>=sqlx::query_as("SELECT result_resource_type,result_resource_id,result_status,result_expires_at>now() FROM draft_operations WHERE operation_id=$1 AND draft_id=$2").bind(op).bind(id).fetch_optional(&mut *tx).await.map_err(db_error)?;
        let out = if let Some((kind, r, status, valid)) = result {
            if !valid {
                return Err(conflict("OPERATION_RESULT_EXPIRED"));
            }
            result_access(&mut tx, &kind, r).await?;
            json!({"state":"committed","resource_type":kind,"resource_id":r,"result_status":status})
        } else {
            json!({"state":"not_recorded"})
        };
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(out).into_response());
    }
    if method == Method::GET {
        let d: Draft = sqlx::query_as("SELECT * FROM form_drafts WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?
            .ok_or_else(missing)?;
        d.live()?;
        let payload = d.plaintext(&app)?;
        payload_check(&d.form_type, &payload)?;
        context(
            &mut tx,
            &u,
            DraftContext {
                kind: &d.form_type,
                target: d.target_id,
                ctx: d.context_id,
                base: d.base_resource_version,
            },
            &payload,
            true,
        )
        .await?;
        let mut out = d.metadata();
        out["payload"] = payload;
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(out).into_response());
    }
    lock(
        &mut tx,
        lock_key(
            "draft-owner",
            &[u.organization_id.to_string(), u.user_id.to_string()],
        ),
    )
    .await?;
    lock(&mut tx, lock_key("draft", &[id.to_string()])).await?;
    let old: Option<Draft> = sqlx::query_as("SELECT * FROM form_drafts WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    if path.ends_with("/discard") {
        fields(&body, &["revision"], &["revision"])?;
        let key = header_key.ok_or_else(invalid)?;
        let d = old.ok_or_else(missing)?;
        context(
            &mut tx,
            &u,
            DraftContext {
                kind: &d.form_type,
                target: d.target_id,
                ctx: d.context_id,
                base: d.base_resource_version,
            },
            &json!({}),
            false,
        )
        .await?;
        let hash = Sha256::digest(
            serde_json::to_vec(&json!(["discard", id, body])).map_err(|_| invalid())?,
        )
        .to_vec();
        let replay: Option<Vec<u8>> = sqlx::query_scalar(
            "SELECT request_hash FROM draft_mutations WHERE mutation_id=$1 AND expires_at>now()",
        )
        .bind(key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
        if let Some(h) = replay {
            if h != hash {
                return Err(conflict("IDEMPOTENCY_MISMATCH"));
            }
            tx.commit().await.map_err(db_error)?;
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        d.live()?;
        if body["revision"].as_i64() != Some(d.revision) {
            return Err(conflict("DRAFT_VERSION_CONFLICT"));
        }
        sqlx::query("UPDATE form_drafts SET state='discarded',revision=revision+1,encrypted_payload=NULL,nonce=NULL,plaintext_bytes=0,consumed_at=now(),updated_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await.map_err(db_error)?;
        mutation(&mut tx, &u, key, id, hash, d.revision + 1, 204).await?;
        tx.commit().await.map_err(db_error)?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let save: Save = serde_json::from_value(body.clone()).map_err(|_| invalid())?;
    if save.schema_version != 1 {
        return Err(conflict("DRAFT_SCHEMA_UNSUPPORTED"));
    }
    if save.revision < 0 {
        return Err(invalid());
    }
    payload_check(&save.form_type, &save.payload)?;
    context(
        &mut tx,
        &u,
        DraftContext {
            kind: &save.form_type,
            target: save.target_id,
            ctx: save.context_id,
            base: save.base_resource_version,
        },
        &save.payload,
        true,
    )
    .await?;
    if let Some(d) = &old {
        d.live()?;
        d.plaintext(&app)?;
        if d.form_type != save.form_type
            || d.target_id != save.target_id
            || d.context_id != save.context_id
        {
            return Err(invalid());
        }
    }
    let hash =
        Sha256::digest(serde_json::to_vec(&json!(["save", id, body])).map_err(|_| invalid())?)
            .to_vec();
    let replay:Option<(Vec<u8>,i64,i32)>=sqlx::query_as("SELECT request_hash,revision,result_status FROM draft_mutations WHERE mutation_id=$1 AND expires_at>now()").bind(save.mutation_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    if let Some((h, r, status)) = replay {
        if h != hash {
            return Err(conflict("IDEMPOTENCY_MISMATCH"));
        }
        tx.commit().await.map_err(db_error)?;
        return Ok((
            StatusCode::from_u16(status as u16).map_err(|_| invalid())?,
            Json(json!({"id":id,"revision":r,"replayed":true})),
        )
            .into_response());
    }
    if old.as_ref().map_or(0, |d| d.revision) != save.revision {
        return Err(conflict("DRAFT_VERSION_CONFLICT"));
    }
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM draft_admissions WHERE at>now()-CASE WHEN $1 THEN interval '1 hour' ELSE interval '1 minute' END AND (NOT $1 OR is_new)").bind(old.is_none()).fetch_one(&mut *tx).await.map_err(db_error)?;
    if count >= if old.is_none() { 30 } else { 120 } {
        let mut r = error(
            StatusCode::TOO_MANY_REQUESTS,
            "DRAFT_RATE_LIMIT",
            "保存が混み合っています。入力を保持して後で再試行してください。",
        )
        .into_response();
        r.headers_mut().insert(
            "retry-after",
            if old.is_none() { "3600" } else { "60" }.parse().unwrap(),
        );
        return Ok(r);
    }
    let raw = serde_json::to_vec(&save.payload).map_err(|_| invalid())?;
    let quota:(i64,i64)=sqlx::query_as("SELECT count(*),coalesce(sum(plaintext_bytes),0)::bigint FROM form_drafts WHERE state='active' AND expires_at>now() AND id<>$1").bind(id).fetch_one(&mut *tx).await.map_err(db_error)?;
    if quota.0 >= 50 || quota.1 + raw.len() as i64 > 2 * 1024 * 1024 {
        return Err(conflict("DRAFT_QUOTA_EXCEEDED"));
    }
    let now = Utc::now();
    let d = Draft {
        id,
        org_id: u.organization_id,
        user_id: u.user_id,
        form_type: save.form_type.clone(),
        target_id: save.target_id,
        context_id: save.context_id,
        schema_version: 1,
        base_resource_version: save.base_resource_version,
        revision: save.revision + 1,
        encrypted_payload: None,
        nonce: None,
        key_version: 1,
        plaintext_bytes: raw.len() as i32,
        state: "active".into(),
        updated_at: now,
        expires_at: now + chrono::Duration::days(7),
    };
    let (c, n) = seal(&derive(&app, b"server-payload"), &d.aad(&app), &raw)?;
    if old.is_none() {
        let inserted=sqlx::query("INSERT INTO form_drafts(id,org_id,user_id,form_type,target_id,context_id,schema_version,base_resource_version,revision,encrypted_payload,nonce,plaintext_bytes,job_target,candidate_target,application_target) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING").bind(id).bind(u.organization_id).bind(u.user_id).bind(&save.form_type).bind(save.target_id).bind(save.context_id).bind(save.base_resource_version).bind(d.revision).bind(c).bind(n).bind(d.plaintext_bytes).bind(if save.form_type=="job_edit"{save.target_id}else{None}).bind(if ["candidate_edit","document_upload"].contains(&save.form_type.as_str()){save.target_id}else{None}).bind(if ["application_reason","application_submit","selection_note"].contains(&save.form_type.as_str()){save.target_id}else{None}).execute(&mut *tx).await.map_err(db_error)?.rows_affected();
        if inserted != 1 {
            return Err(missing());
        }
    } else {
        sqlx::query("UPDATE form_drafts SET encrypted_payload=$2,nonce=$3,plaintext_bytes=$4,schema_version=1,base_resource_version=$5,revision=$6,updated_at=now(),expires_at=now()+interval '7 days' WHERE id=$1").bind(id).bind(c).bind(n).bind(d.plaintext_bytes).bind(d.base_resource_version).bind(d.revision).execute(&mut *tx).await.map_err(db_error)?;
    }
    sqlx::query("INSERT INTO draft_admissions(org_id,user_id,is_new) VALUES($1,$2,$3)")
        .bind(u.organization_id)
        .bind(u.user_id)
        .bind(old.is_none())
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    let status = if old.is_none() { 201 } else { 200 };
    mutation(&mut tx, &u, save.mutation_id, id, hash, d.revision, status).await?;
    tx.commit().await.map_err(db_error)?;
    Ok((
        StatusCode::from_u16(status as u16).map_err(|_| invalid())?,
        Json(d.metadata()),
    )
        .into_response())
}
async fn mutation(
    tx: &mut PgConnection,
    u: &Identity,
    key: Uuid,
    id: Uuid,
    hash: Vec<u8>,
    revision: i64,
    status: i32,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO draft_mutations(org_id,user_id,mutation_id,draft_id,request_hash,revision,result_status) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(org_id,user_id,mutation_id) DO UPDATE SET draft_id=excluded.draft_id,request_hash=excluded.request_hash,revision=excluded.revision,result_status=excluded.result_status,expires_at=now()+interval '24 hours'").bind(u.organization_id).bind(u.user_id).bind(key).bind(id).bind(hash).bind(revision).bind(status).execute(tx).await.map_err(db_error)?;
    Ok(())
}
#[derive(Clone)]
pub struct Operation {
    pub draft: Uuid,
    pub revision: i64,
    pub id: Uuid,
}
pub fn take(
    body: &mut Value,
    headers: &HeaderMap,
    method: &Method,
) -> Result<Option<Operation>, ApiError> {
    let keys = ["draft_id", "draft_revision", "operation_id"];
    let count = keys.iter().filter(|k| body.get(**k).is_some()).count();
    if count == 0 {
        return Ok(None);
    }
    if count != 3 {
        return Err(invalid());
    }
    let o = Operation {
        draft: Uuid::parse_str(body["draft_id"].as_str().ok_or_else(invalid)?)
            .map_err(|_| invalid())?,
        revision: body["draft_revision"]
            .as_i64()
            .filter(|v| *v > 0)
            .ok_or_else(invalid)?,
        id: Uuid::parse_str(body["operation_id"].as_str().ok_or_else(invalid)?)
            .map_err(|_| invalid())?,
    };
    if method == Method::POST
        && headers.get("idempotency-key").and_then(|h| h.to_str().ok())
            != Some(o.id.to_string().as_str())
    {
        return Err(invalid());
    }
    let obj = body.as_object_mut().ok_or_else(invalid)?;
    for k in keys {
        obj.remove(k);
    }
    Ok(Some(o))
}
fn operation_hash(body: &Value, o: &Operation) -> Vec<u8> {
    Sha256::digest(serde_json::to_vec(&json!([body, o.draft, o.revision])).expect("json")).to_vec()
}
async fn result_access(tx: &mut PgConnection, kind: &str, id: Uuid) -> Result<(), ApiError> {
    exists(
        tx,
        match kind {
            "job" => "SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1)",
            "candidate" => "SELECT EXISTS(SELECT 1 FROM candidates WHERE id=$1)",
            "application" => "SELECT EXISTS(SELECT 1 FROM applications WHERE id=$1)",
            _ => return Err(invalid()),
        },
        id,
    )
    .await
}
pub async fn replay(
    tx: &mut PgConnection,
    u: &Identity,
    o: Option<&Operation>,
    method: &Method,
    path: &str,
    body: &Value,
    legacy_key: Option<Uuid>,
) -> Result<Option<(Uuid, StatusCode)>, ApiError> {
    let Some(o) = o else {
        if let Some(key) = legacy_key {
            lock(
                tx,
                lock_key(
                    "draft-operation",
                    &[
                        u.organization_id.to_string(),
                        u.user_id.to_string(),
                        key.to_string(),
                    ],
                ),
            )
            .await?;
            let valid: Option<bool> = sqlx::query_scalar(
                "SELECT result_expires_at>now() FROM draft_operations WHERE operation_id=$1",
            )
            .bind(key)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
            if let Some(valid) = valid {
                return Err(conflict(if valid {
                    "IDEMPOTENCY_MISMATCH"
                } else {
                    "OPERATION_RESULT_EXPIRED"
                }));
            }
        }
        return Ok(None);
    };
    lock(
        tx,
        lock_key(
            "draft-operation",
            &[
                u.organization_id.to_string(),
                u.user_id.to_string(),
                o.id.to_string(),
            ],
        ),
    )
    .await?;
    let prev:Option<OperationRow>=sqlx::query_as("SELECT draft_id,revision,method,normalized_path,request_hash,result_resource_type,result_resource_id,result_status,result_expires_at>now() FROM draft_operations WHERE operation_id=$1").bind(o.id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    if let Some((draft, revision, m, p, h, kind, id, status, valid)) = prev {
        result_access(tx, &kind, id).await?;
        if !valid {
            return Err(conflict("OPERATION_RESULT_EXPIRED"));
        }
        if draft != o.draft
            || revision != o.revision
            || m != method.as_str()
            || p != path
            || h != operation_hash(body, o)
        {
            return Err(conflict("IDEMPOTENCY_MISMATCH"));
        }
        return Ok(Some((
            id,
            StatusCode::from_u16(status as u16).map_err(|_| invalid())?,
        )));
    }
    Ok(None)
}
pub struct CommitRequest<'a> {
    pub method: &'a Method,
    pub path: &'a str,
    pub body: &'a Value,
}
pub async fn consume(
    tx: &mut PgConnection,
    app: &App,
    u: &Identity,
    o: Option<&Operation>,
    request: CommitRequest<'_>,
    resource: Uuid,
    status: StatusCode,
) -> Result<(), ApiError> {
    let Some(o) = o else { return Ok(()) };
    let CommitRequest { method, path, body } = request;
    let d: Draft = sqlx::query_as("SELECT * FROM form_drafts WHERE id=$1 FOR UPDATE")
        .bind(o.draft)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?
        .ok_or_else(missing)?;
    d.live()?;
    if d.revision != o.revision {
        return Err(conflict("DRAFT_VERSION_CONFLICT"));
    }
    let p = d.plaintext(app)?;
    payload_check(&d.form_type, &p)?;
    let parts: Vec<_> = path.split('/').collect();
    let kind = *parts.get(3).ok_or_else(invalid)?;
    let target = parts.get(4).and_then(|s| Uuid::parse_str(s).ok());
    let action = parts.get(5).copied().unwrap_or("");
    let expected = match (kind, target, action) {
        ("jobs", None, "") => "job_new",
        ("jobs", Some(_), "") => "job_edit",
        ("candidates", None, "") => "candidate_new",
        ("candidates", Some(_), "") => "candidate_edit",
        ("applications", None, "") => "application_new",
        ("applications", Some(_), "") => "application_reason",
        ("applications", Some(_), "submit") => "application_submit",
        ("applications", Some(_), "transition" | "revoke-sharing") => "selection_note",
        _ => return Err(invalid()),
    };
    if d.form_type != expected
        || d.target_id != target
        || target.is_some() && d.base_resource_version.map(i64::from) != body["version"].as_i64()
    {
        return Err(conflict("DRAFT_CONTEXT_CHANGED"));
    }
    if expected == "application_new"
        && d.context_id
            != body["job_id"]
                .as_str()
                .and_then(|v| Uuid::parse_str(v).ok())
    {
        return Err(invalid());
    }
    let mut input = body.clone();
    let obj = input.as_object_mut().ok_or_else(invalid)?;
    for k in [
        "version",
        "fictional_confirmed",
        "consent_confirmed",
        "job_id",
    ] {
        obj.remove(k);
    }
    if expected == "selection_note" {
        obj.insert("action".into(), json!(action));
    }
    let mut saved = p.clone();
    saved.as_object_mut().ok_or_else(invalid)?.remove("view");
    if expected == "application_new" {
        saved.as_object_mut().ok_or_else(invalid)?.remove("query");
    }
    if saved != input {
        return Err(conflict("DRAFT_CONTEXT_CHANGED"));
    }
    sqlx::query("UPDATE form_drafts SET state='consumed',revision=revision+1,encrypted_payload=NULL,nonce=NULL,plaintext_bytes=0,consumed_at=now(),updated_at=now() WHERE id=$1").bind(o.draft).execute(&mut *tx).await.map_err(db_error)?;
    let kind = match kind {
        "jobs" => "job",
        "candidates" => "candidate",
        _ => "application",
    };
    sqlx::query("INSERT INTO draft_operations(org_id,user_id,operation_id,draft_id,revision,method,normalized_path,request_hash,result_resource_type,result_resource_id,result_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(u.organization_id).bind(u.user_id).bind(o.id).bind(o.draft).bind(o.revision).bind(method.as_str()).bind(path).bind(operation_hash(body,o)).bind(kind).bind(resource).bind(status.as_u16()as i32).execute(tx).await.map_err(db_error)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hkdf_rfc5869_prefix() {
        let out = hkdf(
            &[0x0b; 22],
            &(0u8..=12).collect::<Vec<_>>(),
            &(0xf0u8..=0xf9).collect::<Vec<_>>(),
        );
        assert_eq!(
            out,
            [
                0x3c, 0xb2, 0x5f, 0x25, 0xfa, 0xac, 0xd5, 0x7a, 0x90, 0x43, 0x4f, 0x64, 0xd0, 0x36,
                0x2f, 0x2a, 0x2d, 0x2d, 0x0a, 0x90, 0xcf, 0x1a, 0x5a, 0x4c, 0x5d, 0xb0, 0x2d, 0x56,
                0xec, 0xc4, 0xc5, 0xbf
            ]
        );
    }
}
#[cfg(test)]
mod crypto_tests {
    use super::*;
    #[test]
    fn aes_gcm_integrity_and_aad_binding() {
        let key = [17u8; 32];
        let (c, n) = seal(&key, b"owner/form/revision", b"synthetic input")
            .unwrap_or_else(|_| panic!("seal"));
        assert!(open(&key, b"owner/form/revision", &c, &n).is_ok_and(|p| p == b"synthetic input"));
        assert!(open(&key, b"another owner", &c, &n).is_err());
        assert!(open(&[18u8; 32], b"owner/form/revision", &c, &n).is_err());
        let mut corrupted = c.clone();
        corrupted[0] ^= 1;
        assert!(open(&key, b"owner/form/revision", &corrupted, &n).is_err());
        assert!(open(&key, b"owner/form/revision", &c, &[0; 11]).is_err());
    }
}
