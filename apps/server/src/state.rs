use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use sqlx::AnyPool;

use crate::config::AppConfig;
use crate::hub::{AuthUser, Hub};

pub struct AppState {
    pub cfg: Arc<AppConfig>,
    pub db: AnyPool,
    pub hub: Arc<Hub>,
    pub registry: Registry,
}

pub type SharedState = Arc<AppState>;

#[derive(Debug, Clone)]
pub struct Conn {
    pub user: Option<AuthUser>,
    pub user_agent: String,
    pub ip: String,
}

pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;

pub type Handler = Arc<
    dyn Fn(SharedState, Conn, Value) -> BoxFuture<Result<Value, String>> + Send + Sync + 'static,
>;

pub fn handler<F, Fut>(f: F) -> Handler
where
    F: Fn(SharedState, Conn, Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Value, String>> + Send + 'static,
{
    Arc::new(move |state, conn, params| Box::pin(f(state, conn, params)))
}

#[derive(Default)]
pub struct Registry {
    pub map: HashMap<String, Handler>,
}

impl Registry {
    pub fn add(&mut self, method: &str, func: Handler) {
        self.map.insert(method.to_string(), func);
    }
}

const MUST_CHANGE_ALLOWED: [&str; 5] = [
    "auth.password",
    "auth.me",
    "presence.list",
    "presence.status",
    "presence.status.set",
];

pub fn must_change_blocked(user: Option<&AuthUser>, method: &str) -> bool {
    match user {
        Some(user) if user.must_change => !MUST_CHANGE_ALLOWED.contains(&method),
        _ => false,
    }
}

pub async fn dispatch(
    state: &SharedState,
    method: &str,
    params: Value,
    conn: Conn,
) -> Result<Value, String> {
    let Some(func) = state.registry.map.get(method).cloned() else {
        return Err(format!("未知方法: {method}"));
    };
    if must_change_blocked(conn.user.as_ref(), method) {
        return Err("请先修改初始密码后再使用".to_string());
    }
    let started = std::time::Instant::now();
    let outcome = func(state.clone(), conn, params).await;
    crate::metrics::metrics().observe_rpc(
        method,
        started.elapsed().as_secs_f64() * 1000.0,
        outcome.is_ok(),
    );
    outcome
}
