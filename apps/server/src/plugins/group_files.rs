use serde_json::json;

use crate::plugins::auth::require_user;
use crate::services::{resolve_group, send_to, SendPayload};
use crate::state::{handler, Registry, SharedState};
use crate::store;
use crate::util;

fn key_ok(key: &str) -> bool {
    key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn notify_members(state: &SharedState, group_id: &str) {
    if let Ok(members) = store::group_members(&state.db, group_id).await {
        for member in members {
            state
                .hub
                .emit_to_user(
                    &member.user_id,
                    "group:update",
                    json!({ "groupId": group_id }),
                )
                .await;
        }
    }
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "group.file.list",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let (row, _) = resolve_group(&state, &me, &format!("g:{group_id}")).await?;
            let offset = util::i64_param(&params, "offset").unwrap_or(0).max(0);
            let limit = util::i64_param(&params, "limit").unwrap_or(50).clamp(1, 100);
            let (rows, total) = store::group_file_list(&state.db, &row.id, offset, limit).await?;
            let ids: Vec<String> = rows.iter().map(|item| item.uploader_id.clone()).collect();
            let names = store::users_by_ids(&state.db, &ids).await?;
            let files: Vec<serde_json::Value> = rows
                .iter()
                .map(|item| {
                    let name = names
                        .iter()
                        .find(|(id, _)| id == &item.uploader_id)
                        .map(|(_, name)| name.clone())
                        .unwrap_or_else(|| item.uploader_id.clone());
                    json!({
                        "key": item.key,
                        "name": item.name,
                        "mime": item.mime,
                        "size": item.size,
                        "uploader": name,
                        "createdAt": util::iso_from_ms(item.created_at),
                    })
                })
                .collect();
            Ok(json!({ "files": files, "total": total }))
        }),
    );

    registry.add(
        "group.file.add",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let key = util::str_param(&params, "key");
            let (row, _) = resolve_group(&state, &me, &format!("g:{group_id}")).await?;
            if !key_ok(&key) {
                return Err("文件不存在".to_string());
            }
            let media = store::media_info(&state.db, &key)
                .await?
                .ok_or_else(|| "文件不存在".to_string())?;
            let uploader = store::media_uploader(&state.db, &key).await?;
            if uploader != me.id {
                return Err("只能添加自己上传的文件".to_string());
            }
            let (name, mime, size) = media;
            store::group_file_save(&state.db, &row.id, &key, &name, &mime, size, &me.id).await?;
            let payload = SendPayload {
                content: format!("/files/{key}"),
                quote: None,
                mentions: None,
                kind: "file".to_string(),
                file: Some(json!({ "name": name, "size": size, "mime": mime })),
                red_packet: None,
                transfer: None,
                aa_bill: None,
                link: None,
};
            let _ = send_to(&state, &me, &format!("g:{}", row.id), payload).await;
            notify_members(&state, &row.id).await;
            Ok(json!({ "key": key }))
        }),
    );

    registry.add(
        "group.file.delete",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let group_id = util::str_param(&params, "groupId");
            let key = util::str_param(&params, "key");
            let (row, role) = resolve_group(&state, &me, &format!("g:{group_id}")).await?;
            let entry = store::group_file_by_key(&state.db, &row.id, &key)
                .await?
                .ok_or_else(|| "文件不存在".to_string())?;
            if entry.uploader_id != me.id && role != "owner" && role != "admin" {
                return Err("只有上传者或群管理可以删除".to_string());
            }
            store::group_file_remove(&state.db, &row.id, &entry.key).await?;
            let in_groups = store::group_file_count_by_key(&state.db, &entry.key).await?;
            let in_messages =
                store::count_messages_with_content(&state.db, &format!("/files/{}", entry.key))
                    .await?;
            if in_groups == 0 && in_messages == 0 {
                crate::plugins::files::remove_object(&state, &entry.key).await;
                store::media_remove(&state.db, &entry.key).await?;
            }
            notify_members(&state, &row.id).await;
            Ok(json!(true))
        }),
    );
}
