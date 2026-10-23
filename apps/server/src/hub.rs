use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

pub type OfflineHook =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub must_change: bool,
    pub session_id: Option<String>,
}

pub struct Entry {
    pub user: Option<AuthUser>,
    pub tx: UnboundedSender<String>,
}

#[derive(Default)]
pub struct Hub {
    inner: Mutex<HashMap<u64, Entry>>,
    last_seen: Mutex<HashMap<String, String>>,
    offline: std::sync::Mutex<Vec<OfflineHook>>,
    next: AtomicU64,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_offline(&self, hook: OfflineHook) {
        if let Ok(mut hooks) = self.offline.lock() {
            hooks.push(hook);
        }
    }

    pub async fn fire_offline(&self, user_id: &str) {
        let hooks = match self.offline.lock() {
            Ok(hooks) => hooks.clone(),
            Err(_) => return,
        };
        for hook in hooks {
            hook(user_id.to_string()).await;
        }
    }

    pub async fn register(&self, tx: UnboundedSender<String>, user: Option<AuthUser>) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(user) = user.as_ref() {
            self.last_seen
                .lock()
                .await
                .insert(user.id.clone(), user.username.clone());
        }
        self.inner.lock().await.insert(id, Entry { user, tx });
        id
    }

    pub async fn unregister(&self, id: u64) -> Option<AuthUser> {
        let removed = self.inner.lock().await.remove(&id);
        removed.and_then(|entry| entry.user)
    }

    pub async fn is_online(&self, user_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .values()
            .any(|entry| entry.user.as_ref().map(|user| user.id == user_id).unwrap_or(false))
    }

    pub async fn online_user_ids(&self) -> Vec<String> {
        let guard = self.inner.lock().await;
        let mut out: Vec<String> = Vec::new();
        for entry in guard.values() {
            if let Some(user) = entry.user.as_ref() {
                if !out.contains(&user.id) {
                    out.push(user.id.clone());
                }
            }
        }
        out
    }

    pub async fn connections(&self) -> usize {
        self.inner.lock().await.len()
    }

    pub async fn take_last_seen(&self, user_id: &str) -> Option<String> {
        self.last_seen.lock().await.remove(user_id)
    }

    pub async fn broadcast(&self, name: &str, payload: Value) {
        let frame = json!({ "kind": "event", "name": name, "payload": payload }).to_string();
        let guard = self.inner.lock().await;
        for entry in guard.values() {
            if entry.user.is_some() {
                let _ = entry.tx.send(frame.clone());
            }
        }
    }

    pub async fn emit_to_user(&self, user_id: &str, name: &str, payload: Value) {
        let frame = json!({ "kind": "event", "name": name, "payload": payload }).to_string();
        let guard = self.inner.lock().await;
        for entry in guard.values() {
            if entry
                .user
                .as_ref()
                .map(|user| user.id == user_id)
                .unwrap_or(false)
            {
                let _ = entry.tx.send(frame.clone());
            }
        }
    }

    pub async fn emit_to_users(&self, user_ids: &[String], name: &str, payload: Value) {
        if user_ids.is_empty() {
            return;
        }
        let frame = json!({ "kind": "event", "name": name, "payload": payload }).to_string();
        let guard = self.inner.lock().await;
        for entry in guard.values() {
            if let Some(user) = entry.user.as_ref() {
                if user_ids.contains(&user.id) {
                    let _ = entry.tx.send(frame.clone());
                }
            }
        }
    }

    pub async fn kick_user(&self, user_id: &str) {
        let guard = self.inner.lock().await;
        for entry in guard.values() {
            if entry
                .user
                .as_ref()
                .map(|user| user.id == user_id)
                .unwrap_or(false)
            {
                let _ = entry.tx.send(String::from("__close__"));
            }
        }
    }

    pub async fn kick_session(&self, session_id: &str) {
        let guard = self.inner.lock().await;
        for entry in guard.values() {
            if entry
                .user
                .as_ref()
                .and_then(|user| user.session_id.as_deref())
                .map(|value| value == session_id)
                .unwrap_or(false)
            {
                let _ = entry.tx.send(String::from("__close__"));
            }
        }
    }
}
