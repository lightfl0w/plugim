use serde_json::{json, Value};

use crate::plugins::auth::require_user;
use crate::services::{send_to, SendPayload};
use crate::state::{handler, Registry, SharedState};
use crate::store;
use crate::util;

const CONTENT_MAX: usize = 1000;
const COMMENT_MAX: usize = 300;
const IMAGES_MAX: usize = 9;
const AUDIENCE_MAX: usize = 200;
const TIMELINE_MAX: i64 = 30;
const TIMELINE_DEFAULT: i64 = 10;
const KEY_MAX: usize = 200;

fn clamp_limit(value: Option<i64>) -> i64 {
    match value {
        Some(num) if num > 0 => num.min(TIMELINE_MAX),
        _ => TIMELINE_DEFAULT,
    }
}

async fn friend_ids_of(state: &SharedState, user_id: &str) -> Result<Vec<String>, String> {
    let edges = store::friend_edges(&state.db, user_id).await?;
    let mut out: Vec<String> = Vec::new();
    for edge in edges {
        if edge.status != "accepted" {
            continue;
        }
        let other = if edge.requester_id == user_id {
            edge.addressee_id
        } else {
            edge.requester_id
        };
        if !out.contains(&other) {
            out.push(other);
        }
    }
    Ok(out)
}

fn space_key_setting(user_id: &str) -> String {
    format!("space_key:{user_id}")
}

async fn space_key_of(state: &SharedState, user_id: &str) -> Result<Option<String>, String> {
    store::settings_get(&state.db, &space_key_setting(user_id)).await
}

async fn ensure_space_key(state: &SharedState, user_id: &str) -> Result<String, String> {
    if let Some(existing) = space_key_of(state, user_id).await? {
        return Ok(existing);
    }
    let key = util::uuid();
    store::settings_set(&state.db, &space_key_setting(user_id), &key).await?;
    Ok(key)
}

async fn build_posts(
    state: &SharedState,
    rows: &[store::MomentRow],
    viewer_id: &str,
) -> Result<Vec<Value>, String> {
    let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    let likes = store::moment_likes_of(&state.db, &ids).await?;
    let comments = store::moment_comments_of(&state.db, &ids).await?;
    let mut user_ids: Vec<String> = rows.iter().map(|row| row.author_id.clone()).collect();
    for like in &likes {
        user_ids.push(like.user_id.clone());
    }
    for comment in &comments {
        user_ids.push(comment.author_id.clone());
    }
    for row in rows {
        user_ids.extend(row.audience.iter().cloned());
    }
    let users = store::users_by_ids(&state.db, &user_ids).await?;
    let name_of = |id: &str| -> String {
        users
            .iter()
            .find(|(user_id, _)| user_id == id)
            .map(|(_, name)| name.clone())
            .unwrap_or_else(|| "未知用户".to_string())
    };
    let mut out: Vec<Value> = Vec::new();
    for row in rows {
        let row_likes: Vec<Value> = likes
            .iter()
            .filter(|like| like.post_id == row.id)
            .map(|like| json!({ "username": name_of(&like.user_id), "at": util::iso_from_ms(like.at) }))
            .collect();
        let row_comments: Vec<Value> = comments
            .iter()
            .filter(|comment| comment.post_id == row.id)
            .map(|comment| {
                json!({
                    "id": comment.id,
                    "author": name_of(&comment.author_id),
                    "content": comment.content,
                    "createdAt": util::iso_from_ms(comment.created_at),
                })
            })
            .collect();
        let audience: Vec<String> = if row.author_id == viewer_id {
            row.audience.iter().map(|id| name_of(id)).collect()
        } else {
            Vec::new()
        };
        out.push(json!({
            "id": row.id,
            "author": name_of(&row.author_id),
            "content": row.content,
            "images": row.images,
            "video": row.video,
            "link": row.link,
            "visibility": row.visibility,
            "audience": audience,
            "createdAt": util::iso_from_ms(row.created_at),
            "likes": row_likes,
            "comments": row_comments,
        }));
    }
    Ok(out)
}

async fn load_visible(
    state: &SharedState,
    post_id: &str,
    me: &crate::hub::AuthUser,
    space_key: Option<&str>,
) -> Result<store::MomentRow, String> {
    let post_id = post_id.trim();
    if post_id.is_empty() {
        return Err("动态不存在或已被删除".to_string());
    }
    let row = store::moment_by_id(&state.db, post_id)
        .await?
        .ok_or_else(|| "动态不存在或已被删除".to_string())?;
    if row.author_id == me.id {
        return Ok(row);
    }
    let friends = friend_ids_of(state, &me.id).await?;
    let is_friend = friends.contains(&row.author_id);
    if row.visibility == "public" {
        if is_friend {
            return Ok(row);
        }
        let key = space_key_of(state, &row.author_id).await?;
        if let Some(given) = space_key {
            if given.len() >= 16 && key.as_deref() == Some(given) {
                return Ok(row);
            }
        }
        return Err("无权查看该动态".to_string());
    }
    if !is_friend {
        return Err("无权查看该动态".to_string());
    }
    if row.visibility == "friends" {
        return Ok(row);
    }
    let audience = store::moment_audience_of(&state.db, &row.id).await?;
    if row.visibility == "partial" && audience.contains(&me.id) {
        return Ok(row);
    }
    if row.visibility == "exclude" && !audience.contains(&me.id) {
        return Ok(row);
    }
    Err("无权查看该动态".to_string())
}

async fn notify(state: &SharedState, row: &store::MomentRow, action: &str, actor: &crate::hub::AuthUser) {
    let owner = store::user_by_id(&state.db, &row.author_id)
        .await
        .ok()
        .flatten()
        .map(|user| user.username)
        .unwrap_or_else(|| actor.username.clone());
    let mut recipients = vec![row.author_id.clone()];
    if let Ok(friends) = friend_ids_of(state, &row.author_id).await {
        recipients.extend(friends);
    }
    let payload = json!({
        "action": action,
        "postId": row.id,
        "author": actor.username,
        "owner": owner,
    });
    state.hub.emit_to_users(&recipients, "moment:update", payload).await;
    if action != "like" && action != "comment" {
        return;
    }
    if row.author_id == actor.id {
        return;
    }
    crate::plugins::push::deliver(
        state.clone(),
        vec![row.author_id.clone()],
        crate::plugins::push::PushPayload {
            title: "朋友圈".to_string(),
            body: format!(
                "{} {}你的动态",
                actor.username,
                if action == "like" { "赞了" } else { "评论了" }
            ),
            session: "moments".to_string(),
        },
    );
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "moment.publish",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let content = util::str_param(&params, "content").trim().to_string();
            if content.chars().count() > CONTENT_MAX {
                return Err(format!("内容不能超过 {CONTENT_MAX} 个字"));
            }
            let mut keys: Vec<String> = Vec::new();
            if let Some(list) = params.get("images").and_then(|value| value.as_array()) {
                for item in list {
                    let Some(raw) = item.as_str() else { continue };
                    let key = raw.trim().to_string();
                    if key.is_empty() || key.len() > KEY_MAX || keys.contains(&key) {
                        continue;
                    }
                    keys.push(key);
                    if keys.len() >= IMAGES_MAX {
                        break;
                    }
                }
            }
            let raw_video = util::str_param(&params, "video").trim().to_string();
            let video = if !raw_video.is_empty() && raw_video.len() <= KEY_MAX {
                Some(raw_video)
            } else {
                None
            };
            if video.is_some() && !keys.is_empty() {
                return Err("视频动态不能同时包含图片".to_string());
            }
            let raw_link = util::str_param(&params, "link").trim().to_string();
            if !raw_link.is_empty() && !keys.is_empty() {
                return Err("链接动态不能同时包含图片".to_string());
            }
            if !raw_link.is_empty() && video.is_some() {
                return Err("链接动态不能同时包含视频".to_string());
            }
            if content.is_empty() && video.is_none() && keys.is_empty() && raw_link.is_empty() {
                return Err("动态内容不能为空".to_string());
            }
            let mut check_keys = keys.clone();
            if let Some(video) = video.clone() {
                check_keys.push(video);
            }
            for key in check_keys {
                if store::media_info(&state.db, &key).await?.is_none() {
                    return Err("图片或视频不存在或已被删除".to_string());
                }
            }
            let visibility = match util::str_param(&params, "visibility").as_str() {
                "friends" => "friends",
                "partial" => "partial",
                "exclude" => "exclude",
                _ => "public",
            };
            let mut audience: Vec<String> = Vec::new();
            if visibility == "partial" || visibility == "exclude" {
                let mut names: Vec<String> = Vec::new();
                if let Some(list) = params.get("audience").and_then(|value| value.as_array()) {
                    for item in list {
                        let Some(raw) = item.as_str() else { continue };
                        let name = raw.trim().to_lowercase();
                        if name.is_empty() || name == me.username || names.contains(&name) {
                            continue;
                        }
                        names.push(name);
                    }
                }
                if names.is_empty() {
                    return Err("请选择可见的好友".to_string());
                }
                if names.len() > AUDIENCE_MAX {
                    return Err(format!("最多选择 {AUDIENCE_MAX} 位好友"));
                }
                let friends = friend_ids_of(&state, &me.id).await?;
                for name in names {
                    let user = store::user_by_username(&state.db, &name)
                        .await?
                        .ok_or_else(|| format!("只能选择好友，{name} 不是你的好友"))?;
                    if !friends.contains(&user.id) {
                        return Err(format!("只能选择好友，{name} 不是你的好友"));
                    }
                    audience.push(user.id);
                }
            }
            let link = if raw_link.is_empty() {
                None
            } else {
                crate::linkpreview::preview(&state, &raw_link).await.ok()
            };
            let row = store::moment_create(
                &state.db,
                &me.id,
                &content,
                &keys,
                video.as_deref(),
                link.as_ref(),
                visibility,
                &audience,
            )
            .await?;
            notify(&state, &row, "publish", &me).await;
            let posts = build_posts(&state, std::slice::from_ref(&row), &me.id).await?;
            Ok(posts.into_iter().next().unwrap_or(Value::Null))
        }),
    );

    registry.add(
        "moment.link",
        handler(|state, conn, params| async move {
            require_user(&conn)?;
            let url = util::str_param(&params, "url").trim().to_string();
            if url.is_empty() {
                return Err("缺少链接".to_string());
            }
            crate::linkpreview::preview(&state, &url).await
        }),
    );

    registry.add(
        "moment.timeline",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let limit = clamp_limit(util::i64_param(&params, "limit"));
            let friends = friend_ids_of(&state, &me.id).await?;
            let author_name = util::str_param(&params, "author").trim().to_lowercase();
            let author = if author_name.is_empty() {
                None
            } else {
                match store::user_by_username(&state.db, &author_name).await? {
                    Some(user) => Some(user.id),
                    None => return Err(format!("用户 {} 不存在", util::str_param(&params, "author").trim())),
                }
            };
            let before = util::str_param(&params, "before");
            let before_id = util::str_param(&params, "beforeId");
            let rows = store::moment_list(
                &state.db,
                &me.id,
                &friends,
                author.as_deref(),
                if before.is_empty() { None } else { util::parse_iso(&before) },
                if before_id.is_empty() { None } else { Some(before_id.as_str()) },
                limit + 1,
            )
            .await?;
            let has_more = rows.len() as i64 > limit;
            let take = rows.len().min(limit as usize);
            let posts = build_posts(&state, &rows[..take], &me.id).await?;
            Ok(json!({ "posts": posts, "hasMore": has_more }))
        }),
    );

    registry.add(
        "moment.space.link",
        handler(|state, conn, _params| async move {
            let me = require_user(&conn)?;
            let key = ensure_space_key(&state, &me.id).await?;
            Ok(json!({ "username": me.username, "key": key }))
        }),
    );

    registry.add(
        "moment.space.view",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let username = util::str_param(&params, "username").trim().to_lowercase();
            if username.is_empty() {
                return Err("缺少用户名".to_string());
            }
            let owner = store::user_by_username(&state.db, &username)
                .await?
                .ok_or_else(|| "用户不存在".to_string())?;
            let key = util::str_param(&params, "key");
            let expected = space_key_of(&state, &owner.id).await?;
            if expected.is_none() || expected.as_deref() != Some(key.as_str()) {
                return Err("空间链接无效或已失效".to_string());
            }
            let limit = clamp_limit(util::i64_param(&params, "limit"));
            let before = util::str_param(&params, "before");
            let before_id = util::str_param(&params, "beforeId");
            let rows = store::moment_list_public(
                &state.db,
                &owner.id,
                if before.is_empty() { None } else { util::parse_iso(&before) },
                if before_id.is_empty() { None } else { Some(before_id.as_str()) },
                limit + 1,
            )
            .await?;
            let has_more = rows.len() as i64 > limit;
            let take = rows.len().min(limit as usize);
            let posts = build_posts(&state, &rows[..take], &me.id).await?;
            Ok(json!({ "username": owner.username, "posts": posts, "hasMore": has_more }))
        }),
    );

    registry.add(
        "moment.like",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let post_id = util::str_param(&params, "postId");
            let row = load_visible(&state, &post_id, &me, None).await?;
            let liked = params
                .get("liked")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            store::moment_set_like(&state.db, &row.id, &me.id, liked).await?;
            notify(&state, &row, "like", &me).await;
            let posts = build_posts(&state, std::slice::from_ref(&row), &me.id).await?;
            Ok(posts.into_iter().next().unwrap_or(Value::Null))
        }),
    );

    registry.add(
        "moment.comment",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let post_id = util::str_param(&params, "postId");
            let row = load_visible(&state, &post_id, &me, None).await?;
            let content = util::str_param(&params, "content").trim().to_string();
            if content.is_empty() {
                return Err("评论内容不能为空".to_string());
            }
            if content.chars().count() > COMMENT_MAX {
                return Err(format!("评论不能超过 {COMMENT_MAX} 个字"));
            }
            store::moment_add_comment(&state.db, &row.id, &me.id, &content).await?;
            notify(&state, &row, "comment", &me).await;
            let posts = build_posts(&state, std::slice::from_ref(&row), &me.id).await?;
            Ok(posts.into_iter().next().unwrap_or(Value::Null))
        }),
    );

    registry.add(
        "moment.comment.delete",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let post_id = util::str_param(&params, "postId");
            let row = load_visible(&state, &post_id, &me, None).await?;
            let comment_id = util::str_param(&params, "commentId");
            let comment = store::moment_comment_by_id(&state.db, &comment_id)
                .await?
                .ok_or_else(|| "评论不存在或已被删除".to_string())?;
            if comment.post_id != row.id {
                return Err("评论不存在或已被删除".to_string());
            }
            if comment.author_id != me.id && row.author_id != me.id {
                return Err("只能删除自己的评论".to_string());
            }
            store::moment_remove_comment(&state.db, &comment.id).await?;
            notify(&state, &row, "commentDelete", &me).await;
            let posts = build_posts(&state, std::slice::from_ref(&row), &me.id).await?;
            Ok(posts.into_iter().next().unwrap_or(Value::Null))
        }),
    );

    registry.add(
        "moment.delete",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let post_id = util::str_param(&params, "postId");
            let row = load_visible(&state, &post_id, &me, None).await?;
            if row.author_id != me.id {
                return Err("只能删除自己的动态".to_string());
            }
            store::moment_remove(&state.db, &row.id).await?;
            notify(&state, &row, "delete", &me).await;
            Ok(json!(true))
        }),
    );

    registry.add(
        "moment.forward",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let post_id = util::str_param(&params, "postId");
            let row = load_visible(&state, &post_id, &me, None).await?;
            let mut sessions: Vec<String> = Vec::new();
            if let Some(list) = params.get("sessions").and_then(|value| value.as_array()) {
                for item in list {
                    let Some(raw) = item.as_str() else { continue };
                    let session = raw.trim().to_string();
                    if session.is_empty() || session == format!("p2p:{}", me.username) {
                        continue;
                    }
                    if !sessions.contains(&session) {
                        sessions.push(session);
                    }
                }
            }
            if sessions.is_empty() {
                return Err("请选择转发目标".to_string());
            }
            if sessions.len() > 50 {
                return Err("一次最多转发 50 个会话".to_string());
            }
            if row.visibility != "public" {
                return Err("仅公开动态可以分享".to_string());
            }
            let author = store::user_by_id(&state.db, &row.author_id)
                .await?
                .map(|user| user.username)
                .unwrap_or_else(|| "未知用户".to_string());
            let share = json!({
                "moment": 1,
                "postId": row.id,
                "author": author,
                "text": row.content.chars().take(200).collect::<String>(),
                "image": match row.images.first() {
                    Some(key) => json!(key),
                    None => Value::Null,
                },
                "video": row.video,
            });
            let mut sent: Vec<Value> = Vec::new();
            for session in sessions {
                let payload = SendPayload {
                    content: share.to_string(),
                    quote: None,
                    mentions: None,
                    kind: "moment".to_string(),
                    file: None,
                    red_packet: None,
                    transfer: None,
                    aa_bill: None,
                    link: None,
                };
                sent.push(send_to(&state, &me, &session, payload).await?);
            }
            Ok(json!(sent))
        }),
    );

    registry.add(
        "moment.get",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let post_id = util::str_param(&params, "postId").trim().to_string();
            if post_id.is_empty() {
                return Err("动态不存在或已被删除".to_string());
            }
            let row = store::moment_by_id(&state.db, &post_id)
                .await?
                .ok_or_else(|| "动态不存在或仅好友可见".to_string())?;
            if row.visibility != "public" {
                return Err("动态不存在或仅好友可见".to_string());
            }
            let posts = build_posts(&state, std::slice::from_ref(&row), &me.id).await?;
            Ok(posts.into_iter().next().unwrap_or(Value::Null))
        }),
    );

    registry.add(
        "moment.unread",
        handler(|state, conn, _params| async move {
            let me = require_user(&conn)?;
            let friends = friend_ids_of(&state, &me.id).await?;
            let (posts, interactions) = store::moment_unread(&state.db, &me.id, &friends).await?;
            Ok(json!({
                "posts": posts,
                "interactions": interactions,
                "total": posts + interactions,
            }))
        }),
    );

    registry.add(
        "moment.seen",
        handler(|state, conn, _params| async move {
            let me = require_user(&conn)?;
            store::moment_mark_seen(&state.db, &me.id, util::now_ms()).await?;
            Ok(json!({ "posts": 0, "interactions": 0, "total": 0 }))
        }),
    );
}
