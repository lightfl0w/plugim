use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::hub::AuthUser;
use crate::plugins::auth::require_user;
use crate::state::{handler, Registry, SharedState};
use crate::store;
use crate::util;

async fn username_to_user(state: &SharedState, username: &str) -> Result<store::UserRow, String> {
    store::user_by_username(&state.db, &username.trim().to_lowercase())
        .await?
        .ok_or_else(|| format!("用户 {username} 不存在"))
}

async fn notify(state: &SharedState, user_id: &str) {
    state
        .hub
        .emit_to_user(user_id, "friend:update", json!({ "at": util::now_ms() }))
        .await;
}

async fn build_list(state: &SharedState, me: &AuthUser) -> Result<Value, String> {
    let edges = store::friend_edges(&state.db, &me.id).await?;
    let mut other_ids: Vec<String> = Vec::new();
    for edge in &edges {
        let other = if edge.requester_id == me.id {
            edge.addressee_id.clone()
        } else {
            edge.requester_id.clone()
        };
        if !other_ids.contains(&other) {
            other_ids.push(other);
        }
    }
    let users = store::users_by_ids(&state.db, &other_ids).await?;
    let name_by_id: HashMap<String, String> = users.iter().cloned().collect();

    let mut friends: Vec<String> = Vec::new();
    let mut incoming: Vec<String> = Vec::new();
    let mut outgoing: Vec<String> = Vec::new();
    let mut blocked: Vec<String> = Vec::new();
    let mut incoming_messages = Map::new();
    for edge in &edges {
        let other = if edge.requester_id == me.id {
            &edge.addressee_id
        } else {
            &edge.requester_id
        };
        let Some(name) = name_by_id.get(other) else {
            continue;
        };
        if edge.status == "accepted" {
            friends.push(name.clone());
        } else if edge.status == "blocked" {
            if edge.requester_id == me.id {
                blocked.push(name.clone());
            }
        } else if edge.requester_id == me.id {
            outgoing.push(name.clone());
        } else {
            incoming.push(name.clone());
            if let Some(message) = edge.message.as_ref() {
                incoming_messages.insert(name.clone(), json!(message));
            }
        }
    }
    friends.sort();
    incoming.sort();
    outgoing.sort();
    blocked.sort();

    let mut remarks = Map::new();
    for (friend_id, remark) in store::friend_remarks(&state.db, &me.id).await? {
        if let Some(name) = name_by_id.get(&friend_id) {
            remarks.insert(name.clone(), json!(remark));
        }
    }

    let groups: Vec<Value> = store::friend_groups_list(&state.db, &me.id)
        .await?
        .iter()
        .map(|(id, name)| json!({ "id": id, "name": name }))
        .collect();

    let group_map: HashMap<String, String> = store::friend_group_map(&state.db, &me.id)
        .await?
        .into_iter()
        .collect();
    let mut friend_groups = Map::new();
    for (id, name) in users.iter() {
        friend_groups.insert(
            name.clone(),
            match group_map.get(id) {
                Some(group_id) => json!(group_id),
                None => Value::Null,
            },
        );
    }

    let mut starred: Vec<String> = Vec::new();
    for friend_id in store::friend_stars(&state.db, &me.id).await? {
        if let Some(name) = name_by_id.get(&friend_id) {
            if friends.contains(name) {
                starred.push(name.clone());
            }
        }
    }

    Ok(json!({
        "friends": friends,
        "incoming": incoming,
        "outgoing": outgoing,
        "blocked": blocked,
        "remarks": remarks,
        "groups": groups,
        "friendGroups": friend_groups,
        "starred": starred,
        "incomingMessages": incoming_messages,
    }))
}

async fn is_friend(state: &SharedState, me_id: &str, target_id: &str) -> Result<bool, String> {
    let edges = store::friend_edges(&state.db, me_id).await?;
    Ok(edges.iter().any(|edge| {
        edge.status == "accepted"
            && ((edge.requester_id == me_id && edge.addressee_id == target_id)
                || (edge.requester_id == target_id && edge.addressee_id == me_id))
    }))
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "user.search",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let keyword: String = util::str_param(&params, "keyword")
                .trim()
                .to_lowercase()
                .chars()
                .take(32)
                .collect();
            if keyword.is_empty() {
                return Ok(json!({ "users": [] }));
            }
            let all = store::all_users(&state.db).await?;
            let mut hits: Vec<store::UserRow> = all
                .into_iter()
                .filter(|user| {
                    user.id != me.id
                        && !user.banned
                        && user.username.to_lowercase().contains(&keyword)
                })
                .collect();
            hits.sort_by(|a, b| a.username.cmp(&b.username));
            hits.truncate(20);
            let edges = store::friend_edges(&state.db, &me.id).await?;
            let relation = |user_id: &str| -> &'static str {
                let edge = edges.iter().find(|edge| {
                    (edge.requester_id == user_id && edge.addressee_id == me.id)
                        || (edge.requester_id == me.id && edge.addressee_id == user_id)
                });
                match edge {
                    None => "none",
                    Some(edge) if edge.status == "accepted" => "friend",
                    Some(edge) if edge.status == "blocked" => "blocked",
                    Some(edge) if edge.requester_id == me.id => "outgoing",
                    Some(_) => "incoming",
                }
            };
            let users: Vec<Value> = hits
                .iter()
                .map(|user| {
                    json!({
                        "name": user.username,
                        "relation": relation(&user.id),
                        "title": user.title,
                    })
                })
                .collect();
            Ok(json!({ "users": users }))
        }),
    );

    registry.add(
        "friend.request",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            if target.id == me.id {
                return Err("不能添加自己为好友".to_string());
            }
            let message: String = util::str_param(&params, "message")
                .trim()
                .chars()
                .take(50)
                .collect();
            if store::friend_add_blocked(&state.db, &me.id, &target.id).await? {
                return Err("对方所在的群设置了禁止互加好友".to_string());
            }
            let edges = store::friend_edges(&state.db, &me.id).await?;
            let existing = edges.iter().find(|edge| {
                (edge.requester_id == target.id && edge.addressee_id == me.id)
                    || (edge.requester_id == me.id && edge.addressee_id == target.id)
            });
            if let Some(edge) = existing {
                if edge.status == "blocked" {
                    return Err("当前无法发送好友申请".to_string());
                }
                if edge.status == "accepted" {
                    return Err("你们已经是好友了".to_string());
                }
                if edge.requester_id == me.id {
                    return Err("已发送过好友申请，等待对方处理".to_string());
                }
                store::friend_accept(&state.db, &me.id, &target.id).await?;
                notify(&state, &target.id).await;
                return build_list(&state, &me).await;
            }
            store::friend_request(&state.db, &me.id, &target.id, &message).await?;
            notify(&state, &target.id).await;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.accept",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            store::friend_accept(&state.db, &target.id, &me.id).await?;
            notify(&state, &target.id).await;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.reject",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            store::friend_remove_between(&state.db, &me.id, &target.id).await?;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.remove",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            store::friend_remove_between(&state.db, &me.id, &target.id).await?;
            notify(&state, &target.id).await;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.block",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            store::friend_block(&state.db, &me.id, &target.id).await?;
            notify(&state, &target.id).await;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.unblock",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            store::friend_unblock(&state.db, &me.id, &target.id).await?;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.remark",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            if target.id == me.id {
                return Err("不能给自己设置备注".to_string());
            }
            if !is_friend(&state, &me.id, &target.id).await? {
                return Err("只能给好友设置备注".to_string());
            }
            let remark: String = util::str_param(&params, "remark").trim().to_string();
            if remark.chars().count() > 24 {
                return Err("备注不能超过 24 个字".to_string());
            }
            store::friend_set_remark(&state.db, &me.id, &target.id, &remark).await?;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.star",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            if target.id == me.id {
                return Err("不能特别关心自己".to_string());
            }
            if !is_friend(&state, &me.id, &target.id).await? {
                return Err("只能特别关心好友".to_string());
            }
            let on = params.get("on").and_then(|value| value.as_bool()).unwrap_or(true);
            store::friend_set_star(&state.db, &me.id, &target.id, on).await?;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.list",
        handler(|state, conn, _params| async move {
            let me = require_user(&conn)?;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.group.create",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let name: String = util::str_param(&params, "name").trim().chars().take(16).collect();
            if name.is_empty() {
                return Err("分组名称不能为空".to_string());
            }
            let rows = store::friend_groups_list(&state.db, &me.id).await?;
            if rows.len() >= 20 {
                return Err("分组数量已达上限".to_string());
            }
            if rows.iter().any(|(_, existing)| existing == &name) {
                return Err("分组名称已存在".to_string());
            }
            store::friend_group_create(&state.db, &me.id, &name).await?;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.group.rename",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            if group_id.is_empty() {
                return Err("缺少分组".to_string());
            }
            let name: String = util::str_param(&params, "name").trim().chars().take(16).collect();
            if name.is_empty() {
                return Err("分组名称不能为空".to_string());
            }
            let rows = store::friend_groups_list(&state.db, &me.id).await?;
            if !rows.iter().any(|(id, _)| id == &group_id) {
                return Err("分组不存在".to_string());
            }
            if rows
                .iter()
                .any(|(id, existing)| id != &group_id && existing == &name)
            {
                return Err("分组名称已存在".to_string());
            }
            store::friend_group_rename(&state.db, &me.id, &group_id, &name).await?;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.group.remove",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            if group_id.is_empty() {
                return Err("缺少分组".to_string());
            }
            let rows = store::friend_groups_list(&state.db, &me.id).await?;
            if !rows.iter().any(|(id, _)| id == &group_id) {
                return Err("分组不存在".to_string());
            }
            store::friend_group_remove(&state.db, &me.id, &group_id).await?;
            build_list(&state, &me).await
        }),
    );

    registry.add(
        "friend.group.move",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let target = username_to_user(&state, &util::str_param(&params, "username")).await?;
            if !is_friend(&state, &me.id, &target.id).await? {
                return Err("只能移动好友".to_string());
            }
            let group_id = util::str_param(&params, "groupId");
            if !group_id.is_empty() {
                let rows = store::friend_groups_list(&state.db, &me.id).await?;
                if !rows.iter().any(|(id, _)| id == &group_id) {
                    return Err("分组不存在".to_string());
                }
                store::friend_group_set(&state.db, &me.id, &target.id, Some(&group_id)).await?;
            } else {
                store::friend_group_set(&state.db, &me.id, &target.id, None).await?;
            }
            build_list(&state, &me).await
        }),
    );
}

