//! S1: authenticated ciphertext reception. No private unwrap key, parser or AV bypass.
use crate::{
    auth::{self, ApiError, App, Identity},
    business::{Tx, begin, db_error, error, invalid, lock, lock_key, missing},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;
const MAX: i64 = 10485760;
const OVERHEAD: i64 = 4116;
const WRAP: &str = "original-v1";
type Hmac256 = Hmac<Sha256>;
pub struct Config {
    key: Vec<u8>,
    public_spki: String,
    active: Mutex<HashSet<Uuid>>,
    _lock: std::fs::File,
}
impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let key = B64.decode(std::env::var("UPLOAD_TICKET_KEY")?)?;
        anyhow::ensure!(key.len() == 32, "ticket key length");
        let pem = std::fs::read_to_string("/run/upload-public.pem")?;
        anyhow::ensure!(
            pem.starts_with("-----BEGIN PUBLIC KEY-----") && !pem.contains("PRIVATE"),
            "public key only"
        );
        let public_spki = pem
            .lines()
            .filter(|s| !s.starts_with('-'))
            .collect::<String>();
        anyhow::ensure!(
            public_spki.len() >= 500 && public_spki.len() < 2000,
            "public key size"
        );
        std::fs::create_dir_all("/data/resumes/encrypted")?;
        // A single local receiver owns this volume. Process death releases the OS lock.
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open("/data/resumes/encrypted/receiver.lock")?;
        file.try_lock()?;
        Ok(Self {
            key,
            public_spki,
            active: Mutex::new(HashSet::new()),
            _lock: file,
        })
    }
}
struct Writer {
    config: Arc<Config>,
    token: Uuid,
}
impl Drop for Writer {
    fn drop(&mut self) {
        self.config
            .active
            .lock()
            .expect("writer registry")
            .remove(&self.token);
    }
}
fn fail(code: &'static str) -> ApiError {
    error(
        StatusCode::CONFLICT,
        code,
        "受付結果を確認してから、同じ操作で再試行してください。",
    )
}
fn storage() -> ApiError {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "UPLOAD_STORAGE_UNAVAILABLE",
        "保存領域を確認できません。受付結果を確認してください。",
    )
}
fn hash(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}
fn p(id: Uuid, ext: &str) -> PathBuf {
    PathBuf::from("/data/resumes/encrypted").join(format!("{id}.{ext}"))
}
async fn checked(app: &App, h: &HeaderMap, write: bool) -> Result<Identity, ApiError> {
    let u = auth::authorize(app, h, write).await?;
    if u.organization_kind != "agency" {
        return Err(missing());
    }
    Ok(u)
}
#[derive(FromRow)]
struct Session {
    id: Uuid,
    document_id: Uuid,
    candidate_id: Uuid,
    request_hash: Vec<u8>,
    document_kind: String,
    file_format: String,
    plain_length: i64,
    state: String,
    reserved_at: DateTime<Utc>,
    canonical_attempt: Option<Uuid>,
}
#[derive(FromRow)]
struct Attempt {
    id: Uuid,
    state: String,
    wrap_version: String,
    aad: String,
    staging_key: Uuid,
    ciphertext_hash: Option<String>,
    ciphertext_size: Option<i64>,
    envelope_hash: Option<String>,
    first_authorized_at: Option<DateTime<Utc>>,
    lease_token: Option<Uuid>,
    receive_deadline: Option<DateTime<Utc>>,
    stored_at: Option<DateTime<Utc>>,
}
pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/v1/candidates/{id}/document-uploads", post(reserve))
        .route("/api/v1/document-uploads/{id}", get(status))
        .route("/api/v1/document-uploads/{id}/attempts", post(new_attempt))
        .route("/api/v1/document-uploads/{id}/authorize", post(authorize))
        .route(
            "/api/v1/document-uploads/{id}/bytes",
            put(receive).layer(DefaultBodyLimit::max((MAX + OVERHEAD) as usize)),
        )
        .route("/api/v1/document-uploads/{id}/complete", post(complete))
        .layer(DefaultBodyLimit::max(16384))
}
async fn session(tx: &mut Tx, id: Uuid) -> Result<Session, ApiError> {
    sqlx::query_as("SELECT * FROM upload_sessions WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db_error)?
        .ok_or_else(missing)
}
async fn attempt(tx: &mut Tx, id: Uuid) -> Result<Attempt, ApiError> {
    sqlx::query_as("SELECT * FROM upload_attempts WHERE upload_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE").bind(id).fetch_optional(&mut **tx).await.map_err(db_error)?.ok_or_else(missing)
}
async fn candidate(tx: &mut Tx, id: Uuid) -> Result<(), ApiError> {
    let archived: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT archived_at FROM candidates WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(db_error)?
            .ok_or_else(missing)?;
    if archived.is_some() {
        return Err(fail("CANDIDATE_ARCHIVED"));
    }
    Ok(())
}
async fn result_valid(tx: &mut Tx, s: &Session) -> Result<(), ApiError> {
    let (state,expired):(String,bool)=sqlx::query_as("SELECT state,coalesce(expires_at<=now(),false) FROM idempotency_records WHERE resource_id=$1 AND normalized_path=$2").bind(s.document_id).bind(format!("/api/v1/candidates/{}/documents",s.candidate_id)).fetch_one(&mut **tx).await.map_err(db_error)?;
    if state == "expired" || expired {
        return Err(fail("OPERATION_RESULT_EXPIRED"));
    }
    Ok(())
}
async fn insert_attempt(tx: &mut Tx, s: &Session, u: &Identity) -> Result<(), ApiError> {
    let id = Uuid::new_v4();
    let aad = format!(
        "rp-upload-v1|{WRAP}|{}|{}|{id}|{}|{}",
        s.id, s.document_id, u.organization_id, s.file_format
    );
    sqlx::query("INSERT INTO upload_attempts(id,upload_id,org_id,user_id,wrap_version,aad,staging_key) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(id).bind(s.id).bind(u.organization_id).bind(u.user_id).bind(WRAP).bind(aad).bind(Uuid::new_v4()).execute(&mut **tx).await.map_err(db_error)?;
    Ok(())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Reservation {
    document_kind: String,
    file_format: String,
    plain_length: i64,
    fictional_confirmed: bool,
}
async fn reserve(
    State(app): State<Arc<App>>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(body): Json<Reservation>,
) -> Result<Response, ApiError> {
    let u = checked(&app, &h, true).await?;
    if !body.fictional_confirmed
        || !(1..=MAX).contains(&body.plain_length)
        || !["pdf", "xlsx"].contains(&body.file_format.as_str())
        || !["resume", "career_history", "other"].contains(&body.document_kind.as_str())
    {
        return Err(invalid());
    }
    let key = h
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(invalid)?;
    let request_hash = Sha256::digest(serde_json::to_vec(&body).map_err(|_| invalid())?).to_vec();
    let mut tx = begin(&app, &u).await?;
    candidate(&mut tx, id).await?;
    lock(
        &mut tx,
        lock_key(
            "idem",
            &[
                u.organization_id.to_string(),
                u.user_id.to_string(),
                "POST".into(),
                format!("/api/v1/candidates/{id}/documents"),
                key.to_string(),
            ],
        ),
    )
    .await?;
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM upload_sessions WHERE candidate_id=$1 AND operation_key=$2",
    )
    .bind(id)
    .bind(key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_error)?;
    let sid = if let Some(sid) = existing {
        let s = session(&mut tx, sid).await?;
        result_valid(&mut tx, &s).await?;
        if s.request_hash != request_hash {
            return Err(fail("IDEMPOTENCY_MISMATCH"));
        }
        sid
    } else {
        let conflict: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM idempotency_records WHERE normalized_path=$1 AND key=$2)",
        )
        .bind(format!("/api/v1/candidates/{id}/documents"))
        .bind(key)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_error)?;
        if conflict {
            return Err(fail("IDEMPOTENCY_MISMATCH"));
        }
        // Serialize org reservations, including requests from different users.
        lock(
            &mut tx,
            lock_key("encrypted-org", &[u.organization_id.to_string()]),
        )
        .await?;
        let quota: bool = sqlx::query_scalar("SELECT encrypted_upload_org_capacity($1)")
            .bind(body.plain_length)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
        if !quota {
            return Err(error(
                StatusCode::TOO_MANY_REQUESTS,
                "UPLOAD_QUOTA",
                "未完了の受付は組織あたり10件・100MiBまでです。受付結果を確認してください。",
            ));
        }
        let sid = Uuid::new_v4();
        let doc = Uuid::new_v4();
        sqlx::query("INSERT INTO upload_sessions(id,document_id,org_id,user_id,candidate_id,operation_key,request_hash,document_kind,file_format,plain_length) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(sid).bind(doc).bind(u.organization_id).bind(u.user_id).bind(id).bind(key).bind(&request_hash).bind(&body.document_kind).bind(&body.file_format).bind(body.plain_length).execute(&mut *tx).await.map_err(db_error)?;
        sqlx::query("INSERT INTO idempotency_records(org_id,user_id,http_method,normalized_path,key,request_hash,resource_id,state) VALUES($1,$2,'POST',$3,$4,$5,$6,'processing')").bind(u.organization_id).bind(u.user_id).bind(format!("/api/v1/candidates/{id}/documents")).bind(key).bind(request_hash).bind(doc).execute(&mut *tx).await.map_err(db_error)?;
        let s = session(&mut tx, sid).await?;
        insert_attempt(&mut tx, &s, &u).await?;
        sid
    };
    let s = session(&mut tx, sid).await?;
    let a = attempt(&mut tx, sid).await?;
    let v = dto(&app, &s, &a);
    tx.commit().await.map_err(db_error)?;
    Ok((StatusCode::CREATED, Json(v)).into_response())
}
fn dto(app: &App, s: &Session, a: &Attempt) -> Value {
    json!({"upload_id":s.id,"document_id":s.document_id,"state":s.state,"attempt_id":a.id,"attempt_state":a.state,"reservation_expires_at":s.reserved_at+Duration::hours(24),"attempt_expires_at":a.first_authorized_at.map(|v|(v+Duration::minutes(15)).min(s.reserved_at+Duration::hours(24))),"file_format":s.file_format,"plain_length":s.plain_length,"wrap_key_version":a.wrap_version,"wrap_public_spki":app.upload_config.public_spki,"aad":a.aad,"available":false,"status_url":format!("/api/v1/document-uploads/{}",s.id)})
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    schema: u8,
    key_version: String,
    wrapped_dek: String,
    nonce: String,
    aad: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Authorization {
    attempt_id: Uuid,
    ciphertext_hash: String,
    ciphertext_size: i64,
    envelope: Envelope,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ticket {
    purpose: String,
    audience: String,
    method: String,
    upload: Uuid,
    attempt: Uuid,
    destination: Uuid,
    hash: String,
    size: i64,
    envelope_hash: String,
    key_version: String,
    expires: i64,
}
fn sign(c: &Config, t: &Ticket) -> Result<String, ApiError> {
    let payload = B64.encode(serde_json::to_vec(t).map_err(|_| invalid())?);
    let mut mac = <Hmac256 as KeyInit>::new_from_slice(&c.key).map_err(|_| storage())?;
    mac.update(payload.as_bytes());
    Ok(format!(
        "{payload}.{}",
        B64.encode(mac.finalize().into_bytes())
    ))
}
fn verify(c: &Config, s: &str) -> Result<Ticket, ApiError> {
    if s.len() > 4096 {
        return Err(fail("INVALID_UPLOAD_TICKET"));
    }
    let (p, sig) = s
        .split_once('.')
        .ok_or_else(|| fail("INVALID_UPLOAD_TICKET"))?;
    let sig = B64.decode(sig).map_err(|_| fail("INVALID_UPLOAD_TICKET"))?;
    let mut mac = <Hmac256 as KeyInit>::new_from_slice(&c.key).map_err(|_| storage())?;
    mac.update(p.as_bytes());
    mac.verify_slice(&sig)
        .map_err(|_| fail("INVALID_UPLOAD_TICKET"))?;
    let t: Ticket =
        serde_json::from_slice(&B64.decode(p).map_err(|_| invalid())?).map_err(|_| invalid())?;
    if t.purpose != "ciphertext-upload-v1"
        || t.audience != "local-receiver"
        || t.method != "PUT"
        || t.key_version != "ticket-v1"
        || t.expires <= Utc::now().timestamp()
    {
        return Err(fail("INVALID_UPLOAD_TICKET"));
    }
    Ok(t)
}
fn ticket(s: &Session, a: &Attempt) -> Result<Ticket, ApiError> {
    let first = a.first_authorized_at.ok_or_else(invalid)?;
    let expires = (Utc::now() + Duration::minutes(5))
        .min(first + Duration::minutes(15))
        .min(s.reserved_at + Duration::hours(24));
    if expires <= Utc::now() {
        return Err(fail("UPLOAD_EXPIRED"));
    }
    Ok(Ticket {
        purpose: "ciphertext-upload-v1".into(),
        audience: "local-receiver".into(),
        method: "PUT".into(),
        upload: s.id,
        attempt: a.id,
        destination: a.staging_key,
        hash: a.ciphertext_hash.clone().ok_or_else(invalid)?,
        size: a.ciphertext_size.ok_or_else(invalid)?,
        envelope_hash: a.envelope_hash.clone().ok_or_else(invalid)?,
        key_version: "ticket-v1".into(),
        expires: expires.timestamp(),
    })
}
async fn authorize(
    State(app): State<Arc<App>>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
    Json(b): Json<Authorization>,
) -> Result<Response, ApiError> {
    let u = checked(&app, &h, true).await?;
    let mut tx = begin(&app, &u).await?;
    let s = session(&mut tx, id).await?;
    result_valid(&mut tx, &s).await?;
    candidate(&mut tx, s.candidate_id).await?;
    let a = attempt(&mut tx, id).await?;
    if a.id != b.attempt_id
        || !["prepared", "authorized"].contains(&a.state.as_str())
        || s.state != "reserved"
    {
        return Err(fail("UPLOAD_RECONCILING"));
    }
    if s.reserved_at + Duration::hours(24) <= Utc::now()
        || a.first_authorized_at
            .is_some_and(|v| v + Duration::minutes(15) <= Utc::now())
    {
        return Err(fail("UPLOAD_EXPIRED"));
    }
    if b.ciphertext_hash.len() != 64
        || !b
            .ciphertext_hash
            .bytes()
            .all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())
        || b.ciphertext_size < s.plain_length + 21
        || b.ciphertext_size > s.plain_length + OVERHEAD
        || b.envelope.schema != 1
        || b.envelope.key_version != a.wrap_version
        || b.envelope.aad != a.aad
        || B64
            .decode(&b.envelope.nonce)
            .map_or(true, |n| n.len() != 12)
        || B64
            .decode(&b.envelope.wrapped_dek)
            .map_or(true, |n| n.len() != 384)
    {
        return Err(invalid());
    }
    let envelope = serde_json::to_value(b.envelope).map_err(|_| invalid())?;
    let encoded = serde_json::to_vec(&envelope).map_err(|_| invalid())?;
    if encoded.len() > 8192 {
        return Err(invalid());
    }
    let eh = hash(&encoded);
    if a.state == "authorized"
        && (a.ciphertext_hash.as_deref() != Some(&b.ciphertext_hash)
            || a.ciphertext_size != Some(b.ciphertext_size)
            || a.envelope_hash.as_deref() != Some(&eh))
    {
        return Err(fail("UPLOAD_IMMUTABLE"));
    }
    if a.state == "prepared" {
        let capacity: bool = sqlx::query_scalar("SELECT encrypted_upload_capacity($1)")
            .bind(b.ciphertext_size + 16384)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
        if !capacity {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "UPLOAD_CAPACITY",
                "保存容量の上限です。管理者に確認してください。",
            ));
        }
        disk_headroom()?;
        sqlx::query("UPDATE upload_attempts SET state='authorized',ciphertext_hash=$2,ciphertext_size=$3,envelope=$4,envelope_hash=$5,first_authorized_at=now(),physical_bytes=$3+16384 WHERE id=$1 AND state='prepared'").bind(a.id).bind(b.ciphertext_hash).bind(b.ciphertext_size).bind(envelope).bind(eh).execute(&mut *tx).await.map_err(db_error)?;
    }
    let a = attempt(&mut tx, id).await?;
    let t = ticket(&s, &a)?;
    let value = json!({"ticket":sign(&app.upload_config,&t)?,"expires_at":t.expires,"method":"PUT","upload_url":format!("/api/v1/document-uploads/{id}/bytes")});
    tx.commit().await.map_err(db_error)?;
    Ok(Json(value).into_response())
}
fn disk_headroom() -> Result<(), ApiError> {
    let out = std::process::Command::new("df")
        .args(["-Pk", "/data/resumes"])
        .output()
        .map_err(|_| storage())?;
    let free = String::from_utf8_lossy(&out.stdout)
        .lines()
        .last()
        .and_then(|s| s.split_whitespace().nth(3))
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(storage)?;
    if !out.status.success() || free < 262144 {
        return Err(storage());
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    attempt: Uuid,
    token: Uuid,
    hash: String,
    size: i64,
    envelope_hash: String,
    finished: DateTime<Utc>,
}
async fn recover(tx: &mut Tx, app: &App, s: &Session, a: &Attempt) -> Result<(), ApiError> {
    if !["receiving", "reconciling"].contains(&a.state.as_str()) {
        return Ok(());
    }
    if a.lease_token.is_some_and(|t| {
        app.upload_config
            .active
            .lock()
            .expect("writer registry")
            .contains(&t)
    }) {
        return Err(fail("UPLOAD_RECONCILING"));
    }
    // The process lock + absent writer guard establishes that the old writer stopped.
    sqlx::query("UPDATE upload_attempts SET state='reconciling' WHERE id=$1")
        .bind(a.id)
        .execute(&mut **tx)
        .await
        .map_err(db_error)?;
    let valid = async {
        let raw = fs::read(p(a.staging_key, "manifest")).await.ok()?;
        if raw.len() > 2048 {
            return None;
        }
        let m: Manifest = serde_json::from_slice(&raw).ok()?;
        if m.attempt != a.id
            || Some(m.token) != a.lease_token
            || Some(m.hash.clone()) != a.ciphertext_hash
            || Some(m.size) != a.ciphertext_size
            || Some(m.envelope_hash.clone()) != a.envelope_hash
            || a.receive_deadline.is_none_or(|v| m.finished > v)
            || m.finished > s.reserved_at + Duration::hours(24)
        {
            return None;
        }
        let data = fs::read(p(a.staging_key, "cipher")).await.ok()?;
        if data.len() as i64 != m.size || hash(&data) != m.hash {
            return None;
        }
        Some(m.finished)
    }
    .await;
    if let Some(time) = valid {
        sqlx::query("UPDATE upload_attempts SET state='stored',stored_at=$2 WHERE id=$1")
            .bind(a.id)
            .bind(time)
            .execute(&mut **tx)
            .await
            .map_err(db_error)?;
        sqlx::query("UPDATE upload_sessions SET state='received' WHERE id=$1")
            .bind(s.id)
            .execute(&mut **tx)
            .await
            .map_err(db_error)?;
    } else {
        sqlx::query("UPDATE upload_attempts SET state='closed' WHERE id=$1")
            .bind(a.id)
            .execute(&mut **tx)
            .await
            .map_err(db_error)?;
    }
    Ok(())
}
async fn expire(tx: &mut Tx, s: &Session, a: &Attempt) -> Result<(), ApiError> {
    if s.state == "reserved"
        && s.reserved_at + Duration::hours(24) <= Utc::now()
        && !["stored", "attached", "receiving", "reconciling"].contains(&a.state.as_str())
    {
        sqlx::query("UPDATE upload_sessions SET state='rejected' WHERE id=$1")
            .bind(s.id)
            .execute(&mut **tx)
            .await
            .map_err(db_error)?;
        sqlx::query("UPDATE idempotency_records SET state='failed',error_code='UPLOAD_EXPIRED',result_status=409,expires_at=now()+interval '7 days' WHERE resource_id=$1 AND state='processing'").bind(s.document_id).execute(&mut **tx).await.map_err(db_error)?;
    }
    Ok(())
}
async fn status(
    State(app): State<Arc<App>>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Response, ApiError> {
    let u = checked(&app, &h, false).await?;
    let mut tx = begin(&app, &u).await?;
    let s = session(&mut tx, id).await?;
    result_valid(&mut tx, &s).await?;
    let a = attempt(&mut tx, id).await?;
    if let Err(e) = recover(&mut tx, &app, &s, &a).await
        && e.code != "UPLOAD_RECONCILING"
    {
        return Err(e);
    }
    let s = session(&mut tx, id).await?;
    let a = attempt(&mut tx, id).await?;
    expire(&mut tx, &s, &a).await?;
    let s = session(&mut tx, id).await?;
    let v = dto(&app, &s, &a);
    tx.commit().await.map_err(db_error)?;
    Ok(Json(v).into_response())
}
async fn new_attempt(
    State(app): State<Arc<App>>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Response, ApiError> {
    let u = checked(&app, &h, true).await?;
    let mut tx = begin(&app, &u).await?;
    let s = session(&mut tx, id).await?;
    result_valid(&mut tx, &s).await?;
    candidate(&mut tx, s.candidate_id).await?;
    let a = attempt(&mut tx, id).await?;
    recover(&mut tx, &app, &s, &a).await?;
    let a = attempt(&mut tx, id).await?;
    if s.state != "reserved"
        || s.reserved_at + Duration::hours(24) <= Utc::now()
        || ["stored", "attached", "receiving", "reconciling"].contains(&a.state.as_str())
    {
        return Err(fail("UPLOAD_RECONCILING"));
    }
    sqlx::query("UPDATE upload_attempts SET state='closed' WHERE id=$1")
        .bind(a.id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    insert_attempt(&mut tx, &s, &u).await?;
    let a = attempt(&mut tx, id).await?;
    let v = dto(&app, &s, &a);
    tx.commit().await.map_err(db_error)?;
    Ok((StatusCode::CREATED, Json(v)).into_response())
}
fn receive_window(reserved: DateTime<Utc>, now: DateTime<Utc>) -> std::time::Duration {
    (reserved + Duration::hours(24) - now)
        .to_std()
        .unwrap_or_default()
        .min(std::time::Duration::from_secs(300))
}
async fn receive(
    State(app): State<Arc<App>>,
    Path(id): Path<Uuid>,
    request: Request,
) -> Result<Response, ApiError> {
    let headers = request.headers().clone();
    let h = &headers;
    let u = checked(&app, h, true).await?;
    let raw = h
        .get("x-upload-ticket")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| fail("INVALID_UPLOAD_TICKET"))?;
    let t = verify(&app.upload_config, raw)?;
    if t.upload != id {
        return Err(fail("INVALID_UPLOAD_TICKET"));
    }
    let mut tx = begin(&app, &u).await?;
    let s = session(&mut tx, id).await?;
    result_valid(&mut tx, &s).await?;
    candidate(&mut tx, s.candidate_id).await?;
    let a = attempt(&mut tx, id).await?;
    if a.id != t.attempt
        || a.staging_key != t.destination
        || a.ciphertext_hash.as_deref() != Some(&t.hash)
        || a.ciphertext_size != Some(t.size)
        || a.envelope_hash.as_deref() != Some(&t.envelope_hash)
    {
        return Err(fail("INVALID_UPLOAD_TICKET"));
    }
    if ["stored", "attached", "receiving", "reconciling"].contains(&a.state.as_str()) {
        let v = dto(&app, &s, &a);
        tx.commit().await.map_err(db_error)?;
        return Ok((StatusCode::ACCEPTED, Json(v)).into_response());
    }
    if a.state != "authorized"
        || s.state != "reserved"
        || s.reserved_at + Duration::hours(24) <= Utc::now()
    {
        return Err(fail("UPLOAD_EXPIRED"));
    }
    if request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        != Some("application/octet-stream")
    {
        return Err(invalid());
    }
    if let Some(length) = request.headers().get("content-length")
        && length.to_str().ok().and_then(|v| v.parse::<i64>().ok()) != Some(t.size)
    {
        return Err(fail("UPLOAD_SIZE"));
    }
    disk_headroom()?;
    let _admission = app.uploads.clone().try_acquire_owned().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "UPLOAD_BUSY",
            "受信処理が混み合っています。受付結果を確認して再試行してください。",
        )
    })?;
    let token = Uuid::new_v4();
    app.upload_config
        .active
        .lock()
        .expect("writer registry")
        .insert(token);
    let _writer = Writer {
        config: app.upload_config.clone(),
        token,
    };
    sqlx::query("UPDATE upload_attempts SET state='receiving',lease_token=$2,receive_deadline=least(now()+interval '5 minutes',$3+interval '24 hours') WHERE id=$1 AND state='authorized'").bind(a.id).bind(token).bind(s.reserved_at).execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    let receive = async {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(p(a.staging_key, "cipher"))
            .await
            .map_err(|_| storage())?;
        let mut body = request.into_body();
        let mut digest = Sha256::new();
        let mut count = 0i64;
        while let Some(chunk) = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_frame(cx)),
        )
        .await
        .map_err(|_| fail("UPLOAD_IDLE_TIMEOUT"))?
        {
            let frame = chunk.map_err(|_| fail("UPLOAD_INTERRUPTED"))?;
            if let Ok(data) = frame.into_data() {
                count += data.len() as i64;
                if count > t.size {
                    return Err(fail("UPLOAD_SIZE"));
                }
                digest.update(&data);
                file.write_all(&data).await.map_err(|_| storage())?;
            }
        }
        let actual: String = digest
            .finalize()
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect();
        if count != t.size || actual != t.hash {
            return Err(fail("UPLOAD_CHECKSUM"));
        }
        file.sync_all().await.map_err(|_| storage())?;
        let m = Manifest {
            attempt: a.id,
            token,
            hash: actual,
            size: count,
            envelope_hash: t.envelope_hash.clone(),
            finished: Utc::now(),
        };
        let encoded = serde_json::to_vec(&m).map_err(|_| storage())?;
        let tmp = p(token, "manifest-tmp");
        let mut manifest = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .await
            .map_err(|_| storage())?;
        manifest.write_all(&encoded).await.map_err(|_| storage())?;
        manifest.sync_all().await.map_err(|_| storage())?;
        // Unique staging name, one fenced writer. Atomic publication after fsync.
        fs::hard_link(&tmp, p(a.staging_key, "manifest"))
            .await
            .map_err(|_| storage())?;
        fs::File::open("/data/resumes/encrypted")
            .await
            .map_err(|_| storage())?
            .sync_all()
            .await
            .map_err(|_| storage())?;
        Ok::<_, ApiError>(m.finished)
    };
    use axum::body::HttpBody;
    let time = tokio::time::timeout(receive_window(s.reserved_at, Utc::now()), receive)
        .await
        .map_err(|_| fail("UPLOAD_TIMEOUT"))??;
    // Recheck login, org, candidate and fencing before promoting the durable receipt.
    let current = checked(&app, &headers, true).await?;
    let mut tx = begin(&app, &current).await?;
    let s = session(&mut tx, id).await?;
    candidate(&mut tx, s.candidate_id).await?;
    result_valid(&mut tx, &s).await?;
    let n=sqlx::query("UPDATE upload_attempts SET state='stored',stored_at=$3 WHERE id=$1 AND lease_token=$2 AND state='receiving' AND receive_deadline>=now() AND receive_deadline>=$3").bind(a.id).bind(token).bind(time).execute(&mut *tx).await.map_err(db_error)?.rows_affected();
    if n != 1 {
        return Err(fail("UPLOAD_RECONCILING"));
    }
    sqlx::query("UPDATE upload_sessions SET state='received' WHERE id=$1 AND state='reserved'")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    let s = session(&mut tx, id).await?;
    let a = attempt(&mut tx, id).await?;
    let v = dto(&app, &s, &a);
    tx.commit().await.map_err(db_error)?;
    Ok((StatusCode::ACCEPTED, Json(v)).into_response())
}
async fn complete(
    State(app): State<Arc<App>>,
    Path(id): Path<Uuid>,
    h: HeaderMap,
) -> Result<Response, ApiError> {
    let u = checked(&app, &h, true).await?;
    let mut tx = begin(&app, &u).await?;
    let s = session(&mut tx, id).await?;
    result_valid(&mut tx, &s).await?;
    candidate(&mut tx, s.candidate_id).await?;
    let a = attempt(&mut tx, id).await?;
    recover(&mut tx, &app, &s, &a).await?;
    let a = attempt(&mut tx, id).await?;
    if s.state == "rejected" {
        return Err(fail("UPLOAD_EXPIRED"));
    }
    if s.state != "attached" {
        if a.state != "stored"
            || a.stored_at
                .is_none_or(|v| v > s.reserved_at + Duration::hours(24))
        {
            return Err(fail("UPLOAD_NOT_STORED"));
        }
        // Original filename and plaintext hash remain NULL, not fabricated values.
        sqlx::query("INSERT INTO documents(id,agency_org_id,candidate_id,created_by,storage_key,size_bytes,status,file_format,media_type,document_kind,encrypted_transport) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,true)").bind(s.document_id).bind(u.organization_id).bind(s.candidate_id).bind(u.user_id).bind(format!("{}.cipher",a.staging_key)).bind(s.plain_length).bind(&s.file_format).bind(if s.file_format=="pdf"{"application/pdf"}else{"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}).bind(&s.document_kind).execute(&mut *tx).await.map_err(db_error)?;
        sqlx::query("INSERT INTO document_encryption(document_id,attempt_id,org_id,user_id,schema_version) VALUES($1,$2,$3,$4,1)").bind(s.document_id).bind(a.id).bind(u.organization_id).bind(u.user_id).execute(&mut *tx).await.map_err(db_error)?;
        sqlx::query(
            "INSERT INTO encrypted_document_jobs(document_id,org_id,user_id) VALUES($1,$2,$3)",
        )
        .bind(s.document_id)
        .bind(u.organization_id)
        .bind(u.user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
        sqlx::query("UPDATE upload_sessions SET state='attached',canonical_attempt=$2 WHERE id=$1 AND canonical_attempt IS NULL").bind(id).bind(a.id).execute(&mut *tx).await.map_err(db_error)?;
        sqlx::query("UPDATE upload_attempts SET state='attached' WHERE id=$1")
            .bind(a.id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
    } else if s.canonical_attempt != Some(a.id) {
        return Err(fail("UPLOAD_RECONCILING"));
    }
    let s = session(&mut tx, id).await?;
    let a = attempt(&mut tx, id).await?;
    let v = dto(&app, &s, &a);
    tx.commit().await.map_err(db_error)?;
    Ok((StatusCode::ACCEPTED, Json(v)).into_response())
}
pub(crate) async fn outcome(
    tx: &mut Tx,
    _u: &Identity,
    candidate: Uuid,
    key: Uuid,
) -> Result<Option<Value>, ApiError> {
    let found: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM upload_sessions WHERE candidate_id=$1 AND operation_key=$2",
    )
    .bind(candidate)
    .bind(key)
    .fetch_optional(&mut **tx)
    .await
    .map_err(db_error)?;
    if let Some(id) = found {
        let s = session(tx, id).await?;
        result_valid(tx, &s).await?;
        let a = attempt(tx, id).await?;
        return Ok(Some(
            json!({"state":"processing","upload_state":s.state,"attempt_state":a.state,"document_id":s.document_id,"upload_id":id,"status_url":format!("/api/v1/document-uploads/{id}"),"result_status":202,"result_expires_at":null}),
        ));
    }
    Ok(None)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            key: vec![42; 32],
            public_spki: String::new(),
            active: Mutex::new(HashSet::new()),
            _lock: std::fs::File::open("/dev/null").expect("test fixture"),
        }
    }
    fn claims() -> Ticket {
        Ticket {
            purpose: "ciphertext-upload-v1".into(),
            audience: "local-receiver".into(),
            method: "PUT".into(),
            upload: Uuid::new_v4(),
            attempt: Uuid::new_v4(),
            destination: Uuid::new_v4(),
            hash: "a".repeat(64),
            size: 21,
            envelope_hash: "b".repeat(64),
            key_version: "ticket-v1".into(),
            expires: Utc::now().timestamp() + 300,
        }
    }
    #[test]
    fn ticket_roundtrip() {
        let c = config();
        let t = claims();
        assert_eq!(
            verify(&c, &sign(&c, &t).ok().expect("test fixture"))
                .ok()
                .expect("test fixture")
                .attempt,
            t.attempt
        );
    }
    #[test]
    fn ticket_alteration() {
        let c = config();
        let signed = sign(&c, &claims()).ok().expect("test fixture");
        let mut b = signed.into_bytes();
        b[10] = if b[10] == b'A' { b'B' } else { b'A' };
        assert!(verify(&c, std::str::from_utf8(&b).expect("test fixture")).is_err());
    }
    #[test]
    fn ticket_wrong_key() {
        let c = config();
        let signed = sign(&c, &claims()).ok().expect("test fixture");
        let mut other = config();
        other.key = vec![1; 32];
        assert!(verify(&other, &signed).is_err());
    }
    #[test]
    fn ticket_expired() {
        let c = config();
        let mut t = claims();
        t.expires = Utc::now().timestamp();
        assert!(verify(&c, &sign(&c, &t).ok().expect("test fixture")).is_err());
    }
    #[test]
    fn ticket_domains() {
        let c = config();
        for field in 0..4 {
            let mut t = claims();
            match field {
                0 => t.method = "GET".into(),
                1 => t.purpose = "view".into(),
                2 => t.audience = "cloud".into(),
                _ => t.key_version = "unknown".into(),
            };
            assert!(verify(&c, &sign(&c, &t).ok().expect("test fixture")).is_err());
        }
    }
    #[test]
    fn receive_window_caps_original_deadline() {
        let now = Utc::now();
        assert_eq!(receive_window(now, now).as_secs(), 300);
        assert_eq!(
            receive_window(now - Duration::hours(24) + Duration::seconds(2), now).as_secs(),
            2
        );
        assert_eq!(receive_window(now - Duration::hours(24), now).as_secs(), 0);
    }
    #[test]
    fn ticket_size_cap() {
        assert!(verify(&config(), &"a".repeat(4097)).is_err());
    }
}
