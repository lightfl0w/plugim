use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::hub::AuthUser;
use crate::state::{handler, Conn, Registry, SharedState};
use crate::store::{self, RowExt, UserRow};
use crate::util;

const LOGIN_WINDOW_MS: i64 = 60_000;
const LOGIN_MAX_ATTEMPTS: u32 = 10;

fn login_attempts() -> &'static Mutex<HashMap<String, (u32, i64)>> {
    static ATTEMPTS: OnceLock<Mutex<HashMap<String, (u32, i64)>>> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn login_limited(key: &str) -> bool {
    let guard = login_attempts().lock().await;
    match guard.get(key) {
        Some((count, reset_at)) if *reset_at > util::now_ms() => *count >= LOGIN_MAX_ATTEMPTS,
        _ => false,
    }
}

async fn record_login_fail(key: &str) {
    let now = util::now_ms();
    let mut guard = login_attempts().lock().await;
    match guard.get_mut(key) {
        Some(entry) if entry.1 > now => entry.0 += 1,
        _ => {
            if guard.len() >= 10_000 {
                guard.clear();
            }
            guard.insert(key.to_string(), (1, now + LOGIN_WINDOW_MS));
        }
    }
}

async fn clear_login_fail(key: &str) {
    login_attempts().lock().await.remove(key);
}

pub fn require_user(conn: &Conn) -> Result<AuthUser, String> {
    conn.user
        .clone()
        .ok_or_else(|| "未登录或登录已过期".to_string())
}

pub async fn require_admin(
    state: &SharedState,
    conn: &Conn,
) -> Result<store::UserRow, String> {
    let user = require_user(conn)?;
    let row = store::user_by_id(&state.db, &user.id)
        .await?
        .ok_or_else(|| "未登录或登录已过期".to_string())?;
    if !row.is_admin {
        return Err("需要管理员权限".to_string());
    }
    Ok(row)
}

pub fn user_json(row: &UserRow) -> Value {
    json!({
        "id": row.id,
        "username": row.username,
        "createdAt": util::iso_from_ms(row.created_at),
        "deptId": row.dept_id,
        "title": row.title,
        "mustChangePassword": row.must_change_password,
    })
}

pub async fn verify_token(state: &SharedState, token: Option<&str>) -> Option<AuthUser> {
    let token = token?;
    let claims = util::verify_jwt(&state.cfg.jwt_secret, token)?;
    let row = store::user_by_id(&state.db, &claims.sub).await.ok()??;
    if row.banned || claims.v != row.token_version {
        return None;
    }
    let session_id = claims.sid.clone();
    if let Some(sid) = session_id.as_ref() {
        match store::auth_session_active(&state.db, &row.id, sid).await {
            Ok(true) => {}
            _ => return None,
        }
    }
    Some(AuthUser {
        id: row.id,
        username: row.username,
        must_change: row.must_change_password,
        session_id,
    })
}

pub async fn register_policy(state: &SharedState) -> (bool, bool) {
    let invite = store::settings_get(&state.db, "invite_code")
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| state.cfg.invite_code.clone());
    let allow = store::settings_get(&state.db, "allow_register")
        .await
        .ok()
        .flatten()
        .map(|raw| raw != "false")
        .unwrap_or(state.cfg.allow_register);
    let has_users = store::count_users(&state.db).await.unwrap_or(0) > 0;
    let require_invite = has_users && !invite.trim().is_empty();
    let open = if !has_users || invite.trim().is_empty() {
        allow
    } else {
        false
    };
    (require_invite, open)
}

fn valid_username(name: &str) -> bool {
    let bytes = name.as_bytes();
    (2..=24).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

async fn issue_session(
    state: &SharedState,
    row: &UserRow,
    conn: &Conn,
) -> Result<String, String> {
    let user_agent: String = conn.user_agent.chars().take(400).collect();
    let ip: String = conn.ip.chars().take(64).collect();
    let id = util::random_token(18);
    let label = util::device_label_of(&user_agent);
    store::auth_session_create(&state.db, &id, &row.id, &label, &user_agent, &ip).await?;
    store::audit(
        &state.db,
        Some(&row.id),
        &row.username,
        "auth.session.create",
        &label,
    )
    .await?;
    Ok(util::sign_jwt(
        &state.cfg.jwt_secret,
        &row.id,
        &row.username,
        row.token_version,
        Some(&id),
    ))
}

async fn to_status(state: &SharedState, user_id: &str) -> String {
    let raw = store::settings_get(&state.db, &format!("presence:{user_id}"))
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    match raw.as_str() {
        "busy" | "away" | "dnd" | "invisible" => raw,
        _ => "online".to_string(),
    }
}

pub async fn announce_presence(state: &SharedState, user: &AuthUser, online: bool) {
    if online {
        let status = to_status(state, &user.id).await;
        if status == "invisible" {
            return;
        }
        state
            .hub
            .broadcast(
                "presence:update",
                json!({ "username": user.username, "online": true, "status": status }),
            )
            .await;
        return;
    }
    state
        .hub
        .broadcast(
            "presence:update",
            json!({ "username": user.username, "online": false }),
        )
        .await;
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "auth.register",
        handler(|state, conn, params| async move {
            let username = util::str_param(&params, "username")
                .trim()
                .to_lowercase();
            let password = util::str_param(&params, "password");
            if !valid_username(&username) {
                return Err("用户名需为 2-24 位小写字母、数字或下划线".to_string());
            }
            if password.chars().count() < 6 {
                return Err("密码至少需要 6 位".to_string());
            }
            let has_users = store::count_users(&state.db).await? > 0;
            let (require_invite, open) = register_policy(&state).await;
            if has_users {
                if require_invite {
                    let invite = util::str_param(&params, "inviteCode").trim().to_string();
                    let expected = store::settings_get(&state.db, "invite_code")
                        .await?
                        .unwrap_or_else(|| state.cfg.invite_code.clone());
                    if invite != expected.trim() {
                        return Err("邀请码错误或未填写".to_string());
                    }
                } else if !open {
                    return Err("已关闭注册，请联系管理员".to_string());
                }
            }
            if store::user_by_username(&state.db, &username).await?.is_some() {
                return Err("用户名已被占用".to_string());
            }
            let hash = util::hash_password(&password)?;
            let row = store::create_user(&state.db, &username, &hash).await?;
            if state.cfg.bootstrap_admins.iter().any(|name| name == &username) {
                store::set_flag(&state.db, &row.id, "isAdmin", true).await?;
            }
            store::audit(
                &state.db,
                Some(&row.id),
                &row.username,
                "auth.register",
                "",
            )
            .await?;
            let token = issue_session(&state, &row, &conn).await?;
            Ok(json!({ "token": token, "user": user_json(&row) }))
        }),
    );

    registry.add(
        "auth.login",
        handler(|state, conn, params| async move {
            let username = util::str_param(&params, "username")
                .trim()
                .to_lowercase();
            let password = util::str_param(&params, "password");
            let limit_key = format!("{}|{}", conn.ip, username);
            if login_limited(&limit_key).await {
                return Err("尝试过于频繁，请一分钟后再试".to_string());
            }
            let Some(row) = store::user_by_username(&state.db, &username).await? else {
                record_login_fail(&limit_key).await;
                store::audit(
                    &state.db,
                    None,
                    if username.is_empty() { "未知" } else { &username },
                    "auth.login.failed",
                    "用户名不存在",
                )
                .await?;
                return Err("用户名或密码错误".to_string());
            };
            if !util::verify_password(&row.password_hash, &password) {
                record_login_fail(&limit_key).await;
                store::audit(
                    &state.db,
                    None,
                    &username,
                    "auth.login.failed",
                    "密码错误",
                )
                .await?;
                return Err("用户名或密码错误".to_string());
            }
            if row.banned {
                store::audit(
                    &state.db,
                    Some(&row.id),
                    &username,
                    "auth.login.failed",
                    "账号已封禁",
                )
                .await?;
                return Err("账号已被封禁".to_string());
            }
            if let Some(secret) = row.totp_secret.as_deref() {
                let code = util::str_param(&params, "totp");
                if !util::verify_totp(secret, &code) {
                    record_login_fail(&limit_key).await;
                    store::audit(
                        &state.db,
                        Some(&row.id),
                        &username,
                        "auth.login.failed",
                        "动态口令错误",
                    )
                    .await?;
                    return Err("动态口令错误或已失效".to_string());
                }
            }
            clear_login_fail(&limit_key).await;
            store::audit(&state.db, Some(&row.id), &username, "auth.login", "").await?;
            let token = issue_session(&state, &row, &conn).await?;
            Ok(json!({ "token": token, "user": user_json(&row) }))
        }),
    );

    registry.add(
        "auth.password",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let old_password = util::str_param(&params, "oldPassword");
            let new_password = util::str_param(&params, "newPassword");
            if new_password.chars().count() < 6 {
                return Err("新密码至少需要 6 位".to_string());
            }
            if new_password == old_password {
                return Err("新密码不能与原密码相同".to_string());
            }
            let row = store::user_by_id(&state.db, &user.id)
                .await?
                .ok_or_else(|| "未登录或登录已过期".to_string())?;
            if !util::verify_password(&row.password_hash, &old_password) {
                return Err("原密码不正确".to_string());
            }
            let hash = util::hash_password(&new_password)?;
            let version = store::set_password(&state.db, &user.id, &hash).await?;
            store::audit(
                &state.db,
                Some(&row.id),
                &row.username,
                "auth.password",
                "",
            )
            .await?;
            let hub = state.hub.clone();
            let user_id = user.id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                hub.kick_user(&user_id).await;
            });
            if let Some(session_id) = user.session_id.as_ref() {
                store::auth_session_revoke(&state.db, &user.id, session_id).await?;
                let sid = util::random_token(18);
                let label = util::device_label_of(&conn.user_agent);
                store::auth_session_create(
                    &state.db,
                    &sid,
                    &user.id,
                    &label,
                    &conn.user_agent,
                    &conn.ip,
                )
                .await?;
                let token = util::sign_jwt(
                    &state.cfg.jwt_secret,
                    &row.id,
                    &row.username,
                    version,
                    Some(&sid),
                );
                return Ok(json!({ "token": token }));
            }
            let token = util::sign_jwt(
                &state.cfg.jwt_secret,
                &row.id,
                &row.username,
                version,
                None,
            );
            Ok(json!({ "token": token }))
        }),
    );

    registry.add(
        "auth.me",
        handler(|state, conn, _params| async move {
            let user = require_user(&conn)?;
            let row = store::user_by_id(&state.db, &user.id)
                .await?
                .ok_or_else(|| "未登录或登录已过期".to_string())?;
            Ok(user_json(&row))
        }),
    );

    registry.add(
        "auth.sessions",
        handler(|state, conn, _params| async move {
            let user = require_user(&conn)?;
            let rows = store::auth_sessions_of(&state.db, &user.id).await?;
            let devices: Vec<Value> = rows
                .iter()
                .filter(|row| !row.revoked)
                .map(|row| {
                    json!({
                        "id": row.id,
                        "label": row.label,
                        "userAgent": row.user_agent,
                        "ip": row.ip,
                        "createdAt": util::iso_from_ms(row.created_at),
                        "lastSeenAt": util::iso_from_ms(row.last_seen_at),
                        "current": Some(row.id.clone()) == user.session_id,
                    })
                })
                .collect();
            let totp_enabled = store::user_by_id(&state.db, &user.id)
                .await?
                .and_then(|row| row.totp_secret)
                .is_some();
            Ok(json!({ "devices": devices, "totpEnabled": totp_enabled }))
        }),
    );

    registry.add(
        "auth.session.rename",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let target = util::str_param(&params, "id").trim().to_string();
            let label: String = util::str_param(&params, "label").trim().chars().take(60).collect();
            if target.is_empty() {
                return Err("缺少设备".to_string());
            }
            if label.is_empty() {
                return Err("设备名称不能为空".to_string());
            }
            if !store::auth_session_rename(&state.db, &user.id, &target, &label).await? {
                return Err("设备不存在".to_string());
            }
            Ok(json!({ "ok": true }))
        }),
    );

    registry.add(
        "auth.session.revoke",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let target = util::str_param(&params, "id").trim().to_string();
            if target.is_empty() {
                return Err("缺少设备".to_string());
            }
            if Some(target.clone()) == user.session_id {
                return Err("不能下线当前设备，请使用「下线其他设备」".to_string());
            }
            if !store::auth_session_revoke(&state.db, &user.id, &target).await? {
                return Err("设备不存在".to_string());
            }
            store::audit(
                &state.db,
                Some(&user.id),
                &user.username,
                "auth.session.revoke",
                "",
            )
            .await?;
            state.hub.kick_session(&target).await;
            Ok(json!({ "ok": true }))
        }),
    );

    registry.add(
        "auth.sessions.revokeOthers",
        handler(|state, conn, _params| async move {
            let user = require_user(&conn)?;
            let Some(session_id) = user.session_id.clone() else {
                return Err("当前会话未绑定设备".to_string());
            };
            let rows = store::auth_sessions_of(&state.db, &user.id).await?;
            let others: Vec<String> = rows
                .iter()
                .filter(|row| !row.revoked && row.id != session_id)
                .map(|row| row.id.clone())
                .collect();
            let revoked =
                store::auth_session_revoke_others(&state.db, &user.id, &session_id).await?;
            for id in others {
                state.hub.kick_session(&id).await;
            }
            store::audit(
                &state.db,
                Some(&user.id),
                &user.username,
                "auth.sessions.revokeOthers",
                &format!("{revoked} 台"),
            )
            .await?;
            Ok(json!({ "revoked": revoked }))
        }),
    );

    registry.add(
        "auth.totp.setup",
        handler(|state, conn, _params| async move {
            let user = require_user(&conn)?;
            if store::user_by_id(&state.db, &user.id)
                .await?
                .and_then(|row| row.totp_secret)
                .is_some()
            {
                return Err("动态口令已开启".to_string());
            }
            let secret = util::totp_secret();
            store::settings_set(&state.db, &format!("totp:pending:{}", user.id), &secret).await?;
            let otpauth = format!(
                "otpauth://totp/plugim:{}?secret={}&issuer=plugim&algorithm=SHA1&digits=6&period=30",
                user.username, secret
            );
            Ok(json!({ "secret": secret, "otpauth": otpauth }))
        }),
    );

    registry.add(
        "auth.totp.enable",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let pending_key = format!("totp:pending:{}", user.id);
            let pending = store::settings_get(&state.db, &pending_key).await?;
            let Some(secret) = pending.filter(|value| !value.is_empty()) else {
                return Err("请先生成密钥".to_string());
            };
            let code = util::str_param(&params, "code");
            if !util::verify_totp(&secret, &code) {
                return Err("动态口令不正确".to_string());
            }
            store::set_totp(&state.db, &user.id, Some(&secret)).await?;
            store::settings_set(&state.db, &pending_key, "").await?;
            store::audit(
                &state.db,
                Some(&user.id),
                &user.username,
                "auth.totp.enable",
                "",
            )
            .await?;
            Ok(json!({ "totpEnabled": true }))
        }),
    );

    registry.add(
        "auth.totp.disable",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let row = store::user_by_id(&state.db, &user.id)
                .await?
                .ok_or_else(|| "未登录或登录已过期".to_string())?;
            if !util::verify_password(&row.password_hash, &util::str_param(&params, "password")) {
                return Err("密码不正确".to_string());
            }
            store::set_totp(&state.db, &user.id, None).await?;
            store::audit(
                &state.db,
                Some(&user.id),
                &user.username,
                "auth.totp.disable",
                "",
            )
            .await?;
            Ok(json!({ "totpEnabled": false }))
        }),
    );

    registry.add(
        "presence.list",
        handler(|state, conn, _params| async move {
            require_user(&conn)?;
            let ids = state.hub.online_user_ids().await;
            let users = store::users_by_ids(&state.db, &ids).await?;
            let mut online: Vec<String> = Vec::new();
            let mut statuses = serde_json::Map::new();
            for (id, username) in users {
                let status = to_status(&state, &id).await;
                if status == "invisible" {
                    continue;
                }
                statuses.insert(username.clone(), json!(status));
                online.push(username);
            }
            Ok(json!({ "online": online, "statuses": statuses }))
        }),
    );

    registry.add(
        "presence.status",
        handler(|state, conn, _params| async move {
            let user = require_user(&conn)?;
            let status = to_status(&state, &user.id).await;
            Ok(json!({ "status": status }))
        }),
    );

    registry.add(
        "presence.status.set",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let raw = util::str_param(&params, "status");
            let status = match raw.as_str() {
                "busy" | "away" | "dnd" | "invisible" => raw,
                _ => "online".to_string(),
            };
            store::settings_set(&state.db, &format!("presence:{}", user.id), &status).await?;
            if status != "invisible" {
                state
                    .hub
                    .broadcast(
                        "presence:update",
                        json!({ "username": user.username, "online": true, "status": status }),
                    )
                    .await;
            }
            Ok(json!({ "status": status }))
        }),
    );

    registry.add(
        "user.info",
        handler(|state, conn, params| async move {
            require_user(&conn)?;
            let username = util::str_param(&params, "username")
                .trim()
                .to_lowercase();
            if username.is_empty() {
                return Err("缺少用户名".to_string());
            }
            let row = store::user_by_username(&state.db, &username)
                .await?
                .ok_or_else(|| "用户不存在".to_string())?;
            let dept_name: Option<String> = match row.dept_id.as_ref() {
                Some(id) => sqlx::query("SELECT name FROM departments WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&state.db)
                    .await
                    .ok()
                    .flatten()
                    .map(|row| row.get_str("name")),
                None => None,
            };
            Ok(json!({
                "username": row.username,
                "createdAt": util::iso_from_ms(row.created_at),
                "deptId": row.dept_id,
                "title": row.title,
                "deptName": dept_name,
            }))
        }),
    );
}

