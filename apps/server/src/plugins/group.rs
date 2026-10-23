use std::collections::HashMap;

use serde_json::{json, Value};

use crate::hub::AuthUser;
use crate::plugins::auth::require_user;
use crate::services::{self, session_of, SendPayload};
use crate::state::{handler, Registry, SharedState};
use crate::store::{self, GroupRow};
use crate::util;

const DAY_MS: i64 = 86_400_000;
const INVITE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

fn new_invite_code() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter()
        .map(|byte| INVITE_ALPHABET[*byte as usize % INVITE_ALPHABET.len()] as char)
        .collect()
}

fn invite_expired(row: &GroupRow) -> bool {
    row.invite_expires_at
        .map(|at| at <= util::now_ms())
        .unwrap_or(false)
}

async fn info_of(state: &SharedState, row: &GroupRow, me_id: &str) -> Result<Value, String> {
    let members = store::group_members(&state.db, &row.id).await?;
    let mine = members.iter().find(|member| member.user_id == me_id);
    let my_role = mine.map(|member| member.role.clone());
    let manager = matches!(my_role.as_deref(), Some("owner") | Some("admin"));
    let pending = if manager {
        store::join_request_count(&state.db, &row.id).await?
    } else {
        0
    };
    Ok(json!({
        "id": row.id,
        "name": row.name,
        "ownerId": row.owner_id,
        "notice": row.notice,
        "muteAll": row.mute_all,
        "noFriendAdd": row.no_friend_add,
        "inviteCode": if manager { row.invite_code.clone() } else { None::<String> },
        "inviteExpiresAt": if manager { row.invite_expires_at.map(util::iso_from_ms) } else { None::<String> },
        "joinApproval": row.join_approval,
        "pendingRequests": pending,
        "createdAt": util::iso_from_ms(row.created_at),
        "memberCount": members.len(),
        "myRole": my_role,
        "myMuted": mine.map(|member| member.muted).unwrap_or(false),
    }))
}

async fn require_membership(
    state: &SharedState,
    group_id: &str,
    me: &AuthUser,
) -> Result<(GroupRow, Vec<store::GroupMemberRow>, String), String> {
    let row = store::group_by_id(&state.db, group_id)
        .await?
        .ok_or_else(|| "群组不存在".to_string())?;
    let members = store::group_members(&state.db, group_id).await?;
    let mine = members
        .iter()
        .find(|member| member.user_id == me.id)
        .ok_or_else(|| "你不在该群中".to_string())?;
    let role = mine.role.clone();
    Ok((row, members, role))
}

async fn require_manage(
    state: &SharedState,
    group_id: &str,
    me: &AuthUser,
) -> Result<(GroupRow, Vec<store::GroupMemberRow>, String), String> {
    let result = require_membership(state, group_id, me).await?;
    if result.2 != "owner" && result.2 != "admin" {
        return Err("需要群主或管理员权限".to_string());
    }
    Ok(result)
}

async fn notify_members(state: &SharedState, group_id: &str) {
    if let Ok(ids) = store::group_member_ids(&state.db, group_id).await {
        for id in ids {
            state
                .hub
                .emit_to_user(&id, "group:update", json!({ "groupId": group_id }))
                .await;
        }
    }
}

async fn say(state: &SharedState, group_id: &str, me: &AuthUser, kind: &str, text: &str) {
    let payload = SendPayload {
        content: text.to_string(),
        quote: None,
        mentions: None,
        kind: kind.to_string(),
        file: None,
        red_packet: None,
        transfer: None,
        aa_bill: None,
        link: None,
};
    let _ = services::send_to(state, me, &session_of(group_id), payload).await;
}

async fn notify_admins(state: &SharedState, group_id: &str, username: &str) {
    if let Ok(members) = store::group_members(&state.db, group_id).await {
        for member in members {
            if member.role != "owner" && member.role != "admin" {
                continue;
            }
            state
                .hub
                .emit_to_user(
                    &member.user_id,
                    "group:request",
                    json!({ "groupId": group_id, "username": username }),
                )
                .await;
        }
    }
}

async fn username_to_user(state: &SharedState, username: &str) -> Result<store::UserRow, String> {
    store::user_by_username(&state.db, &username.trim().to_lowercase())
        .await?
        .ok_or_else(|| format!("用户 {username} 不存在"))
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "group.create",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let name: String = util::str_param(&params, "name").trim().chars().take(32).collect();
            if name.chars().count() < 2 {
                return Err("群名称至少 2 个字符".to_string());
            }
            let row = store::group_create(&state.db, &name, &me.id).await?;
            store::group_add_member(&state.db, &row.id, &me.id).await?;
            store::group_set_role(&state.db, &row.id, &me.id, "owner").await?;
            for username in util::string_list(&params, "members").iter().take(200) {
                if let Ok(Some(user)) =
                    store::user_by_username(&state.db, &username.to_lowercase()).await
                {
                    if user.id != me.id {
                        store::group_add_member(&state.db, &row.id, &user.id).await?;
                    }
                }
            }
            notify_members(&state, &row.id).await;
            info_of(&state, &row, &me.id).await
        }),
    );

    registry.add(
        "group.list",
        handler(|state, conn, _params| async move {
            let me = require_user(&conn)?;
            let rows = store::groups_of(&state.db, &me.id).await?;
            let mut out: Vec<Value> = Vec::new();
            for row in rows {
                out.push(info_of(&state, &row, &me.id).await?);
            }
            Ok(json!(out))
        }),
    );

    registry.add(
        "group.info",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_membership(&state, &group_id, &me).await?;
            info_of(&state, &row, &me.id).await
        }),
    );

    registry.add(
        "group.members",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (_, members, _) = require_membership(&state, &group_id, &me).await?;
            let ids: Vec<String> = members.iter().map(|member| member.user_id.clone()).collect();
            let names: HashMap<String, String> =
                store::users_by_ids(&state.db, &ids).await?.into_iter().collect();
            let mut list: Vec<Value> = members
                .iter()
                .map(|member| {
                    json!({
                        "username": names.get(&member.user_id).cloned().unwrap_or_else(|| member.user_id.clone()),
                        "role": member.role,
                        "muted": member.muted,
                        "joinedAt": util::iso_from_ms(member.joined_at),
                        "title": member.title,
                    })
                })
                .collect();
            list.sort_by(|a, b| {
                let rank = |value: &Value| match value.get("role").and_then(|r| r.as_str()) {
                    Some("owner") => 0,
                    Some("admin") => 1,
                    _ => 2,
                };
                let ra = rank(a);
                let rb = rank(b);
                ra.cmp(&rb).then_with(|| {
                    let na = a.get("username").and_then(|v| v.as_str()).unwrap_or("");
                    let nb = b.get("username").and_then(|v| v.as_str()).unwrap_or("");
                    na.cmp(nb)
                })
            });
            let online = state.hub.online_user_ids().await.len();
            Ok(json!({ "members": list, "online": online }))
        }),
    );

    registry.add(
        "group.rename",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_manage(&state, &group_id, &me).await?;
            let name: String = util::str_param(&params, "name").trim().chars().take(32).collect();
            if name.chars().count() < 2 {
                return Err("群名称至少 2 个字符".to_string());
            }
            store::group_update(&state.db, &group_id, "name", &name).await?;
            notify_members(&state, &group_id).await;
            let mut updated = row;
            updated.name = name;
            info_of(&state, &updated, &me.id).await
        }),
    );

    registry.add(
        "group.notice.set",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_manage(&state, &group_id, &me).await?;
            let notice: String = util::str_param(&params, "notice").trim().chars().take(500).collect();
            store::group_update(&state.db, &group_id, "notice", &notice).await?;
            notify_members(&state, &group_id).await;
            if !notice.is_empty() {
                say(&state, &group_id, &me, "notice", &notice).await;
            } else if !row.notice.is_empty() {
                let text = format!("{} 撤销了群公告", me.username);
                say(&state, &group_id, &me, "system", &text).await;
            }
            let mut updated = row;
            updated.notice = notice;
            info_of(&state, &updated, &me.id).await
        }),
    );

    registry.add(
        "group.muteAll",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_manage(&state, &group_id, &me).await?;
            let on = util::bool_param(&params, "on");
            store::group_set_bool(&state.db, &group_id, "mute_all", on).await?;
            notify_members(&state, &group_id).await;
            let text = if on {
                format!("{} 开启了全员禁言", me.username)
            } else {
                format!("{} 解除了全员禁言", me.username)
            };
            say(&state, &group_id, &me, "system", &text).await;
            let mut updated = row;
            updated.mute_all = on;
            info_of(&state, &updated, &me.id).await
        }),
    );

    registry.add(
        "group.noFriendAdd",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_manage(&state, &group_id, &me).await?;
            let on = util::bool_param(&params, "on");
            store::group_set_bool(&state.db, &group_id, "no_friend_add", on).await?;
            notify_members(&state, &group_id).await;
            let mut updated = row;
            updated.no_friend_add = on;
            info_of(&state, &updated, &me.id).await
        }),
    );

    registry.add(
        "group.member.add",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            require_manage(&state, &group_id, &me).await?;
            for username in util::string_list(&params, "usernames").iter().take(100) {
                let user = username_to_user(&state, username).await?;
                store::group_add_member(&state.db, &group_id, &user.id).await?;
                store::join_request_remove(&state.db, &group_id, &user.id).await?;
            }
            notify_members(&state, &group_id).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "group.invite.set",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_manage(&state, &group_id, &me).await?;
            let expires_in = util::str_param(&params, "expiresIn");
            let ttl = match expires_in.as_str() {
                "" | "never" => 0,
                "7d" => 7 * DAY_MS,
                "30d" => 30 * DAY_MS,
                _ => return Err("非法有效期".to_string()),
            };
            let mut code = new_invite_code();
            for _ in 0..5 {
                if store::group_by_invite(&state.db, &code).await?.is_none() {
                    break;
                }
                code = new_invite_code();
            }
            let expires_at = if ttl > 0 { Some(util::now_ms() + ttl) } else { None };
            store::group_set_invite(&state.db, &group_id, Some(&code), expires_at).await?;
            notify_members(&state, &group_id).await;
            let mut updated = row;
            updated.invite_code = Some(code);
            updated.invite_expires_at = expires_at;
            info_of(&state, &updated, &me.id).await
        }),
    );

    registry.add(
        "group.invite.disable",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_manage(&state, &group_id, &me).await?;
            store::group_set_invite(&state.db, &group_id, None, None).await?;
            notify_members(&state, &group_id).await;
            let mut updated = row;
            updated.invite_code = None;
            updated.invite_expires_at = None;
            info_of(&state, &updated, &me.id).await
        }),
    );

    registry.add(
        "group.joinApproval",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_manage(&state, &group_id, &me).await?;
            let on = util::bool_param(&params, "on");
            store::group_set_bool(&state.db, &group_id, "join_approval", on).await?;
            notify_members(&state, &group_id).await;
            let mut updated = row;
            updated.join_approval = on;
            info_of(&state, &updated, &me.id).await
        }),
    );

    registry.add(
        "group.join",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let code: String = util::str_param(&params, "code").trim().to_uppercase();
            if code.is_empty() {
                return Err("缺少邀请码".to_string());
            }
            let row = store::group_by_invite(&state.db, &code)
                .await?
                .ok_or_else(|| "邀请链接无效或已过期".to_string())?;
            if invite_expired(&row) {
                return Err("邀请链接无效或已过期".to_string());
            }
            let members = store::group_members(&state.db, &row.id).await?;
            if !members.iter().any(|member| member.user_id == me.id) {
                if row.join_approval {
                    let message: String = util::str_param(&params, "message")
                        .trim()
                        .chars()
                        .take(60)
                        .collect();
                    store::join_request_upsert(&state.db, &row.id, &me.id, &message).await?;
                    notify_admins(&state, &row.id, &me.username).await;
                    return Ok(json!({ "status": "pending", "groupId": row.id, "name": row.name }));
                }
                store::group_add_member(&state.db, &row.id, &me.id).await?;
                notify_members(&state, &row.id).await;
            }
            Ok(json!({ "status": "joined", "groupId": row.id, "name": row.name }))
        }),
    );

    registry.add(
        "group.requests",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            require_manage(&state, &group_id, &me).await?;
            let rows = store::join_requests(&state.db, &group_id).await?;
            let ids: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
            let names: HashMap<String, String> =
                store::users_by_ids(&state.db, &ids).await?.into_iter().collect();
            let out: Vec<Value> = rows
                .iter()
                .map(|(id, message, created_at)| {
                    json!({
                        "username": names.get(id).cloned().unwrap_or_else(|| id.clone()),
                        "message": message,
                        "createdAt": util::iso_from_ms(*created_at),
                    })
                })
                .collect();
            Ok(json!(out))
        }),
    );

    registry.add(
        "group.request.approve",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            require_manage(&state, &group_id, &me).await?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            let pending = store::join_requests(&state.db, &group_id).await?;
            if !pending.iter().any(|(id, _, _)| id == &target.id) {
                return Err("该申请已处理".to_string());
            }
            store::join_request_remove(&state.db, &group_id, &target.id).await?;
            if util::bool_param(&params, "on") {
                store::group_add_member(&state.db, &group_id, &target.id).await?;
                notify_members(&state, &group_id).await;
            }
            notify_admins(&state, &group_id, &target.username).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "group.member.remove",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, role) = require_membership(&state, &group_id, &me).await?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            if target.id == row.owner_id {
                return Err("不能移除群主".to_string());
            }
            if target.id == me.id {
                store::group_remove_member(&state.db, &group_id, &me.id).await?;
                notify_members(&state, &group_id).await;
                return Ok(json!(true));
            }
            if role == "member" {
                return Err("只有管理员可以移除成员".to_string());
            }
            store::group_remove_member(&state.db, &group_id, &target.id).await?;
            notify_members(&state, &group_id).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "group.member.role",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, role) = require_membership(&state, &group_id, &me).await?;
            if role != "owner" {
                return Err("只有群主可以调整角色".to_string());
            }
            let next_role = util::str_param(&params, "role");
            if next_role != "admin" && next_role != "member" {
                return Err("非法角色".to_string());
            }
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            if target.id == row.owner_id {
                return Err("不能调整群主角色".to_string());
            }
            store::group_set_role(&state.db, &group_id, &target.id, &next_role).await?;
            notify_members(&state, &group_id).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "group.transferOwner",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, members, _) = require_membership(&state, &group_id, &me).await?;
            if row.owner_id != me.id {
                return Err("只有群主可以转让群主".to_string());
            }
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            if target.id == me.id {
                return Err("不能转让给自己".to_string());
            }
            if !members.iter().any(|member| member.user_id == target.id) {
                return Err("该用户不在群中".to_string());
            }
            store::group_set_owner(&state.db, &group_id, &target.id).await?;
            store::group_set_role(&state.db, &group_id, &target.id, "owner").await?;
            store::group_set_role(&state.db, &group_id, &me.id, "admin").await?;
            notify_members(&state, &group_id).await;
            let text = format!("{} 已将群主转让给 {}", me.username, target.username);
            say(&state, &group_id, &me, "system", &text).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "group.member.title",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (_, members, role) = require_membership(&state, &group_id, &me).await?;
            if role != "owner" {
                return Err("只有群主可以设置头衔".to_string());
            }
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            if !members.iter().any(|member| member.user_id == target.id) {
                return Err("该用户不在群中".to_string());
            }
            let title: String = util::str_param(&params, "title").trim().chars().take(12).collect();
            let value = if title.is_empty() { None } else { Some(title.as_str()) };
            store::group_set_member_title(&state.db, &group_id, &target.id, value).await?;
            notify_members(&state, &group_id).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "group.member.mute",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (_, members, role) = require_membership(&state, &group_id, &me).await?;
            if role == "member" {
                return Err("没有权限".to_string());
            }
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            let Some(member) = members.iter().find(|member| member.user_id == target.id) else {
                return Err("该用户不在群中".to_string());
            };
            if member.role != "member" {
                return Err("不能禁言管理员或群主".to_string());
            }
            let muted = util::bool_param(&params, "muted");
            store::group_set_muted(&state.db, &group_id, &target.id, muted).await?;
            notify_members(&state, &group_id).await;
            let text = if muted {
                format!("{} 禁言了 {}", me.username, target.username)
            } else {
                format!("{} 解除了 {} 的禁言", me.username, target.username)
            };
            say(&state, &group_id, &me, "system", &text).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "group.essence.set",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            require_manage(&state, &group_id, &me).await?;
            let message_id = util::str_param(&params, "messageId");
            let message = store::message_by_id(&state.db, &message_id)
                .await?
                .ok_or_else(|| "消息不属于该群".to_string())?;
            if message.get("session").and_then(|v| v.as_str()) != Some(&session_of(&group_id)) {
                return Err("消息不属于该群".to_string());
            }
            if util::bool_param(&params, "on") {
                if message.get("recalledAt").map(|v| !v.is_null()).unwrap_or(false) {
                    return Err("消息已撤回".to_string());
                }
                store::essence_add(&state.db, &group_id, &message_id, &me.username).await?;
            } else {
                store::essence_remove(&state.db, &group_id, &message_id).await?;
            }
            if let Ok(ids) = store::group_member_ids(&state.db, &group_id).await {
                for id in ids {
                    state
                        .hub
                        .emit_to_user(&id, "essence:update", json!({ "groupId": group_id }))
                        .await;
                }
            }
            Ok(json!(true))
        }),
    );

    registry.add(
        "group.essence.list",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            require_membership(&state, &group_id, &me).await?;
            Ok(json!(store::essence_list(&state.db, &group_id).await?))
        }),
    );

    registry.add(
        "group.delete",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_membership(&state, &group_id, &me).await?;
            if row.owner_id != me.id {
                return Err("只有群主可以解散群".to_string());
            }
            notify_members(&state, &group_id).await;
            store::group_delete(&state.db, &group_id).await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "group.leave",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _, _) = require_membership(&state, &group_id, &me).await?;
            if row.owner_id == me.id {
                return Err("群主请先解散群或转让群主".to_string());
            }
            store::group_remove_member(&state.db, &group_id, &me.id).await?;
            notify_members(&state, &group_id).await;
            Ok(json!(true))
        }),
    );
}
