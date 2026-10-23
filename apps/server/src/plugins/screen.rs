use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::hub::AuthUser;
use crate::plugins::auth::require_user;
use crate::services::{resolve_group, SendPayload};
use crate::state::{handler, Registry, SharedState};
use crate::store;
use crate::util;

const ROOM_LIMIT: usize = 6;
const RING_TIMEOUT_MS: u64 = 60_000;

#[derive(Debug, Clone)]
struct Call {
    id: String,
    from_id: String,
    from_name: String,
    to_id: String,
    to_name: String,
    kind: String,
    active: bool,
    started_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct Room {
    id: String,
    group_id: String,
    group_name: String,
    kind: String,
    host_id: String,
    members: Vec<(String, String)>,
}

#[derive(Default)]
struct ScreenState {
    calls: HashMap<String, Call>,
    rooms: HashMap<String, Room>,
}

fn screen_state() -> &'static Mutex<ScreenState> {
    static STATE: OnceLock<Mutex<ScreenState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ScreenState::default()))
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "voice" => "语音通话",
        "video" => "视频通话",
        _ => "屏幕共享",
    }
}

fn fmt_duration(ms: i64) -> String {
    let total = (ms.max(0) / 1000) as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn call_of(state: &ScreenState, user_id: &str) -> Option<Call> {
    state
        .calls
        .values()
        .find(|call| call.from_id == user_id || call.to_id == user_id)
        .cloned()
}

fn room_of(state: &ScreenState, user_id: &str) -> Option<Room> {
    state
        .rooms
        .values()
        .find(|room| room.members.iter().any(|(id, _)| id == user_id))
        .cloned()
}

fn room_of_group(state: &ScreenState, group_id: &str) -> Option<Room> {
    state
        .rooms
        .values()
        .find(|room| room.group_id == group_id)
        .cloned()
}

fn room_info(room: &Room) -> Value {
    let host = room
        .members
        .iter()
        .find(|(id, _)| id == &room.host_id)
        .map(|(_, name)| name.clone())
        .unwrap_or_default();
    json!({
        "roomId": room.id,
        "groupId": room.group_id,
        "groupName": room.group_name,
        "kind": room.kind,
        "host": host,
        "members": room.members.iter().map(|(_, name)| name.clone()).collect::<Vec<String>>(),
    })
}

async fn emit_room(state: &SharedState, room: &Room, kind: &str, from: &str, targets: Option<Vec<String>>) {
    let payload = json!({
        "type": kind,
        "roomId": room.id,
        "groupId": room.group_id,
        "groupName": room.group_name,
        "kind": room.kind,
        "from": from,
    });
    let ids = targets.unwrap_or_else(|| room.members.iter().map(|(id, _)| id.clone()).collect());
    state.hub.emit_to_users(&ids, "group:call", payload).await;
}

async fn record_group(state: &SharedState, speaker: &AuthUser, group_id: &str, text: &str) {
    let _ = crate::services::send_to(
        state,
        speaker,
        &format!("g:{group_id}"),
        SendPayload {
            content: text.to_string(),
            quote: None,
            mentions: None,
            kind: "system".to_string(),
            file: None,
            red_packet: None,
            transfer: None,
            aa_bill: None,
            link: None,
},
    )
    .await;
}

async fn record_p2p(state: &SharedState, speaker: &AuthUser, call: &Call, text: &str) {
    let other = if speaker.id == call.from_id {
        call.to_name.clone()
    } else {
        call.from_name.clone()
    };
    let _ = crate::services::send_to(
        state,
        speaker,
        &format!("p2p:{other}"),
        SendPayload {
            content: text.to_string(),
            quote: None,
            mentions: None,
            kind: "system".to_string(),
            file: None,
            red_packet: None,
            transfer: None,
            aa_bill: None,
            link: None,
},
    )
    .await;
}

async fn finish_call(state: &SharedState, speaker: &AuthUser, call: &Call, outcome: &str) {
    let label = kind_label(&call.kind);
    let text = match outcome {
        "cancel" => format!("{label}已取消"),
        "decline" => format!("{label}已拒绝"),
        "missed" => format!("{label}无人接听"),
        _ => {
            let spent = util::now_ms() - call.started_at.unwrap_or_else(util::now_ms);
            format!("{label}时长 {}", fmt_duration(spent))
        }
    };
    record_p2p(state, speaker, call, &text).await;
}

async fn forward_signal(
    state: &SharedState,
    call: &Call,
    sender: &AuthUser,
    kind: &str,
    sdp: Option<&str>,
    candidate: Option<Value>,
) {
    let target = if sender.id == call.from_id {
        call.to_id.clone()
    } else {
        call.from_id.clone()
    };
    let mut payload = json!({
        "type": kind,
        "callId": call.id,
        "from": sender.username,
        "kind": call.kind,
    });
    if let Some(sdp) = sdp {
        payload["sdp"] = json!(sdp);
    }
    if let Some(candidate) = candidate {
        payload["candidate"] = candidate;
    }
    state.hub.emit_to_user(&target, "screen:signal", payload).await;
}

async fn are_friends(state: &SharedState, me_id: &str, other_id: &str) -> Result<bool, String> {
    let edges = store::friend_edges(&state.db, me_id).await?;
    Ok(edges.iter().any(|edge| {
        edge.status == "accepted"
            && ((edge.requester_id == me_id && edge.addressee_id == other_id)
                || (edge.requester_id == other_id && edge.addressee_id == me_id))
    }))
}

pub fn install_offline(state: SharedState) {
    let hook_state = state.clone();
    state.hub.on_offline(Arc::new(move |user_id: String| {
        let state = hook_state.clone();
        Box::pin(async move {
            cleanup_offline(&state, &user_id).await;
        })
    }));
}

async fn cleanup_offline(state: &SharedState, user_id: &str) {
    let call = {
        let guard = screen_state().lock().await;
        call_of(&guard, user_id)
    };
    if let Some(call) = call {
        let peer_id = if call.from_id == user_id {
            call.to_id.clone()
        } else {
            call.from_id.clone()
        };
        let gone_name = if call.from_id == user_id {
            call.from_name.clone()
        } else {
            call.to_name.clone()
        };
        state
            .hub
            .emit_to_user(
                &peer_id,
                "screen:signal",
                json!({ "type": "hangup", "callId": call.id, "from": gone_name, "kind": call.kind }),
            )
            .await;
        let active = call.active;
        {
            let mut guard = screen_state().lock().await;
            guard.calls.remove(&call.id);
        }
        if let Ok(Some(speaker)) = store::user_by_id(&state.db, &peer_id).await {
            let auth = AuthUser {
                id: speaker.id,
                username: speaker.username,
                must_change: speaker.must_change_password,
                session_id: None,
            };
            finish_call(state, &auth, &call, if active { "done" } else { "cancel" }).await;
        }
    }

    let room = {
        let guard = screen_state().lock().await;
        room_of(&guard, user_id)
    };
    let Some(room) = room else {
        return;
    };
    let gone_name = room
        .members
        .iter()
        .find(|(id, _)| id == user_id)
        .map(|(_, name)| name.clone())
        .unwrap_or_default();
    let end = room.host_id == user_id || room.members.len() <= 1;
    if end {
        {
            let mut guard = screen_state().lock().await;
            guard.rooms.remove(&room.id);
        }
        emit_room(state, &room, "end", &gone_name, None).await;
        if let Ok(Some(speaker)) = store::user_by_id(&state.db, user_id).await {
            let auth = AuthUser {
                id: speaker.id,
                username: speaker.username,
                must_change: speaker.must_change_password,
                session_id: None,
            };
            record_group(state, &auth, &room.group_id, &format!("{gone_name} 结束了群通话")).await;
        }
        return;
    }
    {
        let mut guard = screen_state().lock().await;
        if let Some(target) = guard.rooms.get_mut(&room.id) {
            target.members.retain(|(id, _)| id != user_id);
        }
    }
    emit_room(state, &room, "leave", &gone_name, None).await;
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "screen.config",
        handler(|state, conn, _params| async move {
            require_user(&conn)?;
            Ok(json!(state.cfg.ice_servers))
        }),
    );

    registry.add(
        "screen.invite",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let to = util::str_param(&params, "to").trim().to_lowercase();
            let raw_kind = util::str_param(&params, "kind");
            let kind = match raw_kind.as_str() {
                "voice" | "video" => raw_kind,
                _ => "screen".to_string(),
            };
            let peer = store::user_by_username(&state.db, &to)
                .await?
                .ok_or_else(|| "用户不存在".to_string())?;
            if peer.id == me.id {
                return Err("用户不存在".to_string());
            }
            if !are_friends(&state, &me.id, &peer.id).await? {
                return Err("只能向好友发起通话".to_string());
            }
            {
                let guard = screen_state().lock().await;
                if call_of(&guard, &me.id).is_some() || room_of(&guard, &me.id).is_some() {
                    return Err("你正在进行通话".to_string());
                }
                if call_of(&guard, &peer.id).is_some() || room_of(&guard, &peer.id).is_some() {
                    return Err("对方正忙".to_string());
                }
            }
            if !state.hub.is_online(&peer.id).await {
                return Err("对方不在线".to_string());
            }
            let call = Call {
                id: util::uuid(),
                from_id: me.id.clone(),
                from_name: me.username.clone(),
                to_id: peer.id.clone(),
                to_name: peer.username.clone(),
                kind: kind.clone(),
                active: false,
                started_at: None,
            };
            {
                let mut guard = screen_state().lock().await;
                guard.calls.insert(call.id.clone(), call.clone());
            }
            state
                .hub
                .emit_to_user(
                    &peer.id,
                    "screen:signal",
                    json!({ "type": "invite", "callId": call.id, "from": me.username, "kind": kind }),
                )
                .await;

            let timer_state = state.clone();
            let timer_call = call.clone();
            let timer_user = me.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(RING_TIMEOUT_MS)).await;
                let still_there = {
                    let guard = screen_state().lock().await;
                    guard
                        .calls
                        .get(&timer_call.id)
                        .map(|existing| !existing.active)
                        .unwrap_or(false)
                };
                if !still_there {
                    return;
                }
                {
                    let mut guard = screen_state().lock().await;
                    guard.calls.remove(&timer_call.id);
                }
                let parties = [
                    (timer_call.from_id.clone(), timer_call.to_name.clone()),
                    (timer_call.to_id.clone(), timer_call.from_name.clone()),
                ];
                for (id, from) in parties {
                    timer_state
                        .hub
                        .emit_to_user(
                            &id,
                            "screen:signal",
                            json!({
                                "type": "timeout",
                                "callId": timer_call.id,
                                "from": from,
                                "kind": timer_call.kind,
                            }),
                        )
                        .await;
                }
                finish_call(&timer_state, &timer_user, &timer_call, "missed").await;
            });

            Ok(json!({ "callId": call.id, "kind": call.kind }))
        }),
    );

    registry.add(
        "screen.state",
        handler(|state, conn, _params| async move {
            let me = require_user(&conn)?;
            let call = {
                let guard = screen_state().lock().await;
                call_of(&guard, &me.id)
            };
            let Some(call) = call else {
                return Ok(Value::Null);
            };
            let incoming = call.to_id == me.id;
            let _ = state;
            Ok(json!({
                "callId": call.id,
                "kind": call.kind,
                "peer": if incoming { call.from_name } else { call.to_name },
                "active": call.active,
                "incoming": incoming,
            }))
        }),
    );

    registry.add(
        "screen.accept",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let call_id = util::str_param(&params, "callId");
            let call = {
                let mut guard = screen_state().lock().await;
                let Some(call) = guard.calls.get_mut(&call_id) else {
                    return Err("通话不存在或已结束".to_string());
                };
                if call.to_id != me.id {
                    return Err("通话不存在或已结束".to_string());
                }
                call.active = true;
                call.started_at = Some(util::now_ms());
                call.clone()
            };
            forward_signal(&state, &call, &me, "accept", None, None).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "screen.decline",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let call_id = util::str_param(&params, "callId");
            let call = {
                let guard = screen_state().lock().await;
                match guard.calls.get(&call_id) {
                    None => return Ok(json!(true)),
                    Some(call) => call.clone(),
                }
            };
            if call.from_id != me.id && call.to_id != me.id {
                return Err("无权操作该通话".to_string());
            }
            if !call.active {
                finish_call(&state, &me, &call, "decline").await;
            }
            forward_signal(&state, &call, &me, "decline", None, None).await;
            screen_state().lock().await.calls.remove(&call.id);
            Ok(json!(true))
        }),
    );

    registry.add(
        "screen.hangup",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let call_id = util::str_param(&params, "callId");
            let call = {
                let guard = screen_state().lock().await;
                match guard.calls.get(&call_id) {
                    None => return Ok(json!(true)),
                    Some(call) => call.clone(),
                }
            };
            if call.from_id != me.id && call.to_id != me.id {
                return Err("无权结束该通话".to_string());
            }
            if call.active {
                finish_call(&state, &me, &call, "done").await;
            } else if call.from_id == me.id {
                finish_call(&state, &me, &call, "cancel").await;
            }
            forward_signal(&state, &call, &me, "hangup", None, None).await;
            screen_state().lock().await.calls.remove(&call.id);
            Ok(json!(true))
        }),
    );

    registry.add(
        "screen.signal",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let call_id = util::str_param(&params, "callId");
            let kind = util::str_param(&params, "type");
            if !["offer", "answer", "ice"].contains(&kind.as_str()) {
                return Err("非法信令类型".to_string());
            }
            let call = {
                let guard = screen_state().lock().await;
                guard
                    .calls
                    .get(&call_id)
                    .cloned()
                    .ok_or_else(|| "通话不存在或已结束".to_string())?
            };
            if call.from_id != me.id && call.to_id != me.id {
                return Err("无权转发该信令".to_string());
            }
            if !call.active {
                return Err("通话尚未接通".to_string());
            }
            let sdp = params.get("sdp").and_then(|value| value.as_str());
            let candidate = params.get("candidate").cloned();
            if kind == "ice" {
                let Some(value) = candidate.as_ref() else {
                    return Err("非法 ICE 候选".to_string());
                };
                if !value.is_object() {
                    return Err("非法 ICE 候选".to_string());
                }
            } else if sdp.is_none() {
                return Err("缺少 SDP".to_string());
            }
            let sdp: Option<String> = sdp.map(|value| value.chars().take(32 * 1024).collect());
            forward_signal(
                &state,
                &call,
                &me,
                &kind,
                sdp.as_deref(),
                if kind == "ice" { candidate } else { None },
            )
            .await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "call.group.info",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            resolve_group(&state, &me, &format!("g:{group_id}")).await?;
            let room = {
                let guard = screen_state().lock().await;
                room_of_group(&guard, &group_id)
            };
            Ok(match room {
                Some(room) => room_info(&room),
                None => Value::Null,
            })
        }),
    );

    registry.add(
        "call.group.start",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let raw_kind = util::str_param(&params, "kind");
            let kind = if raw_kind == "video" { "video" } else { "voice" };
            let (row, _) = resolve_group(&state, &me, &format!("g:{group_id}")).await?;
            let members = store::group_members(&state.db, &row.id).await?;
            {
                let guard = screen_state().lock().await;
                if call_of(&guard, &me.id).is_some() || room_of(&guard, &me.id).is_some() {
                    return Err("你正在进行通话".to_string());
                }
                if room_of_group(&guard, &row.id).is_some() {
                    return Err("该群已有通话进行中".to_string());
                }
            }
            let room = Room {
                id: util::uuid(),
                group_id: row.id.clone(),
                group_name: row.name.clone(),
                kind: kind.to_string(),
                host_id: me.id.clone(),
                members: vec![(me.id.clone(), me.username.clone())],
            };
            {
                let mut guard = screen_state().lock().await;
                guard.rooms.insert(room.id.clone(), room.clone());
            }
            let targets: Vec<String> = members
                .iter()
                .map(|member| member.user_id.clone())
                .filter(|id| id != &me.id)
                .collect();
            emit_room(&state, &room, "invite", &me.username, Some(targets)).await;
            record_group(
                &state,
                &me,
                &row.id,
                &format!("{} 发起了群{}", me.username, kind_label(kind)),
            )
            .await;
            Ok(room_info(&room))
        }),
    );

    registry.add(
        "call.group.join",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let room_id = util::str_param(&params, "roomId");
            let room = {
                let guard = screen_state().lock().await;
                guard
                    .rooms
                    .get(&room_id)
                    .cloned()
                    .ok_or_else(|| "通话已结束".to_string())?
            };
            resolve_group(&state, &me, &format!("g:{}", room.group_id)).await?;
            {
                let guard = screen_state().lock().await;
                if call_of(&guard, &me.id).is_some() {
                    return Err("你正在进行通话".to_string());
                }
                if let Some(current) = room_of(&guard, &me.id) {
                    if current.id != room.id {
                        return Err("你正在进行其他群通话".to_string());
                    }
                }
            }
            let others: Vec<String> = room
                .members
                .iter()
                .filter(|(id, _)| id != &me.id)
                .map(|(_, name)| name.clone())
                .collect();
            let already = room.members.iter().any(|(id, _)| id == &me.id);
            if !already {
                if room.members.len() >= ROOM_LIMIT {
                    return Err(format!("群通话最多 {ROOM_LIMIT} 人"));
                }
                let mut updated = room.clone();
                updated.members.push((me.id.clone(), me.username.clone()));
                {
                    let mut guard = screen_state().lock().await;
                    guard.rooms.insert(room.id.clone(), updated.clone());
                }
                let targets: Vec<String> = updated
                    .members
                    .iter()
                    .filter(|(id, _)| id != &me.id)
                    .map(|(id, _)| id.clone())
                    .collect();
                emit_room(&state, &updated, "join", &me.username, Some(targets)).await;
                return Ok(json!({ "room": room_info(&updated), "others": others }));
            }
            Ok(json!({ "room": room_info(&room), "others": others }))
        }),
    );

    registry.add(
        "call.group.leave",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let room_id = util::str_param(&params, "roomId");
            let room = {
                let mut guard = screen_state().lock().await;
                let Some(room) = guard.rooms.get_mut(&room_id) else {
                    return Ok(json!(true));
                };
                if !room.members.iter().any(|(id, _)| id == &me.id) {
                    return Ok(json!(true));
                }
                room.members.retain(|(id, _)| id != &me.id);
                let cloned = room.clone();
                if room.host_id == me.id || room.members.is_empty() {
                    guard.rooms.remove(&room_id);
                }
                cloned
            };
            if room.host_id == me.id || room.members.is_empty() {
                emit_room(&state, &room, "end", &me.username, None).await;
                record_group(&state, &me, &room.group_id, &format!("{} 结束了群通话", me.username)).await;
                return Ok(json!(true));
            }
            emit_room(&state, &room, "leave", &me.username, None).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "call.group.end",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let room_id = util::str_param(&params, "roomId");
            let room = {
                let mut guard = screen_state().lock().await;
                match guard.rooms.remove(&room_id) {
                    None => return Ok(json!(true)),
                    Some(room) => room,
                }
            };
            if room.host_id != me.id {
                let mut guard = screen_state().lock().await;
                guard.rooms.insert(room.id.clone(), room.clone());
                return Err("只有发起人可以结束通话".to_string());
            }
            emit_room(&state, &room, "end", &me.username, None).await;
            record_group(&state, &me, &room.group_id, &format!("{} 结束了群通话", me.username)).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "call.group.signal",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let room_id = util::str_param(&params, "roomId");
            let kind = util::str_param(&params, "type");
            if !["offer", "answer", "ice"].contains(&kind.as_str()) {
                return Err("非法信令类型".to_string());
            }
            let room = {
                let guard = screen_state().lock().await;
                guard
                    .rooms
                    .get(&room_id)
                    .cloned()
                    .ok_or_else(|| "通话已结束".to_string())?
            };
            if !room.members.iter().any(|(id, _)| id == &me.id) {
                return Err("你不在该通话中".to_string());
            }
            let target_name = util::str_param(&params, "to").trim().to_string();
            let Some((target_id, _)) = room
                .members
                .iter()
                .find(|(id, name)| name == &target_name && id != &me.id)
            else {
                return Err("对方不在该通话中".to_string());
            };
            let sdp = params.get("sdp").and_then(|value| value.as_str());
            let candidate = params.get("candidate").cloned();
            if kind == "ice" {
                let Some(value) = candidate.as_ref() else {
                    return Err("非法 ICE 候选".to_string());
                };
                if !value.is_object() {
                    return Err("非法 ICE 候选".to_string());
                }
            } else if sdp.is_none() {
                return Err("缺少 SDP".to_string());
            }
            let mut payload = json!({
                "type": kind,
                "roomId": room.id,
                "from": me.username,
            });
            if let Some(sdp) = sdp {
                payload["sdp"] = json!(sdp.chars().take(32 * 1024).collect::<String>());
            }
            if kind == "ice" {
                payload["candidate"] = candidate.unwrap_or(Value::Null);
            }
            state
                .hub
                .emit_to_user(target_id, "group:call:signal", payload)
                .await;
            Ok(json!(true))
        }),
    );
}
