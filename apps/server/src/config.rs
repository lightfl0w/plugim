use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub port: u16,
    pub db_file: PathBuf,
    pub db_driver: String,
    pub database_url: String,
    pub log_dir: String,
    pub jwt_secret: Vec<u8>,
    pub default_session: String,
    pub bootstrap_admins: Vec<String>,
    pub allow_register: bool,
    pub invite_code: String,
    pub storage_dir: PathBuf,
    pub upload_limit_mb: u64,
    pub web_dist: Option<PathBuf>,
    pub ice_servers: Vec<serde_json::Value>,
    pub vapid_public_key: String,
    pub vapid_private_key: String,
    pub vapid_subject: String,
    pub link_allow_hosts: Vec<String>,
    pub link_deny_hosts: Vec<String>,
    pub link_allow_private: bool,
}

#[derive(Debug, Default, Deserialize)]
struct InstallConfig {
    #[serde(default, alias = "dbFile")]
    db_file: Option<String>,
    #[serde(default, alias = "dbDriver")]
    db_driver: Option<String>,
    #[serde(default, alias = "databaseUrl")]
    database_url: Option<String>,
    #[serde(default, alias = "logDir")]
    log_dir: Option<String>,
}

pub fn install_path() -> PathBuf {
    let file = env_str("PLUGIM_INSTALL_FILE").unwrap_or_else(|| "data/install.json".to_string());
    PathBuf::from(file)
}

fn env_candidates() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        let mut cursor: Option<&Path> = Some(cwd.as_path());
        for _ in 0..4 {
            let Some(dir) = cursor else { break };
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("apps/server"));
            cursor = dir.parent();
        }
    }
    dirs.push(PathBuf::from("/etc/plugim"));
    dirs
}

pub fn load_dotenv() {
    for dir in env_candidates() {
        let path = dir.join(".env");
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let line = line.strip_prefix("export ").unwrap_or(line);
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            if key.is_empty() || std::env::var_os(key).is_some() {
                continue;
            }
            let mut value = value.trim();
            if value.len() >= 2 {
                let quoted = (value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\''));
                if quoted {
                    value = &value[1..value.len() - 1];
                }
            }
            std::env::set_var(key, value);
        }
    }
}

pub fn read_install_json() -> serde_json::Value {
    match std::fs::read_to_string(install_path()) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

pub fn write_install_json(value: &serde_json::Value) -> Result<(), String> {
    let path = install_path();
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    std::fs::write(&tmp, text).map_err(|err| err.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|err| err.to_string())
}

fn env_str(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
        Err(_) => None,
    }
}

fn read_install() -> InstallConfig {
    let path = install_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return InstallConfig::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn resolve_jwt_secret() -> Vec<u8> {
    if let Some(secret) = env_str("PLUGIM_JWT_SECRET") {
        return secret.into_bytes();
    }
    let file = PathBuf::from("data/.jwt-secret");
    if let Ok(text) = std::fs::read_to_string(&file) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            tracing::warn!("PLUGIM_JWT_SECRET not set, using persisted secret from data/.jwt-secret");
            return trimmed.as_bytes().to_vec();
        }
    }
    let secret = crate::util::random_token(32);
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&file, &secret).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
        }
        tracing::warn!("PLUGIM_JWT_SECRET not set, generated and persisted to data/.jwt-secret");
    } else {
        tracing::warn!("PLUGIM_JWT_SECRET not set and persist failed, using ephemeral secret");
    }
    secret.into_bytes()
}

fn host_list(name: &str) -> Vec<String> {
    env_str(name)
        .unwrap_or_default()
        .split(',')
        .map(|value| value.trim().to_lowercase())
        .map(|value| value.trim_start_matches('.').to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn ice_servers() -> Vec<serde_json::Value> {
    let stun_urls: Vec<String> = env_str("PLUGIM_STUN_URLS")
        .unwrap_or_else(|| "stun:stun.l.google.com:19302".to_string())
        .split(',')
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .collect();
    let mut list = vec![serde_json::json!({ "urls": stun_urls })];
    if let Some(turn) = env_str("PLUGIM_TURN_URL") {
        list.push(serde_json::json!({
            "urls": turn,
            "username": env_str("PLUGIM_TURN_USER").unwrap_or_else(|| "plugim".to_string()),
            "credential": env_str("PLUGIM_TURN_PASS").unwrap_or_default(),
        }));
    }
    list
}

fn find_web_dist() -> Option<PathBuf> {    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = env_str("PLUGIM_WEB_DIST") {
        candidates.push(PathBuf::from(explicit));
    }
    candidates.push(PathBuf::from("apps/web/dist"));
    candidates.push(PathBuf::from("../web/dist"));
    candidates.push(PathBuf::from("web/dist"));
    for candidate in candidates {
        if candidate.join("index.html").exists() {
            return Some(candidate);
        }
    }
    None
}

impl AppConfig {
    pub fn is_postgres(&self) -> bool {
        self.db_driver == "postgres"
    }

    pub fn load() -> Self {
        load_dotenv();
        let install = read_install();
        let port = std::env::var("PORT")
            .ok()
            .and_then(|raw| raw.parse::<u16>().ok())
            .unwrap_or(3000);
        let db_file = install
            .db_file
            .clone()
            .or_else(|| env_str("PLUGIM_DB_FILE"))
            .unwrap_or_else(|| "data/plugim.db".to_string());
        let log_dir = env_str("PLUGIM_LOG_DIR")
            .filter(|value| !value.is_empty())
            .or_else(|| install.log_dir.clone())
            .unwrap_or_default();
        if !log_dir.is_empty() {
            let _ = std::fs::create_dir_all(&log_dir);
        }
        let bootstrap_admins = env_str("PLUGIM_ADMINS")
            .map(|raw| {
                raw.split(',')
                    .map(|name| name.trim().to_lowercase())
                    .filter(|name| !name.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let database_url = install
            .database_url
            .clone()
            .filter(|value| !value.is_empty())
            .or_else(|| env_str("DATABASE_URL"))
            .unwrap_or_default();
        let db_driver = install
            .db_driver
            .clone()
            .or_else(|| env_str("PLUGIM_DB_DRIVER"))
            .map(|value| value.trim().to_lowercase())
            .filter(|value| value == "postgres" || value == "sqlite")
            .unwrap_or_else(|| {
                if database_url.starts_with("postgres://") || database_url.starts_with("postgresql://") {
                    "postgres".to_string()
                } else {
                    "sqlite".to_string()
                }
            });
        AppConfig {
            port,
            db_file: PathBuf::from(db_file),
            db_driver,
            database_url,
            log_dir,
            jwt_secret: resolve_jwt_secret(),
            default_session: env_str("PLUGIM_DEFAULT_SESSION").unwrap_or_else(|| "general".to_string()),
            bootstrap_admins,
            allow_register: env_str("PLUGIM_ALLOW_REGISTER").map(|raw| raw != "false").unwrap_or(true),
            invite_code: env_str("PLUGIM_INVITE_CODE").unwrap_or_default(),
            storage_dir: PathBuf::from(
                env_str("PLUGIM_STORAGE_DIR").unwrap_or_else(|| "data/uploads".to_string()),
            ),
            upload_limit_mb: env_str("PLUGIM_UPLOAD_LIMIT_MB")
                .and_then(|raw| raw.parse::<u64>().ok())
                .unwrap_or(20),
            web_dist: find_web_dist(),
            ice_servers: ice_servers(),
            vapid_public_key: env_str("PLUGIM_VAPID_PUBLIC_KEY").unwrap_or_default(),
            vapid_private_key: env_str("PLUGIM_VAPID_PRIVATE_KEY").unwrap_or_default(),
            vapid_subject: env_str("PLUGIM_VAPID_SUBJECT").unwrap_or_default(),
            link_allow_hosts: host_list("PLUGIM_LINK_ALLOW_HOSTS"),
            link_deny_hosts: host_list("PLUGIM_LINK_DENY_HOSTS"),
            link_allow_private: env_str("PLUGIM_LINK_ALLOW_PRIVATE")
                .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
        }
    }
}
