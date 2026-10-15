use aes_gcm::{
    Aes256Gcm, Nonce as AesNonce,
    aead::{Aead, KeyInit, Payload},
};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use openidconnect::{
    AccessTokenHash, AuthorizationCode, ClientId, CsrfToken, EndpointMaybeSet, EndpointNotSet,
    EndpointSet, IssuerUrl, Nonce, OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier,
    RedirectUrl, TokenResponse,
    core::{
        CoreAuthPrompt, CoreAuthenticationFlow, CoreClient, CoreJwsSigningAlgorithm,
        CoreProviderMetadata,
    },
    reqwest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::{env, sync::Arc};
use uuid::Uuid;

type Oidc = CoreClient<
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointMaybeSet,
    EndpointMaybeSet,
>;
type HmacSha256 = Hmac<Sha256>;
const SESSION: &str = "rp_session";
const ATTEMPT: &str = "rp_attempt";

pub struct Config {
    pub origin: String,
    pub issuer: String,
    pub client_id: String,
    pub redirect: String,
    key: [u8; 32],
    csrf: [u8; 32],
    secure: bool,
}
impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let origin = env::var("APP_ORIGIN")?;
        let issuer = env::var("OIDC_ISSUER")?;
        // This distribution is a loopback-only development prototype.
        let app_url = reqwest::Url::parse(&origin)?;
        let idp_url = reqwest::Url::parse(&issuer)?;
        let app_port = app_url
            .port()
            .ok_or_else(|| anyhow::anyhow!("explicit loopback port required"))?;
        let idp_port = idp_url
            .port()
            .ok_or_else(|| anyhow::anyhow!("explicit loopback port required"))?;
        anyhow::ensure!(
            app_port >= 1024
                && idp_port >= 1024
                && app_port != idp_port
                && origin == format!("http://localhost:{app_port}")
                && issuer
                    == format!("http://idp.recruitment.localhost:{idp_port}/realms/recruitment"),
            "unsupported deployment origin"
        );
        let key = B64
            .decode(env::var("ATTEMPT_KEY")?)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("key length"))?;
        let csrf = B64
            .decode(env::var("CSRF_KEY")?)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("key length"))?;
        Ok(Self {
            redirect: format!("{origin}/auth/callback"),
            origin,
            issuer,
            client_id: "recruitment-local".into(),
            key,
            csrf,
            secure: false,
        })
    }
}
pub struct App {
    pub config: Config,
    pub db: PgPool,
    pub runtime: PgPool,
    pub http: reqwest::Client,
    pub oidc: Oidc,
    pub pdf_key: String,
    pub scan_key: String,
    pub uploads: std::sync::Arc<tokio::sync::Semaphore>,
}
pub async fn discover(config: &Config, http: &reqwest::Client) -> anyhow::Result<Oidc> {
    let metadata =
        CoreProviderMetadata::discover_async(IssuerUrl::new(config.issuer.clone())?, http).await?;
    anyhow::ensure!(
        metadata
            .authorization_endpoint()
            .as_str()
            .starts_with(&format!("{}/", config.issuer)),
        "authorization endpoint"
    );
    anyhow::ensure!(
        metadata
            .token_endpoint()
            .is_some_and(|u| u.as_str().starts_with(&format!("{}/", config.issuer))),
        "token endpoint"
    );
    Ok(
        CoreClient::from_provider_metadata(metadata, ClientId::new(config.client_id.clone()), None)
            .set_redirect_uri(RedirectUrl::new(config.redirect.clone())?),
    )
}

pub struct ApiError {
    status: StatusCode,
    pub(crate) code: &'static str,
    message: &'static str,
    document_id: Option<Uuid>,
    request_id: Option<Uuid>,
}
impl ApiError {
    pub(crate) fn request(mut self, id: Uuid) -> Self {
        self.request_id = Some(id);
        self
    }
    pub(crate) fn document(mut self, id: Uuid) -> Self {
        self.document_id = Some(id);
        self
    }
    pub fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
            document_id: None,
            request_id: None,
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let id = self.request_id.unwrap_or_else(Uuid::new_v4).to_string();
        tracing::warn!(event="request_rejected",code=self.code,status=self.status.as_u16(),request_id=%id);
        let mut body =
            serde_json::json!({"error":{"code":self.code,"message":self.message,"request_id":id}});
        if let Some(id) = self.document_id {
            body["error"]["document_id"] = serde_json::json!(id);
            body["error"]["status_url"] = serde_json::json!(format!("/api/v1/documents/{id}"));
        }
        if self.code == "INVALID_INPUT" {
            body["error"]["field_errors"] =
                serde_json::json!({"_form":"必須項目・許可項目・文字数を確認してください。"});
        }
        let mut r = (self.status, Json(body)).into_response();
        if self.code == "DOCUMENT_RATE_LIMITED" {
            r.headers_mut()
                .insert("retry-after", HeaderValue::from_static("60"));
        }
        r.headers_mut()
            .insert("x-request-id", HeaderValue::from_str(&id).unwrap());
        r
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(_: sqlx::Error) -> Self {
        unavailable()
    }
}
fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "SERVICE_UNAVAILABLE",
        "しばらくしてから再試行してください。",
    )
}
fn invalid() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "AUTH_ATTEMPT_INVALID",
        "ログインを最初からやり直してください。",
    )
}
fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "AUTH_REQUIRED",
        "ログインしてください。",
    )
}
fn membership() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "MEMBERSHIP_REJECTED",
        "利用できるアカウントが登録されていません。",
    )
}
fn random() -> String {
    B64.encode(rand::random::<[u8; 32]>())
}
fn hash(s: &str) -> Vec<u8> {
    Sha256::digest(s.as_bytes()).to_vec()
}
fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<_> = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|s| s.split(';'))
        .filter_map(|s| s.trim().split_once('='))
        .filter(|(k, _)| *k == name)
        .map(|(_, v)| v)
        .collect();
    if values.len() != 1 {
        return None;
    }
    let v = values[0];
    if v.len() != 43
        || !v
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return None;
    }
    Some(v.to_owned())
}
fn set_cookie(r: &mut Response, name: &str, value: &str, path: &str, seconds: u32, secure: bool) {
    let suffix = if secure { "; Secure" } else { "" };
    let v =
        format!("{name}={value}; HttpOnly; SameSite=Lax; Path={path}; Max-Age={seconds}{suffix}");
    r.headers_mut()
        .append(header::SET_COOKIE, HeaderValue::from_str(&v).unwrap());
}
fn encrypt(config: &Config, plain: &str, aad: &str) -> Result<Vec<u8>, ApiError> {
    let cipher = Aes256Gcm::new_from_slice(&config.key).map_err(|_| unavailable())?;
    let nonce = rand::random::<[u8; 12]>();
    let mut out = nonce.to_vec();
    out.extend(
        cipher
            .encrypt(
                &AesNonce::from(nonce),
                Payload {
                    msg: plain.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| unavailable())?,
    );
    Ok(out)
}
fn decrypt(config: &Config, bytes: &[u8], aad: &str) -> Result<String, ApiError> {
    if bytes.len() < 28 {
        return Err(invalid());
    }
    let cipher = Aes256Gcm::new_from_slice(&config.key).map_err(|_| unavailable())?;
    String::from_utf8(
        cipher
            .decrypt(
                &AesNonce::try_from(&bytes[..12]).map_err(|_| invalid())?,
                Payload {
                    msg: &bytes[12..],
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())
}
fn csrf(config: &Config, session: &str) -> String {
    let mut mac =
        <HmacSha256 as hmac::KeyInit>::new_from_slice(&config.csrf).expect("fixed length key");
    mac.update(session.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}

pub async fn login(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Response, ApiError> {
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, state, nonce) = app
        .oidc
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .set_pkce_challenge(challenge)
        .add_prompt(CoreAuthPrompt::Login)
        .url();
    let binding = random();
    let aad = format!("{}:{binding}", state.secret());
    let encrypted = encrypt(&app.config, verifier.secret(), &aad)?;
    // Expired technical attempts only. No business records are removed.
    sqlx::query("DELETE FROM auth_attempts WHERE expires_at <= now()")
        .execute(&app.db)
        .await?;
    if let Some(old) = cookie(&headers, ATTEMPT) {
        sqlx::query("DELETE FROM auth_attempts WHERE browser_binding_hash=$1")
            .bind(hash(&old))
            .execute(&app.db)
            .await?;
    }
    sqlx::query("INSERT INTO auth_attempts(state_hash,browser_binding_hash,nonce,encrypted_pkce_verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')")
        .bind(hash(state.secret())).bind(hash(&binding)).bind(nonce.secret()).bind(encrypted).execute(&app.db).await?;
    let mut r = Redirect::to(url.as_str()).into_response();
    set_cookie(&mut r, ATTEMPT, &binding, "/auth", 300, app.config.secure);
    Ok(r)
}
#[derive(Deserialize)]
pub struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}
#[derive(FromRow)]
struct Attempt {
    nonce: String,
    encrypted_pkce_verifier: Vec<u8>,
}
#[derive(FromRow)]
struct User {
    id: Uuid,
    organization_id: Uuid,
}
pub async fn callback(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    query: Result<Query<Callback>, axum::extract::rejection::QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(q) = query.map_err(|_| invalid())?;
    let state = q.state.filter(|s| s.len() <= 512).ok_or_else(invalid)?;
    let binding = cookie(&headers, ATTEMPT).ok_or_else(invalid)?;
    let attempt=sqlx::query_as::<_,Attempt>("DELETE FROM auth_attempts WHERE state_hash=$1 AND browser_binding_hash=$2 AND expires_at>now() RETURNING nonce,encrypted_pkce_verifier")
        .bind(hash(&state)).bind(hash(&binding)).fetch_optional(&app.db).await?.ok_or_else(invalid)?;
    if q.error.is_some() {
        return Err(invalid());
    }
    let code = q
        .code
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(invalid)?;
    let verifier = decrypt(
        &app.config,
        &attempt.encrypted_pkce_verifier,
        &format!("{state}:{binding}"),
    )?;
    // Refresh discovery/JWKS per callback; local key rotation needs no restart.
    let oidc = discover(&app.config, &app.http)
        .await
        .map_err(|_| unavailable())?;
    let tokens = oidc
        .exchange_code(AuthorizationCode::new(code))
        .map_err(|_| unavailable())?
        .set_pkce_verifier(PkceCodeVerifier::new(verifier))
        .request_async(&app.http)
        .await
        .map_err(|_| invalid())?;
    let token = tokens.id_token().ok_or_else(invalid)?;
    let validator = oidc
        .id_token_verifier()
        .set_allowed_algs([CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256])
        .set_issue_time_verifier_fn(|t| {
            if t > Utc::now() + chrono::Duration::seconds(60) {
                Err("future issue time".into())
            } else {
                Ok(())
            }
        });
    let claims = token
        .claims(&validator, &Nonce::new(attempt.nonce))
        .map_err(|_| invalid())?;
    if let Some(expected) = claims.access_token_hash() {
        let actual = AccessTokenHash::from_token(
            tokens.access_token(),
            token.signing_alg().map_err(|_| invalid())?,
            token.signing_key(&validator).map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())?;
        if &actual != expected {
            return Err(invalid());
        }
    }
    let user=sqlx::query_as::<_,User>("SELECT u.id,u.organization_id FROM users u JOIN organizations o ON o.id=u.organization_id WHERE u.oidc_issuer=$1 AND u.oidc_subject=$2 AND u.active AND o.active")
        .bind(&app.config.issuer).bind(claims.subject().as_str()).fetch_optional(&app.db).await?.ok_or_else(membership)?;
    let session = random();
    let mut tx = app.db.begin().await?;
    if let Some(old) = cookie(&headers, SESSION) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(hash(&old))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')").bind(hash(&session)).bind(user.id).execute(&mut *tx).await?;
    tx.commit().await?;
    let request_id = Uuid::new_v4().to_string();
    tracing::info!(event="login_succeeded",user_id=%user.id,organization_id=%user.organization_id,request_id=%request_id);
    let mut r = Redirect::to("/").into_response();
    r.headers_mut()
        .insert("x-request-id", HeaderValue::from_str(&request_id).unwrap());
    set_cookie(&mut r, SESSION, &session, "/", 28800, app.config.secure);
    set_cookie(&mut r, ATTEMPT, "", "/auth", 0, app.config.secure);
    Ok(r)
}
#[derive(Serialize, FromRow)]
pub struct Identity {
    pub user_id: Uuid,
    display_name: String,
    pub organization_id: Uuid,
    pub organization_name: String,
    pub organization_kind: String,
    expires_at: DateTime<Utc>,
}
async fn identity(app: &App, session: &str) -> Result<Identity, ApiError> {
    sqlx::query_as::<_,Identity>("SELECT u.id AS user_id,u.display_name,o.id AS organization_id,o.name AS organization_name,o.kind AS organization_kind,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=u.organization_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND o.active")
        .bind(hash(session)).fetch_optional(&app.db).await?.ok_or_else(unauthorized)
}
pub async fn me(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Response, ApiError> {
    let session = cookie(&headers, SESSION).ok_or_else(unauthorized)?;
    let u = identity(&app, &session).await?;
    Ok(Json(serde_json::json!({"user":{"id":u.user_id,"display_name":u.display_name},"organization":{"id":u.organization_id,"name":u.organization_name,"kind":u.organization_kind},"expires_at":u.expires_at,"csrf_token":csrf(&app.config,&session)})).into_response())
}
pub async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> Result<Response, ApiError> {
    let session = cookie(&headers, SESSION).ok_or_else(unauthorized)?;
    if headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()) != Some(app.config.origin.as_str())
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "CSRF_REJECTED",
            "操作をやり直してください。",
        ));
    }
    let supplied = headers
        .get("x-csrf-token")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| B64.decode(s).ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::FORBIDDEN,
                "CSRF_REJECTED",
                "操作をやり直してください。",
            )
        })?;
    let mut mac = <HmacSha256 as hmac::KeyInit>::new_from_slice(&app.config.csrf)
        .map_err(|_| unavailable())?;
    mac.update(session.as_bytes());
    mac.verify_slice(&supplied).map_err(|_| {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "CSRF_REJECTED",
            "操作をやり直してください。",
        )
    })?;
    let user=sqlx::query_as::<_,User>("DELETE FROM sessions s USING users u WHERE s.token_hash=$1 AND u.id=s.user_id RETURNING u.id,u.organization_id")
        .bind(hash(&session)).fetch_optional(&app.db).await?;
    let request_id = Uuid::new_v4().to_string();
    if let Some(user) = user {
        tracing::info!(event="logout_succeeded",user_id=%user.id,organization_id=%user.organization_id,request_id=%request_id);
    }
    let mut r = StatusCode::NO_CONTENT.into_response();
    r.headers_mut()
        .insert("x-request-id", HeaderValue::from_str(&request_id).unwrap());
    set_cookie(&mut r, SESSION, "", "/", 0, app.config.secure);
    set_cookie(&mut r, ATTEMPT, "", "/auth", 0, app.config.secure);
    Ok(r)
}

/// Reuse session validation and the exact Origin/HMAC check for every business mutation.
pub async fn authorize(app: &App, headers: &HeaderMap, write: bool) -> Result<Identity, ApiError> {
    let session = cookie(headers, SESSION).ok_or_else(unauthorized)?;
    let identity = identity(app, &session).await?;
    if write {
        let denied = || {
            ApiError::new(
                StatusCode::FORBIDDEN,
                "CSRF_REJECTED",
                "操作をやり直してください。",
            )
        };
        if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
            != Some(app.config.origin.as_str())
        {
            return Err(denied());
        }
        let supplied = headers
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| B64.decode(v).ok())
            .ok_or_else(denied)?;
        let mut mac = <HmacSha256 as hmac::KeyInit>::new_from_slice(&app.config.csrf)
            .map_err(|_| unavailable())?;
        mac.update(session.as_bytes());
        mac.verify_slice(&supplied).map_err(|_| denied())?;
    }
    Ok(identity)
}
