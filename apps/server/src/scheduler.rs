use std::collections::HashSet;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::state::SharedState;
use crate::store;
use crate::util;

pub const STATE_PREFIX: &str = "task_state_";
const DAY_MS: i64 = 86_400_000;
const TICK_SECS: u64 = 60;
const FIRST_TICK_SECS: u64 = 5;
const MIN_INTERVAL: i64 = 1;
const MAX_INTERVAL: i64 = 43_200;
const RETENTION_KEY: &str = "message_retention_days";

#[derive(Clone, Copy)]
pub struct TaskSpec {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub interval_minutes: i64,
}

pub const TASKS: [TaskSpec; 3] = [
    TaskSpec {
        name: "message-cleanup",
        title: "过期消息清理",
        description: "按保留天数删除历史消息，并清理不再被引用的媒体文件",
        interval_minutes: 1440,
    },
    TaskSpec {
        name: "media-sweep",
        title: "孤儿文件清理",
        description: "删除上传后 24 小时内未被任何消息引用或转发引用的文件",
        interval_minutes: 1440,
    },
    TaskSpec {
        name: "db-backup",
        title: "数据库备份",
        description: "把数据库备份到 data/backups，保留最近 7 份",
        interval_minutes: 1440,
    },
];

pub fn spec_of(name: &str) -> Option<TaskSpec> {
    TASKS.iter().copied().find(|spec| spec.name == name)
}

fn clamp_interval(value: i64) -> i64 {
    value.clamp(MIN_INTERVAL, MAX_INTERVAL)
}

#[derive(Debug, Clone)]
pub struct TaskState {
    pub enabled: bool,
    pub interval_minutes: i64,
    pub last_run: Option<String>,
    pub last_status: Option<String>,
    pub last_message: String,
    pub runs: i64,
}

impl TaskState {
    fn fallback(spec: TaskSpec) -> Self {
        Self {
            enabled: true,
            interval_minutes: clamp_interval(spec.interval_minutes),
            last_run: None,
            last_status: None,
            last_message: String::new(),
            runs: 0,
        }
    }

    pub fn to_value(&self, spec: TaskSpec) -> Value {
        json!({
            "name": spec.name,
            "title": spec.title,
            "description": spec.description,
            "enabled": self.enabled,
            "intervalMinutes": self.interval_minutes,
            "lastRun": match &self.last_run {
                Some(value) => json!(value),
                None => Value::Null,
            },
            "lastStatus": match &self.last_status {
                Some(value) => json!(value),
                None => Value::Null,
            },
            "lastMessage": self.last_message,
            "runs": self.runs,
        })
    }
}

pub async fn state_of(state: &SharedState, spec: TaskSpec) -> TaskState {
    let raw = store::settings_get(&state.db, &format!("{STATE_PREFIX}{}", spec.name))
        .await
        .ok()
        .flatten();
    let fallback = TaskState::fallback(spec);
    let Some(raw) = raw else {
        return fallback;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return fallback;
    };
    TaskState {
        enabled: parsed.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
        interval_minutes: parsed
            .get("intervalMinutes")
            .and_then(|v| v.as_i64())
            .map(clamp_interval)
            .unwrap_or(fallback.interval_minutes),
        last_run: parsed
            .get("lastRun")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        last_status: parsed
            .get("lastStatus")
            .and_then(|v| v.as_str())
            .filter(|v| *v == "ok" || *v == "error")
            .map(|v| v.to_string()),
        last_message: parsed
            .get("lastMessage")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(300)
            .collect(),
        runs: parsed.get("runs").and_then(|v| v.as_i64()).unwrap_or(0).max(0),
    }
}

async fn save_state(
    state: &SharedState,
    spec: TaskSpec,
    next: &TaskState,
) -> Result<(), String> {
    let raw = json!({
        "enabled": next.enabled,
        "intervalMinutes": next.interval_minutes,
        "lastRun": next.last_run,
        "lastStatus": next.last_status,
        "lastMessage": next.last_message,
        "runs": next.runs,
    });
    store::settings_set(
        &state.db,
        &format!("{STATE_PREFIX}{}", spec.name),
        &raw.to_string(),
    )
    .await
}

pub async fn list(state: &SharedState) -> Vec<Value> {
    let mut out = Vec::new();
    for spec in TASKS {
        out.push(state_of(state, spec).await.to_value(spec));
    }
    out
}

pub async fn set(
    state: &SharedState,
    name: &str,
    enabled: Option<bool>,
    interval: Option<i64>,
) -> Result<Value, String> {
    let Some(spec) = spec_of(name) else {
        return Err("任务不存在".to_string());
    };
    if let Some(minutes) = interval {
        if !(MIN_INTERVAL..=MAX_INTERVAL).contains(&minutes) {
            return Err(format!(
                "执行周期需为 {MIN_INTERVAL} 到 {MAX_INTERVAL} 分钟之间的整数"
            ));
        }
    }
    let mut current = state_of(state, spec).await;
    if let Some(value) = enabled {
        current.enabled = value;
    }
    if let Some(minutes) = interval {
        current.interval_minutes = minutes;
    }
    save_state(state, spec, &current).await?;
    Ok(current.to_value(spec))
}

static RUNNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn claim(name: &str) -> bool {
    let mut guard = match RUNNING.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    let set = guard.get_or_insert_with(HashSet::new);
    if set.contains(name) {
        return false;
    }
    set.insert(name.to_string());
    true
}

fn release(name: &str) {
    if let Ok(mut guard) = RUNNING.lock() {
        if let Some(set) = guard.as_mut() {
            set.remove(name);
        }
    }
}

pub async fn run(state: &SharedState, name: &str, trigger: &str) -> Result<Value, String> {
    let Some(spec) = spec_of(name) else {
        return Err("任务不存在".to_string());
    };
    if !claim(spec.name) {
        return Err("任务正在执行中".to_string());
    }
    let outcome = execute(state, spec.name).await;
    release(spec.name);
    let (status, message) = match outcome {
        Ok(message) => ("ok", message),
        Err(err) => ("error", err),
    };
    let mut current = state_of(state, spec).await;
    current.last_run = Some(util::iso_from_ms(util::now_ms()));
    current.last_status = Some(status.to_string());
    current.last_message = message.chars().take(300).collect();
    current.runs += 1;
    save_state(state, spec, &current).await?;
    if status == "ok" {
        tracing::info!("task {} ({trigger}): {message}", spec.name);
    } else {
        tracing::warn!("task {} ({trigger}) failed: {message}", spec.name);
    }
    Ok(json!({
        "name": spec.name,
        "title": spec.title,
        "description": spec.description,
        "result": message,
    }))
}

async fn execute(state: &SharedState, name: &str) -> Result<String, String> {
    match name {
        "message-cleanup" => {
            let days = retention_days(state).await;
            if days == 0 {
                return Ok("未设置保留天数，跳过".to_string());
            }
            let (deleted, files) = run_cleanup(state).await;
            Ok(format!("删除 {deleted} 条消息、{files} 个文件"))
        }
        "media-sweep" => {
            let cutoff = util::now_ms() - DAY_MS;
            let rows = store::media_older_than(&state.db, cutoff).await?;
            let keys: Vec<String> = rows.into_iter().map(|row| row.key).collect();
            let removed = prune_media(state, &keys).await;
            Ok(format!("清理 {removed} 个未引用文件"))
        }
        "db-backup" => backup_sqlite(state).await,
        _ => Err("任务不存在".to_string()),
    }
}

pub async fn retention_days(state: &SharedState) -> i64 {
    store::settings_get(&state.db, RETENTION_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|days| *days > 0)
        .unwrap_or(0)
}

pub fn file_key_of(content: &str) -> Option<String> {
    let rest = content.strip_prefix("/files/")?;
    if rest.len() == 32 && rest.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(rest.to_string())
    } else {
        None
    }
}

pub async fn group_file_uses(state: &SharedState, key: &str) -> bool {
    sqlx::query("SELECT key FROM group_files WHERE key = $1 LIMIT 1")
        .bind(key)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .is_some()
}

pub async fn prune_media(state: &SharedState, keys: &[String]) -> i64 {
    if keys.is_empty() {
        return 0;
    }
    let mut removed = 0;
    for key in keys {
        let url = format!("/files/{key}");
        if store::count_messages_with_content(&state.db, &url)
            .await
            .unwrap_or(0)
            > 0
        {
            continue;
        }
        if group_file_uses(state, key).await {
            continue;
        }
        crate::plugins::files::remove_object(state, key).await;
        let _ = store::media_remove(&state.db, key).await;
        removed += 1;
    }
    removed
}

pub async fn run_cleanup(state: &SharedState) -> (i64, i64) {
    let days = retention_days(state).await;
    if days == 0 {
        return (0, 0);
    }
    let cutoff = util::now_ms() - days * DAY_MS;
    let contents = store::delete_messages_before(&state.db, cutoff)
        .await
        .unwrap_or_default();
    let mut keys: Vec<String> = Vec::new();
    for content in contents {
        if let Some(key) = file_key_of(&content) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    for row in store::media_older_than(&state.db, cutoff)
        .await
        .unwrap_or_default()
    {
        if !keys.contains(&row.key) {
            keys.push(row.key);
        }
    }
    let removed = prune_media(state, &keys).await;
    (keys.len() as i64, removed)
}

fn backup_dir() -> String {
    std::env::var("PLUGIM_BACKUP_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "data/backups".to_string())
}

fn backup_keep() -> usize {
    std::env::var("PLUGIM_BACKUP_KEEP")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0 && *value <= 365)
        .unwrap_or(7)
}

fn backup_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d-%H-%M-%S").to_string()
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

async fn backup_postgres(state: &SharedState) -> Result<String, String> {
    let url = state.cfg.database_url.trim().to_string();
    if url.is_empty() {
        return Err("未配置 PostgreSQL 连接串".to_string());
    }
    let dir = std::path::PathBuf::from(backup_dir());
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let target = dir.join(format!("plugim-{}.sql", backup_stamp()));
    let output = tokio::process::Command::new("pg_dump")
        .arg("--dbname")
        .arg(&url)
        .arg("--no-owner")
        .arg("--no-privileges")
        .arg("--format=plain")
        .arg("-f")
        .arg(&target)
        .output()
        .await
        .map_err(|err| format!("备份失败：{err}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("备份失败：{}", detail.trim().chars().take(200).collect::<String>()));
    }
    let install = crate::config::install_path();
    if install.exists() {
        let _ = std::fs::copy(&install, dir.join("install.json"));
    }
    let removed = prune_backups(&dir, backup_keep());
    let bytes = std::fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
    Ok(format!(
        "备份 {}（{}），清理 {} 份旧备份",
        target.file_name().unwrap_or_default().to_string_lossy(),
        format_bytes(bytes),
        removed
    ))
}

async fn backup_sqlite(state: &SharedState) -> Result<String, String> {
    if state.cfg.is_postgres() {
        return backup_postgres(state).await;
    }
    let source = state.cfg.db_file.clone();
    if !source.exists() {
        return Err(format!("数据库文件不存在：{}", source.display()));
    }
    let dir = std::path::PathBuf::from(backup_dir());
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let target = dir.join(format!("plugim-{}.db", backup_stamp()));
    let target_text = target.to_string_lossy().to_string();
    sqlx::query("VACUUM INTO $1")
        .bind(&target_text)
        .execute(&state.db)
        .await
        .map_err(|err| format!("备份失败：{err}"))?;
    let install = crate::config::install_path();
    if install.exists() {
        let _ = std::fs::copy(&install, dir.join("install.json"));
    }
    let removed = prune_backups(&dir, backup_keep());
    let bytes = std::fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
    Ok(format!(
        "备份 {}（{}），清理 {} 份旧备份",
        target.file_name().unwrap_or_default().to_string_lossy(),
        format_bytes(bytes),
        removed
    ))
}

fn backup_matches(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("plugim-") else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(".db").or_else(|| rest.strip_suffix(".sql")) else {
        return false;
    };
    let parts: Vec<&str> = rest.split('-').collect();
    parts.len() == 6
        && parts
            .iter()
            .all(|part| part.len() == 2 && part.bytes().all(|b| b.is_ascii_digit()))
}

pub fn prune_backups(dir: &std::path::Path, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().to_str().map(|name| name.to_string()))
        .filter(|name| backup_matches(name))
        .collect();
    names.sort();
    let keep = keep.max(1);
    if names.len() <= keep {
        return 0;
    }
    let drop_count = names.len() - keep;
    let mut removed = 0;
    for name in names.into_iter().take(drop_count) {
        if std::fs::remove_file(dir.join(&name)).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub fn spawn(state: SharedState) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(FIRST_TICK_SECS)).await;
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(TICK_SECS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            for spec in TASKS {
                let current = state_of(&state, spec).await;
                if !current.enabled {
                    continue;
                }
                let last = current
                    .last_run
                    .as_deref()
                    .and_then(util::parse_iso)
                    .unwrap_or(0);
                if util::now_ms() - last < current.interval_minutes * 60_000 {
                    continue;
                }
                let _ = run(&state, spec.name, "auto").await;
            }
            ticker.tick().await;
        }
    });
}
