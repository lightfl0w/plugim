use serde_json::{json, Value};

use crate::hub::AuthUser;
use crate::state::{SharedState};
use crate::store::{self, GroupRow, SaveMessage, UserRow};

pub fn p2p_key(a: &str, b: &str) -> String {
    let mut names = [a.to_string(), b.to_string()];
    names.sort();
    format!("p2p:{}", names.join("|"))
}

pub fn session_of(group_id: &str) -> String {
    format!("g:{group_id}")
}

pub async fn resolve_p2p(
    state: &SharedState,
    me: &AuthUser,
    raw_session: &str,
) -> Result<UserRow, String> {
    let peer_name = raw_session.trim_start_matches("p2p:").trim().to_string();
    if peer_name.is_empty() || peer_name == me.username {
        return Err("会话不存在".to_string());
    }
    let peer = store::user_by_username(&state.db, &peer_name)
        .await?
        .ok_or_else(|| format!("用户 {peer_name} 不存在"))?;
    let edges = store::friend_edges(&state.db, &me.id).await?;
    let accepted = edges.iter().any(|edge| {
        edge.status == "accepted"
            && ((edge.requester_id == peer.id && edge.addressee_id == me.id)
                || (edge.requester_id == me.id && edge.addressee_id == peer.id))
    });
    if !accepted {
        return Err("只能和好友私聊".to_string());
    }
    Ok(peer)
}

pub async fn resolve_group(
    state: &SharedState,
    me: &AuthUser,
    raw_session: &str,
) -> Result<(GroupRow, String), String> {
    let group_id = raw_session.trim_start_matches("g:").trim().to_string();
    if group_id.is_empty() {
        return Err("群组不存在".to_string());
    }
    let row = store::group_by_id(&state.db, &group_id)
        .await?
        .ok_or_else(|| "群组不存在".to_string())?;
    let members = store::group_members(&state.db, &group_id).await?;
    let mine = members
        .iter()
        .find(|member| member.user_id == me.id)
        .ok_or_else(|| "你不在该群中".to_string())?;
    Ok((row, mine.role.clone()))
}

pub async fn storage_session_of(
    state: &SharedState,
    me: &AuthUser,
    raw_session: &str,
) -> Result<String, String> {
    if raw_session.starts_with("p2p:") {
        let peer = resolve_p2p(state, me, raw_session).await?;
        return Ok(p2p_key(&me.username, &peer.username));
    }
    if raw_session.starts_with("g:") {
        resolve_group(state, me, raw_session).await?;
        return Ok(raw_session.to_string());
    }
    if !raw_session.is_empty() && raw_session != state.cfg.default_session {
        return Err("会话不存在".to_string());
    }
    Ok(state.cfg.default_session.clone())
}

pub async fn visible_sessions(state: &SharedState, me: &AuthUser) -> Result<Vec<String>, String> {
    let mut out = vec![state.cfg.default_session.clone()];
    let edges = store::friend_edges(&state.db, &me.id).await?;
    let mut friend_ids: Vec<String> = Vec::new();
    for edge in edges.iter().filter(|edge| edge.status == "accepted") {
        let other = if edge.requester_id == me.id {
            &edge.addressee_id
        } else {
            &edge.requester_id
        };
        if !friend_ids.contains(other) {
            friend_ids.push(other.clone());
        }
    }
    for (_, username) in store::users_by_ids(&state.db, &friend_ids).await? {
        out.push(p2p_key(&me.username, &username));
    }
    for group in store::groups_of(&state.db, &me.id).await? {
        out.push(session_of(&group.id));
    }
    out.dedup();
    Ok(out)
}

pub fn raw_session_of(username: &str, storage: &str) -> String {
    if !storage.starts_with("p2p:") {
        return storage.to_string();
    }
    let peer = storage
        .trim_start_matches("p2p:")
        .split('|')
        .find(|name| *name != username)
        .unwrap_or("");
    format!("p2p:{peer}")
}

pub struct SendPayload {
    pub content: String,
    pub quote: Option<Value>,
    pub mentions: Option<Value>,
    pub kind: String,
    pub file: Option<Value>,
    pub link: Option<Value>,
    pub red_packet: Option<Value>,
    pub transfer: Option<Value>,
    pub aa_bill: Option<Value>,
}

pub async fn send_to(
    state: &SharedState,
    user: &AuthUser,
    raw_session: &str,
    payload: SendPayload,
) -> Result<Value, String> {
    if !raw_session.starts_with("p2p:")
        && !raw_session.starts_with("g:")
        && raw_session != state.cfg.default_session
    {
        return Err("会话不存在".to_string());
    }

    crate::metrics::metrics().add_message(1);
    let preview_body = crate::plugins::push::preview(
        &payload.kind,
        &payload.content,
        payload
            .file
            .as_ref()
            .and_then(|file| file.get("name"))
            .and_then(|name| name.as_str()),
    );

    if raw_session.starts_with("p2p:") {
        let peer = resolve_p2p(state, user, raw_session).await?;
        let saved = store::save_message(
            &state.db,
            SaveMessage {
                session: p2p_key(&user.username, &peer.username),
                sender: user.username.clone(),
                content: payload.content,
                quote: payload.quote,
                mentions: payload.mentions,
                kind: payload.kind,
                file: payload.file,
                link: payload.link.clone(),
                red_packet: payload.red_packet,
                transfer: payload.transfer,
                aa_bill: payload.aa_bill,
            },
        )
        .await?;
        let mut mine = saved.clone();
        mine["session"] = json!(format!("p2p:{}", peer.username));
        let mut theirs = saved;
        theirs["session"] = json!(format!("p2p:{}", user.username));
        state
            .hub
            .emit_to_user(&user.id, "message:new", json!({ "message": mine.clone() }))
            .await;
        state
            .hub
            .emit_to_user(&peer.id, "message:new", json!({ "message": theirs.clone() }))
            .await;
        crate::plugins::bots::emit(
            state,
            "message.new",
            json!({ "session": format!("p2p:{}", user.username), "message": theirs }),
        );
        crate::plugins::push::deliver(
            state.clone(),
            vec![peer.id.clone()],
            crate::plugins::push::PushPayload {
                title: user.username.clone(),
                body: preview_body.clone(),
                session: format!("p2p:{}", user.username),
            },
        );
        return Ok(mine);
    }

    if raw_session.starts_with("g:") {
        let (row, role) = resolve_group(state, user, raw_session).await?;
        if role != "owner" && role != "admin" {
            if role == "member" && row.mute_all {
                return Err("群主已开启全员禁言".to_string());
            }
            let members = store::group_members(&state.db, &row.id).await?;
            if members
                .iter()
                .find(|member| member.user_id == user.id)
                .map(|member| member.muted)
                .unwrap_or(false)
            {
                return Err("你已被禁言".to_string());
            }
        }
        let saved = store::save_message(
            &state.db,
            SaveMessage {
                session: raw_session.to_string(),
                sender: user.username.clone(),
                content: payload.content,
                quote: payload.quote,
                mentions: payload.mentions,
                kind: payload.kind,
                file: payload.file,
                link: payload.link.clone(),
                red_packet: payload.red_packet,
                transfer: payload.transfer,
                aa_bill: payload.aa_bill,
            },
        )
        .await?;
        let ids = store::group_member_ids(&state.db, &row.id).await?;
        state
            .hub
            .emit_to_users(&ids, "message:new", json!({ "message": saved.clone() }))
            .await;
        crate::plugins::bots::emit(
            state,
            "message.new",
            json!({ "session": raw_session, "message": saved.clone() }),
        );
        let others: Vec<String> = ids
            .iter()
            .filter(|id| id.as_str() != user.id)
            .cloned()
            .collect();
        crate::plugins::push::deliver(
            state.clone(),
            others,
            crate::plugins::push::PushPayload {
                title: row.name.clone(),
                body: format!("{}: {}", user.username, preview_body),
                session: raw_session.to_string(),
            },
        );
        return Ok(saved);
    }

    let saved = store::save_message(
        &state.db,
        SaveMessage {
            session: raw_session.to_string(),
            sender: user.username.clone(),
            content: payload.content,
            quote: payload.quote,
            mentions: payload.mentions,
            kind: payload.kind,
            file: payload.file,
            link: payload.link.clone(),
            red_packet: payload.red_packet,
            transfer: payload.transfer,
            aa_bill: payload.aa_bill,
        },
    )
    .await?;
    state
        .hub
        .broadcast("message:new", json!({ "message": saved.clone() }))
        .await;
    crate::plugins::bots::emit(
        state,
        "message.new",
        json!({ "session": raw_session, "message": saved.clone() }),
    );
    crate::plugins::push::deliver_all(
        state.clone(),
        crate::plugins::push::PushPayload {
            title: user.username.clone(),
            body: preview_body,
            session: raw_session.to_string(),
        },
        user.id.clone(),
    );
    Ok(saved)
}

pub async fn broadcast_message_update(state: &SharedState, message: &Value) {
    let session = message
        .get("session")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if session.starts_with("p2p:") {
        let names: Vec<&str> = session.trim_start_matches("p2p:").split('|').collect();
        if names.len() == 2 {
            for (index, name) in names.iter().enumerate() {
                if let Ok(Some(user)) = store::user_by_username(&state.db, name).await {
                    let peer = names[1 - index];
                    let mut payload = message.clone();
                    payload["session"] = json!(format!("p2p:{peer}"));
                    state
                        .hub
                        .emit_to_user(&user.id, "message:update", json!({ "message": payload }))
                        .await;
                }
            }
        }
        return;
    }
    if session.starts_with("g:") {
        let group_id = session.trim_start_matches("g:");
        if let Ok(ids) = store::group_member_ids(&state.db, group_id).await {
            state
                .hub
                .emit_to_users(&ids, "message:update", json!({ "message": message }))
                .await;
        }
        return;
    }
    state
        .hub
        .broadcast("message:update", json!({ "message": message }))
        .await;
}

pub fn message_str(message: &Value, key: &str) -> String {
    message
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}
