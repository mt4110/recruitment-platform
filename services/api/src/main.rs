mod auth;
mod business;
mod documents;

use auth::{ApiError, App, Config};
use axum::{
    Router,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use sqlx::{
    ConnectOptions,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
};
use std::{path::Path, sync::Arc};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().json().with_target(false).init();
    if start().await.is_err() {
        tracing::error!(event = "startup_failed");
        std::process::exit(1);
    }
}
async fn start() -> anyhow::Result<()> {
    let config = Config::load()?;
    let options = PgConnectOptions::new()
        .host("db")
        .database("recruitment")
        .username("app_auth")
        .password(&std::env::var("AUTH_DB_PASSWORD")?)
        .ssl_mode(PgSslMode::Disable)
        .disable_statement_logging();
    let db = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect_with(options)
        .await?;
    let runtime = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect_with(
            PgConnectOptions::new()
                .host("db")
                .database("recruitment")
                .username("app_runtime")
                .password(&std::env::var("RUNTIME_DB_PASSWORD")?)
                .ssl_mode(PgSslMode::Disable)
                .disable_statement_logging(),
        )
        .await?;
    let http = openidconnect::reqwest::Client::builder()
        .redirect(openidconnect::reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .build()?;
    let oidc = auth::discover(&config, &http).await?;
    let app = Arc::new(App {
        config,
        db,
        runtime,
        http,
        oidc,
        pdf_key: std::env::var("PDF_SHARED_KEY")?,
        uploads: Arc::new(tokio::sync::Semaphore::new(2)),
    });
    let router = Router::new()
        .route("/live", get(|| async { StatusCode::OK }))
        .route("/ready", get(ready))
        .route("/auth/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .route("/auth/logout", post(auth::logout))
        .route("/api/v1/me", get(auth::me))
        .merge(business::routes())
        .merge(documents::routes())
        .fallback(|| async {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "NOT_FOUND",
                "ページが見つかりません。",
            )
        })
        .layer(middleware::from_fn(headers))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
async fn ready(State(app): State<Arc<App>>) -> Response {
    let db = sqlx::query_scalar::<_, bool>(
        "SELECT to_regclass('auth_attempts') IS NOT NULL AND to_regclass('sessions') IS NOT NULL",
    )
    .fetch_one(&app.db)
    .await;
    let business = sqlx::query_scalar::<_,bool>("SELECT to_regclass('documents') IS NOT NULL AND to_regclass('jobs') IS NOT NULL AND to_regclass('candidates') IS NOT NULL AND to_regclass('idempotency_records') IS NOT NULL").fetch_one(&app.runtime).await;
    let pdf = app.http.get("http://pdf-renderer:8080/live").send().await;
    if matches!(db, Ok(true))
        && matches!(business, Ok(true))
        && pdf.is_ok_and(|r| r.status().is_success())
        && Path::new("/data/resumes").is_dir()
    {
        StatusCode::OK.into_response()
    } else {
        StatusCode::SERVICE_UNAVAILABLE.into_response()
    }
}
async fn headers(request: axum::extract::Request, next: Next) -> Response {
    // Never log URI queries, headers, request bodies or identity tokens.
    let callback_page = request.uri().path() == "/auth/callback"
        && request
            .headers()
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/html"));
    let mut response = next.run(request).await;
    if callback_page && (response.status().is_client_error() || response.status().is_server_error())
    {
        let message = match response.status() {
            StatusCode::FORBIDDEN => {
                "このアカウントは利用できません。用意されたデモアカウントでログインしてください。"
            }
            StatusCode::SERVICE_UNAVAILABLE => {
                "接続先が応答していません。しばらくしてからもう一度お試しください。"
            }
            _ => "ログイン情報が無効か、有効期限が切れています。最初からやり直してください。",
        };
        let html = format!(
            r#"<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ログインを完了できませんでした</title><style>body{{font-family:system-ui,sans-serif;background:#f5f7f5;color:#172d32;margin:0;line-height:1.8}}main{{max-width:640px;margin:12vh auto;padding:24px}}h1{{font-size:26px}}a{{display:inline-block;margin:16px 16px 0 0;color:#13685e}}a:focus-visible{{outline:3px solid #a16612;outline-offset:4px}}</style><main><p>架空データ専用デモ</p><h1>ログインを完了できませんでした</h1><p role="alert">{message}</p><a href="/auth/login">ログインをやり直す</a><a href="/login">ログイン画面へ戻る</a></main></html>"#
        );
        *response.body_mut() = axum::body::Body::from(html);
        response.headers_mut().remove(header::CONTENT_LENGTH);
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        response.headers_mut().insert("content-security-policy",HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"));
    }
    let h = response.headers_mut();
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    if !h.contains_key("x-request-id") {
        h.insert(
            "x-request-id",
            HeaderValue::from_str(&uuid::Uuid::new_v4().to_string()).unwrap(),
        );
    }
    response
}
