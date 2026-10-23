use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use sqlx::any::AnyPoolOptions;
use sqlx::any::AnyRow;
use sqlx::{AnyPool, Row};

#[allow(dead_code)]
pub trait RowExt {
    fn get_str(&self, name: &str) -> String;
    fn get_opt_str(&self, name: &str) -> Option<String>;
    fn get_i64(&self, name: &str) -> i64;
    fn get_opt_i64(&self, name: &str) -> Option<i64>;
    fn get_f64(&self, name: &str) -> f64;
    fn get_bool(&self, name: &str) -> bool;
    fn get_bytes(&self, name: &str) -> Vec<u8>;
    fn get_opt_bytes(&self, name: &str) -> Option<Vec<u8>>;
}

impl RowExt for AnyRow {
    fn get_str(&self, name: &str) -> String {
        self.try_get::<String, _>(name).unwrap_or_default()
    }

    fn get_opt_str(&self, name: &str) -> Option<String> {
        self.try_get::<Option<String>, _>(name).ok().flatten()
    }

    fn get_i64(&self, name: &str) -> i64 {
        self.try_get::<i64, _>(name)
            .or_else(|_| self.try_get::<i32, _>(name).map(|value| value as i64))
            .or_else(|_| self.try_get::<bool, _>(name).map(|value| i64::from(value)))
            .unwrap_or(0)
    }

    fn get_opt_i64(&self, name: &str) -> Option<i64> {
        self.try_get::<Option<i64>, _>(name)
            .ok()
            .flatten()
            .or_else(|| self.try_get::<Option<i32>, _>(name).ok().flatten().map(|v| v as i64))
    }

    fn get_f64(&self, name: &str) -> f64 {
        self.try_get::<f64, _>(name).unwrap_or(0.0)
    }

    fn get_bool(&self, name: &str) -> bool {
        if let Ok(value) = self.try_get::<bool, _>(name) {
            return value;
        }
        self.try_get::<i64, _>(name).map(|value| value != 0).unwrap_or(false)
    }

    fn get_bytes(&self, name: &str) -> Vec<u8> {
        self.try_get::<Vec<u8>, _>(name).unwrap_or_default()
    }

    fn get_opt_bytes(&self, name: &str) -> Option<Vec<u8>> {
        self.try_get::<Option<Vec<u8>>, _>(name).ok().flatten()
    }
}

pub fn marks(start: usize, count: usize) -> String {
    (start..start + count)
        .map(|index| format!("${index}"))
        .collect::<Vec<String>>()
        .join(", ")
}

const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  recalled_at INTEGER,
  edited_at INTEGER,
  edit_count INTEGER NOT NULL DEFAULT 0,
  quote TEXT,
  mentions TEXT,
  kind TEXT,
  file TEXT,
  link TEXT,
  reactions TEXT,
  red_packet TEXT,
  transfer TEXT,
  aa_bill TEXT
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, seq);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  dept_id TEXT,
  title TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  group_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  message TEXT,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS friend_remarks (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  remark TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_stars (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_group_members (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS essences (
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, message_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  notice TEXT NOT NULL DEFAULT '',
  mute_all INTEGER NOT NULL DEFAULT 0,
  no_friend_add INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT,
  invite_expires_at INTEGER,
  join_approval INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_join_requests (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  title TEXT,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS reads (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, session)
);
CREATE TABLE IF NOT EXISTS session_meta (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, session)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media_files (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_files (
  group_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, key)
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, last_seen_at);
CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  images TEXT NOT NULL,
  video TEXT,
  link TEXT,
  visibility TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS moments_created_idx ON moments (created_at);
CREATE TABLE IF NOT EXISTS moment_likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS moment_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS moment_comments_post_idx ON moment_comments (post_id, created_at);
CREATE TABLE IF NOT EXISTS moment_audience (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS moment_audience_user_idx ON moment_audience (user_id);
CREATE TABLE IF NOT EXISTS moment_reads (
  user_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS red_packets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  type TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  remain_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at INTEGER NOT NULL,
  expired_at INTEGER
);
CREATE INDEX IF NOT EXISTS red_packets_session_idx ON red_packets (session_id, created_at);
CREATE TABLE IF NOT EXISTS red_packet_records (
  id TEXT NOT NULL,
  red_packet_id TEXT NOT NULL,
  claimer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (red_packet_id, claimer_id)
);
CREATE INDEX IF NOT EXISTS red_packet_records_idx ON red_packet_records (red_packet_id);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  message TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_session_idx ON transfers (session, created_at);
CREATE INDEX IF NOT EXISTS transfers_to_idx ON transfers (to_id, state);
CREATE TABLE IF NOT EXISTS aa_bills (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  description TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  settled_amount INTEGER NOT NULL DEFAULT 0,
  participant_ids TEXT NOT NULL,
  split_type TEXT NOT NULL,
  custom_splits TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS aa_bills_session_idx ON aa_bills (session, created_at);
CREATE TABLE IF NOT EXISTS aa_payments (
  id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  paid_at INTEGER NOT NULL,
  PRIMARY KEY (bill_id, payer_id)
);
CREATE TABLE IF NOT EXISTS bot_apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS bot_apps_owner_idx ON bot_apps (owner_id);
CREATE TABLE IF NOT EXISTS bot_hooks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_hooks_bot_idx ON bot_hooks (bot_id, enabled);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
"#;

const PG_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  seq BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  recalled_at BIGINT,
  edited_at BIGINT,
  edit_count BIGINT NOT NULL DEFAULT 0,
  quote TEXT,
  mentions TEXT,
  kind TEXT,
  file TEXT,
  link TEXT,
  reactions TEXT,
  red_packet TEXT,
  transfer TEXT,
  aa_bill TEXT
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, seq);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  is_admin BIGINT NOT NULL DEFAULT 0,
  banned BIGINT NOT NULL DEFAULT 0,
  token_version BIGINT NOT NULL DEFAULT 0,
  dept_id TEXT,
  title TEXT,
  balance BIGINT NOT NULL DEFAULT 0,
  must_change_password BIGINT NOT NULL DEFAULT 0,
  totp_secret TEXT
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort BIGINT NOT NULL DEFAULT 0,
  group_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  message TEXT,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS friend_remarks (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  remark TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_stars (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_group_members (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS essences (
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (group_id, message_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  notice TEXT NOT NULL DEFAULT '',
  mute_all BIGINT NOT NULL DEFAULT 0,
  no_friend_add BIGINT NOT NULL DEFAULT 0,
  invite_code TEXT,
  invite_expires_at BIGINT,
  join_approval BIGINT NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_join_requests (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  muted BIGINT NOT NULL DEFAULT 0,
  joined_at BIGINT NOT NULL,
  title TEXT,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS reads (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  read_at BIGINT NOT NULL,
  seq BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, session)
);
CREATE TABLE IF NOT EXISTS session_meta (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  pinned BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, session)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media_files (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size BIGINT NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_files (
  group_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size BIGINT NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (group_id, key)
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, last_seen_at);
CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  images TEXT NOT NULL,
  video TEXT,
  link TEXT,
  visibility TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS moments_created_idx ON moments (created_at);
CREATE TABLE IF NOT EXISTS moment_likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS moment_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS moment_comments_post_idx ON moment_comments (post_id, created_at);
CREATE TABLE IF NOT EXISTS moment_audience (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS moment_audience_user_idx ON moment_audience (user_id);
CREATE TABLE IF NOT EXISTS moment_reads (
  user_id TEXT PRIMARY KEY,
  seen_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS red_packets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  type TEXT NOT NULL,
  total_amount BIGINT NOT NULL,
  total_count BIGINT NOT NULL,
  remaining BIGINT NOT NULL,
  remain_count BIGINT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at BIGINT NOT NULL,
  expired_at BIGINT
);
CREATE INDEX IF NOT EXISTS red_packets_session_idx ON red_packets (session_id, created_at);
CREATE TABLE IF NOT EXISTS red_packet_records (
  id TEXT NOT NULL,
  red_packet_id TEXT NOT NULL,
  claimer_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  claimed_at BIGINT NOT NULL,
  PRIMARY KEY (red_packet_id, claimer_id)
);
CREATE INDEX IF NOT EXISTS red_packet_records_idx ON red_packet_records (red_packet_id);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  message TEXT,
  state TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expired_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_session_idx ON transfers (session, created_at);
CREATE INDEX IF NOT EXISTS transfers_to_idx ON transfers (to_id, state);
CREATE TABLE IF NOT EXISTS aa_bills (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  description TEXT NOT NULL,
  total_amount BIGINT NOT NULL,
  settled_amount BIGINT NOT NULL DEFAULT 0,
  participant_ids TEXT NOT NULL,
  split_type TEXT NOT NULL,
  custom_splits TEXT,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  deadline BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS aa_bills_session_idx ON aa_bills (session, created_at);
CREATE TABLE IF NOT EXISTS aa_payments (
  id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  paid_at BIGINT NOT NULL,
  PRIMARY KEY (bill_id, payer_id)
);
CREATE TABLE IF NOT EXISTS bot_apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS bot_apps_owner_idx ON bot_apps (owner_id);
CREATE TABLE IF NOT EXISTS bot_hooks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled BIGINT NOT NULL DEFAULT 1,
  failures BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_hooks_bot_idx ON bot_hooks (bot_id, enabled);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
"#;

pub async fn init_pool(
    driver: &str,
    db_file: &Path,
    database_url: &str,
) -> Result<AnyPool, String> {
    sqlx::any::install_default_drivers();
    let postgres = driver == "postgres";
    let url = if postgres {
        if database_url.trim().is_empty() {
            return Err("PostgreSQL 需要填写连接串".to_string());
        }
        database_url.trim().to_string()
    } else {
        if let Some(parent) = db_file.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
        }
        format!("sqlite://{}?mode=rwc", db_file.display())
    };

    let pool = AnyPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(move |conn, _meta| {
            Box::pin(async move {
                if !postgres {
                    let _ = sqlx::query("PRAGMA busy_timeout = 5000")
                        .execute(&mut *conn)
                        .await;
                }
                Ok(())
            })
        })
        .connect(&url)
        .await
        .map_err(|err| format!("数据库连接失败：{err}"))?;

    if postgres {
        sqlx::raw_sql(PG_DDL)
            .execute(&pool)
            .await
            .map_err(|err| format!("建表失败：{err}"))?;
    } else {
        sqlx::query("PRAGMA journal_mode = WAL")
            .execute(&pool)
            .await
            .map_err(|err| err.to_string())?;
        sqlx::raw_sql(DDL)
            .execute(&pool)
            .await
            .map_err(|err| err.to_string())?;
        init_fts(&pool).await;
    }
    Ok(pool)
}

static FTS_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn fts_enabled() -> bool {
    FTS_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

async fn init_fts(pool: &AnyPool) {
    let setup = async {
        sqlx::raw_sql(
            "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, message_id UNINDEXED, tokenize = 'trigram')",
        )
        .execute(pool)
        .await?;
        sqlx::raw_sql(
            "CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
            END",
        )
        .execute(pool)
        .await?;
        sqlx::raw_sql(
            "CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
                DELETE FROM messages_fts WHERE message_id = old.id;
            END",
        )
        .execute(pool)
        .await?;
        sqlx::raw_sql(
            "CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
                DELETE FROM messages_fts WHERE message_id = old.id;
                INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
            END",
        )
        .execute(pool)
        .await?;
        sqlx::raw_sql(
            "INSERT INTO messages_fts(content, message_id) SELECT content, id FROM messages WHERE id NOT IN (SELECT message_id FROM messages_fts)",
        )
        .execute(pool)
        .await?;
        Ok::<(), sqlx::Error>(())
    };
    match setup.await {
        Ok(_) => {
            FTS_ENABLED.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        Err(err) => {
            tracing::warn!("sqlite fts5 trigram unavailable, fallback to LIKE: {err}");
        }
    }
}

#[derive(Debug, Clone)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub created_at: i64,
    pub is_admin: bool,
    pub banned: bool,
    pub token_version: i64,
    pub dept_id: Option<String>,
    pub title: Option<String>,
    pub must_change_password: bool,
    pub totp_secret: Option<String>,
}

fn user_of(row: &AnyRow) -> UserRow {
    UserRow {
        id: row.get("id"),
        username: row.get("username"),
        password_hash: row.get("password_hash"),
        created_at: row.get("created_at"),
        is_admin: row.get_i64("is_admin") != 0,
        banned: row.get_i64("banned") != 0,
        token_version: row.get("token_version"),
        dept_id: row.try_get("dept_id").ok().flatten(),
        title: row.try_get("title").ok().flatten(),
        must_change_password: row.get_i64("must_change_password") != 0,
        totp_secret: row.try_get("totp_secret").ok().flatten(),
    }
}

pub async fn user_by_username(db: &AnyPool, username: &str) -> Result<Option<UserRow>, String> {
    sqlx::query("SELECT * FROM users WHERE username = $1")
        .bind(username)
        .fetch_optional(db)
        .await
        .map(|row| row.as_ref().map(user_of))
        .map_err(|err| err.to_string())
}

pub async fn user_by_id(db: &AnyPool, id: &str) -> Result<Option<UserRow>, String> {
    sqlx::query("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map(|row| row.as_ref().map(user_of))
        .map_err(|err| err.to_string())
}

pub async fn users_by_ids(db: &AnyPool, ids: &[String]) -> Result<Vec<(String, String)>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = marks(1, ids.len());
    let sql = format!("SELECT id, username FROM users WHERE id IN ({placeholders})");
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id);
    }
    let rows = query.fetch_all(db).await.map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| (row.get_str("id"), row.get_str("username")))
        .collect())
}

pub async fn all_users(db: &AnyPool) -> Result<Vec<UserRow>, String> {
    sqlx::query("SELECT * FROM users ORDER BY username")
        .fetch_all(db)
        .await
        .map(|rows| rows.iter().map(user_of).collect())
        .map_err(|err| err.to_string())
}

pub async fn count_users(db: &AnyPool) -> Result<i64, String> {
    sqlx::query("SELECT count(*) AS total FROM users")
        .fetch_one(db)
        .await
        .map(|row| row.get_i64("total"))
        .map_err(|err| err.to_string())
}

pub async fn create_user(
    db: &AnyPool,
    username: &str,
    password_hash: &str,
) -> Result<UserRow, String> {
    let total = count_users(db).await?;
    let id = crate::util::uuid();
    let now = crate::util::now_ms();
    sqlx::query(
        "INSERT INTO users (id, username, password_hash, created_at, is_admin, banned, token_version, must_change_password) VALUES ($1, $2, $3, $4, $5, 0, 0, 0)",
    )
    .bind(&id)
    .bind(username)
    .bind(password_hash)
    .bind(now)
    .bind(if total == 0 { 1 } else { 0 })
    .execute(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(UserRow {
        id,
        username: username.to_string(),
        password_hash: password_hash.to_string(),
        created_at: now,
        is_admin: total == 0,
        banned: false,
        token_version: 0,
        dept_id: None,
        title: None,
        must_change_password: false,
        totp_secret: None,
    })
}

pub async fn set_password(db: &AnyPool, id: &str, hash: &str) -> Result<i64, String> {
    sqlx::query("UPDATE users SET password_hash = $1, token_version = token_version + 1, must_change_password = 0 WHERE id = $2")
        .bind(hash)
        .bind(id)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    let version = sqlx::query("SELECT token_version FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map_err(|err| err.to_string())?
        .map(|row| row.get_i64("token_version"))
        .unwrap_or(0);
    Ok(version)
}

pub async fn set_totp(db: &AnyPool, id: &str, secret: Option<&str>) -> Result<(), String> {
    sqlx::query("UPDATE users SET totp_secret = $1 WHERE id = $2")
        .bind(secret)
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn set_flag(db: &AnyPool, id: &str, flag: &str, value: bool) -> Result<(), String> {
    let column = if flag == "isAdmin" { "is_admin" } else { "banned" };
    let sql = format!("UPDATE users SET {column} = $1 WHERE id = $2");
    sqlx::query(&sql)
        .bind(if value { 1 } else { 0 })
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn settings_get(db: &AnyPool, key: &str) -> Result<Option<String>, String> {
    sqlx::query("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await
        .map(|row| row.map(|row| row.get_str("value")))
        .map_err(|err| err.to_string())
}

pub async fn settings_set(db: &AnyPool, key: &str, value: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn audit(
    db: &AnyPool,
    actor_id: Option<&str>,
    actor: &str,
    action: &str,
    detail: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO audit_logs (id, actor_id, actor, action, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(crate::util::uuid())
    .bind(actor_id)
    .bind(actor)
    .bind(action)
    .bind(detail)
    .bind(crate::util::now_ms())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
pub struct FriendEdge {
    pub requester_id: String,
    pub addressee_id: String,
    pub status: String,
    pub message: Option<String>,
}

pub async fn friend_edges(db: &AnyPool, user_id: &str) -> Result<Vec<FriendEdge>, String> {
    let rows = sqlx::query(
        "SELECT requester_id, addressee_id, status, message FROM friendships WHERE requester_id = $1 OR addressee_id = $2",
    )
    .bind(user_id)
    .bind(user_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| FriendEdge {
            requester_id: row.get("requester_id"),
            addressee_id: row.get("addressee_id"),
            status: row.get("status"),
            message: row.try_get("message").ok().flatten(),
        })
        .collect())
}

pub async fn friend_request(
    db: &AnyPool,
    requester: &str,
    addressee: &str,
    message: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO friendships (requester_id, addressee_id, status, created_at, message) VALUES ($1, $2, 'pending', $3, $4)",
    )
    .bind(requester)
    .bind(addressee)
    .bind(crate::util::now_ms())
    .bind(message)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn friend_accept(db: &AnyPool, requester: &str, addressee: &str) -> Result<(), String> {
    let changed = sqlx::query(
        "UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2",
    )
    .bind(requester)
    .bind(addressee)
    .execute(db)
    .await
    .map_err(|err| err.to_string())?
    .rows_affected();
    if changed == 0 {
        sqlx::query(
            "INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES ($1, $2, 'accepted', $3) ON CONFLICT(requester_id, addressee_id) DO UPDATE SET status = 'accepted'",
        )
        .bind(requester)
        .bind(addressee)
        .bind(crate::util::now_ms())
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub async fn friend_remove_between(db: &AnyPool, a: &str, b: &str) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $3 AND addressee_id = $4)",
    )
    .bind(a)
    .bind(b)
    .bind(b)
    .bind(a)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn friend_block(db: &AnyPool, owner: &str, target: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES ($1, $2, 'blocked', $3) ON CONFLICT(requester_id, addressee_id) DO UPDATE SET status = 'blocked'",
    )
    .bind(owner)
    .bind(target)
    .bind(crate::util::now_ms())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn friend_unblock(db: &AnyPool, owner: &str, target: &str) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'blocked'",
    )
    .bind(owner)
    .bind(target)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn friend_remarks(
    db: &AnyPool,
    owner: &str,
) -> Result<Vec<(String, String)>, String> {
    let rows = sqlx::query("SELECT friend_id, remark FROM friend_remarks WHERE owner_id = $1")
        .bind(owner)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| (row.get_str("friend_id"), row.get_str("remark")))
        .collect())
}

pub async fn friend_set_remark(
    db: &AnyPool,
    owner: &str,
    friend: &str,
    remark: &str,
) -> Result<(), String> {
    if remark.is_empty() {
        sqlx::query("DELETE FROM friend_remarks WHERE owner_id = $1 AND friend_id = $2")
            .bind(owner)
            .bind(friend)
            .execute(db)
            .await
            .map_err(|err| err.to_string())?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO friend_remarks (owner_id, friend_id, remark) VALUES ($1, $2, $3) ON CONFLICT(owner_id, friend_id) DO UPDATE SET remark = excluded.remark",
    )
    .bind(owner)
    .bind(friend)
    .bind(remark)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn friend_stars(db: &AnyPool, owner: &str) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT friend_id FROM friend_stars WHERE owner_id = $1")
        .bind(owner)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows.iter().map(|row| row.get_str("friend_id")).collect())
}

pub async fn friend_set_star(
    db: &AnyPool,
    owner: &str,
    friend: &str,
    on: bool,
) -> Result<(), String> {
    if on {
        sqlx::query(
            "INSERT INTO friend_stars (owner_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(owner)
        .bind(friend)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
    } else {
        sqlx::query("DELETE FROM friend_stars WHERE owner_id = $1 AND friend_id = $2")
            .bind(owner)
            .bind(friend)
            .execute(db)
            .await
            .map(|_| ())
            .map_err(|err| err.to_string())
    }
}

pub async fn friend_groups_list(
    db: &AnyPool,
    owner: &str,
) -> Result<Vec<(String, String)>, String> {
    let rows = sqlx::query("SELECT id, name FROM friend_groups WHERE owner_id = $1 ORDER BY created_at")
        .bind(owner)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| (row.get_str("id"), row.get_str("name")))
        .collect())
}

pub async fn friend_group_create(
    db: &AnyPool,
    owner: &str,
    name: &str,
) -> Result<String, String> {
    let id = crate::util::uuid();
    sqlx::query("INSERT INTO friend_groups (id, owner_id, name, created_at) VALUES ($1, $2, $3, $4)")
        .bind(&id)
        .bind(owner)
        .bind(name)
        .bind(crate::util::now_ms())
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(id)
}

pub async fn friend_group_rename(
    db: &AnyPool,
    owner: &str,
    group_id: &str,
    name: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE friend_groups SET name = $1 WHERE id = $2 AND owner_id = $3")
        .bind(name)
        .bind(group_id)
        .bind(owner)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn friend_group_remove(
    db: &AnyPool,
    owner: &str,
    group_id: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM friend_groups WHERE id = $1 AND owner_id = $2")
        .bind(group_id)
        .bind(owner)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    sqlx::query("DELETE FROM friend_group_members WHERE owner_id = $1 AND group_id = $2")
        .bind(owner)
        .bind(group_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn friend_group_map(
    db: &AnyPool,
    owner: &str,
) -> Result<Vec<(String, String)>, String> {
    let rows = sqlx::query("SELECT friend_id, group_id FROM friend_group_members WHERE owner_id = $1")
        .bind(owner)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| (row.get_str("friend_id"), row.get_str("group_id")))
        .collect())
}

pub async fn friend_group_set(
    db: &AnyPool,
    owner: &str,
    friend: &str,
    group_id: Option<&str>,
) -> Result<(), String> {
    let Some(group_id) = group_id else {
        sqlx::query("DELETE FROM friend_group_members WHERE owner_id = $1 AND friend_id = $2")
            .bind(owner)
            .bind(friend)
            .execute(db)
            .await
            .map_err(|err| err.to_string())?;
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO friend_group_members (owner_id, friend_id, group_id) VALUES ($1, $2, $3) ON CONFLICT(owner_id, friend_id) DO UPDATE SET group_id = excluded.group_id",
    )
    .bind(owner)
    .bind(friend)
    .bind(group_id)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    pub notice: String,
    pub mute_all: bool,
    pub no_friend_add: bool,
    pub invite_code: Option<String>,
    pub invite_expires_at: Option<i64>,
    pub join_approval: bool,
    pub created_at: i64,
}

fn group_of(row: &AnyRow) -> GroupRow {
    GroupRow {
        id: row.get("id"),
        name: row.get("name"),
        owner_id: row.get("owner_id"),
        notice: row.get("notice"),
        mute_all: row.get_i64("mute_all") != 0,
        no_friend_add: row.get_i64("no_friend_add") != 0,
        invite_code: row.try_get("invite_code").ok().flatten(),
        invite_expires_at: row.try_get("invite_expires_at").ok().flatten(),
        join_approval: row.get_i64("join_approval") != 0,
        created_at: row.get("created_at"),
    }
}

pub async fn group_by_id(db: &AnyPool, id: &str) -> Result<Option<GroupRow>, String> {
    sqlx::query("SELECT * FROM groups WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map(|row| row.as_ref().map(group_of))
        .map_err(|err| err.to_string())
}

pub async fn group_by_invite(db: &AnyPool, code: &str) -> Result<Option<GroupRow>, String> {
    sqlx::query("SELECT * FROM groups WHERE invite_code = $1")
        .bind(code)
        .fetch_optional(db)
        .await
        .map(|row| row.as_ref().map(group_of))
        .map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
pub struct GroupMemberRow {
    pub user_id: String,
    pub role: String,
    pub muted: bool,
    pub joined_at: i64,
    pub title: Option<String>,
}

pub async fn group_members(
    db: &AnyPool,
    group_id: &str,
) -> Result<Vec<GroupMemberRow>, String> {
    let rows = sqlx::query(
        "SELECT user_id, role, muted, joined_at, title FROM group_members WHERE group_id = $1 ORDER BY joined_at",
    )
    .bind(group_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| GroupMemberRow {
            user_id: row.get("user_id"),
            role: row.get("role"),
            muted: row.get_i64("muted") != 0,
            joined_at: row.get("joined_at"),
            title: row.try_get("title").ok().flatten(),
        })
        .collect())
}

pub async fn group_member_ids(db: &AnyPool, group_id: &str) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT user_id FROM group_members WHERE group_id = $1")
        .bind(group_id)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows.iter().map(|row| row.get_str("user_id")).collect())
}

pub async fn groups_of(db: &AnyPool, user_id: &str) -> Result<Vec<GroupRow>, String> {
    let rows = sqlx::query(
        "SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = $1 ORDER BY g.created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows.iter().map(group_of).collect())
}

pub async fn group_create(db: &AnyPool, name: &str, owner_id: &str) -> Result<GroupRow, String> {
    let id = crate::util::uuid();
    let now = crate::util::now_ms();
    sqlx::query(
        "INSERT INTO groups (id, name, owner_id, notice, mute_all, no_friend_add, join_approval, created_at) VALUES ($1, $2, $3, '', 0, 0, 1, $4)",
    )
    .bind(&id)
    .bind(name)
    .bind(owner_id)
    .bind(now)
    .execute(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(GroupRow {
        id,
        name: name.to_string(),
        owner_id: owner_id.to_string(),
        notice: String::new(),
        mute_all: false,
        no_friend_add: false,
        invite_code: None,
        invite_expires_at: None,
        join_approval: true,
        created_at: now,
    })
}

pub async fn group_add_member(
    db: &AnyPool,
    group_id: &str,
    user_id: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO group_members (group_id, user_id, role, muted, joined_at) VALUES ($1, $2, 'member', 0, $3) ON CONFLICT(group_id, user_id) DO NOTHING",
    )
    .bind(group_id)
    .bind(user_id)
    .bind(crate::util::now_ms())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn group_remove_member(
    db: &AnyPool,
    group_id: &str,
    user_id: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2")
        .bind(group_id)
        .bind(user_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn group_set_role(
    db: &AnyPool,
    group_id: &str,
    user_id: &str,
    role: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3")
        .bind(role)
        .bind(group_id)
        .bind(user_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn group_set_muted(
    db: &AnyPool,
    group_id: &str,
    user_id: &str,
    muted: bool,
) -> Result<(), String> {
    sqlx::query("UPDATE group_members SET muted = $1 WHERE group_id = $2 AND user_id = $3")
        .bind(if muted { 1 } else { 0 })
        .bind(group_id)
        .bind(user_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn group_set_member_title(
    db: &AnyPool,
    group_id: &str,
    user_id: &str,
    title: Option<&str>,
) -> Result<(), String> {
    sqlx::query("UPDATE group_members SET title = $1 WHERE group_id = $2 AND user_id = $3")
        .bind(title)
        .bind(group_id)
        .bind(user_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn group_update(
    db: &AnyPool,
    group_id: &str,
    column: &str,
    value: &str,
) -> Result<(), String> {
    let allowed = [
        "name",
        "notice",
        "mute_all",
        "no_friend_add",
        "invite_code",
        "invite_expires_at",
        "join_approval",
        "owner_id",
    ];
    if !allowed.contains(&column) {
        return Err("非法字段".to_string());
    }
    let sql = format!("UPDATE groups SET {column} = $1 WHERE id = $2");
    sqlx::query(&sql)
        .bind(value)
        .bind(group_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn group_set_bool(
    db: &AnyPool,
    group_id: &str,
    column: &str,
    value: bool,
) -> Result<(), String> {
    let allowed = ["mute_all", "no_friend_add", "join_approval"];
    if !allowed.contains(&column) {
        return Err("非法字段".to_string());
    }
    let sql = format!("UPDATE groups SET {column} = $1 WHERE id = $2");
    sqlx::query(&sql)
        .bind(if value { 1 } else { 0 })
        .bind(group_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn group_set_invite(
    db: &AnyPool,
    group_id: &str,
    code: Option<&str>,
    expires_at: Option<i64>,
) -> Result<(), String> {
    sqlx::query("UPDATE groups SET invite_code = $1, invite_expires_at = $2 WHERE id = $3")
        .bind(code)
        .bind(expires_at)
        .bind(group_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn group_set_owner(
    db: &AnyPool,
    group_id: &str,
    owner_id: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE groups SET owner_id = $1 WHERE id = $2")
        .bind(owner_id)
        .bind(group_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn group_delete(db: &AnyPool, group_id: &str) -> Result<(), String> {
    for sql in [
        "DELETE FROM group_members WHERE group_id = $1",
        "DELETE FROM group_join_requests WHERE group_id = $1",
        "DELETE FROM group_files WHERE group_id = $1",
        "DELETE FROM essences WHERE group_id = $1",
        "DELETE FROM groups WHERE id = $1",
    ] {
        sqlx::query(sql)
            .bind(group_id)
            .execute(db)
            .await
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub async fn join_request_upsert(
    db: &AnyPool,
    group_id: &str,
    user_id: &str,
    message: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO group_join_requests (group_id, user_id, message, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT(group_id, user_id) DO UPDATE SET message = excluded.message, created_at = excluded.created_at",
    )
    .bind(group_id)
    .bind(user_id)
    .bind(message)
    .bind(crate::util::now_ms())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn join_requests(
    db: &AnyPool,
    group_id: &str,
) -> Result<Vec<(String, String, i64)>, String> {
    let rows = sqlx::query(
        "SELECT user_id, message, created_at FROM group_join_requests WHERE group_id = $1 ORDER BY created_at",
    )
    .bind(group_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get_str("user_id"),
                row.get_str("message"),
                row.get_i64("created_at"),
            )
        })
        .collect())
}

pub async fn join_request_count(db: &AnyPool, group_id: &str) -> Result<i64, String> {
    sqlx::query("SELECT count(*) AS total FROM group_join_requests WHERE group_id = $1")
        .bind(group_id)
        .fetch_one(db)
        .await
        .map(|row| row.get_i64("total"))
        .map_err(|err| err.to_string())
}

pub async fn join_request_remove(
    db: &AnyPool,
    group_id: &str,
    user_id: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM group_join_requests WHERE group_id = $1 AND user_id = $2")
        .bind(group_id)
        .bind(user_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn friend_add_blocked(
    db: &AnyPool,
    a: &str,
    b: &str,
) -> Result<bool, String> {
    let rows = sqlx::query(
        "SELECT g.no_friend_add AS flag FROM group_members ma JOIN group_members mb ON mb.group_id = ma.group_id JOIN groups g ON g.id = ma.group_id WHERE ma.user_id = $1 AND mb.user_id = $2 AND g.no_friend_add = 1 LIMIT 1",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows.is_some())
}

#[derive(Debug, Clone)]
pub struct SaveMessage {
    pub session: String,
    pub sender: String,
    pub content: String,
    pub quote: Option<Value>,
    pub mentions: Option<Value>,
    pub kind: String,
    pub file: Option<Value>,
    pub link: Option<Value>,
    pub red_packet: Option<Value>,
    pub transfer: Option<Value>,
    pub aa_bill: Option<Value>,
}

fn json_col(row: &AnyRow, column: &str) -> Value {
    match row.try_get::<Option<String>, _>(column) {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

pub fn message_json(row: &AnyRow) -> Value {
    json!({
        "id": row.get_str("id"),
        "session": row.get_str("session"),
        "sender": row.get_str("sender"),
        "content": row.get_str("content"),
        "seq": row.get_i64("seq"),
        "createdAt": crate::util::iso_from_ms(row.get_i64("created_at")),
        "recalledAt": row.try_get::<Option<i64>, _>("recalled_at").ok().flatten().map(crate::util::iso_from_ms),
        "editedAt": row.try_get::<Option<i64>, _>("edited_at").ok().flatten().map(crate::util::iso_from_ms),
        "editCount": row.get_i64("edit_count"),
        "quote": json_col(row, "quote"),
        "mentions": json_col(row, "mentions"),
        "kind": row.try_get::<Option<String>, _>("kind").ok().flatten().unwrap_or_else(|| "text".to_string()),
        "file": json_col(row, "file"),
        "link": json_col(row, "link"),
        "reactions": json_col(row, "reactions"),
        "redPacket": json_col(row, "red_packet"),
        "transfer": json_col(row, "transfer"),
        "aaBill": json_col(row, "aa_bill"),
    })
}

fn encode_col(value: &Option<Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(other) => Some(other.to_string()),
    }
}

pub async fn save_message(db: &AnyPool, input: SaveMessage) -> Result<Value, String> {
    let id = crate::util::uuid();
    let now = crate::util::now_ms();
    let mut tx = db.begin().await.map_err(|err| err.to_string())?;
    let seq: i64 = sqlx::query("SELECT coalesce(max(seq), 0) AS maxseq FROM messages WHERE session = $1")
        .bind(&input.session)
        .fetch_one(&mut *tx)
        .await
        .map_err(|err| err.to_string())?
        .get("maxseq");
    let seq = seq + 1;
    sqlx::query(
        "INSERT INTO messages (id, session, sender, content, seq, created_at, edit_count, quote, mentions, kind, file, link, red_packet, transfer, aa_bill) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, $12, $13, $14)",
    )
    .bind(&id)
    .bind(&input.session)
    .bind(&input.sender)
    .bind(&input.content)
    .bind(seq)
    .bind(now)
    .bind(encode_col(&input.quote))
    .bind(encode_col(&input.mentions))
    .bind(&input.kind)
    .bind(encode_col(&input.file))
    .bind(encode_col(&input.link))
    .bind(encode_col(&input.red_packet))
    .bind(encode_col(&input.transfer))
    .bind(encode_col(&input.aa_bill))
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(json!({
        "id": id,
        "session": input.session,
        "sender": input.sender,
        "content": input.content,
        "seq": seq,
        "createdAt": crate::util::iso_from_ms(now),
        "recalledAt": Value::Null,
        "editedAt": Value::Null,
        "editCount": 0,
        "quote": input.quote.unwrap_or(Value::Null),
        "mentions": input.mentions.unwrap_or(Value::Null),
        "kind": input.kind,
        "file": input.file.unwrap_or(Value::Null),
        "link": input.link.unwrap_or(Value::Null),
        "reactions": Value::Null,
        "redPacket": input.red_packet.unwrap_or(Value::Null),
        "transfer": input.transfer.unwrap_or(Value::Null),
        "aaBill": input.aa_bill.unwrap_or(Value::Null),
    }))
}

pub async fn message_by_id(db: &AnyPool, id: &str) -> Result<Option<Value>, String> {
    sqlx::query("SELECT * FROM messages WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map(|row| row.as_ref().map(message_json))
        .map_err(|err| err.to_string())
}

pub async fn message_cursor(db: &AnyPool, id: &str) -> Result<Option<i64>, String> {
    sqlx::query("SELECT seq FROM messages WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map(|row| row.map(|row| row.get_i64("seq")))
        .map_err(|err| err.to_string())
}

pub async fn last_seq(db: &AnyPool, session: &str) -> Result<i64, String> {
    sqlx::query("SELECT coalesce(max(seq), 0) AS maxseq FROM messages WHERE session = $1")
        .bind(session)
        .fetch_one(db)
        .await
        .map(|row| row.get_i64("maxseq"))
        .map_err(|err| err.to_string())
}

pub struct HistoryCursor {
    pub before: Option<String>,
    pub after: Option<String>,
    pub before_id: Option<String>,
    pub after_id: Option<String>,
    pub before_seq: Option<i64>,
    pub after_seq: Option<i64>,
}

pub async fn message_list(
    db: &AnyPool,
    session: &str,
    limit: i64,
    cursor: &HistoryCursor,
) -> Result<Vec<Value>, String> {
    let older = match cursor.before_id.as_deref() {
        Some(id) => message_cursor(db, id).await?,
        None => None,
    };
    let newer = match cursor.after_id.as_deref() {
        Some(id) => message_cursor(db, id).await?,
        None => None,
    };
    let before_seq = cursor.before_seq.or(older);
    let after_seq = cursor.after_seq.or(newer);
    let before_inclusive = cursor.before_seq.is_none() && older.is_some();
    let after_inclusive = cursor.after_seq.is_none() && newer.is_some();

    let mut clauses: Vec<String> = vec!["session = $1".to_string()];
    let mut binds: Vec<Value> = vec![Value::String(session.to_string())];
    match before_seq {
        Some(seq) => {
            let op = if before_inclusive { "<=" } else { "<" };
            clauses.push(format!("seq {op} ${}", binds.len() + 1));
            binds.push(json!(seq));
        }
        None => {
            if let Some(before) = cursor.before.as_deref().and_then(crate::util::parse_iso) {
                clauses.push(format!("created_at < ${}", binds.len() + 1));
                binds.push(json!(before));
            }
        }
    }
    match after_seq {
        Some(seq) => {
            let op = if after_inclusive { ">=" } else { ">" };
            clauses.push(format!("seq {op} ${}", binds.len() + 1));
            binds.push(json!(seq));
        }
        None => {
            if let Some(after) = cursor.after.as_deref().and_then(crate::util::parse_iso) {
                clauses.push(format!("created_at > ${}", binds.len() + 1));
                binds.push(json!(after));
            }
        }
    }
    let ascending = cursor.after_seq.is_some() || newer.is_some() || (!older.is_some() && cursor.after.is_some());
    let order = if ascending {
        "seq ASC, created_at ASC, id ASC"
    } else {
        "seq DESC, created_at DESC, id DESC"
    };
    let limit_mark = binds.len() + 1;
    let sql = format!(
        "SELECT * FROM messages WHERE {} ORDER BY {} LIMIT ${limit_mark}",
        clauses.join(" AND "),
        order
    );
    let mut query = sqlx::query(&sql);
    for bind in &binds {
        query = match bind {
            Value::String(text) => query.bind(text),
            Value::Number(number) => query.bind(number.as_i64().unwrap_or(0)),
            _ => query.bind(0i64),
        };
    }
    let rows = query
        .bind(limit)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    let mut list: Vec<Value> = rows.iter().map(message_json).collect();
    if !ascending {
        list.reverse();
    }
    Ok(list)
}

pub async fn messages_since(
    db: &AnyPool,
    session: &str,
    seq: i64,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let rows = sqlx::query(
        "SELECT * FROM messages WHERE session = $1 AND seq > $2 ORDER BY seq ASC, created_at ASC, id ASC LIMIT $3",
    )
    .bind(session)
    .bind(seq)
    .bind(limit)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows.iter().map(message_json).collect())
}

pub struct SessionSummary {
    pub session: String,
    pub last_seq: i64,
    pub read_seq: i64,
    pub unread: i64,
    pub last_message: Option<Value>,
}

pub async fn session_summaries(
    db: &AnyPool,
    user_id: &str,
    username: &str,
    sessions: &[String],
) -> Result<Vec<SessionSummary>, String> {
    let mut out = Vec::new();
    for session in sessions {
        let row = sqlx::query(
            "SELECT max(m.seq) AS lastseq, coalesce(max(r.seq), 0) AS readseq, CAST(sum(CASE WHEN m.seq > coalesce(r.seq, 0) AND m.sender <> $1 THEN 1 ELSE 0 END) AS BIGINT) AS unread FROM messages m LEFT JOIN reads r ON r.session = m.session AND r.user_id = $2 WHERE m.session = $3",
        )
        .bind(username)
        .bind(user_id)
        .bind(session)
        .fetch_one(db)
        .await
        .map_err(|err| err.to_string())?;
        let last_seq: i64 = row.try_get::<Option<i64>, _>("lastseq").ok().flatten().unwrap_or(0);
        let read_seq: i64 = row.try_get::<Option<i64>, _>("readseq").ok().flatten().unwrap_or(0);
        let unread: i64 = row.try_get::<Option<i64>, _>("unread").ok().flatten().unwrap_or(0);
        let last_message = if last_seq > 0 {
            sqlx::query("SELECT * FROM messages WHERE session = $1 AND seq = $2 LIMIT 1")
                .bind(session)
                .bind(last_seq)
                .fetch_optional(db)
                .await
                .map_err(|err| err.to_string())?
                .as_ref()
                .map(message_json)
        } else {
            None
        };
        out.push(SessionSummary {
            session: session.clone(),
            last_seq,
            read_seq,
            unread,
            last_message,
        });
    }
    Ok(out)
}

pub struct SearchParams {
    pub keyword: Option<String>,
    pub session: Option<String>,
    pub sessions: Option<Vec<String>>,
    pub sender: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub offset: i64,
    pub limit: i64,
}

pub async fn search_messages(
    db: &AnyPool,
    params: &SearchParams,
) -> Result<(Vec<Value>, i64), String> {
    let mut clauses: Vec<String> = vec!["recalled_at IS NULL".to_string()];
    let mut binds: Vec<Bind> = Vec::new();
    if let Some(session) = params.session.as_ref() {
        clauses.push(format!("session = ${}", binds.len() + 1));
        binds.push(Bind::Text(session.clone()));
    }
    if let Some(sessions) = params.sessions.as_ref() {
        if sessions.is_empty() {
            return Ok((Vec::new(), 0));
        }
        clauses.push(format!("session IN ({})", marks(binds.len() + 1, sessions.len())));
        for session in sessions {
            binds.push(Bind::Text(session.clone()));
        }
    }
    if let Some(sender) = params.sender.as_ref() {
        clauses.push(format!("sender = ${}", binds.len() + 1));
        binds.push(Bind::Text(sender.clone()));
    }
    if let Some(from) = params.from {
        clauses.push(format!("created_at >= ${}", binds.len() + 1));
        binds.push(Bind::Int(from));
    }
    if let Some(to) = params.to {
        clauses.push(format!("created_at <= ${}", binds.len() + 1));
        binds.push(Bind::Int(to));
    }
    if let Some(keyword) = params.keyword.as_ref() {
        let keyword = keyword.trim();
        if !keyword.is_empty() {
            let chars = keyword.chars().count();
            if fts_enabled() && chars >= 3 && !keyword.chars().any(|ch| ch.is_whitespace()) {
                clauses.push(format!(
                    "id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ${})",
                    binds.len() + 1
                ));
                binds.push(Bind::Text(format!("\"{}\"", keyword.replace('"', "\"\""))));
            } else {
                clauses.push(format!("content LIKE ${} ESCAPE '\\'", binds.len() + 1));
                let escaped = keyword
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
                binds.push(Bind::Text(format!("%{escaped}%")));
            }
        }
    }

    let where_sql = clauses.join(" AND ");
    let count_sql = format!("SELECT count(*) AS total FROM messages WHERE {where_sql}");
    let total: i64 = apply_binds(sqlx::query(&count_sql), &binds)
        .fetch_one(db)
        .await
        .map_err(|err| err.to_string())?
        .get("total");

    let limit_mark = binds.len() + 1;
    let list_sql = format!(
        "SELECT * FROM messages WHERE {where_sql} ORDER BY created_at DESC LIMIT ${limit_mark} OFFSET ${}",
        limit_mark + 1
    );
    let rows = apply_binds(sqlx::query(&list_sql), &binds)
        .bind(params.limit)
        .bind(params.offset)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok((rows.iter().map(message_json).collect(), total))
}

pub async fn mark_recalled(db: &AnyPool, id: &str) -> Result<Option<i64>, String> {
    let now = crate::util::now_ms();
    sqlx::query("UPDATE messages SET recalled_at = $1 WHERE id = $2")
        .bind(now)
        .bind(id)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(Some(now))
}

pub async fn set_reactions(db: &AnyPool, id: &str, reactions: Value) -> Result<Option<Value>, String> {
    sqlx::query("UPDATE messages SET reactions = $1 WHERE id = $2")
        .bind(if reactions.is_null() {
            None
        } else {
            Some(reactions.to_string())
        })
        .bind(id)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    message_by_id(db, id).await
}

pub async fn edit_message(db: &AnyPool, id: &str, content: &str, at_ms: i64) -> Result<Option<Value>, String> {
    sqlx::query("UPDATE messages SET content = $1, edited_at = $2, edit_count = edit_count + 1 WHERE id = $3")
        .bind(content)
        .bind(at_ms)
        .bind(id)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    message_by_id(db, id).await
}

pub async fn read_set(
    db: &AnyPool,
    user_id: &str,
    session: &str,
    at_ms: i64,
    seq: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO reads (user_id, session, read_at, seq) VALUES ($1, $2, $3, $4) ON CONFLICT(user_id, session) DO UPDATE SET read_at = excluded.read_at, seq = CASE WHEN excluded.seq > reads.seq THEN excluded.seq ELSE reads.seq END",
    )
    .bind(user_id)
    .bind(session)
    .bind(at_ms)
    .bind(seq)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn read_cursors(db: &AnyPool, user_id: &str) -> Result<Vec<(String, i64)>, String> {
    let rows = sqlx::query("SELECT session, seq FROM reads WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| (row.get_str("session"), row.get_i64("seq")))
        .collect())
}

pub async fn reads_of_session(
    db: &AnyPool,
    session: &str,
) -> Result<Vec<(String, i64, i64)>, String> {
    let rows = sqlx::query("SELECT user_id, read_at, seq FROM reads WHERE session = $1")
        .bind(session)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get_str("user_id"),
                row.get_i64("read_at"),
                row.get_i64("seq"),
            )
        })
        .collect())
}

pub async fn session_meta_of(db: &AnyPool, user_id: &str) -> Result<Vec<(String, bool)>, String> {
    let rows = sqlx::query("SELECT session, pinned FROM session_meta WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| (row.get_str("session"), row.get_i64("pinned") != 0))
        .collect())
}

pub async fn session_meta_set(
    db: &AnyPool,
    user_id: &str,
    session: &str,
    pinned: bool,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO session_meta (user_id, session, pinned) VALUES ($1, $2, $3) ON CONFLICT(user_id, session) DO UPDATE SET pinned = excluded.pinned",
    )
    .bind(user_id)
    .bind(session)
    .bind(if pinned { 1 } else { 0 })
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
pub struct AuthSessionRow {
    pub id: String,
    pub label: String,
    pub user_agent: String,
    pub ip: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub revoked: bool,
}

pub async fn auth_session_create(
    db: &AnyPool,
    id: &str,
    user_id: &str,
    label: &str,
    user_agent: &str,
    ip: &str,
) -> Result<(), String> {
    let now = crate::util::now_ms();
    sqlx::query(
        "INSERT INTO auth_sessions (id, user_id, label, user_agent, ip, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(user_id)
    .bind(label)
    .bind(user_agent)
    .bind(ip)
    .bind(now)
    .bind(now)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn auth_session_active(
    db: &AnyPool,
    user_id: &str,
    session_id: &str,
) -> Result<bool, String> {
    sqlx::query("SELECT id FROM auth_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL")
        .bind(session_id)
        .bind(user_id)
        .fetch_optional(db)
        .await
        .map(|row| row.is_some())
        .map_err(|err| err.to_string())
}

pub async fn auth_session_touch(db: &AnyPool, session_id: &str) -> Result<(), String> {
    sqlx::query("UPDATE auth_sessions SET last_seen_at = $1 WHERE id = $2")
        .bind(crate::util::now_ms())
        .bind(session_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn auth_sessions_of(
    db: &AnyPool,
    user_id: &str,
) -> Result<Vec<AuthSessionRow>, String> {
    let rows = sqlx::query(
        "SELECT id, label, user_agent, ip, created_at, last_seen_at, revoked_at FROM auth_sessions WHERE user_id = $1 ORDER BY last_seen_at DESC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| AuthSessionRow {
            id: row.get("id"),
            label: row.get("label"),
            user_agent: row.get("user_agent"),
            ip: row.get("ip"),
            created_at: row.get("created_at"),
            last_seen_at: row.get("last_seen_at"),
            revoked: row.try_get::<Option<i64>, _>("revoked_at").ok().flatten().is_some(),
        })
        .collect())
}

pub async fn auth_session_revoke(
    db: &AnyPool,
    user_id: &str,
    session_id: &str,
) -> Result<bool, String> {
    let changed = sqlx::query(
        "UPDATE auth_sessions SET revoked_at = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL",
    )
    .bind(crate::util::now_ms())
    .bind(session_id)
    .bind(user_id)
    .execute(db)
    .await
    .map_err(|err| err.to_string())?
    .rows_affected();
    Ok(changed > 0)
}

pub async fn auth_session_revoke_others(
    db: &AnyPool,
    user_id: &str,
    keep: &str,
) -> Result<u64, String> {
    let changed = sqlx::query(
        "UPDATE auth_sessions SET revoked_at = $1 WHERE user_id = $2 AND id <> $3 AND revoked_at IS NULL",
    )
    .bind(crate::util::now_ms())
    .bind(user_id)
    .bind(keep)
    .execute(db)
    .await
    .map_err(|err| err.to_string())?
    .rows_affected();
    Ok(changed)
}

pub async fn auth_session_rename(
    db: &AnyPool,
    user_id: &str,
    session_id: &str,
    label: &str,
) -> Result<bool, String> {
    let changed = sqlx::query("UPDATE auth_sessions SET label = $1 WHERE id = $2 AND user_id = $3")
        .bind(label)
        .bind(session_id)
        .bind(user_id)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?
        .rows_affected();
    Ok(changed > 0)
}

pub async fn media_save(
    db: &AnyPool,
    key: &str,
    name: &str,
    mime: &str,
    size: i64,
    uploader_id: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO media_files (key, name, mime, size, uploader_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(key)
    .bind(name)
    .bind(mime)
    .bind(size)
    .bind(uploader_id)
    .bind(crate::util::now_ms())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn media_info(
    db: &AnyPool,
    key: &str,
) -> Result<Option<(String, String, i64)>, String> {
    sqlx::query("SELECT name, mime, size FROM media_files WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await
        .map(|row| {
            row.map(|row| {
                (
                    row.get_str("name"),
                    row.get_str("mime"),
                    row.get_i64("size"),
                )
            })
        })
        .map_err(|err| err.to_string())
}

pub async fn essence_add(
    db: &AnyPool,
    group_id: &str,
    message_id: &str,
    set_by: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO essences (group_id, message_id, set_by, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT(group_id, message_id) DO NOTHING",
    )
    .bind(group_id)
    .bind(message_id)
    .bind(set_by)
    .bind(crate::util::now_ms())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn essence_remove(
    db: &AnyPool,
    group_id: &str,
    message_id: &str,
) -> Result<(), String> {
    sqlx::query("DELETE FROM essences WHERE group_id = $1 AND message_id = $2")
        .bind(group_id)
        .bind(message_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn essence_list(db: &AnyPool, group_id: &str) -> Result<Vec<Value>, String> {
    let rows = sqlx::query(
        "SELECT e.message_id AS message_id, e.set_by AS set_by, e.created_at AS set_at, m.sender AS sender, m.content AS content, m.kind AS kind, m.created_at AS created_at FROM essences e LEFT JOIN messages m ON m.id = e.message_id WHERE e.group_id = $1 ORDER BY e.created_at DESC",
    )
    .bind(group_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
            json!({
                "messageId": row.get_str("message_id"),
                "sender": row.try_get::<Option<String>, _>("sender").ok().flatten().unwrap_or_default(),
                "content": row.try_get::<Option<String>, _>("content").ok().flatten().unwrap_or_default(),
                "kind": row.try_get::<Option<String>, _>("kind").ok().flatten(),
                "createdAt": row.try_get::<Option<i64>, _>("created_at").ok().flatten().map(crate::util::iso_from_ms).unwrap_or_default(),
                "setBy": row.get_str("set_by"),
                "setAt": crate::util::iso_from_ms(row.get_i64("set_at")),
            })
        })
        .collect())
}

pub async fn message_count(db: &AnyPool) -> Result<i64, String> {
    sqlx::query("SELECT count(*) AS total FROM messages")
        .fetch_one(db)
        .await
        .map(|row| row.get_i64("total"))
        .map_err(|err| err.to_string())
}

pub async fn message_media_bytes(db: &AnyPool) -> Result<i64, String> {
    sqlx::query("SELECT coalesce(sum(length(content)), 0) AS total FROM messages WHERE kind IS NOT NULL AND kind <> 'text'")
        .fetch_one(db)
        .await
        .map(|row| row.get_i64("total"))
        .map_err(|err| err.to_string())
}

pub async fn count_messages_with_content(db: &AnyPool, content: &str) -> Result<i64, String> {
    sqlx::query("SELECT count(*) AS total FROM messages WHERE content = $1")
        .bind(content)
        .fetch_one(db)
        .await
        .map(|row| row.get_i64("total"))
        .map_err(|err| err.to_string())
}

pub async fn delete_messages_before(
    db: &AnyPool,
    cutoff_ms: i64,
) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT id, content FROM messages WHERE created_at < $1")
        .bind(cutoff_ms)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    let ids: Vec<String> = rows.iter().map(|row| row.get_str("id")).collect();
    let contents: Vec<String> = rows.iter().map(|row| row.get_str("content")).collect();
    sqlx::query("DELETE FROM messages WHERE created_at < $1")
        .bind(cutoff_ms)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    let _ = ids;
    Ok(contents)
}

pub async fn trend(db: &AnyPool, days: i64) -> Result<Vec<Value>, String> {
    let days = days.clamp(1, 90);
    let now = chrono::Local::now();
    let start_day = (now - chrono::Duration::days(days - 1))
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    let start_ms = start_day
        .and_local_timezone(chrono::Local)
        .single()
        .map(|value| value.timestamp_millis())
        .unwrap_or(0);
    let rows = sqlx::query("SELECT created_at, sender FROM messages WHERE created_at >= $1")
        .bind(start_ms)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    let mut map: std::collections::HashMap<String, (i64, std::collections::HashSet<String>)> =
        std::collections::HashMap::new();
    for row in rows.iter() {
        let created_at = row.get_i64("created_at");
        let Some(stamp) = chrono::DateTime::from_timestamp_millis(created_at) else {
            continue;
        };
        let key = stamp
            .with_timezone(&chrono::Local)
            .date_naive()
            .format("%Y-%m-%d")
            .to_string();
        let entry = map.entry(key).or_default();
        entry.0 += 1;
        entry.1.insert(row.get_str("sender"));
    }
    let mut out: Vec<Value> = Vec::new();
    for offset in (0..days).rev() {
        let day = (chrono::Local::now() - chrono::Duration::days(offset)).date_naive();
        let key = day.format("%Y-%m-%d").to_string();
        let (messages, senders) = map
            .get(&key)
            .map(|entry| (entry.0, entry.1.len() as i64))
            .unwrap_or((0, 0));
        out.push(json!({ "date": key, "messages": messages, "senders": senders }));
    }
    Ok(out)
}

pub async fn group_list_all(db: &AnyPool) -> Result<Vec<GroupRow>, String> {
    sqlx::query("SELECT * FROM groups ORDER BY created_at")
        .fetch_all(db)
        .await
        .map(|rows| rows.iter().map(group_of).collect())
        .map_err(|err| err.to_string())
}

pub async fn set_must_change(db: &AnyPool, id: &str, value: bool) -> Result<(), String> {
    sqlx::query("UPDATE users SET must_change_password = $1 WHERE id = $2")
        .bind(if value { 1 } else { 0 })
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn set_org(
    db: &AnyPool,
    id: &str,
    dept_id: Option<&str>,
    title: Option<&str>,
) -> Result<(), String> {
    sqlx::query("UPDATE users SET dept_id = $1, title = $2 WHERE id = $3")
        .bind(dept_id)
        .bind(title)
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
pub struct MediaRow {
    pub key: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub uploader_id: String,
    pub created_at: i64,
}

pub async fn media_list(
    db: &AnyPool,
    offset: i64,
    limit: i64,
) -> Result<(Vec<MediaRow>, i64, i64), String> {
    let rows = sqlx::query("SELECT * FROM media_files ORDER BY created_at DESC LIMIT $1 OFFSET $2")
        .bind(limit)
        .bind(offset)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    let total: i64 = sqlx::query("SELECT count(*) AS total FROM media_files")
        .fetch_one(db)
        .await
        .map(|row| row.get("total"))
        .map_err(|err| err.to_string())?;
    let total_bytes: i64 = sqlx::query("SELECT coalesce(sum(size), 0) AS total FROM media_files")
        .fetch_one(db)
        .await
        .map(|row| row.get("total"))
        .map_err(|err| err.to_string())?;
    let list = rows
        .iter()
        .map(|row| MediaRow {
            key: row.get("key"),
            name: row.get("name"),
            mime: row.get("mime"),
            size: row.get("size"),
            uploader_id: row.get("uploader_id"),
            created_at: row.get("created_at"),
        })
        .collect();
    Ok((list, total, total_bytes))
}

pub async fn media_older_than(db: &AnyPool, cutoff_ms: i64) -> Result<Vec<MediaRow>, String> {
    let rows = sqlx::query("SELECT * FROM media_files WHERE created_at < $1")
        .bind(cutoff_ms)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| MediaRow {
            key: row.get("key"),
            name: row.get("name"),
            mime: row.get("mime"),
            size: row.get("size"),
            uploader_id: row.get("uploader_id"),
            created_at: row.get("created_at"),
        })
        .collect())
}

pub async fn media_remove(db: &AnyPool, key: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM media_files WHERE key = $1")
        .bind(key)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn media_total_count(db: &AnyPool) -> Result<i64, String> {
    sqlx::query("SELECT count(*) AS total FROM media_files")
        .fetch_one(db)
        .await
        .map(|row| row.get("total"))
        .map_err(|err| err.to_string())
}

pub async fn audits_list(
    db: &AnyPool,
    keyword: Option<&str>,
    category: Option<&str>,
    offset: i64,
    limit: i64,
) -> Result<(Vec<Value>, i64), String> {
    let mut clauses: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    if let Some(keyword) = keyword {
        if !keyword.trim().is_empty() {
            let at = binds.len() + 1;
            clauses.push(format!("(actor LIKE ${at} OR detail LIKE ${})", at + 1));
            let like = format!("%{}%", keyword.trim());
            binds.push(Bind::Text(like.clone()));
            binds.push(Bind::Text(like));
        }
    }
    if let Some(category) = category {
        clauses.push(format!("action LIKE ${}", binds.len() + 1));
        binds.push(Bind::Text(format!("{category}.%")));
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    let count_sql = format!("SELECT count(*) AS total FROM audit_logs{where_sql}");
    let total: i64 = apply_binds(sqlx::query(&count_sql), &binds)
        .fetch_one(db)
        .await
        .map_err(|err| err.to_string())?
        .get("total");
    let limit_mark = binds.len() + 1;
    let list_sql = format!(
        "SELECT * FROM audit_logs{where_sql} ORDER BY created_at DESC LIMIT ${limit_mark} OFFSET ${}",
        limit_mark + 1
    );
    let rows = apply_binds(sqlx::query(&list_sql), &binds)
        .bind(limit)
        .bind(offset)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    let list = rows
        .iter()
        .map(|row| {
            json!({
                "id": row.get_str("id"),
                "actorId": row.try_get::<Option<String>, _>("actor_id").ok().flatten(),
                "actor": row.get_str("actor"),
                "action": row.get_str("action"),
                "detail": row.get_str("detail"),
                "createdAt": crate::util::iso_from_ms(row.get_i64("created_at")),
            })
        })
        .collect();
    Ok((list, total))
}

#[derive(Debug, Clone)]
pub struct DepartmentRow {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort: i64,
    pub group_id: Option<String>,
    pub created_at: i64,
}

pub async fn departments_all(db: &AnyPool) -> Result<Vec<DepartmentRow>, String> {
    let rows = sqlx::query("SELECT * FROM departments ORDER BY sort, created_at")
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| DepartmentRow {
            id: row.get("id"),
            name: row.get("name"),
            parent_id: row.try_get("parent_id").ok().flatten(),
            sort: row.get("sort"),
            group_id: row.try_get("group_id").ok().flatten(),
            created_at: row.get("created_at"),
        })
        .collect())
}

pub async fn department_by_id(
    db: &AnyPool,
    id: &str,
) -> Result<Option<DepartmentRow>, String> {
    Ok(departments_all(db)
        .await?
        .into_iter()
        .find(|row| row.id == id))
}

pub async fn department_member_counts(
    db: &AnyPool,
) -> Result<std::collections::HashMap<String, i64>, String> {
    let rows = sqlx::query(
        "SELECT dept_id AS dept_id, count(*) AS total FROM users WHERE dept_id IS NOT NULL GROUP BY dept_id",
    )
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| (row.get_str("dept_id"), row.get_i64("total")))
        .collect())
}

pub async fn department_create(
    db: &AnyPool,
    name: &str,
    parent_id: Option<&str>,
) -> Result<DepartmentRow, String> {
    let id = crate::util::uuid();
    let now = crate::util::now_ms();
    sqlx::query(
        "INSERT INTO departments (id, name, parent_id, sort, created_at) VALUES ($1, $2, $3, 0, $4)",
    )
    .bind(&id)
    .bind(name)
    .bind(parent_id)
    .bind(now)
    .execute(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(DepartmentRow {
        id,
        name: name.to_string(),
        parent_id: parent_id.map(|value| value.to_string()),
        sort: 0,
        group_id: None,
        created_at: now,
    })
}

pub async fn department_rename(db: &AnyPool, id: &str, name: &str) -> Result<(), String> {
    sqlx::query("UPDATE departments SET name = $1 WHERE id = $2")
        .bind(name)
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn department_move(
    db: &AnyPool,
    id: &str,
    parent_id: Option<&str>,
) -> Result<(), String> {
    sqlx::query("UPDATE departments SET parent_id = $1 WHERE id = $2")
        .bind(parent_id)
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn department_set_group(
    db: &AnyPool,
    id: &str,
    group_id: Option<&str>,
) -> Result<(), String> {
    sqlx::query("UPDATE departments SET group_id = $1 WHERE id = $2")
        .bind(group_id)
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn department_delete(db: &AnyPool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM departments WHERE id = $1")
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}


pub struct GroupFileRow {
    pub key: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub uploader_id: String,
    pub created_at: i64,
}

fn group_file_row(row: &sqlx::any::AnyRow) -> GroupFileRow {
    GroupFileRow {
        key: row.get_str("key"),
        name: row.get_str("name"),
        mime: row.get_str("mime"),
        size: row.get_i64("size"),
        uploader_id: row.get_str("uploader_id"),
        created_at: row.get_i64("created_at"),
    }
}

pub async fn group_file_list(
    db: &AnyPool,
    group_id: &str,
    offset: i64,
    limit: i64,
) -> Result<(Vec<GroupFileRow>, i64), String> {
    let rows = sqlx::query(
        "SELECT key, name, mime, size, uploader_id, created_at FROM group_files WHERE group_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
    )
    .bind(group_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    let total = sqlx::query("SELECT COUNT(*) AS total FROM group_files WHERE group_id = $1")
        .bind(group_id)
        .fetch_one(db)
        .await
        .map(|row| row.get_i64("total"))
        .map_err(|err| err.to_string())?;
    Ok((rows.iter().map(group_file_row).collect(), total))
}

pub async fn group_file_save(
    db: &AnyPool,
    group_id: &str,
    key: &str,
    name: &str,
    mime: &str,
    size: i64,
    uploader_id: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO group_files (group_id, key, name, mime, size, uploader_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(group_id, key) DO NOTHING",
    )
    .bind(group_id)
    .bind(key)
    .bind(name)
    .bind(mime)
    .bind(size)
    .bind(uploader_id)
    .bind(crate::util::now_ms())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn group_file_by_key(
    db: &AnyPool,
    group_id: &str,
    key: &str,
) -> Result<Option<GroupFileRow>, String> {
    sqlx::query("SELECT key, name, mime, size, uploader_id, created_at FROM group_files WHERE group_id = $1 AND key = $2")
        .bind(group_id)
        .bind(key)
        .fetch_optional(db)
        .await
        .map(|row| row.as_ref().map(group_file_row))
        .map_err(|err| err.to_string())
}

pub async fn group_file_remove(db: &AnyPool, group_id: &str, key: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM group_files WHERE group_id = $1 AND key = $2")
        .bind(group_id)
        .bind(key)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn group_file_count_by_key(db: &AnyPool, key: &str) -> Result<i64, String> {
    sqlx::query("SELECT COUNT(*) AS total FROM group_files WHERE key = $1")
        .bind(key)
        .fetch_one(db)
        .await
        .map(|row| row.get_i64("total"))
        .map_err(|err| err.to_string())
}

pub struct PushRow {
    pub endpoint: String,
    pub user_id: String,
    pub p256dh: String,
    pub auth: String,
}

fn push_row(row: &sqlx::any::AnyRow) -> PushRow {
    PushRow {
        endpoint: row.get_str("endpoint"),
        user_id: row.get_str("user_id"),
        p256dh: row.get_str("p256dh"),
        auth: row.get_str("auth"),
    }
}

pub async fn push_save(
    db: &AnyPool,
    user_id: &str,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth",
    )
    .bind(endpoint)
    .bind(user_id)
    .bind(p256dh)
    .bind(auth)
    .bind(crate::util::now_ms())
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn push_of_user(db: &AnyPool, user_id: &str) -> Result<Vec<PushRow>, String> {
    sqlx::query("SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(db)
        .await
        .map(|rows| rows.iter().map(push_row).collect())
        .map_err(|err| err.to_string())
}

pub async fn push_of_users(db: &AnyPool, ids: &[String]) -> Result<Vec<PushRow>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = marks(1, ids.len());
    let sql = format!("SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions WHERE user_id IN ({marks})");
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id);
    }
    query
        .fetch_all(db)
        .await
        .map(|rows| rows.iter().map(push_row).collect())
        .map_err(|err| err.to_string())
}

pub async fn push_of_all(db: &AnyPool) -> Result<Vec<PushRow>, String> {
    sqlx::query("SELECT endpoint, user_id, p256dh, auth FROM push_subscriptions")
        .fetch_all(db)
        .await
        .map(|rows| rows.iter().map(push_row).collect())
        .map_err(|err| err.to_string())
}

pub async fn push_remove(db: &AnyPool, user_id: &str, endpoint: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2")
        .bind(endpoint)
        .bind(user_id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn media_uploader(db: &AnyPool, key: &str) -> Result<String, String> {
    sqlx::query("SELECT uploader_id FROM media_files WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await
        .map(|row| row.map(|row| row.get_str("uploader_id")).unwrap_or_default())
        .map_err(|err| err.to_string())
}

pub struct MomentRow {
    pub id: String,
    pub author_id: String,
    pub content: String,
    pub images: Vec<String>,
    pub video: Option<String>,
    pub link: Option<Value>,
    pub visibility: String,
    pub audience: Vec<String>,
    pub created_at: i64,
}

enum Bind {
    Text(String),
    Int(i64),
}

fn apply_binds<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments<'q>>,
    binds: &[Bind],
) -> sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments<'q>> {
    for bind in binds {
        query = match bind {
            Bind::Text(value) => query.bind(value.clone()),
            Bind::Int(value) => query.bind(*value),
        };
    }
    query
}

fn parse_json_vec(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn moment_row(row: &sqlx::any::AnyRow) -> MomentRow {
    let raw_link: Option<String> = row.get_opt_str("link");
    MomentRow {
        id: row.get_str("id"),
        author_id: row.get_str("author_id"),
        content: row.get_str("content"),
        images: parse_json_vec(&row.get_str("images")),
        video: row.get_opt_str("video"),
        link: raw_link.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
        visibility: row.get_str("visibility"),
        audience: Vec::new(),
        created_at: row.get_i64("created_at"),
    }
}

fn visible_clause(viewer_id: &str, friend_ids: &[String], binds: &mut Vec<Bind>) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("author_id = ${}", binds.len() + 1));
    binds.push(Bind::Text(viewer_id.to_string()));
    if friend_ids.is_empty() {
        parts.push(format!(
            "(visibility = 'partial' AND EXISTS (SELECT 1 FROM moment_audience a WHERE a.post_id = moments.id AND a.user_id = ${}))",
            binds.len() + 1
        ));
        binds.push(Bind::Text(viewer_id.to_string()));
    } else {
        let friend_marks = marks(binds.len() + 1, friend_ids.len());
        let viewer_at = binds.len() + friend_ids.len() + 1;
        parts.push(format!(
            "(author_id IN ({friend_marks}) AND visibility IN ('public','exclude') AND NOT EXISTS (SELECT 1 FROM moment_audience a WHERE a.post_id = moments.id AND a.user_id = ${viewer_at}))"
        ));
        for id in friend_ids {
            binds.push(Bind::Text(id.clone()));
        }
        binds.push(Bind::Text(viewer_id.to_string()));
        parts.push(format!(
            "(visibility = 'partial' AND EXISTS (SELECT 1 FROM moment_audience a WHERE a.post_id = moments.id AND a.user_id = ${}))",
            binds.len() + 1
        ));
        binds.push(Bind::Text(viewer_id.to_string()));
        parts.push(format!(
            "(visibility = 'friends' AND author_id IN ({}))",
            marks(binds.len() + 1, friend_ids.len())
        ));
        for id in friend_ids {
            binds.push(Bind::Text(id.clone()));
        }
    }
    format!("({})", parts.join(" OR "))
}

fn cursor_clause(before: Option<i64>, before_id: Option<&str>, binds: &mut Vec<Bind>) -> String {
    match before {
        None => String::new(),
        Some(at) => match before_id {
            Some(id) => {
                let base = binds.len() + 1;
                binds.push(Bind::Int(at));
                binds.push(Bind::Int(at));
                binds.push(Bind::Text(id.to_string()));
                format!(" AND (created_at < ${base} OR (created_at = ${} AND id < ${}))", base + 1, base + 2)
            }
            None => {
                let base = binds.len() + 1;
                binds.push(Bind::Int(at));
                format!(" AND created_at < ${base}")
            }
        },
    }
}

async fn attach_moment_audience(
    db: &AnyPool,
    mut rows: Vec<MomentRow>,
) -> Result<Vec<MomentRow>, String> {
    let targets: Vec<String> = rows
        .iter()
        .filter(|row| row.visibility == "partial" || row.visibility == "exclude")
        .map(|row| row.id.clone())
        .collect();
    if targets.is_empty() {
        return Ok(rows);
    }
    let mut links: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let marks = marks(1, targets.len());
    let sql = format!("SELECT post_id, user_id FROM moment_audience WHERE post_id IN ({marks})");
    let mut query = sqlx::query(&sql);
    for id in &targets {
        query = query.bind(id.clone());
    }
    let found = query.fetch_all(db).await.map_err(|err| err.to_string())?;
    for row in found {
        let post_id: String = row.get("post_id");
        let user_id: String = row.get("user_id");
        links.entry(post_id).or_default().push(user_id);
    }
    for row in rows.iter_mut() {
        if let Some(list) = links.get(&row.id) {
            row.audience = list.clone();
        }
    }
    Ok(rows)
}

pub async fn moment_create(
    db: &AnyPool,
    author_id: &str,
    content: &str,
    images: &[String],
    video: Option<&str>,
    link: Option<&Value>,
    visibility: &str,
    audience: &[String],
) -> Result<MomentRow, String> {
    let id = crate::util::uuid();
    let now = crate::util::now_ms();
    let mut tx = db.begin().await.map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO moments (id, author_id, content, images, video, link, visibility, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(author_id)
    .bind(content)
    .bind(json!(images).to_string())
    .bind(video)
    .bind(link.map(|value| value.to_string()))
    .bind(visibility)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    for user_id in audience {
        sqlx::query(
            "INSERT INTO moment_audience (post_id, user_id) VALUES ($1, $2) ON CONFLICT(post_id, user_id) DO NOTHING",
        )
        .bind(&id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(MomentRow {
        id,
        author_id: author_id.to_string(),
        content: content.to_string(),
        images: images.to_vec(),
        video: video.map(|value| value.to_string()),
        link: link.cloned(),
        visibility: visibility.to_string(),
        audience: audience.to_vec(),
        created_at: now,
    })
}

pub async fn moment_by_id(db: &AnyPool, id: &str) -> Result<Option<MomentRow>, String> {
    let row = sqlx::query("SELECT * FROM moments WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map_err(|err| err.to_string())?;
    let Some(row) = row else {
        return Ok(None);
    };
    let rows = attach_moment_audience(db, vec![moment_row(&row)]).await?;
    Ok(rows.into_iter().next())
}

pub async fn moment_remove(db: &AnyPool, id: &str) -> Result<(), String> {
    for sql in [
        "DELETE FROM moment_audience WHERE post_id = $1",
        "DELETE FROM moment_likes WHERE post_id = $1",
        "DELETE FROM moment_comments WHERE post_id = $1",
        "DELETE FROM moments WHERE id = $1",
    ] {
        sqlx::query(sql)
            .bind(id)
            .execute(db)
            .await
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub async fn moment_list(
    db: &AnyPool,
    viewer_id: &str,
    friend_ids: &[String],
    author: Option<&str>,
    before: Option<i64>,
    before_id: Option<&str>,
    limit: i64,
) -> Result<Vec<MomentRow>, String> {
    let mut binds: Vec<Bind> = Vec::new();
    let visible = visible_clause(viewer_id, friend_ids, &mut binds);
    let mut sql = format!("SELECT * FROM moments WHERE {visible}");
    if let Some(author) = author {
        sql.push_str(&format!(" AND author_id = ${}", binds.len() + 1));
        binds.push(Bind::Text(author.to_string()));
    }
    sql.push_str(&cursor_clause(before, before_id, &mut binds));
    sql.push_str(&format!(" ORDER BY created_at DESC, id DESC LIMIT ${}", binds.len() + 1));
    binds.push(Bind::Int(limit));
    let rows = apply_binds(sqlx::query(&sql), &binds)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    attach_moment_audience(db, rows.iter().map(moment_row).collect()).await
}

pub async fn moment_list_public(
    db: &AnyPool,
    author_id: &str,
    before: Option<i64>,
    before_id: Option<&str>,
    limit: i64,
) -> Result<Vec<MomentRow>, String> {
    let mut binds: Vec<Bind> = vec![Bind::Text(author_id.to_string())];
    let cursor = cursor_clause(before, before_id, &mut binds);
    let limit_mark = binds.len() + 1;
    let sql = format!(
        "SELECT * FROM moments WHERE author_id = $1 AND visibility = 'public'{cursor} ORDER BY created_at DESC, id DESC LIMIT ${limit_mark}"
    );
    binds.push(Bind::Int(limit));
    let rows = apply_binds(sqlx::query(&sql), &binds)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    attach_moment_audience(db, rows.iter().map(moment_row).collect()).await
}

pub async fn moment_audience_of(db: &AnyPool, post_id: &str) -> Result<Vec<String>, String> {
    let rows = sqlx::query("SELECT user_id FROM moment_audience WHERE post_id = $1")
        .bind(post_id)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| row.get_str("user_id"))
        .collect())
}

pub struct MomentLike {
    pub post_id: String,
    pub user_id: String,
    pub at: i64,
}

pub struct MomentComment {
    pub id: String,
    pub post_id: String,
    pub author_id: String,
    pub content: String,
    pub created_at: i64,
}

pub async fn moment_likes_of(
    db: &AnyPool,
    post_ids: &[String],
) -> Result<Vec<MomentLike>, String> {
    if post_ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = marks(1, post_ids.len());
    let sql = format!("SELECT post_id, user_id, at FROM moment_likes WHERE post_id IN ({marks}) ORDER BY at ASC");
    let mut query = sqlx::query(&sql);
    for id in post_ids {
        query = query.bind(id.clone());
    }
    let rows = query.fetch_all(db).await.map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| MomentLike {
            post_id: row.get_str("post_id"),
            user_id: row.get_str("user_id"),
            at: row.get_i64("at"),
        })
        .collect())
}

pub async fn moment_comments_of(
    db: &AnyPool,
    post_ids: &[String],
) -> Result<Vec<MomentComment>, String> {
    if post_ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = marks(1, post_ids.len());
    let sql = format!("SELECT id, post_id, author_id, content, created_at FROM moment_comments WHERE post_id IN ({marks}) ORDER BY created_at ASC");
    let mut query = sqlx::query(&sql);
    for id in post_ids {
        query = query.bind(id.clone());
    }
    let rows = query.fetch_all(db).await.map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| MomentComment {
            id: row.get_str("id"),
            post_id: row.get_str("post_id"),
            author_id: row.get_str("author_id"),
            content: row.get_str("content"),
            created_at: row.get_i64("created_at"),
        })
        .collect())
}

pub async fn moment_comment_by_id(
    db: &AnyPool,
    id: &str,
) -> Result<Option<MomentComment>, String> {
    let row = sqlx::query(
        "SELECT id, post_id, author_id, content, created_at FROM moment_comments WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(row.map(|row| MomentComment {
        id: row.get_str("id"),
        post_id: row.get_str("post_id"),
        author_id: row.get_str("author_id"),
        content: row.get_str("content"),
        created_at: row.get_i64("created_at"),
    }))
}

pub async fn moment_add_comment(
    db: &AnyPool,
    post_id: &str,
    author_id: &str,
    content: &str,
) -> Result<String, String> {
    let id = crate::util::uuid();
    sqlx::query("INSERT INTO moment_comments (id, post_id, author_id, content, created_at) VALUES ($1, $2, $3, $4, $5)")
        .bind(&id)
        .bind(post_id)
        .bind(author_id)
        .bind(content)
        .bind(crate::util::now_ms())
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(id)
}

pub async fn moment_remove_comment(db: &AnyPool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM moment_comments WHERE id = $1")
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn moment_set_like(
    db: &AnyPool,
    post_id: &str,
    user_id: &str,
    liked: bool,
) -> Result<(), String> {
    if !liked {
        return sqlx::query("DELETE FROM moment_likes WHERE post_id = $1 AND user_id = $2")
            .bind(post_id)
            .bind(user_id)
            .execute(db)
            .await
            .map(|_| ())
            .map_err(|err| err.to_string());
    }
    sqlx::query("INSERT INTO moment_likes (post_id, user_id, at) VALUES ($1, $2, $3) ON CONFLICT(post_id, user_id) DO NOTHING")
        .bind(post_id)
        .bind(user_id)
        .bind(crate::util::now_ms())
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn moment_seen_at(db: &AnyPool, user_id: &str) -> Result<i64, String> {
    sqlx::query("SELECT seen_at FROM moment_reads WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .map(|row| row.map(|row| row.get_i64("seen_at")).unwrap_or(0))
        .map_err(|err| err.to_string())
}

pub async fn moment_mark_seen(db: &AnyPool, user_id: &str, at: i64) -> Result<(), String> {
    sqlx::query("INSERT INTO moment_reads (user_id, seen_at) VALUES ($1, $2) ON CONFLICT(user_id) DO UPDATE SET seen_at = excluded.seen_at")
        .bind(user_id)
        .bind(at)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

pub async fn moment_unread(
    db: &AnyPool,
    user_id: &str,
    friend_ids: &[String],
) -> Result<(i64, i64), String> {
    let seen = moment_seen_at(db, user_id).await?;
    let posts = if friend_ids.is_empty() {
        0
    } else {
        let marks = marks(3, friend_ids.len());
        let sql = format!(
            "SELECT COUNT(*) AS total FROM moments WHERE created_at > $1 AND author_id <> $2 AND author_id IN ({marks})"
        );
        let mut query = sqlx::query(&sql).bind(seen).bind(user_id.to_string());
        for id in friend_ids {
            query = query.bind(id.clone());
        }
        query
            .fetch_one(db)
            .await
            .map(|row| row.get_i64("total"))
            .map_err(|err| err.to_string())?
    };
    let likes = sqlx::query(
        "SELECT COUNT(*) AS total FROM moment_likes l JOIN moments m ON m.id = l.post_id WHERE m.author_id = $1 AND l.user_id <> $2 AND l.at > $3",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(seen)
    .fetch_one(db)
    .await
    .map(|row| row.get_i64("total"))
    .map_err(|err| err.to_string())?;
    let comments = sqlx::query(
        "SELECT COUNT(*) AS total FROM moment_comments c JOIN moments m ON m.id = c.post_id WHERE m.author_id = $1 AND c.author_id <> $2 AND c.created_at > $3",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(seen)
    .fetch_one(db)
    .await
    .map(|row| row.get_i64("total"))
    .map_err(|err| err.to_string())?;
    Ok((posts, likes + comments))
}

pub async fn wallet_balance(db: &AnyPool, user_id: &str) -> Result<i64, String> {
    sqlx::query("SELECT balance FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .map(|row| row.map(|row| row.get_i64("balance")).unwrap_or(0))
        .map_err(|err| err.to_string())
}

pub enum WalletError {
    Missing,
    Insufficient,
}

async fn add_balance(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    user_id: &str,
    delta: i64,
) -> Result<i64, WalletError> {
    let current = sqlx::query("SELECT balance FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| WalletError::Missing)?
        .map(|row| row.get_i64("balance"))
        .ok_or(WalletError::Missing)?;
    let next = current + delta;
    if next < 0 {
        return Err(WalletError::Insufficient);
    }
    sqlx::query("UPDATE users SET balance = $1 WHERE id = $2")
        .bind(next)
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(|_| WalletError::Missing)?;
    Ok(next)
}

pub async fn wallet_adjust(
    db: &AnyPool,
    user_id: &str,
    delta: i64,
) -> Result<i64, String> {
    let mut tx = db.begin().await.map_err(|err| err.to_string())?;
    let result = match add_balance(&mut tx, user_id, delta).await {
        Ok(next) => next,
        Err(WalletError::Missing) => return Err("用户不存在".to_string()),
        Err(WalletError::Insufficient) => return Err("余额不足".to_string()),
    };
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(result)
}

#[derive(Debug, Clone)]
pub struct TransferRow {
    pub id: String,
    pub session: String,
    pub from_id: String,
    pub to_id: String,
    pub amount: i64,
    pub message: Option<String>,
    pub state: String,
    pub created_at: i64,
    pub expired_at: i64,
}

fn transfer_row(row: &sqlx::any::AnyRow) -> TransferRow {
    TransferRow {
        id: row.get_str("id"),
        session: row.get_str("session"),
        from_id: row.get_str("from_id"),
        to_id: row.get_str("to_id"),
        amount: row.get_i64("amount"),
        message: row.get_opt_str("message"),
        state: row.get_str("state"),
        created_at: row.get_i64("created_at"),
        expired_at: row.get_i64("expired_at"),
    }
}

pub enum TransferCreateResult {
    Ok(TransferRow),
    Duplicate,
    Missing,
    Insufficient,
}

pub async fn transfer_create(
    db: &AnyPool,
    id: &str,
    session: &str,
    from_id: &str,
    to_id: &str,
    amount: i64,
    message: Option<&str>,
    expired_at: i64,
) -> Result<TransferCreateResult, String> {
    let mut tx = db.begin().await.map_err(|err| err.to_string())?;
    let dup = sqlx::query("SELECT id FROM transfers WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    if dup.is_some() {
        return Ok(TransferCreateResult::Duplicate);
    }
    match add_balance(&mut tx, from_id, -amount).await {
        Ok(_) => {}
        Err(WalletError::Missing) => return Ok(TransferCreateResult::Missing),
        Err(WalletError::Insufficient) => return Ok(TransferCreateResult::Insufficient),
    }
    let now = crate::util::now_ms();
    sqlx::query(
        "INSERT INTO transfers (id, session, from_id, to_id, amount, message, state, created_at, expired_at) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)",
    )
    .bind(id)
    .bind(session)
    .bind(from_id)
    .bind(to_id)
    .bind(amount)
    .bind(message)
    .bind(now)
    .bind(expired_at)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(TransferCreateResult::Ok(TransferRow {
        id: id.to_string(),
        session: session.to_string(),
        from_id: from_id.to_string(),
        to_id: to_id.to_string(),
        amount,
        message: message.map(|value| value.to_string()),
        state: "pending".to_string(),
        created_at: now,
        expired_at,
    }))
}

pub async fn transfer_get(db: &AnyPool, id: &str) -> Result<Option<TransferRow>, String> {
    sqlx::query("SELECT * FROM transfers WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map(|row| row.as_ref().map(transfer_row))
        .map_err(|err| err.to_string())
}

pub enum TransferSettleResult {
    Ok(TransferRow),
    Missing,
    Conflict,
}

pub async fn transfer_settle(
    db: &AnyPool,
    id: &str,
    accept: bool,
) -> Result<TransferSettleResult, String> {
    let mut tx = db.begin().await.map_err(|err| err.to_string())?;
    let row = sqlx::query("SELECT * FROM transfers WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    let Some(row) = row else {
        return Ok(TransferSettleResult::Missing);
    };
    let row = transfer_row(&row);
    if row.state != "pending" {
        return Ok(TransferSettleResult::Conflict);
    }
    let next = if accept { "accepted" } else { "rejected" };
    let target = if accept { row.to_id.clone() } else { row.from_id.clone() };
    add_balance(&mut tx, &target, row.amount)
        .await
        .map_err(|_| "余额更新失败".to_string())?;
    sqlx::query("UPDATE transfers SET state = $1 WHERE id = $2")
        .bind(next)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(|err| err.to_string())?;
    let mut fresh = row;
    fresh.state = next.to_string();
    Ok(TransferSettleResult::Ok(fresh))
}

pub async fn transfer_cancel_refund(db: &AnyPool, id: &str) -> Result<bool, String> {
    let mut tx = db.begin().await.map_err(|err| err.to_string())?;
    let row = sqlx::query("SELECT * FROM transfers WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    let Some(row) = row else {
        return Ok(false);
    };
    let row = transfer_row(&row);
    if row.state != "pending" {
        return Ok(false);
    }
    add_balance(&mut tx, &row.from_id, row.amount)
        .await
        .map_err(|_| "退款失败".to_string())?;
    sqlx::query("UPDATE transfers SET state = 'refunded' WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(true)
}

pub async fn transfer_expire_if_needed(db: &AnyPool) -> Result<Vec<String>, String> {
    let now = crate::util::now_ms();
    let rows = sqlx::query("SELECT * FROM transfers WHERE state = 'pending' AND expired_at <= $1")
        .bind(now)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut ids: Vec<String> = Vec::new();
    let mut tx = db.begin().await.map_err(|err| err.to_string())?;
    for row in rows {
        let row = transfer_row(&row);
        add_balance(&mut tx, &row.from_id, row.amount)
            .await
            .map_err(|_| "退款失败".to_string())?;
        sqlx::query("UPDATE transfers SET state = 'refunded' WHERE id = $1")
            .bind(&row.id)
            .execute(&mut *tx)
            .await
            .map_err(|err| err.to_string())?;
        ids.push(row.id);
    }
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(ids)
}

pub async fn transfer_list_for_user(
    db: &AnyPool,
    user_id: &str,
) -> Result<Vec<TransferRow>, String> {
    let rows = sqlx::query(
        "SELECT * FROM transfers WHERE from_id = $1 OR to_id = $2 ORDER BY created_at DESC LIMIT 200",
    )
    .bind(user_id)
    .bind(user_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows.iter().map(transfer_row).collect())
}

#[derive(Debug, Clone)]
pub struct RedPacketRow {
    pub id: String,
    pub session_id: String,
    pub sender_id: String,
    pub kind: String,
    pub total_amount: i64,
    pub total_count: i64,
    pub remaining: i64,
    pub remain_count: i64,
    pub status: String,
    pub message: Option<String>,
    pub created_at: i64,
    pub expired_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct RedPacketRecord {
    pub claimer_id: String,
    pub amount: i64,
    pub claimed_at: i64,
}

fn packet_row(row: &sqlx::any::AnyRow) -> RedPacketRow {
    RedPacketRow {
        id: row.get_str("id"),
        session_id: row.get_str("session_id"),
        sender_id: row.get_str("sender_id"),
        kind: row.get_str("type"),
        total_amount: row.get_i64("total_amount"),
        total_count: row.get_i64("total_count"),
        remaining: row.get_i64("remaining"),
        remain_count: row.get_i64("remain_count"),
        status: row.get_str("status"),
        message: row.get_opt_str("message"),
        created_at: row.get_i64("created_at"),
        expired_at: row.get_opt_i64("expired_at"),
    }
}

pub async fn packet_create(
    db: &AnyPool,
    id: &str,
    session_id: &str,
    sender_id: &str,
    kind: &str,
    total_amount: i64,
    total_count: i64,
    message: &str,
    expired_at: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO red_packets (id, session_id, sender_id, type, total_amount, total_count, remaining, remain_count, status, message, created_at, expired_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11)",
    )
    .bind(id)
    .bind(session_id)
    .bind(sender_id)
    .bind(kind)
    .bind(total_amount)
    .bind(total_count)
    .bind(total_amount)
    .bind(total_count)
    .bind(message)
    .bind(crate::util::now_ms())
    .bind(expired_at)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn packet_get(db: &AnyPool, id: &str) -> Result<Option<RedPacketRow>, String> {
    sqlx::query("SELECT * FROM red_packets WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map(|row| row.as_ref().map(packet_row))
        .map_err(|err| err.to_string())
}

pub async fn packet_claimed_by(
    db: &AnyPool,
    packet_id: &str,
    claimer_id: &str,
) -> Result<Option<i64>, String> {
    sqlx::query("SELECT amount FROM red_packet_records WHERE red_packet_id = $1 AND claimer_id = $2")
        .bind(packet_id)
        .bind(claimer_id)
        .fetch_optional(db)
        .await
        .map(|row| row.map(|row| row.get_i64("amount")))
        .map_err(|err| err.to_string())
}

pub async fn packet_records(
    db: &AnyPool,
    packet_id: &str,
) -> Result<Vec<RedPacketRecord>, String> {
    let rows = sqlx::query(
        "SELECT claimer_id, amount, claimed_at FROM red_packet_records WHERE red_packet_id = $1 ORDER BY claimed_at ASC",
    )
    .bind(packet_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| RedPacketRecord {
            claimer_id: row.get_str("claimer_id"),
            amount: row.get_i64("amount"),
            claimed_at: row.get_i64("claimed_at"),
        })
        .collect())
}

pub enum PacketClaimResult {
    Ok(()),
    Duplicate,
    Missing,
    Empty,
}

pub async fn packet_claim(
    db: &AnyPool,
    packet_id: &str,
    claimer_id: &str,
    amount: i64,
) -> Result<PacketClaimResult, String> {
    let mut tx = db.begin().await.map_err(|err| err.to_string())?;
    let row = sqlx::query("SELECT * FROM red_packets WHERE id = $1")
        .bind(packet_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    let Some(row) = row else {
        return Ok(PacketClaimResult::Missing);
    };
    let row = packet_row(&row);
    if row.remain_count <= 0 || row.remaining < amount || row.status != "active" {
        return Ok(PacketClaimResult::Empty);
    }
    let dup = sqlx::query(
        "SELECT claimer_id FROM red_packet_records WHERE red_packet_id = $1 AND claimer_id = $2",
    )
    .bind(packet_id)
    .bind(claimer_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    if dup.is_some() {
        return Ok(PacketClaimResult::Duplicate);
    }
    let remaining = row.remaining - amount;
    let remain_count = row.remain_count - 1;
    let status = if remain_count <= 0 || remaining <= 0 {
        "finished"
    } else {
        "active"
    };
    sqlx::query("UPDATE red_packets SET remaining = $1, remain_count = $2, status = $3 WHERE id = $4")
        .bind(remaining)
        .bind(remain_count)
        .bind(status)
        .bind(packet_id)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO red_packet_records (id, red_packet_id, claimer_id, amount, claimed_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(crate::util::uuid())
    .bind(packet_id)
    .bind(claimer_id)
    .bind(amount)
    .bind(crate::util::now_ms())
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(|err| err.to_string())?;
    Ok(PacketClaimResult::Ok(()))
}

pub async fn packet_expire_if_needed(db: &AnyPool) -> Result<Vec<String>, String> {
    let now = crate::util::now_ms();
    let rows = sqlx::query(
        "SELECT id FROM red_packets WHERE status = 'active' AND expired_at IS NOT NULL AND expired_at <= $1",
    )
    .bind(now)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    let mut ids: Vec<String> = Vec::new();
    for row in rows {
        let id: String = row.get("id");
        sqlx::query("UPDATE red_packets SET status = 'expired' WHERE id = $1")
            .bind(&id)
            .execute(db)
            .await
            .map_err(|err| err.to_string())?;
        ids.push(id);
    }
    Ok(ids)
}

#[derive(Debug, Clone)]
pub struct BillRow {
    pub id: String,
    pub session_id: String,
    pub creator_id: String,
    pub description: String,
    pub total_amount: i64,
    pub settled_amount: i64,
    pub participant_ids: Vec<String>,
    pub split_type: String,
    pub custom_splits: std::collections::HashMap<String, i64>,
    pub status: String,
    pub created_at: i64,
    pub deadline: i64,
}

fn bill_row(row: &sqlx::any::AnyRow) -> BillRow {
    let participant_raw: String = row.get("participant_ids");
    let custom_raw: Option<String> = row.get("custom_splits");
    BillRow {
        id: row.get("id"),
        session_id: row.get("session"),
        creator_id: row.get("creator_id"),
        description: row.get("description"),
        total_amount: row.get("total_amount"),
        settled_amount: row.get("settled_amount"),
        participant_ids: serde_json::from_str(&participant_raw).unwrap_or_default(),
        split_type: row.get("split_type"),
        custom_splits: custom_raw
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default(),
        status: row.get("status"),
        created_at: row.get("created_at"),
        deadline: row.get("deadline"),
    }
}

#[derive(Debug, Clone)]
pub struct BillPayment {
    pub payer_id: String,
    pub amount: i64,
    pub paid_at: i64,
}

pub async fn bill_create(
    db: &AnyPool,
    id: &str,
    session_id: &str,
    creator_id: &str,
    description: &str,
    total_amount: i64,
    participant_ids: &[String],
    split_type: &str,
    custom_splits: &std::collections::HashMap<String, i64>,
    deadline: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO aa_bills (id, session, creator_id, description, total_amount, settled_amount, participant_ids, split_type, custom_splits, status, created_at, deadline) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, 'pending', $9, $10)",
    )
    .bind(id)
    .bind(session_id)
    .bind(creator_id)
    .bind(description)
    .bind(total_amount)
    .bind(json!(participant_ids).to_string())
    .bind(split_type)
    .bind(json!(custom_splits).to_string())
    .bind(crate::util::now_ms())
    .bind(deadline)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|err| err.to_string())
}

pub async fn bill_get(db: &AnyPool, id: &str) -> Result<Option<BillRow>, String> {
    sqlx::query("SELECT * FROM aa_bills WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await
        .map(|row| row.as_ref().map(bill_row))
        .map_err(|err| err.to_string())
}

pub async fn bill_list_session(db: &AnyPool, session: &str) -> Result<Vec<BillRow>, String> {
    let rows = sqlx::query("SELECT * FROM aa_bills WHERE session = $1 ORDER BY created_at DESC LIMIT 100")
        .bind(session)
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows.iter().map(bill_row).collect())
}

pub async fn bill_list_for_user(db: &AnyPool, user_id: &str) -> Result<Vec<BillRow>, String> {
    let rows = sqlx::query("SELECT * FROM aa_bills WHERE creator_id = $1 OR participant_ids LIKE $2 ORDER BY created_at DESC LIMIT 200")
        .bind(user_id)
        .bind(format!("%{user_id}%"))
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(bill_row)
        .filter(|bill| bill.creator_id == user_id || bill.participant_ids.iter().any(|id| id == user_id))
        .collect())
}

pub async fn bill_payments(db: &AnyPool, bill_id: &str) -> Result<Vec<BillPayment>, String> {
    let rows = sqlx::query(
        "SELECT payer_id, amount, paid_at FROM aa_payments WHERE bill_id = $1 ORDER BY paid_at ASC",
    )
    .bind(bill_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| BillPayment {
            payer_id: row.get("payer_id"),
            amount: row.get("amount"),
            paid_at: row.get("paid_at"),
        })
        .collect())
}

pub fn bill_share(bill: &BillRow, user_id: &str) -> Option<i64> {
    if !bill.participant_ids.iter().any(|id| id == user_id) {
        return None;
    }
    if bill.split_type == "custom" {
        return bill.custom_splits.get(user_id).copied();
    }
    let count = bill.participant_ids.len() as i64;
    if count == 0 {
        return None;
    }
    Some(bill.total_amount / count)
}

pub enum BillPayResult {
    Ok(BillRow),
    Missing,
    Closed,
    Duplicate,
    Amount,
    Insufficient,
}

pub async fn bill_pay(
    db: &AnyPool,
    bill_id: &str,
    payer_id: &str,
    amount: i64,
) -> Result<BillPayResult, String> {
    let mut tx = db.begin().await.map_err(|err| err.to_string())?;
    let row = sqlx::query("SELECT * FROM aa_bills WHERE id = $1")
        .bind(bill_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    let Some(row) = row else {
        return Ok(BillPayResult::Missing);
    };
    let bill = bill_row(&row);
    if bill.status != "pending" {
        return Ok(BillPayResult::Closed);
    }
    let dup = sqlx::query("SELECT id FROM aa_payments WHERE bill_id = $1 AND payer_id = $2")
        .bind(bill_id)
        .bind(payer_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    if dup.is_some() {
        return Ok(BillPayResult::Duplicate);
    }
    let share = bill_share(&bill, payer_id);
    if share.is_none() || share != Some(amount) {
        return Ok(BillPayResult::Amount);
    }
    match add_balance(&mut tx, payer_id, -amount).await {
        Ok(_) => {}
        Err(WalletError::Missing) => return Ok(BillPayResult::Missing),
        Err(WalletError::Insufficient) => return Ok(BillPayResult::Insufficient),
    }
    add_balance(&mut tx, &bill.creator_id, amount)
        .await
        .map_err(|_| "入账失败".to_string())?;
    sqlx::query("INSERT INTO aa_payments (id, bill_id, payer_id, amount, paid_at) VALUES ($1, $2, $3, $4, $5)")
        .bind(crate::util::uuid())
        .bind(bill_id)
        .bind(payer_id)
        .bind(amount)
        .bind(crate::util::now_ms())
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    let settled = bill.settled_amount + amount;
    let status = if settled >= bill.total_amount {
        "settled"
    } else {
        "pending"
    };
    sqlx::query("UPDATE aa_bills SET settled_amount = $1, status = $2 WHERE id = $3")
        .bind(settled)
        .bind(status)
        .bind(bill_id)
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    tx.commit().await.map_err(|err| err.to_string())?;
    let mut fresh = bill;
    fresh.settled_amount = settled;
    fresh.status = status.to_string();
    Ok(BillPayResult::Ok(fresh))
}

pub async fn bill_cancel(db: &AnyPool, bill_id: &str) -> Result<bool, String> {
    sqlx::query("UPDATE aa_bills SET status = 'cancelled' WHERE id = $1 AND status = 'pending'")
        .bind(bill_id)
        .execute(db)
        .await
        .map(|result| result.rows_affected() > 0)
        .map_err(|err| err.to_string())
}

pub async fn bill_overdue(db: &AnyPool) -> Result<Vec<BillRow>, String> {
    let rows = sqlx::query("SELECT * FROM aa_bills WHERE status = 'pending' AND deadline < $1 ORDER BY created_at DESC LIMIT 100")
        .bind(crate::util::now_ms())
        .fetch_all(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(rows.iter().map(bill_row).collect())
}

fn parse_str_list(raw: Option<String>) -> Vec<String> {
    match raw {
        Some(text) => serde_json::from_str::<Vec<String>>(&text).unwrap_or_default(),
        None => Vec::new(),
    }
}

#[derive(Debug, Clone)]
pub struct BotAppRow {
    pub id: String,
    pub owner_id: String,
    pub owner: String,
    pub name: String,
    pub token_hash: String,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked: bool,
}

fn bot_app_row(row: &sqlx::any::AnyRow, owner: String) -> BotAppRow {
    BotAppRow {
        id: row.get_str("id"),
        owner_id: row.get_str("owner_id"),
        owner,
        name: row.get_str("name"),
        token_hash: row.get_str("token_hash"),
        scopes: parse_str_list(row.get_opt_str("scopes")),
        created_at: row.get_i64("created_at"),
        last_used_at: row.get_opt_i64("last_used_at"),
        revoked: row.get_opt_i64("revoked_at").is_some(),
    }
}

const BOT_APP_COLS: &str =
    "id, owner_id, name, token_hash, scopes, created_at, last_used_at, revoked_at";

pub async fn bot_create_app(
    db: &AnyPool,
    owner_id: &str,
    name: &str,
    token_hash: &str,
    scopes: &[String],
) -> Result<BotAppRow, String> {
    let id = crate::util::uuid();
    let now = crate::util::now_ms();
    sqlx::query(
        "INSERT INTO bot_apps (id, owner_id, name, token_hash, scopes, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(owner_id)
    .bind(name)
    .bind(token_hash)
    .bind(serde_json::to_string(scopes).unwrap_or_else(|_| "[]".into()))
    .bind(now)
    .execute(db)
    .await
    .map_err(|err| err.to_string())?;
    let owner = user_by_id(db, owner_id)
        .await?
        .map(|row| row.username)
        .unwrap_or_default();
    Ok(BotAppRow {
        id,
        owner_id: owner_id.to_string(),
        owner,
        name: name.to_string(),
        token_hash: token_hash.to_string(),
        scopes: scopes.to_vec(),
        created_at: now,
        last_used_at: None,
        revoked: false,
    })
}

pub async fn bot_list_apps(db: &AnyPool, owner_id: &str) -> Result<Vec<BotAppRow>, String> {
    let rows = sqlx::query(
        "SELECT id, owner_id, name, token_hash, scopes, created_at, last_used_at, revoked_at FROM bot_apps WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 50",
    )
    .bind(owner_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    let owner = user_by_id(db, owner_id)
        .await?
        .map(|row| row.username)
        .unwrap_or_default();
    Ok(rows
        .iter()
        .map(|row| bot_app_row(row, owner.clone()))
        .collect())
}

pub async fn bot_revoke_app(db: &AnyPool, owner_id: &str, id: &str) -> Result<bool, String> {
    let result = sqlx::query(
        "UPDATE bot_apps SET revoked_at = $1 WHERE id = $2 AND owner_id = $3 AND revoked_at IS NULL",
    )
    .bind(crate::util::now_ms())
    .bind(id)
    .bind(owner_id)
    .execute(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(result.rows_affected() > 0)
}

pub async fn bot_by_token(db: &AnyPool, token_hash: &str) -> Result<Option<BotAppRow>, String> {
    let row = sqlx::query(&format!(
        "SELECT {BOT_APP_COLS} FROM bot_apps WHERE token_hash = $1 AND revoked_at IS NULL LIMIT 1"
    ))
    .bind(token_hash)
    .fetch_optional(db)
    .await
    .map_err(|err| err.to_string())?;
    let Some(row) = row else { return Ok(None) };
    let app = bot_app_row(&row, String::new());
    let owner = user_by_id(db, &app.owner_id)
        .await?
        .map(|row| row.username)
        .unwrap_or_default();
    sqlx::query("UPDATE bot_apps SET last_used_at = $1 WHERE id = $2")
        .bind(crate::util::now_ms())
        .bind(&app.id)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(Some(BotAppRow { owner, ..app }))
}

#[derive(Debug, Clone)]
pub struct BotHookRow {
    pub id: String,
    pub bot_id: String,
    pub bot_name: String,
    pub url: String,
    pub secret: String,
    pub events: Vec<String>,
    pub enabled: bool,
    pub failures: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
}

fn bot_hook_row(row: &sqlx::any::AnyRow, bot_name: String) -> BotHookRow {
    BotHookRow {
        id: row.get_str("id"),
        bot_id: row.get_str("bot_id"),
        bot_name,
        url: row.get_str("url"),
        secret: row.get_str("secret"),
        events: parse_str_list(row.get_opt_str("events")),
        enabled: row.get_i64("enabled") != 0,
        failures: row.get_i64("failures"),
        last_error: row.get_opt_str("last_error"),
        created_at: row.get_i64("created_at"),
    }
}

const BOT_HOOK_COLS: &str = "bot_hooks.id AS id, bot_hooks.bot_id AS bot_id, bot_hooks.url AS url, bot_hooks.secret AS secret, bot_hooks.events AS events, bot_hooks.enabled AS enabled, bot_hooks.failures AS failures, bot_hooks.last_error AS last_error, bot_hooks.created_at AS created_at, bot_apps.name AS bot_name";

pub async fn bot_create_hook(
    db: &AnyPool,
    bot_id: &str,
    url: &str,
    secret: &str,
    events: &[String],
) -> Result<BotHookRow, String> {
    let id = crate::util::uuid();
    let now = crate::util::now_ms();
    sqlx::query(
        "INSERT INTO bot_hooks (id, bot_id, url, secret, events, enabled, failures, created_at) VALUES ($1, $2, $3, $4, $5, 1, 0, $6)",
    )
    .bind(&id)
    .bind(bot_id)
    .bind(url)
    .bind(secret)
    .bind(serde_json::to_string(events).unwrap_or_else(|_| "[]".into()))
    .bind(now)
    .execute(db)
    .await
    .map_err(|err| err.to_string())?;
    let bot_name = sqlx::query("SELECT name FROM bot_apps WHERE id = $1")
        .bind(bot_id)
        .fetch_optional(db)
        .await
        .map_err(|err| err.to_string())?
        .map(|row| row.get_str("name"))
        .unwrap_or_default();
    Ok(BotHookRow {
        id,
        bot_id: bot_id.to_string(),
        bot_name,
        url: url.to_string(),
        secret: secret.to_string(),
        events: events.to_vec(),
        enabled: true,
        failures: 0,
        last_error: None,
        created_at: now,
    })
}

pub async fn bot_list_hooks(db: &AnyPool, owner_id: &str) -> Result<Vec<BotHookRow>, String> {
    let rows = sqlx::query(&format!(
        "SELECT {BOT_HOOK_COLS} FROM bot_hooks INNER JOIN bot_apps ON bot_apps.id = bot_hooks.bot_id WHERE bot_apps.owner_id = $1 ORDER BY bot_hooks.created_at DESC LIMIT 100"
    ))
    .bind(owner_id)
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
            let name = row.get_str("bot_name");
            bot_hook_row(row, name)
        })
        .collect())
}

async fn bot_hook_owned(db: &AnyPool, owner_id: &str, id: &str) -> Result<bool, String> {
    let row = sqlx::query(
        "SELECT bot_hooks.id AS id FROM bot_hooks INNER JOIN bot_apps ON bot_apps.id = bot_hooks.bot_id WHERE bot_hooks.id = $1 AND bot_apps.owner_id = $2 LIMIT 1",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(row.is_some())
}

pub async fn bot_set_hook_enabled(
    db: &AnyPool,
    owner_id: &str,
    id: &str,
    enabled: bool,
) -> Result<bool, String> {
    if !bot_hook_owned(db, owner_id, id).await? {
        return Ok(false);
    }
    sqlx::query("UPDATE bot_hooks SET enabled = $1, last_error = NULL WHERE id = $2")
        .bind(if enabled { 1 } else { 0 })
        .bind(id)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(true)
}

pub async fn bot_remove_hook(db: &AnyPool, owner_id: &str, id: &str) -> Result<bool, String> {
    if !bot_hook_owned(db, owner_id, id).await? {
        return Ok(false);
    }
    sqlx::query("DELETE FROM bot_hooks WHERE id = $1")
        .bind(id)
        .execute(db)
        .await
        .map_err(|err| err.to_string())?;
    Ok(true)
}

pub async fn bot_hooks_of_event(db: &AnyPool, event: &str) -> Result<Vec<BotHookRow>, String> {
    let rows = sqlx::query(&format!(
        "SELECT {BOT_HOOK_COLS} FROM bot_hooks INNER JOIN bot_apps ON bot_apps.id = bot_hooks.bot_id WHERE bot_hooks.enabled = 1 AND bot_apps.revoked_at IS NULL LIMIT 500"
    ))
    .fetch_all(db)
    .await
    .map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
            let name = row.get_str("bot_name");
            bot_hook_row(row, name)
        })
        .filter(|hook| hook.events.iter().any(|item| item == event))
        .collect())
}

pub async fn bot_report_hook(
    db: &AnyPool,
    id: &str,
    ok: bool,
    error: Option<String>,
) -> Result<(), String> {
    if ok {
        sqlx::query("UPDATE bot_hooks SET failures = 0, last_error = NULL WHERE id = $1")
            .bind(id)
            .execute(db)
            .await
            .map_err(|err| err.to_string())?;
        return Ok(());
    }
    sqlx::query("UPDATE bot_hooks SET failures = failures + 1, last_error = $1 WHERE id = $2")
        .bind(error)
        .bind(id)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}
