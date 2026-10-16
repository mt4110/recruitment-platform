//! Recommendation workflow. All reads/writes use the ordinary RLS runtime role.
use crate::auth::{self, ApiError, App, Identity};
use crate::business::{
    begin, db_error, error, fields, invalid, lock, lock_key, missing, text, version,
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Query, Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use std::sync::Arc;
use uuid::Uuid;
#[derive(FromRow)]
struct Application {
    id: Uuid,
    agency_org_id: Uuid,
    employer_org_id: Uuid,
    candidate_id: Uuid,
    job_id: Uuid,
    status: String,
    reason: String,
    version: i32,
    submitted_at: Option<DateTime<Utc>>,
    share_revoked_at: Option<DateTime<Utc>>,
    job_title_snapshot: Option<String>,
    job_description_snapshot: Option<String>,
    job_location_snapshot: Option<String>,
    job_employment_type_snapshot: Option<String>,
    job_version_snapshot: Option<i32>,
    agency_name_snapshot: Option<String>,
    employer_name_snapshot: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
#[derive(FromRow)]
struct Job {
    employer_org_id: Uuid,
    employer_name: String,
    title: String,
    description: String,
    location: String,
    employment_type: String,
    version: i32,
}
#[derive(FromRow)]
struct Candidate {
    name: String,
    summary: String,
    version: i32,
    archived_at: Option<DateTime<Utc>>,
}
#[derive(FromRow)]
struct Replay {
    request_hash: Vec<u8>,
    resource_id: Uuid,
    result_status: Option<i32>,
    state: String,
    valid: bool,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Search {
    status: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    at: DateTime<Utc>,
    id: Uuid,
    filter: String,
}
#[derive(FromRow)]
struct SharedFile {
    file_format_snapshot: String,
    media_type_snapshot: String,
    storage_key_snapshot: String,
    size_bytes_snapshot: i64,
    sha256_snapshot: String,
}
fn conflict(code: &'static str) -> ApiError {
    error(
        StatusCode::CONFLICT,
        code,
        match code {
            "JOB_NOT_OPEN" => "この求人は募集していません。",
            "CANDIDATE_ARCHIVED" => "候補者はアーカイブ済みです。",
            "DUPLICATE_APPLICATION" => "同じ候補者・求人の進行中または採用済みの推薦があります。",
            "VERSION_CONFLICT" => {
                "情報が更新されています。入力を控えたうえで最新情報を読み直してください。"
            }
            "SHARE_NOT_STARTED" => "まだ共有を開始していません。",
            "IDEMPOTENCY_MISMATCH" => "同じ操作キーの内容が変わっています。",
            _ => "現在の状態ではこの操作を行えません。",
        },
    )
}
fn sharing_revoked() -> ApiError {
    error(
        StatusCode::FORBIDDEN,
        "SHARING_REVOKED",
        "共有が取り消されているため変更できません。",
    )
}
fn workflow_db(e: sqlx::Error) -> ApiError {
    if e.as_database_error().and_then(|e| e.constraint()) == Some("applications_one_active") {
        conflict("DUPLICATE_APPLICATION")
    } else {
        db_error(e)
    }
}
pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/v1/applications", get(handle).post(handle))
        .route("/api/v1/applications/{id}", get(handle).patch(handle))
        .route(
            "/api/v1/applications/{id}/submit",
            axum::routing::post(handle),
        )
        .route(
            "/api/v1/applications/{id}/transition",
            axum::routing::post(handle),
        )
        .route(
            "/api/v1/applications/{id}/revoke-sharing",
            axum::routing::post(handle),
        )
        .route(
            "/api/v1/applications/{id}/documents/{document}/content",
            get(shared_content),
        )
}
async fn row(tx: &mut PgConnection, id: Uuid) -> Result<Application, ApiError> {
    sqlx::query_as("SELECT * FROM applications WHERE id=$1")
        .bind(id)
        .fetch_optional(tx)
        .await
        .map_err(db_error)?
        .ok_or_else(missing)
}
async fn locked(tx: &mut PgConnection, id: Uuid, u: &Identity) -> Result<Application, ApiError> {
    let result =
        sqlx::query_as::<_, Application>("SELECT * FROM applications WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
    if let Some(a) = result {
        return Ok(a);
    }
    let current = row(tx, id).await?;
    if u.organization_kind == "employer" && current.share_revoked_at.is_some() {
        return Err(sharing_revoked());
    }
    Err(missing())
}
async fn read(tx: &mut PgConnection, id: Uuid, u: &Identity) -> Result<Value, ApiError> {
    let a = row(tx, id).await?;
    let owner = u.organization_kind == "agency" && a.agency_org_id == u.organization_id;
    if !(owner || u.organization_kind == "employer" && a.employer_org_id == u.organization_id) {
        return Err(missing());
    }
    let shared =
        a.submitted_at.is_some() && a.share_revoked_at.is_none() && a.status != "withdrawn";
    let mut out = json!({"id":a.id,"status":a.status,"version":a.version,"job_id":a.job_id,"created_at":a.created_at,"updated_at":a.updated_at,"submitted_at":a.submitted_at,"share_revoked_at":a.share_revoked_at,"sharing_active":shared});
    if let Some(title) = a.job_title_snapshot {
        out["job_snapshot"] = json!({"title":title,"description":a.job_description_snapshot,"location":a.job_location_snapshot,"employment_type":a.job_employment_type_snapshot,"version":a.job_version_snapshot,"agency_name":a.agency_name_snapshot,"employer_name":a.employer_name_snapshot});
    }
    if owner {
        out["candidate_id"] = json!(a.candidate_id);
    }
    if owner || shared {
        out["reason"] = json!(a.reason);
        let snapshot:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('name',name,'summary',summary,'consent_recorded_at',consent_recorded_at,'consent_text_version',consent_text_version) FROM application_snapshots WHERE application_id=$1").bind(id).fetch_optional(&mut *tx).await.map_err(db_error)?;
        if let Some(snapshot) = snapshot {
            out["candidate_snapshot"] = snapshot;
        }
        let docs:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',document_id,'original_name',original_name_snapshot,'size_bytes',size_bytes_snapshot,'file_format',file_format_snapshot,'document_kind',document_kind_snapshot,'document_version',(SELECT version FROM document_versions v WHERE v.document_id=application_documents.document_id),'available',document_usable(document_id,sha256_snapshot,file_format_snapshot)) FROM application_documents WHERE application_id=$1 ORDER BY document_id").bind(id).fetch_all(&mut *tx).await.map_err(db_error)?;
        out["documents"] = json!(docs);
    }
    let mut events:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'event_type',event_type,'from_status',from_status,'to_status',to_status,'reason',reason,'created_at',created_at) FROM selection_events WHERE application_id=$1 ORDER BY created_at,id").bind(id).fetch_all(&mut *tx).await.map_err(db_error)?;
    if !owner && !shared {
        for e in &mut events {
            e.as_object_mut().ok_or_else(invalid)?.remove("reason");
        }
    }
    out["events"] = json!(events);
    let placement:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'decided_at',decided_at,'demo_fee_yen',demo_fee_yen) FROM placements WHERE application_id=$1").bind(id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    if let Some(p) = placement {
        out["placement"] = p;
    }
    Ok(out)
}
async fn list(tx: &mut PgConnection, u: &Identity, s: Search) -> Result<Value, ApiError> {
    let limit = s.limit.unwrap_or(20);
    if !(1..=100).contains(&limit)
        || s.status.as_deref().is_some_and(|v| {
            ![
                "draft",
                "submitted",
                "screening",
                "rejected",
                "hired",
                "withdrawn",
            ]
            .contains(&v)
        })
    {
        return Err(invalid());
    }
    let filter = B64.encode(Sha256::digest(
        serde_json::to_vec(&json!([u.organization_id, s.status, limit])).map_err(|_| invalid())?,
    ));
    let cursor = if let Some(c) = s.cursor {
        if c.len() > 1024 {
            return Err(invalid());
        }
        let c: Cursor = serde_json::from_slice(&B64.decode(c).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        if c.filter != filter {
            return Err(invalid());
        }
        Some(c)
    } else {
        None
    };
    #[derive(FromRow, Serialize)]
    struct Item {
        id: Uuid,
        status: String,
        version: i32,
        job_title: Option<String>,
        updated_at: DateTime<Utc>,
        share_revoked_at: Option<DateTime<Utc>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        candidate_name: Option<String>,
    }
    let mut items:Vec<Item>=sqlx::query_as("SELECT a.id,a.status,a.version,a.job_title_snapshot AS job_title,a.updated_at,a.share_revoked_at,s.name AS candidate_name FROM applications a LEFT JOIN application_snapshots s ON s.application_id=a.id WHERE ($1::text IS NULL OR a.status=$1) AND ($2::timestamptz IS NULL OR (a.updated_at,a.id)<($2,$3::uuid)) ORDER BY a.updated_at DESC,a.id DESC LIMIT $4")
    .bind(s.status).bind(cursor.as_ref().map(|c|c.at)).bind(cursor.map(|c|c.id)).bind(limit+1).fetch_all(tx).await.map_err(db_error)?;
    let next = if items.len() > limit as usize {
        items.truncate(limit as usize);
        let last = items.last().ok_or_else(invalid)?;
        Some(
            B64.encode(
                serde_json::to_vec(&Cursor {
                    at: last.updated_at,
                    id: last.id,
                    filter,
                })
                .map_err(|_| invalid())?,
            ),
        )
    } else {
        None
    };
    Ok(json!({"items":items,"next_cursor":next}))
}
fn uuid(v: &Value, key: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(v.get(key).and_then(Value::as_str).ok_or_else(invalid)?).map_err(|_| invalid())
}
fn input(body: &Value, id: Option<Uuid>, action: &str) -> Result<(), ApiError> {
    if id.is_none() {
        fields(
            body,
            &["candidate_id", "job_id", "reason"],
            &["candidate_id", "job_id", "reason"],
        )?;
        uuid(body, "candidate_id")?;
        uuid(body, "job_id")?;
        text(body, "reason", 2000)?;
        return Ok(());
    }
    version(body)?;
    match action {
        "" => {
            fields(body, &["version", "reason"], &["version", "reason"])?;
            text(body, "reason", 2000)?;
        }
        "submit" => {
            fields(
                body,
                &[
                    "version",
                    "candidate_version",
                    "job_version",
                    "document_ids",
                    "fictional_confirmed",
                    "consent_confirmed",
                ],
                &[
                    "version",
                    "candidate_version",
                    "job_version",
                    "document_ids",
                    "fictional_confirmed",
                    "consent_confirmed",
                ],
            )?;
            for key in ["candidate_version", "job_version"] {
                if body[key]
                    .as_i64()
                    .is_none_or(|n| n < 1 || n > i32::MAX as i64)
                {
                    return Err(invalid());
                }
            }
            if body["fictional_confirmed"] != true || body["consent_confirmed"] != true {
                return Err(invalid());
            }
            let docs = body["document_ids"].as_array().ok_or_else(invalid)?;
            if docs.is_empty() {
                return Err(invalid());
            }
            let mut seen = std::collections::HashSet::new();
            for d in docs {
                let id = Uuid::parse_str(d.as_str().ok_or_else(invalid)?).map_err(|_| invalid())?;
                if !seen.insert(id) {
                    return Err(invalid());
                }
            }
        }
        "transition" => {
            fields(
                body,
                &["version", "to_status", "reason"],
                &["version", "to_status"],
            )?;
            let to = text(body, "to_status", 20)?;
            if !["screening", "rejected", "hired", "withdrawn"].contains(&to.as_str()) {
                return Err(invalid());
            }
            if ["rejected", "withdrawn"].contains(&to.as_str()) || body.get("reason").is_some() {
                text(body, "reason", 500)?;
            }
        }
        "revoke-sharing" => {
            fields(body, &["version", "reason"], &["version", "reason"])?;
            text(body, "reason", 500)?;
        }
        _ => return Err(missing()),
    }
    Ok(())
}
async fn handle(State(app): State<Arc<App>>, request: Request) -> Result<Response, ApiError> {
    let method = request.method().clone();
    let draft_headers = request.headers().clone();
    let write = method != Method::GET;
    let u = auth::authorize(&app, request.headers(), write).await?;
    let parts: Vec<_> = request
        .uri()
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let id = parts
        .get(3)
        .map(|s| Uuid::parse_str(s).map_err(|_| invalid()))
        .transpose()?;
    let action = parts.get(4).copied().unwrap_or("").to_owned();
    let normalized = if let Some(id) = id {
        format!(
            "/api/v1/applications/{id}{}",
            if action.is_empty() {
                String::new()
            } else {
                format!("/{action}")
            }
        )
    } else {
        "/api/v1/applications".to_owned()
    };
    if write && u.organization_kind != "agency" && action != "transition" {
        return Err(error(
            StatusCode::FORBIDDEN,
            "ROLE_FORBIDDEN",
            "この利用区分では操作できません。",
        ));
    }
    let search = if !write && id.is_none() {
        Some(
            Query::<Search>::try_from_uri(request.uri())
                .map_err(|_| invalid())?
                .0,
        )
    } else {
        None
    };
    let key = if method == Method::POST {
        Some(
            request
                .headers()
                .get("idempotency-key")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| Uuid::parse_str(v).ok())
                .ok_or_else(invalid)?,
        )
    } else {
        None
    };
    let mut body = if write {
        if request
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| v.split(';').next() != Some("application/json"))
        {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "INVALID_JSON",
                "JSON形式で入力してください。",
            ));
        }
        let raw = to_bytes(request.into_body(), 65536).await.map_err(|_| {
            error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "BODY_TOO_LARGE",
                "入力が大きすぎます。",
            )
        })?;
        let v: Value = serde_json::from_slice(&raw).map_err(|_| {
            error(
                StatusCode::BAD_REQUEST,
                "INVALID_JSON",
                "JSON形式を確認してください。",
            )
        })?;
        if !v.is_object() {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "INVALID_JSON",
                "JSONオブジェクトで入力してください。",
            ));
        }
        v
    } else {
        json!({})
    };
    let operation = crate::drafts::take(&mut body, &draft_headers, &method)?;
    if write {
        input(&body, id, &action)?;
    }
    let mut tx = begin(&app, &u).await?;
    if !write {
        let out = if let Some(id) = id {
            read(&mut tx, id, &u).await?
        } else {
            list(&mut tx, &u, search.unwrap_or_default()).await?
        };
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(out).into_response());
    }
    let initial = if let Some(id) = id {
        Some(row(&mut tx, id).await?)
    } else {
        None
    };
    if let Some((resource, status)) =
        crate::drafts::replay(&mut tx, &u, operation.as_ref(), &method, &normalized, &body).await?
    {
        let value = read(&mut tx, resource, &u).await?;
        tx.commit().await.map_err(db_error)?;
        return Ok((status, Json(value)).into_response());
    }
    let (candidate, job) = if let Some(a) = &initial {
        (a.candidate_id, a.job_id)
    } else {
        (uuid(&body, "candidate_id")?, uuid(&body, "job_id")?)
    };
    // New draft relationship is checked before probing an idempotency key.
    if id.is_none() {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM candidates WHERE id=$1")
            .bind(candidate)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?
            .ok_or_else(missing)?;
    }
    let hash = Sha256::digest(serde_json::to_vec(&body).map_err(|_| invalid())?).to_vec();
    let resource = id.unwrap_or_else(Uuid::new_v4);
    if let Some(key) = key {
        lock(
            &mut tx,
            lock_key(
                "idem",
                &[
                    u.organization_id.to_string(),
                    u.user_id.to_string(),
                    method.to_string(),
                    normalized.clone(),
                    key.to_string(),
                ],
            ),
        )
        .await?;
        let previous:Option<Replay>=sqlx::query_as("SELECT request_hash,resource_id,result_status,state,coalesce(expires_at>now(),false) AS valid FROM idempotency_records WHERE org_id=$1 AND user_id=$2 AND http_method=$3 AND normalized_path=$4 AND key=$5").bind(u.organization_id).bind(u.user_id).bind(method.as_str()).bind(&normalized).bind(key).fetch_optional(&mut *tx).await.map_err(db_error)?;
        if operation.is_some() && previous.is_some() {
            return Err(conflict("IDEMPOTENCY_MISMATCH"));
        }
        if let Some(p) = previous
            .as_ref()
            .filter(|p| p.valid || p.state == "processing")
        {
            if p.request_hash != hash {
                return Err(conflict("IDEMPOTENCY_MISMATCH"));
            }
            if p.state != "completed" {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "RETRYABLE_BUSY",
                    "同じ操作を再試行してください。",
                ));
            }
            let out = read(&mut tx, p.resource_id, &u).await?;
            let status = StatusCode::from_u16(p.result_status.unwrap_or(200) as u16)
                .map_err(|_| invalid())?;
            tx.commit().await.map_err(db_error)?;
            return Ok((status, Json(out)).into_response());
        }
        sqlx::query("INSERT INTO idempotency_records(org_id,user_id,http_method,normalized_path,key,request_hash,resource_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,'processing') ON CONFLICT(org_id,user_id,http_method,normalized_path,key) DO UPDATE SET request_hash=excluded.request_hash,resource_id=excluded.resource_id,state='processing',result_status=NULL,error_code=NULL,expires_at=NULL WHERE idempotency_records.expires_at<=now()")
  .bind(u.organization_id).bind(u.user_id).bind(method.as_str()).bind(&normalized).bind(key).bind(&hash).bind(resource).execute(&mut *tx).await.map_err(db_error)?;
    }
    let mut event = None;
    let mut changed = true;
    if id.is_none() || action == "submit" {
        lock(&mut tx, lock_key("job", &[job.to_string()])).await?;
        let selected:Option<Job>=sqlx::query_as("SELECT employer_org_id,employer_name,title,description,location,employment_type,version FROM jobs WHERE id=$1 AND status='published'").bind(job).fetch_optional(&mut *tx).await.map_err(db_error)?;
        let j = selected.ok_or_else(|| {
            if id.is_some() {
                conflict("JOB_NOT_OPEN")
            } else {
                missing()
            }
        })?;
        let c: Candidate = sqlx::query_as(
            "SELECT name,summary,version,archived_at FROM candidates WHERE id=$1 FOR UPDATE",
        )
        .bind(candidate)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?
        .ok_or_else(missing)?;
        if id.is_none() {
            if c.archived_at.is_some() {
                return Err(conflict("CANDIDATE_ARCHIVED"));
            }
            sqlx::query("INSERT INTO applications(id,agency_org_id,employer_org_id,candidate_id,job_id,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(resource).bind(u.organization_id).bind(j.employer_org_id).bind(candidate).bind(job).bind(text(&body,"reason",2000)?).execute(&mut *tx).await.map_err(workflow_db)?;
        } else {
            let a = locked(&mut tx, resource, &u).await?;
            if a.version != version(&body)? {
                return Err(conflict("VERSION_CONFLICT"));
            }
            if a.status != "draft" || a.share_revoked_at.is_some() {
                return Err(conflict("INVALID_TRANSITION"));
            }
            if c.archived_at.is_some() {
                return Err(conflict("CANDIDATE_ARCHIVED"));
            }
            if c.version as i64 != body["candidate_version"].as_i64().unwrap_or(0)
                || j.version as i64 != body["job_version"].as_i64().unwrap_or(0)
            {
                return Err(conflict("VERSION_CONFLICT"));
            }
            let mut ids = body["document_ids"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .map(|v| Uuid::parse_str(v.as_str().ok_or_else(invalid)?).map_err(|_| invalid()))
                .collect::<Result<Vec<_>, _>>()?;
            ids.sort();
            for doc in ids {
                let n=sqlx::query("INSERT INTO application_documents(application_id,document_id,agency_org_id,storage_key_snapshot,original_name_snapshot,size_bytes_snapshot,sha256_snapshot,file_format_snapshot,media_type_snapshot,document_kind_snapshot) SELECT $1,id,agency_org_id,storage_key,original_name,size_bytes,sha256,file_format,media_type,document_kind FROM documents WHERE id=$2 AND candidate_id=$3 AND status='ready' AND document_usable(id,sha256,file_format)").bind(resource).bind(doc).bind(candidate).execute(&mut *tx).await.map_err(db_error)?.rows_affected();
                if n != 1 {
                    return Err(invalid());
                }
            }
            sqlx::query("INSERT INTO application_snapshots(application_id,name,summary,consent_recorded_at,consent_recorded_by,consent_text_version) VALUES($1,$2,$3,now(),$4,'demo-share-v1')").bind(resource).bind(c.name).bind(c.summary).bind(u.user_id).execute(&mut *tx).await.map_err(db_error)?;
            sqlx::query("UPDATE applications SET status='submitted',submitted_at=now(),job_title_snapshot=$2,job_description_snapshot=$3,job_location_snapshot=$4,job_employment_type_snapshot=$5,job_version_snapshot=$6,agency_name_snapshot=$7,employer_name_snapshot=$8,version=version+1,updated_at=now() WHERE id=$1 AND version=$9").bind(resource).bind(j.title).bind(j.description).bind(j.location).bind(j.employment_type).bind(j.version).bind(&u.organization_name).bind(j.employer_name).bind(a.version).execute(&mut *tx).await.map_err(workflow_db)?;
            event = Some(("transition", "draft".to_owned(), "submitted".to_owned()));
        }
    } else {
        let a = locked(&mut tx, resource, &u).await?;
        if u.organization_kind == "employer" && a.share_revoked_at.is_some() {
            return Err(sharing_revoked());
        }
        if a.version != version(&body)? {
            return Err(conflict("VERSION_CONFLICT"));
        }
        if action.is_empty() {
            if a.status != "draft" {
                return Err(conflict("INVALID_TRANSITION"));
            }
            sqlx::query("UPDATE applications SET reason=$2,version=version+1,updated_at=now() WHERE id=$1 AND version=$3").bind(resource).bind(text(&body,"reason",2000)?).bind(a.version).execute(&mut *tx).await.map_err(db_error)?;
        } else {
            let (to, kind, revoke) = if action == "revoke-sharing" {
                if a.status == "draft" {
                    return Err(conflict("SHARE_NOT_STARTED"));
                }
                if a.share_revoked_at.is_some() {
                    (a.status.clone(), "", false)
                } else if ["submitted", "screening"].contains(&a.status.as_str()) {
                    ("withdrawn".into(), "transition", true)
                } else {
                    (a.status.clone(), "sharing_revoked", true)
                }
            } else {
                let to = text(&body, "to_status", 20)?;
                let allowed = if u.organization_kind == "agency" {
                    to == "withdrawn" && ["submitted", "screening"].contains(&a.status.as_str())
                } else {
                    a.status == "submitted" && ["screening", "rejected"].contains(&to.as_str())
                        || a.status == "screening" && ["rejected", "hired"].contains(&to.as_str())
                };
                if !allowed {
                    return Err(conflict("INVALID_TRANSITION"));
                }
                (to.clone(), "transition", to == "withdrawn")
            };
            if kind.is_empty() {
                changed = false;
            }
            if !kind.is_empty() {
                sqlx::query("UPDATE applications SET status=$2,share_revoked_at=CASE WHEN $3 THEN now() ELSE share_revoked_at END,version=version+1,updated_at=now() WHERE id=$1 AND version=$4").bind(resource).bind(&to).bind(revoke).bind(a.version).execute(&mut *tx).await.map_err(workflow_db)?;
                if to == "hired" && a.status != "hired" {
                    sqlx::query("INSERT INTO placements(id,application_id,demo_fee_yen) VALUES($1,$2,500000)").bind(Uuid::new_v4()).bind(resource).execute(&mut *tx).await.map_err(db_error)?;
                }
                event = Some((kind, a.status, to));
            }
        }
    }
    let request_id = Uuid::new_v4();
    if let Some((kind, from, to)) = event {
        let event_id = Uuid::new_v4();
        let note = if action == "submit" {
            None
        } else {
            body.get("reason").and_then(Value::as_str)
        };
        sqlx::query("INSERT INTO selection_events(id,application_id,event_type,from_status,to_status,actor_user_id,actor_org_id,reason,application_version) SELECT $1,$2,$3,$4,$5,$6,$7,$8,version FROM applications WHERE id=$2").bind(event_id).bind(resource).bind(kind).bind(from).bind(to).bind(u.user_id).bind(u.organization_id).bind(note).execute(&mut *tx).await.map_err(db_error)?;
        sqlx::query("INSERT INTO notification_previews(id,application_id,recipient_org_id,event_id,subject,body) SELECT $1,id,CASE WHEN $2=agency_org_id THEN employer_org_id ELSE agency_org_id END,$3,'推薦の状態が更新されました','架空データ専用デモの未送信通知です。' FROM applications WHERE id=$4").bind(Uuid::new_v4()).bind(u.organization_id).bind(event_id).bind(resource).execute(&mut *tx).await.map_err(db_error)?;
    }
    // A no-op revoke only completes its idempotency result; no audit/event/notice is added.
    if changed {
        sqlx::query("INSERT INTO audit_events(id,actor_user_id,actor_org_id,action,resource_type,resource_id,result,request_id) VALUES($1,$2,$3,$4,'application',$5,'completed',$6)").bind(Uuid::new_v4()).bind(u.user_id).bind(u.organization_id).bind(if action.is_empty(){if id.is_none(){"application.create"}else{"application.update"}}else{action.as_str()}).bind(resource).bind(request_id).execute(&mut *tx).await.map_err(db_error)?;
    }
    let status = if id.is_none() {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    if let Some(key) = key {
        sqlx::query("UPDATE idempotency_records SET state='completed',result_status=$6,expires_at=now()+interval '24 hours' WHERE org_id=$1 AND user_id=$2 AND http_method=$3 AND normalized_path=$4 AND key=$5").bind(u.organization_id).bind(u.user_id).bind(method.as_str()).bind(&normalized).bind(key).bind(status.as_u16()as i32).execute(&mut *tx).await.map_err(db_error)?;
    }
    crate::drafts::consume(
        &mut tx,
        &app,
        &u,
        operation.as_ref(),
        &method,
        &normalized,
        &body,
        resource,
        status,
    )
    .await?;
    let out = read(&mut tx, resource, &u).await?;
    tx.commit().await.map_err(db_error)?;
    tracing::info!(event="application_operation",resource_id=%resource,request_id=%request_id,changed);
    let mut r = (status, Json(out)).into_response();
    r.headers_mut()
        .insert("x-request-id", request_id.to_string().parse().unwrap());
    Ok(r)
}
async fn shared_content(
    State(app): State<Arc<App>>,
    axum::extract::Path((raw, doc)): axum::extract::Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let u = auth::authorize(&app, &headers, false).await?;
    let id = Uuid::parse_str(&raw).map_err(|_| invalid())?;
    let document = Uuid::parse_str(&doc).map_err(|_| invalid())?;
    let mut tx = begin(&app, &u).await?;
    let file:SharedFile=sqlx::query_as("SELECT storage_key_snapshot,size_bytes_snapshot,sha256_snapshot,file_format_snapshot,media_type_snapshot FROM application_documents WHERE application_id=$1 AND document_id=$2 AND document_usable(document_id,sha256_snapshot,file_format_snapshot)").bind(id).bind(document).fetch_optional(&mut *tx).await.map_err(db_error)?.ok_or_else(missing)?;
    tx.commit().await.map_err(db_error)?;
    let data = crate::documents::verified_bytes(
        &file.storage_key_snapshot,
        file.size_bytes_snapshot,
        &file.sha256_snapshot,
    )
    .await?
    .ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "STORAGE_CONFLICT",
            "保存ファイルを確認できません。",
        )
    })?;
    tracing::info!(event="shared_document_download",application_id=%id,document_id=%document,request_id=%Uuid::new_v4());
    Ok((
        [
            ("content-type", file.media_type_snapshot.as_str()),
            (
                "content-disposition",
                if file.file_format_snapshot == "pdf" {
                    "attachment; filename=\"resume.pdf\""
                } else {
                    "attachment; filename=\"resume.xlsx\""
                },
            ),
        ],
        data,
    )
        .into_response())
}
