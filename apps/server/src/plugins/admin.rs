use std::collections::HashMap;

use serde_json::{json, Value};

use crate::plugins::auth::require_admin;
use crate::state::{handler, Registry};
use crate::store::{self, RowExt, SearchParams};
use crate::util;


pub fn register(registry: &mut Registry) {
    registry.add(
        "admin.users",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            let users = store::all_users(&state.db).await?;
            let online: Vec<String> = state.hub.online_user_ids().await;
            let list: Vec<Value> = users
                .iter()
                .map(|user| {
                    json!({
                        "id": user.id,
                        "username": user.username,
                        "createdAt": util::iso_from_ms(user.created_at),
                        "isAdmin": user.is_admin,
                        "banned": user.banned,
                        "deptId": user.dept_id,
                        "title": user.title,
                        "online": online.contains(&user.id),
                    })
                })
                .collect();
            Ok(json!(list))
        }),
    );

    registry.add(
        "admin.ban",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let user_id = util::str_param(&params, "userId");
            if user_id == me.id {
                return Err("不能封禁自己".to_string());
            }
            let target = store::user_by_id(&state.db, &user_id)
                .await?
                .ok_or_else(|| "用户不存在".to_string())?;
            let on = util::bool_param(&params, "on");
            store::set_flag(&state.db, &user_id, "banned", on).await?;
            if on {
                state.hub.kick_user(&user_id).await;
            }
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.ban",
                &format!("{}账号 {}", if on { "封禁" } else { "解封" }, target.username),
            )
            .await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "admin.grant",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let user_id = util::str_param(&params, "userId");
            let target = store::user_by_id(&state.db, &user_id)
                .await?
                .ok_or_else(|| "用户不存在".to_string())?;
            let on = util::bool_param(&params, "on");
            store::set_flag(&state.db, &user_id, "isAdmin", on).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.grant",
                &format!("{} {} 管理员", if on { "授予" } else { "取消" }, target.username),
            )
            .await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "admin.password",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let user_id = util::str_param(&params, "userId");
            let password = util::str_param(&params, "password");
            if user_id.is_empty() {
                return Err("缺少用户".to_string());
            }
            if password.chars().count() < 6 {
                return Err("密码至少需要 6 位".to_string());
            }
            let target = store::user_by_id(&state.db, &user_id)
                .await?
                .ok_or_else(|| "用户不存在".to_string())?;
            let hash = util::hash_password(&password)?;
            store::set_password(&state.db, &user_id, &hash).await?;
            store::set_must_change(&state.db, &user_id, true).await?;
            state.hub.kick_user(&user_id).await;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.password",
                &format!("重置 {} 的密码", target.username),
            )
            .await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "admin.user.create",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let username = util::str_param(&params, "username").trim().to_lowercase();
            let password = util::str_param(&params, "password");
            let valid = (2..=24).contains(&username.len())
                && username
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
            if !valid {
                return Err("用户名需为 2-24 位小写字母、数字或下划线".to_string());
            }
            if password.chars().count() < 6 {
                return Err("密码至少需要 6 位".to_string());
            }
            if store::user_by_username(&state.db, &username).await?.is_some() {
                return Err("用户名已被占用".to_string());
            }
            let dept_id = {
                let raw = util::str_param(&params, "deptId");
                if raw.is_empty() {
                    None
                } else {
                    Some(raw)
                }
            };
            if let Some(id) = dept_id.as_ref() {
                if store::department_by_id(&state.db, id).await?.is_none() {
                    return Err("部门不存在".to_string());
                }
            }
            let title: String = util::str_param(&params, "title").trim().chars().take(20).collect();
            let hash = util::hash_password(&password)?;
            let row = store::create_user(&state.db, &username, &hash).await?;
            if dept_id.is_some() || !title.is_empty() {
                let title_value = if title.is_empty() { None } else { Some(title.as_str()) };
                store::set_org(&state.db, &row.id, dept_id.as_deref(), title_value).await?;
            }
            store::set_must_change(&state.db, &row.id, true).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.user.create",
                &format!("创建账号 {username}"),
            )
            .await?;
            Ok(json!({
                "id": row.id,
                "username": row.username,
                "createdAt": util::iso_from_ms(row.created_at),
            }))
        }),
    );

    registry.add(
        "admin.groups",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            let rows = store::group_list_all(&state.db).await?;
            let owner_ids: Vec<String> = rows.iter().map(|row| row.owner_id.clone()).collect();
            let names: HashMap<String, String> =
                store::users_by_ids(&state.db, &owner_ids).await?.into_iter().collect();
            let counts: HashMap<String, i64> = sqlx::query(
                "SELECT group_id, count(*) AS total FROM group_members GROUP BY group_id",
            )
            .fetch_all(&state.db)
            .await
            .unwrap_or_default()
            .iter()
            .map(|row| (row.get_str("group_id"), row.get_i64("total")))
            .collect();
            let list: Vec<Value> = rows
                .iter()
                .map(|row| {
                    json!({
                        "id": row.id,
                        "name": row.name,
                        "ownerId": row.owner_id,
                        "ownerName": names.get(&row.owner_id).cloned().unwrap_or_else(|| row.owner_id.clone()),
                        "notice": row.notice,
                        "muteAll": row.mute_all,
                        "noFriendAdd": row.no_friend_add,
                        "joinApproval": row.join_approval,
                        "createdAt": util::iso_from_ms(row.created_at),
                        "memberCount": counts.get(&row.id).copied().unwrap_or(0),
                    })
                })
                .collect();
            Ok(json!(list))
        }),
    );

    registry.add(
        "admin.group.delete",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let group_id = util::str_param(&params, "groupId");
            let row = store::group_by_id(&state.db, &group_id)
                .await?
                .ok_or_else(|| "群组不存在".to_string())?;
            store::group_delete(&state.db, &group_id).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.group.delete",
                &format!("解散群「{}」", row.name),
            )
            .await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "admin.messages",
        handler(|state, conn, params| async move {
            require_admin(&state, &conn).await?;
            let keyword = {
                let raw: String = util::str_param(&params, "keyword").chars().take(100).collect();
                if raw.trim().is_empty() {
                    None
                } else {
                    Some(raw)
                }
            };
            let session = {
                let raw: String = util::str_param(&params, "session").chars().take(200).collect();
                if raw.trim().is_empty() {
                    None
                } else {
                    Some(raw)
                }
            };
            let sender = {
                let raw: String = util::str_param(&params, "sender").chars().take(64).collect();
                if raw.trim().is_empty() {
                    None
                } else {
                    Some(raw)
                }
            };
            let offset = util::i64_param(&params, "offset").unwrap_or(0).max(0);
            let limit = util::i64_param(&params, "limit").unwrap_or(20).clamp(1, 100);
            let (rows, total) = store::search_messages(
                &state.db,
                &SearchParams {
                    keyword,
                    session,
                    sessions: None,
                    sender,
                    from: None,
                    to: None,
                    offset,
                    limit,
                },
            )
            .await?;
            Ok(json!({ "rows": rows, "total": total }))
        }),
    );

    registry.add(
        "admin.files",
        handler(|state, conn, params| async move {
            require_admin(&state, &conn).await?;
            let offset = util::i64_param(&params, "offset").unwrap_or(0).max(0);
            let limit = util::i64_param(&params, "limit").unwrap_or(20).clamp(1, 100);
            let (rows, total, total_bytes) = store::media_list(&state.db, offset, limit).await?;
            let ids: Vec<String> = rows.iter().map(|row| row.uploader_id.clone()).collect();
            let names: HashMap<String, String> =
                store::users_by_ids(&state.db, &ids).await?.into_iter().collect();
            let list: Vec<Value> = rows
                .iter()
                .map(|row| {
                    json!({
                        "key": row.key,
                        "name": row.name,
                        "mime": row.mime,
                        "size": row.size,
                        "uploaderId": row.uploader_id,
                        "uploaderName": names.get(&row.uploader_id).cloned().unwrap_or_else(|| row.uploader_id.clone()),
                        "createdAt": util::iso_from_ms(row.created_at),
                    })
                })
                .collect();
            Ok(json!({ "rows": list, "total": total, "totalBytes": total_bytes }))
        }),
    );

    registry.add(
        "admin.files.delete",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let key = util::str_param(&params, "key");
            if key.len() != 32 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("文件不存在".to_string());
            }
            let Some((name, _, _)) = store::media_info(&state.db, &key).await? else {
                return Err("文件不存在".to_string());
            };
            if store::count_messages_with_content(&state.db, &format!("/files/{key}")).await? > 0 {
                return Err("该文件仍被消息引用，请先删除相关消息".to_string());
            }
            if crate::scheduler::group_file_uses(&state, &key).await {
                return Err("该文件仍被群文件引用，请先删除群文件".to_string());
            }
            let path = state.cfg.storage_dir.join(&key);
            let _ = std::fs::remove_file(path);
            store::media_remove(&state.db, &key).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.file.delete",
                &format!("删除文件「{name}」"),
            )
            .await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "admin.retention.get",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            Ok(json!({ "days": crate::scheduler::retention_days(&state).await }))
        }),
    );

    registry.add(
        "admin.retention.set",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let days = util::i64_param(&params, "days").unwrap_or(-1);
            if !(0..=3650).contains(&days) {
                return Err("保留天数需为 0 到 3650 之间的整数".to_string());
            }
            store::settings_set(&state.db, "message_retention_days", &days.to_string()).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.retention",
                &format!("设置消息保留 {days} 天"),
            )
            .await?;
            Ok(json!({ "days": days }))
        }),
    );

    registry.add(
        "admin.site.get",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            let name = store::settings_get(&state.db, "site_name")
                .await?
                .unwrap_or_default();
            let icon = store::settings_get(&state.db, "site_icon")
                .await?
                .unwrap_or_default();
            Ok(json!({ "name": name, "icon": icon }))
        }),
    );

    registry.add(
        "admin.site.set",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let name = util::str_param(&params, "name").trim().to_string();
            if name.chars().count() > 30 {
                return Err("站点名称不能超过 30 个字符".to_string());
            }
            let icon = util::str_param(&params, "icon").trim().to_string();
            if !icon.is_empty() && crate::scheduler::file_key_of(&icon).is_none() {
                return Err("图标地址无效".to_string());
            }
            store::settings_set(&state.db, "site_name", &name).await?;
            store::settings_set(&state.db, "site_icon", &icon).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.site",
                &format!("更新站点信息（名称：{}）", if name.is_empty() { "默认" } else { &name }),
            )
            .await?;
            let meta = json!({ "name": name, "icon": icon });
            state.hub.broadcast("site:meta", meta.clone()).await;
            Ok(meta)
        }),
    );

    registry.add(
        "admin.cleanup",
        handler(|state, conn, _params| async move {
            let me = require_admin(&state, &conn).await?;
            if crate::scheduler::retention_days(&state).await == 0 {
                return Err("尚未设置保留天数".to_string());
            }
            let (deleted, files) = crate::scheduler::run_cleanup(&state).await;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.cleanup",
                &format!("手动清理：删除 {deleted} 条消息、{files} 个文件"),
            )
            .await?;
            Ok(json!({ "deleted": deleted, "files": files }))
        }),
    );

    registry.add(
        "admin.stats",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            let users = store::count_users(&state.db).await?;
            let groups = store::group_list_all(&state.db).await?.len() as i64;
            let messages = store::message_count(&state.db).await?;
            let media_bytes = store::message_media_bytes(&state.db).await?;
            let files = store::media_total_count(&state.db).await?;
            let file_bytes: i64 = sqlx::query("SELECT coalesce(sum(size), 0) AS total FROM media_files")
                .fetch_one(&state.db)
                .await
                .map(|row| {
                    use sqlx::Row;
                    row.get("total")
                })
                .unwrap_or(0);
            Ok(json!({
                "users": users,
                "groups": groups,
                "connections": state.hub.connections().await,
                "messages": messages,
                "mediaBytes": file_bytes + media_bytes,
                "files": files,
                "retentionDays": crate::scheduler::retention_days(&state).await,
            }))
        }),
    );

    registry.add(
        "admin.trend",
        handler(|state, conn, params| async move {
            require_admin(&state, &conn).await?;
            let days = util::i64_param(&params, "days").unwrap_or(14);
            let points = store::trend(&state.db, days).await?;
            Ok(json!({ "days": points.len(), "points": points }))
        }),
    );

    registry.add(
        "admin.tasks",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            Ok(json!(crate::scheduler::list(&state).await))
        }),
    );

    registry.add(
        "admin.task.run",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let name = util::str_param(&params, "name");
            let result = crate::scheduler::run(&state, &name, "manual").await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.task.run",
                &format!("执行任务「{name}」"),
            )
            .await?;
            Ok(result)
        }),
    );

    registry.add(
        "admin.task.set",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let name = util::str_param(&params, "name");
            let enabled = params.get("enabled").and_then(|value| value.as_bool());
            let interval = util::i64_param(&params, "intervalMinutes");
            let result = crate::scheduler::set(&state, &name, enabled, interval).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.task.set",
                &format!("更新任务「{name}」"),
            )
            .await?;
            Ok(result)
        }),
    );

    registry.add(
        "admin.register.get",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            let invite = store::settings_get(&state.db, "invite_code")
                .await?
                .unwrap_or_else(|| state.cfg.invite_code.clone());
            let allow = store::settings_get(&state.db, "allow_register")
                .await?
                .map(|raw| raw != "false")
                .unwrap_or(state.cfg.allow_register);
            Ok(json!({ "inviteCode": invite, "allowRegister": allow }))
        }),
    );

    registry.add(
        "admin.register.set",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            if let Some(allow) = params.get("allowRegister").and_then(|value| value.as_bool()) {
                store::settings_set(&state.db, "allow_register", if allow { "true" } else { "false" })
                    .await?;
            }
            if let Some(invite) = params.get("inviteCode").filter(|value| value.is_string()) {
                let code: String = invite
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .chars()
                    .take(64)
                    .collect();
                store::settings_set(&state.db, "invite_code", &code).await?;
            }
            let invite = store::settings_get(&state.db, "invite_code")
                .await?
                .unwrap_or_else(|| state.cfg.invite_code.clone());
            let allow = store::settings_get(&state.db, "allow_register")
                .await?
                .map(|raw| raw != "false")
                .unwrap_or(state.cfg.allow_register);
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.register",
                &format!(
                    "注册策略：{}{}",
                    if allow { "允许自助注册" } else { "关闭自助注册" },
                    if invite.is_empty() { "" } else { "，已设邀请码" }
                ),
            )
            .await?;
            Ok(json!({ "inviteCode": invite, "allowRegister": allow }))
        }),
    );

    registry.add(
        "admin.mode.get",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            let mode = store::settings_get(&state.db, "app_mode")
                .await?
                .unwrap_or_default();
            Ok(json!(if mode == "chat" { "chat" } else { "enterprise" }))
        }),
    );

    registry.add(
        "admin.mode.set",
        handler(|state, conn, params| async move {
            let me = require_admin(&state, &conn).await?;
            let mode = util::str_param(&params, "mode");
            if mode != "chat" && mode != "enterprise" {
                return Err("无效的站点模式".to_string());
            }
            store::settings_set(&state.db, "app_mode", &mode).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "admin.mode",
                &format!(
                    "站点模式：{}",
                    if mode == "chat" { "聊天模式" } else { "企业模式" }
                ),
            )
            .await?;
            Ok(json!(mode))
        }),
    );

    registry.add(
        "admin.audit.list",
        handler(|state, conn, params| async move {
            require_admin(&state, &conn).await?;
            let keyword: String = util::str_param(&params, "keyword").chars().take(100).collect();
            let category = {
                let raw = util::str_param(&params, "category");
                if ["auth", "admin", "org"].contains(&raw.as_str()) {
                    Some(raw)
                } else {
                    None
                }
            };
            let offset = util::i64_param(&params, "offset").unwrap_or(0).max(0);
            let limit = util::i64_param(&params, "limit").unwrap_or(20).clamp(1, 100);
            let (rows, total) = store::audits_list(
                &state.db,
                if keyword.trim().is_empty() { None } else { Some(&keyword) },
                category.as_deref(),
                offset,
                limit,
            )
            .await?;
            Ok(json!({ "rows": rows, "total": total }))
        }),
    );
}
