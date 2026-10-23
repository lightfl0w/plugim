use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::hub::AuthUser;
use crate::plugins::auth::require_user;
use crate::services::{
    self, broadcast_message_update, message_str, p2p_key, raw_session_of, resolve_group,
    resolve_p2p, storage_session_of, visible_sessions, SendPayload,
};
use crate::state::{handler, Registry, SharedState};
use crate::store::{self, HistoryCursor, SearchParams};
use crate::util;

const KINDS: [&str; 7] = [
    "text", "image", "audio", "video", "file", "merge", "redpacket",
];
const REACTION_EMOJIS: [&str; 8] = ["👍", "😂", "❤️", "🎉", "😮", "😢", "😡", "🙏"];
const REACTIONS_MAX: usize = 8;
const CONTENT_MAX: usize = 8000;
const EDIT_WINDOW_MS: i64 = 10 * 60 * 1000;

fn typing_gate() -> &'static Mutex<HashMap<String, i64>> {
    static GATE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn poke_gate() -> &'static Mutex<HashMap<String, i64>> {
    static GATE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_url_ok(content: &str) -> bool {
    let Some(rest) = content.strip_prefix("/files/") else {
        return false;
    };
    rest.len() == 32 && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_mime(mime: &str) -> bool {
    let mut parts = mime.splitn(2, '/');
    let Some(top) = parts.next() else {
        return false;
    };
    let Some(sub) = parts.next() else {
        return false;
    };
    !top.is_empty()
        && !sub.is_empty()
        && top
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'+' || b == b'-' || b == b'_')
        && sub
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'+' || b == b'-' || b == b'_')
}

fn sanitize_quote(params: &Value) -> Option<Value> {
    let quote = params.get("quote")?;
    let sender = quote.get("sender")?.as_str()?;
    let content = quote.get("content")?.as_str()?;
    Some(json!({
        "sender": sender.chars().take(64).collect::<String>(),
        "content": content.chars().take(200).collect::<String>(),
    }))
}

fn sanitize_mentions(params: &Value) -> Option<Value> {
    let list = params.get("mentions")?.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for item in list {
        if let Some(name) = item.as_str() {
            let name: String = name.chars().take(64).collect();
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out.truncate(50);
    if out.is_empty() {
        return None;
    }
    Some(json!(out))
}

fn sanitize_file(params: &Value) -> Option<Value> {
    let file = params.get("file")?;
    let name = file.get("name")?.as_str()?;
    let size = file.get("size")?.as_f64()?;
    let raw_mime = file.get("mime").and_then(|value| value.as_str()).unwrap_or("");
    let mime = if valid_mime(raw_mime) {
        raw_mime.chars().take(100).collect::<String>()
    } else {
        "application/octet-stream".to_string()
    };
    Some(json!({
        "name": name.chars().take(200).collect::<String>(),
        "size": size.max(0.0).floor() as i64,
        "mime": mime,
    }))
}

fn recall_session_message(session: &str) -> (Option<String>, Option<String>) {
    if !session.starts_with("p2p:") {
        return (None, None);
    }
    let names: Vec<&str> = session.trim_start_matches("p2p:").split('|').collect();
    if names.len() == 2 {
        (Some(names[0].to_string()), Some(names[1].to_string()))
    } else {
        (None, None)
    }
}

async fn emit_recall(state: &SharedState, message: &Value, at: i64) {
    let session = message_str(message, "session");
    let id = message_str(message, "id");
    let at_iso = util::iso_from_ms(at);
    crate::plugins::bots::emit(
        state,
        "message.recalled",
        json!({ "id": id, "session": session, "recalledAt": at_iso }),
    );
    if let (Some(a), Some(b)) = recall_session_message(&session) {
        if let Ok(Some(user)) = store::user_by_username(&state.db, &a).await {
            state
                .hub
                .emit_to_user(
                    &user.id,
                    "message:recalled",
                    json!({ "id": id, "session": format!("p2p:{b}"), "recalledAt": at_iso }),
                )
                .await;
        }
        if let Ok(Some(user)) = store::user_by_username(&state.db, &b).await {
            state
                .hub
                .emit_to_user(
                    &user.id,
                    "message:recalled",
                    json!({ "id": id, "session": format!("p2p:{a}"), "recalledAt": at_iso }),
                )
                .await;
        }
        return;
    }
    if session.starts_with("g:") {
        if let Ok(ids) = store::group_member_ids(&state.db, session.trim_start_matches("g:")).await {
            state
                .hub
                .emit_to_users(
                    &ids,
                    "message:recalled",
                    json!({ "id": id, "session": session, "recalledAt": at_iso }),
                )
                .await;
        }
        return;
    }
    state
        .hub
        .broadcast(
            "message:recalled",
            json!({ "id": id, "session": session, "recalledAt": at_iso }),
        )
        .await;
}

async fn visible_message(state: &SharedState, user: &AuthUser, message: &Value) -> Result<bool, String> {
    let session = message_str(message, "session");
    if session.starts_with("p2p:") {
        return Ok(session
            .trim_start_matches("p2p:")
            .split('|')
            .any(|name| name == user.username));
    }
    if session.starts_with("g:") {
        let ids = store::group_member_ids(&state.db, session.trim_start_matches("g:")).await?;
        return Ok(ids.contains(&user.id));
    }
    Ok(true)
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "message.send",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let kind_raw = util::str_param(&params, "kind");
            let content = util::str_param(&params, "content");
            if content.trim().is_empty() && kind_raw != "redpacket" {
                return Err("消息内容不能为空".to_string());
            }
            let raw_session = match util::str_param(&params, "session") {
                value if value.is_empty() => state.cfg.default_session.clone(),
                value => value,
            };
            let quote = sanitize_quote(&params);
            let mentions = sanitize_mentions(&params);
            if let Some(list) = mentions.as_ref().and_then(|value| value.as_array()) {
                if list.iter().any(|item| item.as_str() == Some("@all")) {
                    if !raw_session.starts_with("g:") {
                        return Err("只有群聊支持 @全体成员".to_string());
                    }
                    let (_, role) = resolve_group(&state, &user, &raw_session).await?;
                    if role != "owner" && role != "admin" {
                        return Err("只有群主或管理员可以 @全体成员".to_string());
                    }
                }
            }
            let kind = if KINDS.contains(&kind_raw.as_str()) {
                kind_raw
            } else {
                "text".to_string()
            };
            let content: String = content.chars().take(CONTENT_MAX).collect();
            if ["image", "audio", "video", "file"].contains(&kind.as_str())
                && !file_url_ok(&content)
            {
                return Err("媒体消息必须引用已上传的文件".to_string());
            }
            let file = sanitize_file(&params);
            let link = if crate::linkpreview::has_link(&content) {
                match tokio::time::timeout(
                    std::time::Duration::from_millis(2000),
                    crate::linkpreview::preview_of_text(&state, &content),
                )
                .await
                {
                    Ok(value) => value,
                    Err(_) => None,
                }
            } else {
                None
            };
            services::send_to(
                &state,
                &user,
                &raw_session,
                SendPayload {
                    content,
                    quote,
                    mentions,
                    kind,
                    file,
                    red_packet: None,
                    transfer: None,
                    aa_bill: None,
                    link,
                },
            )
            .await
        }),
    );

    registry.add(
        "typing.send",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let raw_session = util::str_param(&params, "session").trim().to_string();
            if raw_session.is_empty() {
                return Ok(json!(false));
            }
            let now = util::now_ms();
            {
                let mut gate = typing_gate().lock().await;
                if now - gate.get(&user.id).copied().unwrap_or(0) < 1500 {
                    return Ok(json!(false));
                }
                gate.insert(user.id.clone(), now);
            }
            if raw_session.starts_with("p2p:") {
                let peer = resolve_p2p(&state, &user, &raw_session).await?;
                state
                    .hub
                    .emit_to_user(
                        &peer.id,
                        "typing",
                        json!({ "session": format!("p2p:{}", user.username), "username": user.username }),
                    )
                    .await;
                return Ok(json!(true));
            }
            if raw_session.starts_with("g:") {
                let (row, _) = resolve_group(&state, &user, &raw_session).await?;
                let ids = store::group_member_ids(&state.db, &row.id).await?;
                let targets: Vec<String> = ids.into_iter().filter(|id| id != &user.id).collect();
                state
                    .hub
                    .emit_to_users(
                        &targets,
                        "typing",
                        json!({ "session": raw_session, "username": user.username }),
                    )
                    .await;
                return Ok(json!(true));
            }
            if raw_session != state.cfg.default_session {
                return Err("会话不存在".to_string());
            }
            state
                .hub
                .broadcast(
                    "typing",
                    json!({ "session": raw_session, "username": user.username }),
                )
                .await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "chat.poke",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let raw_session = util::str_param(&params, "session").trim().to_string();
            if raw_session.is_empty() {
                return Err("缺少会话".to_string());
            }
            if !raw_session.starts_with("p2p:") && !raw_session.starts_with("g:") {
                return Err("该会话不支持戳一戳".to_string());
            }
            let target = util::str_param(&params, "target");
            let mut target_name = String::new();
            let mut peer_id: Option<String> = None;
            if raw_session.starts_with("p2p:") {
                let peer = resolve_p2p(&state, &user, &raw_session).await?;
                target_name = peer.username.clone();
                peer_id = Some(peer.id.clone());
            } else {
                resolve_group(&state, &user, &raw_session).await?;
                if !target.is_empty() {
                    let members =
                        store::group_members(&state.db, raw_session.trim_start_matches("g:")).await?;
                    let target_user = store::user_by_username(&state.db, &target.to_lowercase())
                        .await?
                        .ok_or_else(|| "对方不在该群中".to_string())?;
                    if !members.iter().any(|member| member.user_id == target_user.id) {
                        return Err("对方不在该群中".to_string());
                    }
                    target_name = target_user.username;
                }
            }
            let gate_key = format!("{}:{}:{}", user.id, raw_session, target_name);
            let now = util::now_ms();
            {
                let mut gate = poke_gate().lock().await;
                if now - gate.get(&gate_key).copied().unwrap_or(0) < 10_000 {
                    return Err("戳得太快了，休息一下吧".to_string());
                }
                gate.insert(gate_key, now);
            }
            let text = if target_name.is_empty() {
                format!("{} 戳了戳大家", user.username)
            } else {
                format!("{} 戳了戳 {}", user.username, target_name)
            };
            let storage = if raw_session.starts_with("p2p:") {
                p2p_key(&user.username, &target_name)
            } else {
                raw_session.clone()
            };
            let saved = store::save_message(
                &state.db,
                store::SaveMessage {
                    session: storage,
                    sender: user.username.clone(),
                    content: text,
                    quote: None,
                    mentions: None,
                    kind: "system".to_string(),
                    file: None,
                    link: None,
                    red_packet: None,
                    transfer: None,
                    aa_bill: None,
                },
            )
            .await?;
            if raw_session.starts_with("p2p:") {
                let mut mine = saved.clone();
                mine["session"] = json!(format!("p2p:{target_name}"));
                state
                    .hub
                    .emit_to_user(&user.id, "message:new", json!({ "message": mine.clone() }))
                    .await;
                if let Some(peer_id) = peer_id {
                    let mut theirs = saved.clone();
                    theirs["session"] = json!(format!("p2p:{}", user.username));
                    state
                        .hub
                        .emit_to_user(&peer_id, "message:new", json!({ "message": theirs }))
                        .await;
                }
                return Ok(mine);
            }
            let ids = store::group_member_ids(&state.db, raw_session.trim_start_matches("g:")).await?;
            state
                .hub
                .emit_to_users(&ids, "message:new", json!({ "message": saved.clone() }))
                .await;
            Ok(saved)
        }),
    );

    registry.add(
        "history.list",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let raw_session = match util::str_param(&params, "session") {
                value if value.is_empty() => state.cfg.default_session.clone(),
                value => value,
            };
            let limit = util::i64_param(&params, "limit").unwrap_or(50).min(200).max(1);
            let session = storage_session_of(&state, &user, &raw_session).await?;
            let cursor = HistoryCursor {
                before: params.get("before").and_then(|v| v.as_str()).map(|v| v.to_string()),
                after: params.get("after").and_then(|v| v.as_str()).map(|v| v.to_string()),
                before_id: params.get("beforeId").and_then(|v| v.as_str()).map(|v| v.to_string()),
                after_id: params.get("afterId").and_then(|v| v.as_str()).map(|v| v.to_string()),
                before_seq: util::i64_param(&params, "beforeSeq"),
                after_seq: util::i64_param(&params, "afterSeq"),
            };
            let list = store::message_list(&state.db, &session, limit, &cursor).await?;
            Ok(json!(list))
        }),
    );

    registry.add(
        "message.recall",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let id = util::str_param(&params, "id");
            let message = store::message_by_id(&state.db, &id)
                .await?
                .ok_or_else(|| "消息不存在".to_string())?;
            let sender = message_str(&message, "sender");
            let session = message_str(&message, "session");
            let is_self = sender == user.username;
            if !is_self {
                if !session.starts_with("g:") {
                    return Err("只能撤回自己的消息".to_string());
                }
                let (_, role) = resolve_group(&state, &user, &session).await?;
                if role != "owner" && role != "admin" {
                    return Err("只有管理员可以撤回他人消息".to_string());
                }
            }
            if let Some(existing) = message.get("recalledAt").and_then(|v| v.as_str()) {
                return Ok(json!({ "id": id, "recalledAt": existing }));
            }
            if is_self {
                let created = message_str(&message, "createdAt");
                if let Some(created_ms) = util::parse_iso(&created) {
                    if util::now_ms() - created_ms > 2 * 60 * 1000 {
                        return Err("已超过可撤回时限".to_string());
                    }
                }
            }
            let at = store::mark_recalled(&state.db, &id)
                .await?
                .ok_or_else(|| "消息不存在".to_string())?;
            emit_recall(&state, &message, at).await;
            Ok(json!({ "id": id, "recalledAt": util::iso_from_ms(at) }))
        }),
    );

    registry.add(
        "message.react",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let id = util::str_param(&params, "id");
            let emoji = util::str_param(&params, "emoji");
            if !REACTION_EMOJIS.contains(&emoji.as_str()) {
                return Err("不支持的回应表情".to_string());
            }
            let message = store::message_by_id(&state.db, &id)
                .await?
                .ok_or_else(|| "消息不存在".to_string())?;
            if message.get("recalledAt").map(|v| !v.is_null()).unwrap_or(false) {
                return Err("消息已撤回".to_string());
            }
            if !visible_message(&state, &user, &message).await? {
                return Err("无权回应该消息".to_string());
            }
            let mut reactions: Map<String, Value> = message
                .get("reactions")
                .and_then(|value| value.as_object())
                .cloned()
                .unwrap_or_default();
            let mine: Vec<String> = reactions
                .get(&emoji)
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let removing = mine.contains(&user.username);
            if removing {
                let rest: Vec<String> = mine
                    .into_iter()
                    .filter(|name| name != &user.username)
                    .collect();
                if rest.is_empty() {
                    reactions.remove(&emoji);
                } else {
                    reactions.insert(emoji.clone(), json!(rest));
                }
            } else {
                if !reactions.contains_key(&emoji) && reactions.len() >= REACTIONS_MAX {
                    return Err("回应表情种类已达上限".to_string());
                }
                let mut next = mine;
                next.push(user.username.clone());
                reactions.insert(emoji.clone(), json!(next));
            }
            let payload = if reactions.is_empty() {
                Value::Null
            } else {
                Value::Object(reactions)
            };
            let updated = store::set_reactions(&state.db, &id, payload)
                .await?
                .ok_or_else(|| "消息不存在".to_string())?;
            broadcast_message_update(&state, &updated).await;
            Ok(json!({ "message": updated }))
        }),
    );

    registry.add(
        "message.edit",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let id = util::str_param(&params, "id");
            let content: String = util::str_param(&params, "content").trim().to_string();
            if id.is_empty() {
                return Err("缺少消息".to_string());
            }
            if content.is_empty() {
                return Err("消息内容不能为空".to_string());
            }
            if content.chars().count() > CONTENT_MAX {
                return Err(format!("消息内容不能超过 {CONTENT_MAX} 字"));
            }
            let message = store::message_by_id(&state.db, &id)
                .await?
                .ok_or_else(|| "消息不存在".to_string())?;
            if message.get("recalledAt").map(|v| !v.is_null()).unwrap_or(false) {
                return Err("消息已撤回".to_string());
            }
            if message_str(&message, "sender") != user.username {
                return Err("只能编辑自己的消息".to_string());
            }
            let kind = message_str(&message, "kind");
            if kind != "text" {
                return Err("只能编辑文字消息".to_string());
            }
            if let Some(created_ms) = util::parse_iso(&message_str(&message, "createdAt")) {
                if util::now_ms() - created_ms > EDIT_WINDOW_MS {
                    return Err("已超过可编辑时限".to_string());
                }
            }
            if message_str(&message, "content") == content {
                return Err("内容没有变化".to_string());
            }
            let at = util::now_ms();
            let updated = store::edit_message(&state.db, &id, &content, at)
                .await?
                .ok_or_else(|| "消息不存在".to_string())?;
            broadcast_message_update(&state, &updated).await;
            let payload = json!({
                "id": id,
                "session": message_str(&updated, "session"),
                "content": content,
                "editedAt": util::iso_from_ms(at),
                "editCount": updated.get("editCount").cloned().unwrap_or(json!(1)),
            });
            state.hub.broadcast("message:edited", payload.clone()).await;
            crate::plugins::bots::emit(&state, "message.edited", payload);
            Ok(json!({
                "message": updated,
                "editedAt": util::iso_from_ms(at),
                "editCount": updated.get("editCount").cloned().unwrap_or(json!(1)),
            }))
        }),
    );

    registry.add(
        "message.search",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let keyword = util::str_param(&params, "keyword").trim().to_string();
            if keyword.is_empty() {
                return Err("请输入搜索关键词".to_string());
            }
            let offset = util::i64_param(&params, "offset").unwrap_or(0).max(0);
            let limit = util::i64_param(&params, "limit").unwrap_or(20).clamp(1, 100);
            let scope = util::str_param(&params, "session").trim().to_string();
            let mut session: Option<String> = None;
            let mut sessions: Option<Vec<String>> = None;
            if !scope.is_empty() {
                if scope.starts_with("p2p:") {
                    let peer = resolve_p2p(&state, &user, &scope).await?;
                    session = Some(p2p_key(&user.username, &peer.username));
                } else if scope.starts_with("g:") {
                    resolve_group(&state, &user, &scope).await?;
                    session = Some(scope);
                } else {
                    session = Some(scope);
                }
            } else {
                sessions = Some(visible_sessions(&state, &user).await?);
            }
            let sender = {
                let raw = util::str_param(&params, "sender").trim().to_string();
                if raw.is_empty() {
                    None
                } else {
                    Some(raw)
                }
            };
            let from = params
                .get("from")
                .and_then(|value| value.as_str())
                .and_then(util::parse_iso);
            let to = params
                .get("to")
                .and_then(|value| value.as_str())
                .and_then(util::parse_iso);
            let (rows, total) = store::search_messages(
                &state.db,
                &SearchParams {
                    keyword: Some(keyword),
                    session,
                    sessions,
                    sender,
                    from,
                    to,
                    offset,
                    limit,
                },
            )
            .await?;
            Ok(json!({ "hits": rows, "total": total }))
        }),
    );

    registry.add(
        "receipt.read",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let session = util::str_param(&params, "session");
            if session.is_empty() {
                return Err("缺少会话".to_string());
            }
            let at_ms = util::now_ms();
            let at = util::iso_from_ms(at_ms);
            if session.starts_with("p2p:") {
                let peer_name = session.trim_start_matches("p2p:").trim().to_string();
                let peer = store::user_by_username(&state.db, &peer_name)
                    .await?
                    .ok_or_else(|| "用户不存在".to_string())?;
                store::read_set(
                    &state.db,
                    &user.id,
                    &p2p_key(&user.username, &peer_name),
                    at_ms,
                    0,
                )
                .await?;
                state
                    .hub
                    .emit_to_user(
                        &peer.id,
                        "receipt:update",
                        json!({ "session": format!("p2p:{}", user.username), "username": user.username, "at": at }),
                    )
                    .await;
            } else if session.starts_with("g:") {
                resolve_group(&state, &user, &session).await?;
                store::read_set(&state.db, &user.id, &session, at_ms, 0).await?;
                let ids = store::group_member_ids(&state.db, session.trim_start_matches("g:")).await?;
                let targets: Vec<String> = ids.into_iter().filter(|id| id != &user.id).collect();
                state
                    .hub
                    .emit_to_users(
                        &targets,
                        "receipt:update",
                        json!({ "session": session, "username": user.username, "at": at }),
                    )
                    .await;
            } else {
                store::read_set(&state.db, &user.id, &session, at_ms, 0).await?;
            }
            Ok(json!({ "at": at }))
        }),
    );

    registry.add(
        "receipt.list",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let session = util::str_param(&params, "session");
            let storage = if session.starts_with("p2p:") {
                let peer_name = session.trim_start_matches("p2p:").trim().to_string();
                let peer = store::user_by_username(&state.db, &peer_name)
                    .await?
                    .ok_or_else(|| "用户不存在".to_string())?;
                p2p_key(&user.username, &peer.username)
            } else {
                if session.starts_with("g:") {
                    resolve_group(&state, &user, &session).await?;
                }
                session
            };
            let rows = store::reads_of_session(&state.db, &storage).await?;
            let ids: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
            let names: HashMap<String, String> =
                store::users_by_ids(&state.db, &ids).await?.into_iter().collect();
            let out: Vec<Value> = rows
                .iter()
                .map(|(id, at, _)| {
                    json!({
                        "username": names.get(id).cloned().unwrap_or_else(|| id.clone()),
                        "at": util::iso_from_ms(*at),
                    })
                })
                .collect();
            Ok(json!(out))
        }),
    );

    registry.add(
        "chat.read",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let raw_session = util::str_param(&params, "session").trim().to_string();
            if raw_session.is_empty() {
                return Err("缺少会话".to_string());
            }
            let session = storage_session_of(&state, &user, &raw_session).await?;
            let last_seq = store::last_seq(&state.db, &session).await?;
            let target = util::i64_param(&params, "seq")
                .unwrap_or(last_seq)
                .clamp(0, last_seq);
            let at_ms = util::now_ms();
            store::read_set(&state.db, &user.id, &session, at_ms, target).await?;
            let cursors: HashMap<String, i64> =
                store::read_cursors(&state.db, &user.id).await?.into_iter().collect();
            let effective = cursors.get(&session).copied().unwrap_or(target).max(target);
            let payload = json!({
                "session": raw_session,
                "username": user.username,
                "seq": effective,
                "at": util::iso_from_ms(at_ms),
            });
            if raw_session.starts_with("p2p:") {
                if let Ok(Some(peer)) =
                    store::user_by_username(&state.db, raw_session.trim_start_matches("p2p:")).await
                {
                    state
                        .hub
                        .emit_to_user(&peer.id, "read:update", payload.clone())
                        .await;
                }
            } else if raw_session.starts_with("g:") {
                let ids = store::group_member_ids(&state.db, raw_session.trim_start_matches("g:")).await?;
                for id in ids {
                    if id == user.id {
                        continue;
                    }
                    state
                        .hub
                        .emit_to_user(&id, "read:update", payload.clone())
                        .await;
                }
            }
            let mut bot_payload = payload.clone();
            bot_payload["storageSession"] = json!(session);
            state
                .hub
                .emit_to_user(&user.id, "read:update", payload)
                .await;
            crate::plugins::bots::emit(&state, "read.update", bot_payload);
            Ok(json!({ "seq": effective, "at": util::iso_from_ms(at_ms) }))
        }),
    );

    registry.add(
        "chat.sessionList",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let requested = util::string_list(&params, "sessions");
            let sessions = if requested.is_empty() {
                visible_sessions(&state, &user).await?
            } else {
                let mut out: Vec<String> = Vec::new();
                for raw in requested.iter().take(200) {
                    if let Ok(storage) = storage_session_of(&state, &user, raw).await {
                        if !out.contains(&storage) {
                            out.push(storage);
                        }
                    }
                }
                out
            };
            let rows = store::session_summaries(&state.db, &user.id, &user.username, &sessions).await?;
            let meta: HashMap<String, bool> =
                store::session_meta_of(&state.db, &user.id).await?.into_iter().collect();
            let out: Vec<Value> = rows
                .iter()
                .map(|row| {
                    json!({
                        "session": raw_session_of(&user.username, &row.session),
                        "lastSeq": row.last_seq,
                        "readSeq": row.read_seq,
                        "unread": row.unread,
                        "lastMessage": row.last_message,
                        "pinned": meta.get(&row.session).copied().unwrap_or(false),
                    })
                })
                .collect();
            Ok(json!(out))
        }),
    );

    registry.add(
        "chat.session.meta",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let raw_session = util::str_param(&params, "session").trim().to_string();
            if raw_session.is_empty() {
                return Err("缺少会话".to_string());
            }
            let storage = storage_session_of(&state, &user, &raw_session).await?;
            let Some(pinned) = params.get("pinned").and_then(|value| value.as_bool()) else {
                return Err("没有需要修改的项".to_string());
            };
            store::session_meta_set(&state.db, &user.id, &storage, pinned).await?;
            Ok(json!({ "session": raw_session, "pinned": pinned }))
        }),
    );

    registry.add(
        "sync.delta",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let limit = util::i64_param(&params, "limit").unwrap_or(200).clamp(1, 500);
            let cursors: HashMap<String, i64> =
                store::read_cursors(&state.db, &user.id).await?.into_iter().collect();
            let requested: Vec<(String, i64)> = params
                .get("cursors")
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .take(200)
                        .filter_map(|item| {
                            let session = item.get("session")?.as_str()?.to_string();
                            let seq = item.get("seq")?.as_i64().unwrap_or(0).max(0);
                            Some((session, seq))
                        })
                        .collect()
                })
                .unwrap_or_default();

            let mut targets: Vec<(String, String, i64)> = Vec::new();
            if requested.is_empty() {
                for storage in visible_sessions(&state, &user).await? {
                    targets.push((raw_session_of(&user.username, &storage), storage, 0));
                }
            } else {
                for (raw, seq) in requested {
                    if let Ok(storage) = storage_session_of(&state, &user, &raw).await {
                        targets.push((raw, storage, seq));
                    }
                }
            }

            let mut sessions: Vec<Value> = Vec::new();
            for (raw, storage, cursor) in targets {
                let rows = store::messages_since(&state.db, &storage, cursor, limit + 1).await?;
                let has_more = rows.len() as i64 > limit;
                let messages: Vec<Value> = rows.into_iter().take(limit as usize).collect();
                let last = messages
                    .last()
                    .and_then(|message| message.get("seq").and_then(|v| v.as_i64()))
                    .unwrap_or(cursor);
                sessions.push(json!({
                    "session": raw,
                    "messages": messages,
                    "lastSeq": last,
                    "readSeq": cursors.get(&storage).copied().unwrap_or(0),
                    "hasMore": has_more,
                }));
            }
            Ok(json!({ "sessions": sessions, "at": util::iso_from_ms(util::now_ms()) }))
        }),
    );

    registry.add(
        "message.forward",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let ids: Vec<String> = {
                let list = util::string_list(&params, "ids");
                if list.is_empty() {
                    let single = util::str_param(&params, "id");
                    if single.is_empty() {
                        Vec::new()
                    } else {
                        vec![single]
                    }
                } else {
                    list
                }
            };
            let ids: Vec<String> = ids.into_iter().take(100).collect();
            let sessions = util::string_list(&params, "sessions");
            if sessions.is_empty() {
                return Err("请选择转发目标".to_string());
            }
            if sessions.len() > 50 {
                return Err("一次最多转发 50 个会话".to_string());
            }
            if ids.is_empty() {
                return Err("请选择要转发的消息".to_string());
            }
            let mut sources: Vec<(i64, Value)> = Vec::new();
            for id in &ids {
                let message = store::message_by_id(&state.db, id)
                    .await?
                    .ok_or_else(|| "消息不存在或已撤回".to_string())?;
                if message.get("recalledAt").map(|v| !v.is_null()).unwrap_or(false) {
                    return Err("消息不存在或已撤回".to_string());
                }
                if !visible_message(&state, &user, &message).await? {
                    return Err("无权转发该消息".to_string());
                }
                let created = util::parse_iso(&message_str(&message, "createdAt")).unwrap_or(0);
                sources.push((created, message));
            }
            sources.sort_by_key(|(created, _)| *created);

            let merged = if sources.len() > 1 {
                let list: Vec<Value> = sources
                    .iter()
                    .map(|(_, message)| {
                        let kind = message_str(message, "kind");
                        json!({
                            "sender": message_str(message, "sender"),
                            "content": message_str(message, "content").chars().take(500).collect::<String>(),
                            "kind": kind,
                            "file": message.get("file").cloned().unwrap_or(Value::Null),
                            "link": Value::Null,
                            "createdAt": message_str(message, "createdAt"),
                        })
                    })
                    .collect();
                Some(json!({
                    "merge": 1,
                    "title": format!("{} 条转发消息", sources.len()),
                    "list": list,
                }))
            } else {
                None
            };

            let mut sent: Vec<Value> = Vec::new();
            for target in sessions.iter().take(50) {
                let raw_session = if target.is_empty() {
                    state.cfg.default_session.clone()
                } else {
                    target.clone()
                };
                if raw_session == format!("p2p:{}", user.username) {
                    continue;
                }
                if let Some(merged) = merged.as_ref() {
                    sent.push(
                        services::send_to(
                            &state,
                            &user,
                            &raw_session,
                            SendPayload {
                                content: merged.to_string(),
                                quote: None,
                                mentions: None,
                                kind: "merge".to_string(),
                                file: None,
                                red_packet: None,
                                transfer: None,
                                aa_bill: None,
                                link: None,
                            },
                        )
                        .await?,
                    );
                    continue;
                }
                for (_, message) in sources.iter() {
                    sent.push(
                        services::send_to(
                            &state,
                            &user,
                            &raw_session,
                            SendPayload {
                                content: message_str(message, "content"),
                                quote: None,
                                mentions: None,
                                kind: message_str(message, "kind"),
                                file: message.get("file").cloned().filter(|v| !v.is_null()),
                                red_packet: None,
                                transfer: None,
                                aa_bill: None,
                                link: None,
                            },
                        )
                        .await?,
                    );
                }
            }
            if sent.is_empty() {
                return Err("没有有效的转发目标".to_string());
            }
            Ok(json!(sent))
        }),
    );
}

