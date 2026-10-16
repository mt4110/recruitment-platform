//! M2 business boundary. All statements use a context-bound runtime transaction.
use crate::auth::{self, ApiError, App, Identity};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Query, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection, Postgres, Transaction};
use std::sync::Arc;
use uuid::Uuid;

pub(crate) type Tx = Transaction<'static, Postgres>;
pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/v1/jobs", get(handle).post(handle))
        .route("/api/v1/jobs/{id}", get(handle).patch(handle))
        .route("/api/v1/jobs/{id}/status", axum::routing::post(handle))
        .route(
            "/api/v1/jobs/{id}/favorite",
            axum::routing::put(handle).delete(handle),
        )
        .route("/api/v1/candidates", get(handle).post(handle))
        .route("/api/v1/candidates/{id}", get(handle).patch(handle))
        .route(
            "/api/v1/candidates/{id}/archive",
            axum::routing::post(handle),
        )
}
pub(crate) fn error(status: StatusCode, code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(status, code, message)
}
pub(crate) fn invalid() -> ApiError {
    error(
        StatusCode::UNPROCESSABLE_ENTITY,
        "INVALID_INPUT",
        "入力内容・項目・長さを確認してください。",
    )
}
pub(crate) fn missing() -> ApiError {
    error(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "見つからない、または閲覧できません。",
    )
}
fn conflict(code: &'static str) -> ApiError {
    error(
        StatusCode::CONFLICT,
        code,
        "情報が変更されています。入力を控えたうえで最新情報を読み直してください。",
    )
}
pub(crate) fn db_error(e: sqlx::Error) -> ApiError {
    let code = e.as_database_error().and_then(|v| v.code());
    if matches!(code.as_deref(), Some("55P03" | "57014" | "25P04" | "40P01")) {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "RETRYABLE_BUSY",
            "処理が混み合っています。同じ操作を再試行してください。",
        );
    }
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        "処理を完了できませんでした。",
    )
}
pub(crate) async fn begin(app: &App, u: &Identity) -> Result<Tx, ApiError> {
    let mut tx = app.runtime.begin().await.map_err(db_error)?;
    sqlx::query("SELECT set_config('app.user_id',$1,true),set_config('app.org_id',$2,true),set_config('lock_timeout','3s',true),set_config('statement_timeout','5s',true),set_config('transaction_timeout','10s',true)")
        .bind(u.user_id.to_string()).bind(u.organization_id.to_string()).execute(&mut *tx).await.map_err(db_error)?;
    Ok(tx)
}
/// Length-delimited domain and components, SHA-256 first signed 64 bits, big endian.
pub(crate) fn lock_key(domain: &str, parts: &[String]) -> i64 {
    let mut hash = Sha256::new();
    for part in std::iter::once(domain).chain(parts.iter().map(String::as_str)) {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    i64::from_be_bytes(hash.finalize()[..8].try_into().expect("8 bytes"))
}
pub(crate) async fn lock(tx: &mut PgConnection, key: i64) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(key)
        .execute(tx)
        .await
        .map_err(db_error)?;
    Ok(())
}
async fn job_lock(tx: &mut PgConnection, id: Uuid) -> Result<(), ApiError> {
    lock(tx, lock_key("job", &[id.to_string()])).await
}
pub(crate) fn text(v: &Value, key: &str, max: usize) -> Result<String, ApiError> {
    let s = v.get(key).and_then(Value::as_str).ok_or_else(invalid)?;
    if s.trim().is_empty() || s.chars().count() > max || s.contains('\0') {
        return Err(invalid());
    }
    Ok(s.to_owned())
}
pub(crate) fn fields(v: &Value, allowed: &[&str], required: &[&str]) -> Result<(), ApiError> {
    let object = v.as_object().ok_or_else(invalid)?;
    if object.keys().any(|k| !allowed.contains(&k.as_str()))
        || required.iter().any(|k| !object.contains_key(*k))
    {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn version(v: &Value) -> Result<i32, ApiError> {
    v.get("version")
        .and_then(Value::as_i64)
        .and_then(|v| i32::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or_else(invalid)
}
fn employment(s: &str) -> Result<(), ApiError> {
    if !["full_time", "contract", "part_time"].contains(&s) {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn dto<T: Serialize>(v: T) -> Result<Value, ApiError> {
    serde_json::to_value(v).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "処理を完了できませんでした。",
        )
    })
}
#[derive(Serialize, FromRow)]
struct Job {
    id: Uuid,
    employer_org_id: Uuid,
    employer_name: String,
    title: String,
    description: String,
    location: String,
    employment_type: String,
    status: String,
    version: i32,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    favorited: bool,
}
#[derive(Serialize, FromRow)]
struct Candidate {
    id: Uuid,
    agency_org_id: Uuid,
    name: String,
    summary: String,
    archived_at: Option<DateTime<Utc>>,
    version: i32,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
async fn read(tx: &mut PgConnection, jobs: bool, id: Uuid) -> Result<Value, ApiError> {
    if jobs {
        dto(
            sqlx::query_as::<_, Job>("SELECT j.id,j.employer_org_id,j.employer_name,j.title,j.description,j.location,j.employment_type,j.status,j.version,j.created_at,j.updated_at,EXISTS(SELECT 1 FROM job_favorites f WHERE f.job_id=j.id) AS favorited FROM jobs j WHERE j.id=$1")
                .bind(id)
                .fetch_optional(tx)
                .await
                .map_err(db_error)?
                .ok_or_else(missing)?,
        )
    } else {
        let mut v = dto(
            sqlx::query_as::<_, Candidate>("SELECT * FROM candidates WHERE id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_error)?
                .ok_or_else(missing)?,
        )?;
        v["documents"] = crate::documents::list(tx, id).await?;
        Ok(v)
    }
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Search {
    q: Option<String>,
    location: Option<String>,
    employment_type: Option<String>,
    favorited: Option<bool>,
    archived: Option<bool>,
    cursor: Option<String>,
    limit: Option<i64>,
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    at: DateTime<Utc>,
    id: Uuid,
    filter: String,
}
fn like(s: &str) -> String {
    format!(
        "%{}%",
        s.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}
async fn list(
    tx: &mut PgConnection,
    jobs: bool,
    u: &Identity,
    s: Search,
) -> Result<Value, ApiError> {
    let limit = s.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(invalid());
    }
    for v in [&s.q, &s.location].into_iter().flatten() {
        if v.is_empty() || v.chars().count() > 100 || v.contains('\0') {
            return Err(invalid());
        }
    }
    if let Some(t) = &s.employment_type {
        employment(t)?;
    }
    if jobs && s.archived.is_some()
        || !jobs && (s.location.is_some() || s.employment_type.is_some() || s.favorited.is_some())
        || u.organization_kind == "employer" && s.favorited.is_some()
    {
        return Err(invalid());
    }
    let filter = B64.encode(Sha256::digest(
        serde_json::to_vec(&json!([
            jobs,
            u.organization_id,
            s.q,
            s.location,
            s.employment_type,
            s.favorited,
            s.archived,
            limit
        ]))
        .map_err(|_| invalid())?,
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
    let at = cursor.as_ref().map(|c| c.at);
    let id = cursor.map(|c| c.id);
    let mut items: Vec<Value> = if jobs {
        sqlx::query_as::<_,Job>("SELECT j.id,j.employer_org_id,j.employer_name,j.title,j.description,j.location,j.employment_type,j.status,j.version,j.created_at,j.updated_at,EXISTS(SELECT 1 FROM job_favorites f WHERE f.job_id=j.id) AS favorited FROM jobs j WHERE ($1::text IS NULL OR j.title ILIKE $1 OR j.description ILIKE $1) AND ($2::text IS NULL OR j.location ILIKE $2) AND ($3::text IS NULL OR j.employment_type=$3) AND ($4::bool IS NULL OR EXISTS(SELECT 1 FROM job_favorites f WHERE f.job_id=j.id)=$4) AND ($5::timestamptz IS NULL OR (j.created_at,j.id)<($5,$6::uuid)) ORDER BY j.created_at DESC,j.id DESC LIMIT $7")
            .bind(s.q.as_deref().map(like)).bind(s.location.as_deref().map(like)).bind(s.employment_type).bind(s.favorited).bind(at).bind(id).bind(limit+1).fetch_all(tx).await.map_err(db_error)?.into_iter().map(dto).collect::<Result<_,_>>()?
    } else {
        sqlx::query_as::<_,Candidate>("SELECT * FROM candidates WHERE ($1::text IS NULL OR name ILIKE $1 OR summary ILIKE $1) AND (archived_at IS NOT NULL)=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5")
            .bind(s.q.as_deref().map(like)).bind(s.archived.unwrap_or(false)).bind(at).bind(id).bind(limit+1).fetch_all(tx).await.map_err(db_error)?.into_iter().map(dto).collect::<Result<_,_>>()?
    };
    let next = if items.len() > limit as usize {
        items.truncate(limit as usize);
        let last = items.last().ok_or_else(invalid)?;
        Some(
            B64.encode(
                serde_json::to_vec(&Cursor {
                    at: serde_json::from_value(last["created_at"].clone())
                        .map_err(|_| invalid())?,
                    id: serde_json::from_value(last["id"].clone()).map_err(|_| invalid())?,
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
#[derive(FromRow)]
struct Replay {
    request_hash: Vec<u8>,
    resource_id: Uuid,
    result_status: Option<i32>,
    state: String,
    valid: bool,
}
async fn audit(
    tx: &mut PgConnection,
    u: &Identity,
    action: &str,
    jobs: bool,
    id: Uuid,
    request_id: Uuid,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO audit_events(id,actor_user_id,actor_org_id,action,resource_type,resource_id,result,request_id) VALUES($1,$2,$3,$4,$5,$6,'success',$7)").bind(Uuid::new_v4()).bind(u.user_id).bind(u.organization_id).bind(action).bind(if jobs{"job"}else{"candidate"}).bind(id).bind(request_id).execute(tx).await.map_err(db_error)?;
    Ok(())
}
pub async fn handle(State(app): State<Arc<App>>, request: Request) -> Result<Response, ApiError> {
    let request_id = Uuid::new_v4();
    let write = request.method() != Method::GET;
    let mut response = execute(app, request, request_id).await?;
    response.headers_mut().insert(
        "x-request-id",
        axum::http::HeaderValue::from_str(&request_id.to_string()).expect("UUID header"),
    );
    if write {
        tracing::info!(event="business_committed",request_id=%request_id,status=response.status().as_u16());
    }
    Ok(response)
}
async fn execute(app: Arc<App>, request: Request, request_id: Uuid) -> Result<Response, ApiError> {
    let method = request.method().clone();
    let draft_headers = request.headers().clone();
    let write = method != Method::GET;
    let u = auth::authorize(&app, request.headers(), write).await?;
    let path = request.uri().path().to_owned();
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    let jobs = parts[2] == "jobs";
    let id = parts
        .get(3)
        .map(|v| Uuid::parse_str(v).map_err(|_| invalid()))
        .transpose()?;
    let action = parts.get(4).copied().unwrap_or("");
    let allowed = if jobs {
        if action == "favorite" {
            u.organization_kind == "agency"
        } else {
            !write || u.organization_kind == "employer"
        }
    } else {
        u.organization_kind == "agency"
    };
    if !allowed {
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
    let idem = if method == Method::POST {
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
    let mut body = if write && action != "favorite" {
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
        let bytes = to_bytes(request.into_body(), 65536).await.map_err(|_| {
            error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "BODY_TOO_LARGE",
                "入力が大きすぎます。",
            )
        })?;
        serde_json::from_slice::<Value>(&bytes).map_err(|_| {
            error(
                StatusCode::BAD_REQUEST,
                "INVALID_JSON",
                "JSON形式を確認してください。",
            )
        })?
    } else {
        json!({})
    };
    if !body.is_object() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "INVALID_JSON",
            "JSONオブジェクトで入力してください。",
        ));
    }
    let operation = crate::drafts::take(&mut body, &draft_headers, &method)?;
    // Validate the canonical shape before any idempotency or resource queries.
    if write && action != "favorite" {
        if id.is_none() {
            if jobs {
                fields(
                    &body,
                    &["title", "description", "location", "employment_type"],
                    &["title", "description", "location", "employment_type"],
                )?;
                text(&body, "title", 200)?;
                text(&body, "description", 10000)?;
                text(&body, "location", 200)?;
                employment(&text(&body, "employment_type", 20)?)?;
            } else {
                fields(
                    &body,
                    &["name", "summary", "fictional_confirmed"],
                    &["name", "summary", "fictional_confirmed"],
                )?;
                text(&body, "name", 100)?;
                text(&body, "summary", 10000)?;
                if body["fictional_confirmed"] != true {
                    return Err(invalid());
                }
            }
        } else if action == "status" {
            fields(&body, &["version", "status"], &["version", "status"])?;
            version(&body)?;
            if !["published", "closed"].contains(&text(&body, "status", 20)?.as_str()) {
                return Err(invalid());
            }
        } else if action == "archive" {
            fields(&body, &["version"], &["version"])?;
            version(&body)?;
        } else {
            let limits = if jobs {
                vec![
                    ("title", 200),
                    ("description", 10000),
                    ("location", 200),
                    ("employment_type", 20),
                ]
            } else {
                vec![("name", 100), ("summary", 10000)]
            };
            let mut allowed = vec!["version"];
            allowed.extend(limits.iter().map(|v| v.0));
            fields(&body, &allowed, &["version"])?;
            version(&body)?;
            if body.as_object().is_none_or(|v| v.len() < 2) {
                return Err(invalid());
            }
            for (key, max) in limits {
                if body.get(key).is_some() {
                    let value = text(&body, key, max)?;
                    if key == "employment_type" {
                        employment(&value)?;
                    }
                }
            }
        }
    }
    let mut tx = begin(&app, &u).await?;
    if !write {
        let value = if let Some(id) = id {
            read(&mut tx, jobs, id).await?
        } else {
            list(&mut tx, jobs, &u, search.unwrap_or_default()).await?
        };
        tx.commit().await.map_err(db_error)?;
        return Ok(Json(value).into_response());
    }
    // Relationship check precedes idempotency. Hidden IDs never become replay probes.
    if let Some(id) = id
        && (action != "favorite" || method != Method::DELETE)
    {
        read(&mut tx, jobs, id).await?;
    }
    let normalized = if let Some(id) = id {
        format!(
            "/api/v1/{}/{}{}",
            if jobs { "jobs" } else { "candidates" },
            id,
            if action.is_empty() {
                String::new()
            } else {
                format!("/{action}")
            }
        )
    } else {
        path.clone()
    };
    let request_hash = Sha256::digest(serde_json::to_vec(&body).map_err(|_| invalid())?).to_vec();
    if let Some((resource, status)) =
        crate::drafts::replay(&mut tx, &u, operation.as_ref(), &method, &normalized, &body).await?
    {
        let value = read(&mut tx, jobs, resource).await?;
        tx.commit().await.map_err(db_error)?;
        return Ok((status, Json(value)).into_response());
    }
    let resource = id.unwrap_or_else(Uuid::new_v4);
    if let Some(key) = idem {
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
        let existing=sqlx::query_as::<_,Replay>("SELECT request_hash,resource_id,result_status,state,coalesce(expires_at>now(),false) AS valid FROM idempotency_records WHERE org_id=$1 AND user_id=$2 AND http_method=$3 AND normalized_path=$4 AND key=$5").bind(u.organization_id).bind(u.user_id).bind(method.as_str()).bind(&normalized).bind(key).fetch_optional(&mut *tx).await.map_err(db_error)?;
        if operation.is_some() && existing.is_some() {
            return Err(conflict("IDEMPOTENCY_MISMATCH"));
        }
        if existing
            .as_ref()
            .is_some_and(|previous| previous.state == "processing")
        {
            return Err(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "RETRYABLE_BUSY",
                "同じ操作をしばらくしてから再試行してください。",
            ));
        }
        if let Some(previous) = existing
            && previous.valid
        {
            if previous.request_hash != request_hash {
                return Err(conflict("IDEMPOTENCY_MISMATCH"));
            }
            if previous.state != "completed" {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "RETRYABLE_BUSY",
                    "同じ操作をしばらくしてから再試行してください。",
                ));
            }
            let value = read(&mut tx, jobs, previous.resource_id).await?;
            let status = StatusCode::from_u16(previous.result_status.unwrap_or(200) as u16)
                .map_err(|_| invalid())?;
            tx.commit().await.map_err(db_error)?;
            return Ok((status, Json(value)).into_response());
        }
        sqlx::query("INSERT INTO idempotency_records(org_id,user_id,http_method,normalized_path,key,request_hash,resource_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,'processing') ON CONFLICT(org_id,user_id,http_method,normalized_path,key) DO UPDATE SET request_hash=excluded.request_hash,resource_id=excluded.resource_id,state='processing',result_status=NULL,error_code=NULL,expires_at=NULL WHERE idempotency_records.expires_at<=now()")
            .bind(u.organization_id).bind(u.user_id).bind(method.as_str()).bind(&normalized).bind(key).bind(&request_hash).bind(resource).execute(&mut *tx).await.map_err(db_error)?;
    }
    if action == "favorite" {
        if method == Method::PUT {
            job_lock(&mut tx, resource).await?;
            read(&mut tx, true, resource).await?;
            sqlx::query("INSERT INTO job_favorites(agency_org_id,job_id,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(u.organization_id).bind(resource).bind(u.user_id).execute(&mut *tx).await.map_err(db_error)?;
        } else {
            sqlx::query("DELETE FROM job_favorites WHERE agency_org_id=$1 AND job_id=$2")
                .bind(u.organization_id)
                .bind(resource)
                .execute(&mut *tx)
                .await
                .map_err(db_error)?;
        }
        audit(
            &mut tx,
            &u,
            if method == Method::PUT {
                "favorite.save"
            } else {
                "favorite.remove"
            },
            true,
            resource,
            request_id,
        )
        .await?;
        tx.commit().await.map_err(db_error)?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let status = if id.is_none() {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    if id.is_none() {
        if jobs {
            sqlx::query("INSERT INTO jobs(id,employer_org_id,employer_name,title,description,location,employment_type) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(resource).bind(u.organization_id).bind(&u.organization_name).bind(text(&body,"title",200)?).bind(text(&body,"description",10000)?).bind(text(&body,"location",200)?).bind(text(&body,"employment_type",20)?).execute(&mut *tx).await.map_err(db_error)?;
        } else {
            sqlx::query(
                "INSERT INTO candidates(id,agency_org_id,name,summary) VALUES($1,$2,$3,$4)",
            )
            .bind(resource)
            .bind(u.organization_id)
            .bind(text(&body, "name", 100)?)
            .bind(text(&body, "summary", 10000)?)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        }
    } else {
        if jobs {
            job_lock(&mut tx, resource).await?;
        } else {
            sqlx::query("SELECT id FROM candidates WHERE id=$1 FOR UPDATE")
                .bind(resource)
                .fetch_optional(&mut *tx)
                .await
                .map_err(db_error)?
                .ok_or_else(missing)?;
        }
        let current = read(&mut tx, jobs, resource).await?;
        if current["version"].as_i64() != Some(version(&body)? as i64) {
            return Err(conflict("VERSION_CONFLICT"));
        }
        if jobs && current["status"] == "closed" {
            return Err(conflict("JOB_CLOSED"));
        }
        if !jobs && !current["archived_at"].is_null() {
            return Err(conflict("CANDIDATE_ARCHIVED"));
        }
        if action == "status" {
            let next = text(&body, "status", 20)?;
            if !((current["status"] == "draft" && next == "published")
                || (current["status"] == "published" && next == "closed"))
            {
                return Err(conflict("INVALID_TRANSITION"));
            }
            sqlx::query("UPDATE jobs SET status=$2,version=version+1,updated_at=now() WHERE id=$1 AND version=$3").bind(resource).bind(next).bind(version(&body)?).execute(&mut *tx).await.map_err(db_error)?;
        } else if action == "archive" {
            sqlx::query("UPDATE candidates SET archived_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND version=$2").bind(resource).bind(version(&body)?).execute(&mut *tx).await.map_err(db_error)?;
        } else if jobs {
            let value = |k: &str| {
                body.get(k)
                    .unwrap_or(&current[k])
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(invalid)
            };
            sqlx::query("UPDATE jobs SET title=$2,description=$3,location=$4,employment_type=$5,version=version+1,updated_at=now() WHERE id=$1 AND version=$6").bind(resource).bind(value("title")?).bind(value("description")?).bind(value("location")?).bind(value("employment_type")?).bind(version(&body)?).execute(&mut *tx).await.map_err(db_error)?;
        } else {
            sqlx::query("UPDATE candidates SET name=$2,summary=$3,version=version+1,updated_at=now() WHERE id=$1 AND version=$4").bind(resource).bind(body.get("name").unwrap_or(&current["name"]).as_str().ok_or_else(invalid)?).bind(body.get("summary").unwrap_or(&current["summary"]).as_str().ok_or_else(invalid)?).bind(version(&body)?).execute(&mut *tx).await.map_err(db_error)?;
        }
    }
    audit(
        &mut tx,
        &u,
        if id.is_none() {
            "create"
        } else if action.is_empty() {
            "update"
        } else {
            action
        },
        jobs,
        resource,
        request_id,
    )
    .await?;
    if let Some(key) = idem {
        sqlx::query("UPDATE idempotency_records SET state='completed',result_status=$6,expires_at=now()+interval '24 hours' WHERE org_id=$1 AND user_id=$2 AND http_method=$3 AND normalized_path=$4 AND key=$5").bind(u.organization_id).bind(u.user_id).bind(method.as_str()).bind(&normalized).bind(key).bind(status.as_u16() as i32).execute(&mut *tx).await.map_err(db_error)?;
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
    let value = read(&mut tx, jobs, resource).await?;
    tx.commit().await.map_err(db_error)?;
    Ok((status, Json(value)).into_response())
}
