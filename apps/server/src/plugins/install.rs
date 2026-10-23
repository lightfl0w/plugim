use std::path::PathBuf;
use std::str::FromStr;

use serde_json::{json, Value};

use crate::config::{self, AppConfig};
use crate::state::{handler, Registry, SharedState};
use crate::store::{self, RowExt};
use crate::util;

fn has_dot_dot(value: &str) -> bool {
    value
        .split(|ch| ch == '/' || ch == '\\')
        .any(|part| part == "..")
}

fn db_file_ok(value: &str) -> bool {
    if value.is_empty() || value.len() > 256 {
        return false;
    }
    if !value.ends_with(".db") {
        return false;
    }
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-'))
}

fn db_url_ok(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if !lower.starts_with("postgres://") && !lower.starts_with("postgresql://") {
        return false;
    }
    value.len() <= 519 && !value.chars().any(|ch| ch.is_whitespace())
}

fn log_dir_ok(value: &str) -> bool {
    value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-'))
}

struct DbParams {
    driver: String,
    file: String,
    url: String,
    log_dir: String,
}

fn normalize_db_params(params: &Value) -> Result<DbParams, String> {
    let driver = if util::str_param(params, "dbDriver") == "postgres" {
        "postgres"
    } else {
        "sqlite"
    };
    let file = util::str_param(params, "dbFile").trim().to_string();
    let url = util::str_param(params, "databaseUrl").trim().to_string();
    let log_dir = util::str_param(params, "logDir").trim().to_string();
    if !log_dir.is_empty() && (!log_dir_ok(&log_dir) || has_dot_dot(&log_dir)) {
        return Err("日志目录仅允许字母数字与 . / _ -".to_string());
    }
    if driver == "sqlite" {
        let target = if file.is_empty() {
            "data/plugim.db".to_string()
        } else {
            file
        };
        if !db_file_ok(&target) || has_dot_dot(&target) {
            return Err("数据库文件名需以 .db 结尾，且不含空格".to_string());
        }
        return Ok(DbParams {
            driver: driver.to_string(),
            file: target,
            url: String::new(),
            log_dir,
        });
    }
    if !db_url_ok(&url) {
        return Err("Postgres 连接串需以 postgres:// 开头".to_string());
    }
    Ok(DbParams {
        driver: driver.to_string(),
        file: String::new(),
        url,
        log_dir,
    })
}

async fn test_database(params: &DbParams) -> Result<(), String> {
    if params.driver == "sqlite" {
        let path = PathBuf::from(&params.file);
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
        }
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&params.file)
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|err| err.to_string())?;
        let _: i64 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&pool)
            .await
            .map_err(|err| err.to_string())?;
        pool.close().await;
        return Ok(());
    }
    let options = sqlx::postgres::PgConnectOptions::from_str(&params.url)
        .map_err(|err| err.to_string())?;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect_with(options)
        .await
        .map_err(|err| err.to_string())?;
    let _: i32 = sqlx::query_scalar("SELECT 1")
        .fetch_one(&pool)
        .await
        .map_err(|err| err.to_string())?;
    let version: String = sqlx::query_scalar("SELECT version()")
        .fetch_one(&pool)
        .await
        .map_err(|err| err.to_string())?;
    if !version.to_ascii_lowercase().contains("postgresql") {
        pool.close().await;
        return Err("连接串指向的不是 PostgreSQL".to_string());
    }
    pool.close().await;
    Ok(())
}

async fn is_locked(state: &SharedState) -> Result<bool, String> {
    let installed = store::settings_get(&state.db, "installed").await?;
    if installed.as_deref() == Some("true") {
        return Ok(true);
    }
    Ok(store::count_users(&state.db).await? > 0)
}

async fn app_mode_of(state: &SharedState) -> Result<String, String> {
    Ok(match store::settings_get(&state.db, "app_mode").await?.as_deref() {
        Some("chat") => "chat".to_string(),
        _ => "enterprise".to_string(),
    })
}

fn supervised() -> bool {
    std::env::var("pm_id").is_ok()
        || std::env::var("pm_exec_path").is_ok()
        || std::env::var("INVOCATION_ID").is_ok()
        || std::env::var("PLUGIM_SUPERVISED").as_deref() == Ok("1")
}

fn respawn_self() {
    if std::env::var("PLUGIM_NO_RESPAWN").as_deref() == Ok("1") {
        return;
    }
    if supervised() {
        std::process::exit(0);
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut command = std::process::Command::new(&exe);
    command.args(&args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    if command.spawn().is_ok() {
        std::process::exit(0);
    }
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "install.status",
        handler(|state, _conn, _params| async move {
            let allow = store::settings_get(&state.db, "allow_register").await?;
            let invite = store::settings_get(&state.db, "invite_code").await?;
            let locked = is_locked(&state).await?;
            let has_users = store::count_users(&state.db).await? > 0;
            let mode = app_mode_of(&state).await?;
            let install = config::read_install_json();
            let cfg: &AppConfig = state.cfg.as_ref();
            let mut payload = json!({
                "installed": locked,
                "hasUsers": has_users,
                "mode": mode,
            });
            if !locked {
                let db_file = install
                    .get("dbFile")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| {
                        if cfg.db_driver == "sqlite" {
                            cfg.db_file.display().to_string()
                        } else {
                            String::new()
                        }
                    });
                let log_dir = install
                    .get("logDir")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| cfg.log_dir.clone());
                payload["dbDriver"] = json!(cfg.db_driver);
                payload["dbFile"] = json!(db_file);
                payload["databaseUrlSet"] = json!(
                    install.get("databaseUrl").is_some()
                        || std::env::var("DATABASE_URL").is_ok()
                );
                payload["logDir"] = json!(log_dir);
            }
            payload["allowRegister"] = json!(match allow {
                Some(value) => value != "false",
                None => cfg.allow_register,
            });
            let invite_value = invite.unwrap_or_else(|| cfg.invite_code.clone());
            payload["inviteRequired"] = json!(!invite_value.trim().is_empty());
            Ok(payload)
        }),
    );

    registry.add(
        "install.testdb",
        handler(|state, _conn, params| async move {
            if is_locked(&state).await? {
                return Err("系统已完成初始化".to_string());
            }
            let parsed = normalize_db_params(&params)?;
            test_database(&parsed)
                .await
                .map_err(|err| format!("连接失败: {}", err.chars().take(200).collect::<String>()))?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "install.savedb",
        handler(|state, _conn, params| async move {
            if is_locked(&state).await? {
                return Err("系统已完成初始化".to_string());
            }
            let parsed = normalize_db_params(&params)?;
            test_database(&parsed).await?;
            if !parsed.log_dir.is_empty() {
                std::fs::create_dir_all(&parsed.log_dir).map_err(|err| err.to_string())?;
            }
            let mut next = config::read_install_json();
            if !next.is_object() {
                next = json!({});
            }
            next["dbDriver"] = json!(parsed.driver);
            if parsed.driver == "sqlite" {
                next["dbFile"] = json!(parsed.file);
                next.as_object_mut().map(|map| map.remove("databaseUrl"));
            } else {
                next["databaseUrl"] = json!(parsed.url);
                next.as_object_mut().map(|map| map.remove("dbFile"));
            }
            next["logDir"] = json!(parsed.log_dir);
            config::write_install_json(&next)?;
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                respawn_self();
            });
            Ok(json!(true))
        }),
    );

    registry.add(
        "install.finish",
        handler(|state, conn, params| async move {
            if store::settings_get(&state.db, "installed").await?.as_deref() == Some("true") {
                return Err("系统已完成初始化".to_string());
            }
            if store::count_users(&state.db).await? > 0 {
                let first = sqlx::query("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
                    .fetch_optional(&state.db)
                    .await
                    .map_err(|err| err.to_string())?
                    .map(|row| row.get_str("id"));
                let mine = conn.user.as_ref().map(|user| user.id.clone());
                if mine.is_none() || first.as_deref() != mine.as_deref() {
                    return Err("系统已完成初始化".to_string());
                }
            }
            if let Some(value) = params.get("allowRegister").and_then(|item| item.as_bool()) {
                store::settings_set(
                    &state.db,
                    "allow_register",
                    if value { "true" } else { "false" },
                )
                .await?;
            }
            if let Some(value) = params.get("inviteCode").and_then(|item| item.as_str()) {
                let trimmed: String = value.trim().chars().take(64).collect();
                store::settings_set(&state.db, "invite_code", &trimmed).await?;
            }
            let mode = util::str_param(&params, "mode");
            if mode == "chat" || mode == "enterprise" {
                store::settings_set(&state.db, "app_mode", &mode).await?;
                let actor_id = conn.user.as_ref().map(|user| user.id.as_str());
                let actor = conn
                    .user
                    .as_ref()
                    .map(|user| user.username.clone())
                    .unwrap_or_else(|| "安装向导".to_string());
                let detail = if mode == "chat" {
                    "站点模式：聊天模式"
                } else {
                    "站点模式：企业模式"
                };
                store::audit(&state.db, actor_id, &actor, "admin.mode", detail).await?;
            }
            store::settings_set(&state.db, "installed", "true").await?;
            Ok(json!(true))
        }),
    );
}
