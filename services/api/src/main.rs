mod auth;

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
    let http = openidconnect::reqwest::Client::builder()
        .redirect(openidconnect::reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .build()?;
    let oidc = auth::discover(&config, &http).await?;
    let app = Arc::new(App {
        config,
        db,
        http,
        oidc,
    });
    let router = Router::new()
        .route("/live", get(|| async { StatusCode::OK }))
        .route("/ready", get(ready))
        .route("/auth/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .route("/auth/logout", post(auth::logout))
        .route("/api/v1/me", get(auth::me))
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
    let pdf = app.http.get("http://pdf-renderer:8080/live").send().await;
    if matches!(db, Ok(true))
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
    let mut response = next.run(request).await;
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
