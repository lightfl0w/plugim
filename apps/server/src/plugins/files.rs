use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::plugins::auth::{require_admin, require_user, verify_token};
use crate::state::{handler, Registry, SharedState};
use crate::store;
use crate::util;

const TEXT_LIMIT: usize = 512;
const DIR_LIMIT: usize = 256;

pub struct FileStoreConfig {
    pub driver: String,
    pub dir: String,
    pub upload_limit_mb: i64,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub path_style: bool,
    pub public_base: String,
}

async fn pick(state: &SharedState, key: &str, fallback: &str) -> String {
    match store::settings_get(&state.db, key).await {
        Ok(Some(value)) => value.trim().to_string(),
        _ => fallback.trim().to_string(),
    }
}

pub async fn read_config(state: &SharedState) -> FileStoreConfig {
    let cfg = state.cfg.as_ref();
    let driver = pick(state, "storage_driver", "local").await;
    let limit = pick(state, "upload_limit_mb", &cfg.upload_limit_mb.to_string())
        .await
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .map(|value| value.min(1024))
        .unwrap_or(20);
    let region = pick(state, "s3_region", "").await;
    let public_base = pick(state, "s3_public_base", "").await;
    FileStoreConfig {
        driver: if driver == "s3" { "s3".to_string() } else { "local".to_string() },
        dir: pick(state, "storage_dir", &cfg.storage_dir.to_string_lossy()).await,
        upload_limit_mb: limit,
        endpoint: pick(state, "s3_endpoint", "").await,
        region: if region.is_empty() { "us-east-1".to_string() } else { region },
        bucket: pick(state, "s3_bucket", "").await,
        access_key: pick(state, "s3_access_key", "").await,
        secret_key: pick(state, "s3_secret_key", "").await,
        path_style: pick(state, "s3_path_style", "false").await == "true",
        public_base: public_base.trim_end_matches('/').to_string(),
    }
}

pub async fn remove_object(state: &SharedState, key: &str) {
    let cfg = read_config(state).await;
    if cfg.driver == "s3" {
        match crate::plugins::s3::S3Client::new(&cfg) {
            Ok(client) => {
                if let Err(err) = client.delete(key).await {
                    tracing::warn!("s3 delete failed: {key} {err}");
                }
            }
            Err(err) => tracing::warn!("s3 client failed: {err}"),
        }
        return;
    }
    let root = storage_dir_of(state).await;
    if let Err(err) = std::fs::remove_file(root.join(key)) {
        if err.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("file delete failed: {key} {err}");
        }
    }
}

pub async fn storage_dir_of(state: &SharedState) -> PathBuf {
    let dir = pick(state, "storage_dir", &state.cfg.storage_dir.to_string_lossy()).await;
    PathBuf::from(if dir.is_empty() { "data/uploads".to_string() } else { dir })
}

fn public_config(cfg: &FileStoreConfig) -> Value {
    json!({
        "driver": cfg.driver,
        "dir": cfg.dir,
        "uploadLimitMb": cfg.upload_limit_mb,
        "endpoint": cfg.endpoint,
        "region": cfg.region,
        "bucket": cfg.bucket,
        "accessKey": cfg.access_key,
        "secretKeySet": !cfg.secret_key.is_empty(),
        "pathStyle": cfg.path_style,
        "publicBase": cfg.public_base,
    })
}

fn text_field(
    params: &Value,
    key: &str,
    label: &str,
    pattern: Option<fn(&str) -> bool>,
) -> Result<Option<String>, String> {
    let Some(value) = params.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let text = value.as_str().unwrap_or("").trim().to_string();
    if text.chars().count() > TEXT_LIMIT {
        return Err(format!("{label} 过长"));
    }
    if let Some(check) = pattern {
        if !check(&text) {
            return Err(format!("{label} 格式不正确"));
        }
    }
    Ok(Some(text))
}

fn dir_shape_ok(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= DIR_LIMIT
        && raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-'))
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    raw.strip_prefix("Bearer ").map(|value| value.to_string())
}

fn key_ok(key: &str) -> bool {
    key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "ok": false, "message": message }))).into_response()
}

pub async fn upload(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = bearer(&headers);
    let Some(user) = verify_token(&state, token.as_deref()).await else {
        return json_error(StatusCode::UNAUTHORIZED, "未登录或登录已过期");
    };
    let cfg = read_config(&state).await;
    let limit = cfg.upload_limit_mb as u64 * 1024 * 1024;
    if body.len() as u64 > limit {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!("文件超过 {} MB 上限", cfg.upload_limit_mb),
        );
    }
    if body.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "上传内容为空");
    }
    let raw_mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let mime = if raw_mime.contains('/') {
        raw_mime
    } else {
        "application/octet-stream".to_string()
    };
    let raw_name = headers
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let name = if raw_name.is_empty() {
        "未命名文件".to_string()
    } else {
        percent_decode(&raw_name)
    };
    let key = util::random_hex(16);
    if cfg.driver == "s3" {
        let client = match crate::plugins::s3::S3Client::new(&cfg) {
            Ok(client) => client,
            Err(err) => return json_error(StatusCode::BAD_REQUEST, &err),
        };
        if let Err(err) = client.put(&key, &body, &mime).await {
            return json_error(StatusCode::BAD_GATEWAY, &err);
        }
    } else {
        let root = PathBuf::from(if cfg.dir.is_empty() {
            "data/uploads".to_string()
        } else {
            cfg.dir.clone()
        });
        if let Err(err) = std::fs::create_dir_all(&root) {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string());
        }
        let path = root.join(&key);
        if let Err(err) = std::fs::write(&path, &body) {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string());
        }
    }
    if let Err(err) = store::media_save(
        &state.db,
        &key,
        &name,
        &mime,
        body.len() as i64,
        &user.id,
    )
    .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &err);
    }
    axum::Json(json!({
        "ok": true,
        "result": {
            "key": key,
            "url": format!("/files/{key}"),
            "name": name,
            "size": body.len(),
            "mime": mime,
        }
    }))
    .into_response()
}

pub async fn download(
    State(state): State<SharedState>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let token = bearer(&headers).or_else(|| query.get("token").cloned());
    if verify_token(&state, token.as_deref()).await.is_none() {
        return json_error(StatusCode::UNAUTHORIZED, "未登录或登录已过期");
    }
    if !key_ok(&key) {
        return json_error(StatusCode::BAD_REQUEST, "非法文件标识");
    }
    let info = match store::media_info(&state.db, &key).await {
        Ok(info) => info,
        Err(err) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &err),
    };
    let (name, mime) = info
        .map(|(name, mime, _)| (name, mime))
        .unwrap_or_else(|| ("file".to_string(), "application/octet-stream".to_string()));
    let cfg = read_config(&state).await;
    let bytes = if cfg.driver == "s3" {
        let Ok(client) = crate::plugins::s3::S3Client::new(&cfg) else {
            return json_error(StatusCode::BAD_REQUEST, "S3 配置不完整");
        };
        match client.get(&key).await {
            Ok(bytes) => bytes,
            Err(err) if err == "文件不存在" => {
                return json_error(StatusCode::NOT_FOUND, "文件不存在")
            }
            Err(err) => return json_error(StatusCode::BAD_GATEWAY, &err),
        }
    } else {
        let root = storage_dir_of(&state).await;
        let path = root.join(&key);
        let Ok(bytes) = std::fs::read(&path) else {
            return json_error(StatusCode::NOT_FOUND, "文件不存在");
        };
        bytes
    };
    let disposition = format!(
        "inline; filename*=UTF-8''{}",
        percent_encode(&name)
    );
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
        ],
        bytes,
    )
        .into_response()
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn percent_encode(raw: &str) -> String {
    let mut out = String::new();
    for byte in raw.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "files.info",
        handler(|state, conn, _params| async move {
            require_user(&conn)?;
            let cfg = read_config(&state).await;
            Ok(json!({
                "uploadLimitMb": cfg.upload_limit_mb,
                "driver": cfg.driver,
            }))
        }),
    );

    registry.add(
        "files.config.get",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            let cfg = read_config(&state).await;
            Ok(public_config(&cfg))
        }),
    );

    registry.add(
        "files.config.set",
        handler(|state, conn, params| async move {
            require_admin(&state, &conn).await?;
            let mut writes: Vec<(String, String)> = Vec::new();
            if let Some(value) = params.get("driver").filter(|value| !value.is_null()) {
                let driver = value.as_str().unwrap_or("");
                if driver != "local" && driver != "s3" {
                    return Err("存储驱动仅支持 local 或 s3".to_string());
                }
                writes.push(("storage_driver".to_string(), driver.to_string()));
            }
            if let Some(value) = text_field(&params, "dir", "存储目录", Some(dir_shape_ok))? {
                writes.push(("storage_dir".to_string(), value));
            }
            if let Some(value) = params.get("uploadLimitMb").filter(|value| !value.is_null()) {
                let limit = value.as_i64().unwrap_or(-1);
                if limit < 1 || limit > 1024 {
                    return Err("上传上限需为 1 到 1024 之间的整数".to_string());
                }
                writes.push(("upload_limit_mb".to_string(), limit.to_string()));
            }
            if let Some(value) = text_field(&params, "endpoint", "Endpoint", None)? {
                writes.push(("s3_endpoint".to_string(), value));
            }
            if let Some(value) = text_field(&params, "region", "Region", None)? {
                writes.push(("s3_region".to_string(), value));
            }
            if let Some(value) = text_field(&params, "bucket", "Bucket", None)? {
                writes.push(("s3_bucket".to_string(), value));
            }
            if let Some(value) = text_field(&params, "accessKey", "Access Key", None)? {
                writes.push(("s3_access_key".to_string(), value));
            }
            if let Some(value) = text_field(&params, "secretKey", "Secret Key", None)? {
                writes.push(("s3_secret_key".to_string(), value));
            }
            if let Some(value) = params.get("pathStyle") {
                if !value.is_null() {
                    writes.push((
                        "s3_path_style".to_string(),
                        if value.as_bool().unwrap_or(false) {
                            "true".to_string()
                        } else {
                            "false".to_string()
                        },
                    ));
                }
            }
            if let Some(value) = text_field(&params, "publicBase", "公开访问前缀", None)? {
                writes.push(("s3_public_base".to_string(), value));
            }

            let pending: HashMap<String, String> = writes.iter().cloned().collect();
            let current = read_config(&state).await;
            let resolve = |key: &str, fallback: &str| -> String {
                pending
                    .get(key)
                    .cloned()
                    .unwrap_or_else(|| fallback.to_string())
            };
            let driver = resolve("storage_driver", &current.driver);
            if driver == "s3" {
                if resolve("s3_bucket", &current.bucket).is_empty() {
                    return Err("S3 需要填写 Bucket".to_string());
                }
                if resolve("s3_access_key", &current.access_key).is_empty()
                    || resolve("s3_secret_key", &current.secret_key).is_empty()
                {
                    return Err("S3 需要填写 Access Key 与 Secret Key".to_string());
                }
            } else if resolve("storage_dir", &current.dir).is_empty() {
                return Err("本地存储需要填写目录".to_string());
            }
            for (key, value) in writes {
                store::settings_set(&state.db, &key, &value).await?;
            }
            let cfg = read_config(&state).await;
            tracing::info!("media storage switched to: {}", cfg.driver);
            Ok(public_config(&cfg))
        }),
    );

    registry.add(
        "files.config.test",
        handler(|state, conn, _params| async move {
            require_admin(&state, &conn).await?;
            let cfg = read_config(&state).await;
            if cfg.driver == "s3" {
                let client = crate::plugins::s3::S3Client::new(&cfg)?;
                client.head_bucket().await?;
                return Ok(json!({
                    "ok": true,
                    "message": format!("Bucket {} 可访问", cfg.bucket),
                }));
            }
            let dir = PathBuf::from(if cfg.dir.is_empty() {
                "data/uploads".to_string()
            } else {
                cfg.dir.clone()
            });
            std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
            let probe = dir.join(format!(".probe-{}", util::now_ms()));
            std::fs::write(&probe, "plugim").map_err(|err| err.to_string())?;
            let size = std::fs::metadata(&probe)
                .map_err(|err| err.to_string())?
                .len();
            let _ = std::fs::remove_file(&probe);
            Ok(json!({
                "ok": true,
                "message": format!("{} 可写 ({} 字节)", dir.display(), size),
            }))
        }),
    );
}


