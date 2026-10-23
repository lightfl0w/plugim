mod config;
mod hub;
mod linkpreview;
mod logger;
mod metrics;
mod plugins;
mod scheduler;
mod services;
mod state;
mod store;
mod util;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::config::AppConfig;
use crate::hub::{AuthUser, Hub};
use crate::state::{dispatch, AppState, Conn, Registry, SharedState};

const MAX_FRAME_BYTES: usize = 1_048_576;
const RPC_RATE_LIMIT: u32 = 60;

fn client_ip(addr: Option<&SocketAddr>) -> String {
    addr.map(|value| value.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

async fn rpc_http(
    State(state): State<SharedState>,
    Path(method): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let params = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|value| value.get("params").cloned())
        .unwrap_or_else(|| json!({}));
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.to_string());
    let user = plugins::auth::verify_token(&state, token.as_deref()).await;
    let conn = Conn {
        user,
        user_agent: headers
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string(),
        ip: client_ip(Some(&addr)),
    };
    match dispatch(&state, &method, params, conn).await {
        Ok(result) => axum::Json(json!({ "ok": true, "result": result })).into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "ok": false, "message": message })),
        )
            .into_response(),
    }
}

async fn health(State(state): State<SharedState>) -> Response {
    axum::Json(json!({ "ok": true, "connections": state.hub.connections().await, "runtime": "rust" }))
        .into_response()
}

async fn prometheus(State(state): State<SharedState>) -> Response {
    let metrics = metrics::metrics();
    metrics.set_connections(state.hub.connections().await as u64);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        metrics.prometheus(),
    )
        .into_response()
}

async fn metrics_json(State(state): State<SharedState>) -> Response {
    let metrics = metrics::metrics();
    metrics.set_connections(state.hub.connections().await as u64);
    axum::Json(metrics.snapshot()).into_response()
}

async fn observe_http(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let started = std::time::Instant::now();
    let response = next.run(request).await;
    let status = response.status();
    metrics::metrics().observe_http(
        started.elapsed().as_secs_f64() * 1000.0,
        status.is_success() || status.is_redirection(),
    );
    response
}

async fn version(State(state): State<SharedState>) -> Response {
    axum::Json(json!({
        "name": "plugim",
        "version": env!("CARGO_PKG_VERSION"),
        "runtime": format!("rust {}", env!("CARGO_PKG_VERSION")),
        "port": state.cfg.port,
    }))
    .into_response()
}

async fn site_meta(State(state): State<SharedState>) -> Response {
    let name = store::settings_get(&state.db, "site_name")
        .await
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "plugim".to_string());
    let icon = store::settings_get(&state.db, "site_icon")
        .await
        .ok()
        .flatten()
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    axum::Json(json!({ "name": name, "icon": icon })).into_response()
}

async fn register_policy(State(state): State<SharedState>) -> Response {
    let (require_invite, open) = plugins::auth::register_policy(&state).await;
    axum::Json(json!({ "requireInvite": require_invite, "open": open })).into_response()
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|value| value.to_str().ok()) {
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let origin_host = origin
            .split("://")
            .nth(1)
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("");
        if !host.is_empty() && origin_host != host {
            return (
                StatusCode::FORBIDDEN,
                axum::Json(json!({ "ok": false, "message": "拒绝跨站连接" })),
            )
                .into_response();
        }
    }
    let token = query.get("token").cloned();
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ip = client_ip(Some(&addr));
    ws.max_message_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, token, user_agent, ip))
}

async fn handle_socket(
    socket: WebSocket,
    state: SharedState,
    token: Option<String>,
    user_agent: String,
    ip: String,
) {
    let user = plugins::auth::verify_token(&state, token.as_deref()).await;
    let was_online = match user.as_ref() {
        Some(user) => state.hub.is_online(&user.id).await,
        None => false,
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let conn_id = state.hub.register(tx.clone(), user.clone()).await;
    metrics::metrics().set_connections(state.hub.connections().await as u64);
    tracing::info!("ws conn {conn_id} opened user={:?}", user.as_ref().map(|item| item.username.clone()));
    if let Some(user) = user.as_ref() {
        if let Some(session_id) = user.session_id.as_ref() {
            let session_id = session_id.clone();
            let db = state.db.clone();
            tokio::spawn(async move {
                let _ = store::auth_session_touch(&db, &session_id).await;
            });
        }
        if !was_online {
            plugins::auth::announce_presence(&state, user, true).await;
        }
    }

    let (mut sink, mut stream) = socket.split();
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(30));
    heartbeat.tick().await;
    let mut window: i64 = 0;
    let mut count: u32 = 0;

    loop {
        tokio::select! {
            outbound = rx.recv() => {
                match outbound {
                    Some(frame) => {
                        if frame == "__close__" {
                            tracing::info!("ws conn {conn_id} closing on __close__");
                            let _ = sink.send(Message::Close(None)).await;
                            break;
                        }
                        if sink.send(Message::Text(frame.into())).await.is_err() {
                            tracing::info!("ws conn {conn_id} sink send failed");
                            break;
                        }
                    }
                    None => {
                        tracing::info!("ws conn {conn_id} outbound channel closed");
                        break;
                    }
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let now_sec = util::now_ms() / 1000;
                        if now_sec != window {
                            window = now_sec;
                            count = 0;
                        }
                        if count >= RPC_RATE_LIMIT {
                            tracing::info!("ws conn {conn_id} rate limited");
                            let _ = sink.send(Message::Close(None)).await;
                            break;
                        }
                        count += 1;
                        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        if frame.get("kind").and_then(|value| value.as_str()) != Some("rpc") {
                            continue;
                        }
                        let id = frame
                            .get("id")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string();
                        let method = frame
                            .get("method")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string();
                        let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
                        let conn = Conn {
                            user: user.clone(),
                            user_agent: user_agent.clone(),
                            ip: ip.clone(),
                        };
                        let task_state = state.clone();
                        let reply = tx.clone();
                        tokio::spawn(async move {
                            let started = std::time::Instant::now();
                            let outcome = tokio::time::timeout(
                                std::time::Duration::from_secs(6),
                                dispatch(&task_state, &method, params, conn),
                            )
                            .await;
                            let payload = match outcome {
                                Ok(Ok(result)) => {
                                    json!({ "kind": "rpc:ok", "id": id, "result": result })
                                }
                                Ok(Err(message)) => {
                                    json!({ "kind": "rpc:err", "id": id, "message": message })
                                }
                                Err(_) => {
                                    tracing::error!(
                                        "rpc {method} timed out; pool size {} idle {}",
                                        task_state.db.size(),
                                        task_state.db.num_idle()
                                    );
                                    json!({ "kind": "rpc:err", "id": id, "message": "内部超时" })
                                }
                            };
                            let spent = started.elapsed().as_millis();
                            if spent > 500 {
                                tracing::warn!("slow rpc {method} took {spent}ms");
                            }
                            let _ = reply.send(payload.to_string());
                        });
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = sink.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) => {
                        tracing::info!("ws conn {conn_id} client close frame");
                        break;
                    }
                    None => {
                        tracing::info!("ws conn {conn_id} stream ended");
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        tracing::info!("ws conn {conn_id} stream error: {err}");
                        break;
                    }
                }
            }
            _ = heartbeat.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }

    tracing::info!("ws loop ended conn {conn_id}");
    let last_user = state.hub.unregister(conn_id).await;
    metrics::metrics().set_connections(state.hub.connections().await as u64);
    if let Some(user) = last_user {
        if !state.hub.is_online(&user.id).await {
            let _ = state.hub.take_last_seen(&user.id).await;
            plugins::auth::announce_presence(&state, &user, false).await;
            state.hub.fire_offline(&user.id).await;
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[tokio::main]
async fn main() {
    let cfg = Arc::new(AppConfig::load());
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let mut file_log: Option<std::sync::Arc<logger::RotatingFile>> = None;
    if !cfg.log_dir.trim().is_empty() {
        match logger::RotatingFile::open(std::path::Path::new(&cfg.log_dir)) {
            Ok(handle) => file_log = Some(handle),
            Err(err) => eprintln!("file logger disabled: {err}"),
        }
    }
    match file_log {
        Some(handle) => {
            use tracing_subscriber::fmt::writer::MakeWriterExt;
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .with_writer(std::io::stdout.and(logger::SharedLogger(handle)))
                .init();
        }
        None => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .init();
        }
    }

    let db = match store::init_pool(&cfg.db_driver, &cfg.db_file, &cfg.database_url).await {
        Ok(pool) => pool,
        Err(err) => {
            tracing::error!("database init failed: {err}");
            std::process::exit(1);
        }
    };
    for name in cfg.bootstrap_admins.iter() {
        if let Ok(Some(row)) = store::user_by_username(&db, name).await {
            if !row.is_admin {
                let _ = store::set_flag(&db, &row.id, "isAdmin", true).await;
            }
        }
    }

    let mut registry = Registry::default();
    plugins::install(&mut registry);
    metrics::spawn_lag_probe();
    let method_count = registry.map.len();

    let state: SharedState = Arc::new(AppState {
        cfg: cfg.clone(),
        db: db.clone(),
        hub: Arc::new(Hub::new()),
        registry,
    });
    plugins::screen::install_offline(state.clone());
    scheduler::spawn(state.clone());

    let upload_limit_mb = store::settings_get(&db, "upload_limit_mb")
        .await
        .ok()
        .flatten()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(cfg.upload_limit_mb)
        .min(1024);

    let mut app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(prometheus))
        .route("/metrics.json", get(metrics_json))
        .route("/version", get(version))
        .route("/site/meta", get(site_meta))
        .route("/auth/register-policy", get(register_policy))
        .route("/rpc/{method}", post(rpc_http))
        .route("/ws", get(ws_handler))
        .route("/upload", post(plugins::files::upload))
        .route("/files/{key}", get(plugins::files::download))
        .route("/open/message", post(plugins::bots::open_message))
        .route("/open/messages", get(plugins::bots::open_messages))
        .route("/open/whoami", get(plugins::bots::open_whoami))
        .layer(axum::extract::DefaultBodyLimit::max(
            (upload_limit_mb as usize) * 1024 * 1024 + 1024,
        ))
        .with_state(state.clone());

    if let Some(dist) = cfg.web_dist.clone() {
        let index = dist.join("index.html");
        let service = tower_http::services::ServeDir::new(&dist)
            .fallback(tower_http::services::ServeFile::new(index));
        app = app.fallback_service(service);
        tracing::info!("web dist served from {}", dist.display());
    } else {
        app = app.fallback(|| async {
            (
                StatusCode::NOT_FOUND,
                axum::Json(json!({ "ok": false, "message": "not found" })),
            )
        });
    }

    app = app.layer(axum::middleware::from_fn(observe_http));

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("bind {addr} failed: {err}");
            std::process::exit(1);
        }
    };
    tracing::info!(
        "plugim rust gateway listening on http://localhost:{} ({} rpc methods)",
        cfg.port,
        method_count
    );

    let serve = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal());

    if let Err(err) = serve.await {
        tracing::error!("server error: {err}");
    }
    state.hub.broadcast("server:shutdown", json!({})).await;
    db.close().await;
    tracing::info!("shutdown complete");
}

fn _assert_types(_: Option<AuthUser>) {}
