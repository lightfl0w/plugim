use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

use crate::hub::AuthUser;
use crate::services::{self, SendPayload};
use crate::state::{handler, Registry, SharedState};
use crate::store::{self, BotAppRow, BotHookRow, HistoryCursor};
use crate::util;

const NAME_MAX: usize = 40;
const URL_MAX: usize = 500;
const TOKEN_PREFIX: &str = "pgm_";
const CONTENT_MAX: usize = 8000;
const DELIVERY_TIMEOUT_MS: u64 = 5000;
const DELIVERY_MAX_ATTEMPTS: u32 = 3;

const SCOPES: [&str; 3] = ["messages:read", "messages:write", "events"];

pub const EVENTS: [&str; 6] = [
    "message.new",
    "message.recalled",
    "message.edited",
    "read.update",
    "group.join",
    "redpacket.update",
];

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sign_body(secret: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{secret}.{body}").as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn token_ok(raw: &str) -> bool {
    let Some(rest) = raw.strip_prefix(TOKEN_PREFIX) else {
        return false;
    };
    rest.len() == 32
        && rest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn url_ok(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return false;
    }
    let rest = &raw[raw.find("://").map(|index| index + 3).unwrap_or(0)..];
    !rest.is_empty() && !rest.chars().any(|ch| ch.is_whitespace())
}

fn scopes_of(params: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = params.get("scopes") {
        for item in items {
            let text = item.as_str().unwrap_or("").to_string();
            if SCOPES.contains(&text.as_str()) && !out.contains(&text) {
                out.push(text);
            }
        }
    }
    if out.is_empty() {
        out.push("messages:write".to_string());
    }
    out
}

fn events_of(params: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = params.get("events") {
        for item in items {
            let text = item.as_str().unwrap_or("").to_string();
            if EVENTS.contains(&text.as_str()) && !out.contains(&text) {
                out.push(text);
            }
        }
    }
    out.truncate(20);
    out
}

fn app_json(row: &BotAppRow) -> Value {
    let preview: String = row.token_hash.chars().take(8).collect();
    json!({
        "id": row.id,
        "name": row.name,
        "owner": row.owner,
        "scopes": row.scopes,
        "createdAt": util::iso_from_ms(row.created_at),
        "lastUsedAt": row.last_used_at.map(util::iso_from_ms),
        "tokenPreview": format!("{preview}…"),
    })
}

fn hook_json(row: &BotHookRow) -> Value {
    json!({
        "id": row.id,
        "botId": row.bot_id,
        "botName": row.bot_name,
        "url": row.url,
        "events": row.events,
        "enabled": row.enabled,
        "createdAt": util::iso_from_ms(row.created_at),
        "failures": row.failures,
        "lastError": row.last_error,
    })
}

async fn deliver(state: &SharedState, hook: &BotHookRow, event: &str, payload: Value) {
    let body = json!({
        "event": event,
        "bot": hook.bot_name,
        "at": util::iso_from_ms(util::now_ms()),
        "data": payload,
    })
    .to_string();
    let signature = sign_body(&hook.secret, &body);
    let client = reqwest::Client::new();
    let mut last_error = String::from("投递失败");
    for attempt in 1..=DELIVERY_MAX_ATTEMPTS {
        let sent = client
            .post(&hook.url)
            .header("content-type", "application/json")
            .header("x-plugim-event", event)
            .header("x-plugim-signature", &signature)
            .timeout(Duration::from_millis(DELIVERY_TIMEOUT_MS))
            .body(body.clone())
            .send()
            .await;
        match sent {
            Ok(res) => {
                let status = res.status();
                if status.is_success() {
                    let _ = store::bot_report_hook(&state.db, &hook.id, true, None).await;
                    return;
                }
                last_error = format!("HTTP {}", status.as_u16());
                let retryable = status.as_u16() >= 500 || status.as_u16() == 429;
                if !retryable {
                    break;
                }
            }
            Err(err) => {
                last_error = err.to_string();
            }
        }
        if attempt < DELIVERY_MAX_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(300 * attempt as u64)).await;
        }
    }
    let brief: String = last_error.chars().take(200).collect();
    let _ = store::bot_report_hook(&state.db, &hook.id, false, Some(brief)).await;
}

pub fn emit(state: &SharedState, event: &str, payload: Value) {
    let state = state.clone();
    let event = event.to_string();
    tokio::spawn(async move {
        match store::bot_hooks_of_event(&state.db, &event).await {
            Ok(hooks) => {
                for hook in hooks {
                    let task_state = state.clone();
                    let task_event = event.clone();
                    let task_payload = payload.clone();
                    tokio::spawn(async move {
                        deliver(&task_state, &hook, &task_event, task_payload).await;
                    });
                }
            }
            Err(err) => tracing::warn!("bot hook dispatch failed: {err}"),
        }
    });
}

fn owner_session(user_id: &str, username: &str) -> AuthUser {
    AuthUser {
        id: user_id.to_string(),
        username: username.to_string(),
        must_change: false,
        session_id: None,
    }
}

async fn app_by_token(state: &SharedState, token: &str) -> Option<BotAppRow> {
    let value = token.trim();
    if !token_ok(value) {
        return None;
    }
    store::bot_by_token(&state.db, &hash_token(value))
        .await
        .ok()
        .flatten()
}

fn token_of(headers: &HeaderMap, query: &HashMap<String, String>) -> String {
    let header_value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if !header_value.is_empty() {
        return header_value;
    }
    query.get("token").cloned().unwrap_or_default()
}

fn fail(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "ok": false, "message": message }))).into_response()
}

async fn assert_session_reachable(
    state: &SharedState,
    user: &AuthUser,
    session: &str,
) -> Result<(), String> {
    if let Some(group_id) = session.strip_prefix("g:") {
        let members = store::group_members(&state.db, group_id).await?;
        if !members.iter().any(|member| member.user_id == user.id) {
            return Err("应用所有者不在该群中".to_string());
        }
        return Ok(());
    }
    if let Some(raw) = session.strip_prefix("p2p:") {
        let peer = raw.trim().to_lowercase();
        if peer.is_empty() {
            return Err("缺少对端用户名".to_string());
        }
        if store::user_by_username(&state.db, &peer).await?.is_none() {
            return Err("目标用户不存在".to_string());
        }
        return Ok(());
    }
    Err("仅支持 p2p: 与 g: 会话".to_string())
}

pub async fn open_message(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = token_of(&headers, &HashMap::new());
    let Some(app) = app_by_token(&state, &token).await else {
        return fail(StatusCode::UNAUTHORIZED, "无效的应用令牌");
    };
    if !app.scopes.iter().any(|scope| scope == "messages:write") {
        return fail(StatusCode::FORBIDDEN, "该应用没有发消息权限");
    }
    let params: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let Some(owner) = store::user_by_id(&state.db, &app.owner_id).await.ok().flatten() else {
        return fail(StatusCode::NOT_FOUND, "应用所有者不存在");
    };
    let user = owner_session(&owner.id, &owner.username);
    let session = util::str_param(&params, "session").trim().to_string();
    if session.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "缺少 session");
    }
    let kind = if util::str_param(&params, "kind") == "notice" {
        "notice"
    } else {
        "text"
    };
    let mut content = util::str_param(&params, "content").trim().to_string();
    if content.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "缺少 content");
    }
    let title: String = util::str_param(&params, "title")
        .trim()
        .chars()
        .take(60)
        .collect();
    if kind == "notice" && !title.is_empty() {
        content = format!("【{title}】\n{content}");
    }
    if content.chars().count() > CONTENT_MAX {
        content = content.chars().take(CONTENT_MAX).collect();
    }
    if let Err(message) = assert_session_reachable(&state, &user, &session).await {
        return fail(StatusCode::BAD_REQUEST, &message);
    }
    let sent = services::send_to(
        &state,
        &user,
        &session,
        SendPayload {
            content,
            quote: None,
            mentions: None,
            kind: kind.to_string(),
            file: None,
            red_packet: None,
            transfer: None,
            aa_bill: None,
            link: None,
        },
    )
    .await;
    match sent {
        Ok(message) => {
            emit(
                &state,
                "message.new",
                json!({ "session": session, "message": message }),
            );
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            let seq = message.get("seq").cloned().unwrap_or(Value::Null);
            axum::Json(json!({ "ok": true, "result": { "id": id, "seq": seq } })).into_response()
        }
        Err(message) => fail(StatusCode::BAD_REQUEST, &message),
    }
}

pub async fn open_messages(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let token = token_of(&headers, &query);
    let Some(app) = app_by_token(&state, &token).await else {
        return fail(StatusCode::UNAUTHORIZED, "无效的应用令牌");
    };
    if !app.scopes.iter().any(|scope| scope == "messages:read") {
        return fail(StatusCode::FORBIDDEN, "该应用没有读消息权限");
    }
    let Some(owner) = store::user_by_id(&state.db, &app.owner_id).await.ok().flatten() else {
        return fail(StatusCode::NOT_FOUND, "应用所有者不存在");
    };
    let user = owner_session(&owner.id, &owner.username);
    let session = query
        .get("session")
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if session.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "缺少 session");
    }
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let storage = match services::storage_session_of(&state, &user, &session).await {
        Ok(value) => value,
        Err(message) => return fail(StatusCode::BAD_REQUEST, &message),
    };
    let cursor = HistoryCursor {
        before: None,
        after: None,
        before_id: None,
        after_id: None,
        before_seq: None,
        after_seq: None,
    };
    match store::message_list(&state.db, &storage, limit, &cursor).await {
        Ok(messages) => axum::Json(json!({ "ok": true, "result": { "messages": messages } }))
            .into_response(),
        Err(message) => fail(StatusCode::BAD_REQUEST, &message),
    }
}

pub async fn open_whoami(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let token = token_of(&headers, &query);
    let Some(app) = app_by_token(&state, &token).await else {
        return fail(StatusCode::UNAUTHORIZED, "无效的应用令牌");
    };
    axum::Json(json!({ "ok": true, "result": app_json(&app) })).into_response()
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "bots.apps",
        handler(|state, conn, _params| async move {
            let user = crate::plugins::auth::require_user(&conn)?;
            let rows = store::bot_list_apps(&state.db, &user.id).await?;
            Ok(Value::Array(
                rows.iter()
                    .filter(|row| !row.revoked)
                    .map(app_json)
                    .collect(),
            ))
        }),
    );

    registry.add(
        "bots.app.create",
        handler(|state, conn, params| async move {
            let user = crate::plugins::auth::require_user(&conn)?;
            let name: String = util::str_param(&params, "name")
                .trim()
                .chars()
                .take(NAME_MAX)
                .collect();
            if name.is_empty() {
                return Err("请填写应用名称".to_string());
            }
            let scopes = scopes_of(&params);
            let token = format!("{TOKEN_PREFIX}{}", util::random_token(24));
            let row = store::bot_create_app(
                &state.db,
                &user.id,
                &name,
                &hash_token(&token),
                &scopes,
            )
            .await?;
            let mut payload = app_json(&row);
            payload["token"] = json!(token);
            Ok(payload)
        }),
    );

    registry.add(
        "bots.app.revoke",
        handler(|state, conn, params| async move {
            let user = crate::plugins::auth::require_user(&conn)?;
            let id = util::str_param(&params, "id").trim().to_string();
            if id.is_empty() {
                return Err("缺少应用".to_string());
            }
            if !store::bot_revoke_app(&state.db, &user.id, &id).await? {
                return Err("应用不存在".to_string());
            }
            Ok(json!({ "ok": true }))
        }),
    );

    registry.add(
        "bots.hooks",
        handler(|state, conn, _params| async move {
            let user = crate::plugins::auth::require_user(&conn)?;
            let rows = store::bot_list_hooks(&state.db, &user.id).await?;
            Ok(Value::Array(rows.iter().map(hook_json).collect()))
        }),
    );

    registry.add(
        "bots.hook.create",
        handler(|state, conn, params| async move {
            let user = crate::plugins::auth::require_user(&conn)?;
            let url: String = util::str_param(&params, "url")
                .trim()
                .chars()
                .take(URL_MAX)
                .collect();
            if !url_ok(&url) {
                return Err("回调地址必须是 http(s) URL".to_string());
            }
            let events = events_of(&params);
            if events.is_empty() {
                return Err("请至少选择一个事件".to_string());
            }
            let apps = store::bot_list_apps(&state.db, &user.id).await?;
            let Some(owned) = apps.iter().find(|row| !row.revoked) else {
                return Err("请先创建应用".to_string());
            };
            let secret = util::random_token(24);
            let row = store::bot_create_hook(&state.db, &owned.id, &url, &secret, &events).await?;
            let mut payload = hook_json(&row);
            payload["secret"] = json!(secret);
            Ok(payload)
        }),
    );

    registry.add(
        "bots.hook.toggle",
        handler(|state, conn, params| async move {
            let user = crate::plugins::auth::require_user(&conn)?;
            let id = util::str_param(&params, "id").trim().to_string();
            if id.is_empty() {
                return Err("缺少订阅".to_string());
            }
            let enabled = params
                .get("enabled")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if !store::bot_set_hook_enabled(&state.db, &user.id, &id, enabled).await? {
                return Err("订阅不存在".to_string());
            }
            Ok(json!({ "ok": true }))
        }),
    );

    registry.add(
        "bots.hook.remove",
        handler(|state, conn, params| async move {
            let user = crate::plugins::auth::require_user(&conn)?;
            let id = util::str_param(&params, "id").trim().to_string();
            if id.is_empty() {
                return Err("缺少订阅".to_string());
            }
            if !store::bot_remove_hook(&state.db, &user.id, &id).await? {
                return Err("订阅不存在".to_string());
            }
            Ok(json!({ "ok": true }))
        }),
    );
}
