use std::sync::OnceLock;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::Sha256;

use crate::plugins::auth::require_user;
use crate::plugins::prefs;
use crate::state::{handler, Registry, SharedState};
use crate::store;

const VAPID_PUBLIC: &str = "vapid_public";
const VAPID_PRIVATE: &str = "vapid_private";
const SUBJECT_FALLBACK: &str = "mailto:admin@example.com";
const RECORD_SIZE: u32 = 4096;

pub struct Vapid {
    pub public: String,
    private: Vec<u8>,
    subject: String,
}

static VAPID: OnceLock<Option<Vapid>> = OnceLock::new();

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64(text: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(text.trim())
        .map_err(|_| "密钥格式无效".to_string())
}

fn generate_vapid() -> (String, String) {
    let secret = SecretKey::random(&mut rand::thread_rng());
    let public = secret.public_key().to_encoded_point(false);
    (b64(public.as_bytes()), b64(secret.to_bytes().as_slice()))
}

async fn resolve_vapid(state: &SharedState) -> Result<Vapid, String> {
    let mut public = state.cfg.vapid_public_key.trim().to_string();
    let mut private = state.cfg.vapid_private_key.trim().to_string();
    if public.is_empty() || private.is_empty() {
        public = store::settings_get(&state.db, VAPID_PUBLIC)
            .await?
            .unwrap_or_default();
        private = store::settings_get(&state.db, VAPID_PRIVATE)
            .await?
            .unwrap_or_default();
    }
    if public.is_empty() || private.is_empty() {
        let (next_public, next_private) = generate_vapid();
        store::settings_set(&state.db, VAPID_PUBLIC, &next_public).await?;
        store::settings_set(&state.db, VAPID_PRIVATE, &next_private).await?;
        public = next_public;
        private = next_private;
        tracing::info!("VAPID keys generated and stored");
    }
    let secret = SecretKey::from_slice(&unb64(&private)?).map_err(|err| err.to_string())?;
    let derived_public = b64(secret.public_key().to_encoded_point(false).as_bytes());
    if derived_public != public {
        public = derived_public;
    }
    let subject = state.cfg.vapid_subject.trim().to_string();
    Ok(Vapid {
        public,
        private: secret.to_bytes().to_vec(),
        subject: if subject.is_empty() {
            SUBJECT_FALLBACK.to_string()
        } else {
            subject
        },
    })
}

async fn vapid(state: &SharedState) -> Result<&'static Vapid, String> {
    if let Some(value) = VAPID.get() {
        return value.as_ref().ok_or_else(|| "推送未初始化".to_string());
    }
    let resolved = resolve_vapid(state).await;
    let stored = resolved.ok();
    let _ = VAPID.set(stored);
    VAPID
        .get()
        .and_then(|value| value.as_ref())
        .ok_or_else(|| "推送未初始化".to_string())
}

pub fn encrypt(
    ua_public: &[u8],
    auth_secret: &[u8],
    peer_secret: &SecretKey,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    let as_public = peer_secret
        .public_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec();
    let peer = PublicKey::from_sec1_bytes(ua_public).map_err(|_| "p256dh 公钥无效".to_string())?;
    let shared = p256::ecdh::diffie_hellman(peer_secret.to_nonzero_scalar(), peer.as_affine());
    let ecdh_secret = shared.raw_secret_bytes();

    let mut auth_info = b"WebPush: info\0".to_vec();
    auth_info.extend_from_slice(ua_public);
    auth_info.extend_from_slice(&as_public);

    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), ecdh_secret.as_slice())
        .expand(&auth_info, &mut ikm)
        .map_err(|_| "HKDF 派生失败".to_string())?;

    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0u8; 16];
    hkdf.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| "HKDF 派生失败".to_string())?;
    let mut nonce = [0u8; 12];
    hkdf.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| "HKDF 派生失败".to_string())?;

    let mut plain: Vec<u8> = payload.to_vec();
    plain.push(0x02);

    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| "密钥长度无效".to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_slice())
        .map_err(|_| "载荷加密失败".to_string())?;

    let mut body = Vec::with_capacity(16 + 4 + 1 + as_public.len() + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(&as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

fn is_local_endpoint(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    match url.host_str() {
        Some(host) => {
            let host = host.trim_start_matches('[').trim_end_matches(']');
            if host == "localhost" || host.ends_with(".localhost") {
                return true;
            }
            host.parse::<std::net::IpAddr>()
                .map(|ip| ip.is_loopback())
                .unwrap_or(false)
        }
        None => false,
    }
}

fn audience(endpoint: &str) -> Option<String> {
    let url = reqwest::Url::parse(endpoint).ok()?;
    let host = url.host_str()?.to_string();
    let port = url.port().map(|value| format!(":{value}")).unwrap_or_default();
    Some(format!("{}://{}{}", url.scheme(), host, port))
}

fn vapid_header(vapid: &Vapid, endpoint: &str) -> Result<String, String> {
    let aud = audience(endpoint).ok_or_else(|| "订阅地址无效".to_string())?;
    let exp = chrono::Utc::now().timestamp() + 12 * 3600;
    let header = json!({ "typ": "JWT", "alg": "ES256" });
    let claims = json!({ "aud": aud, "exp": exp, "sub": vapid.subject });
    let signing = format!(
        "{}.{}",
        b64(header.to_string().as_bytes()),
        b64(claims.to_string().as_bytes())
    );
    let key = SigningKey::from_slice(&vapid.private).map_err(|err| err.to_string())?;
    let signature: Signature = key.sign(signing.as_bytes());
    Ok(format!(
        "vapid t={}.{}, k={}",
        signing,
        b64(signature.to_bytes().as_slice()),
        vapid.public
    ))
}

async fn send_one(
    vapid: &Vapid,
    row: &store::PushRow,
    body_text: &str,
) -> Result<bool, (bool, String)> {
    let peer_public = unb64(&row.p256dh).map_err(|err| (false, err))?;
    let auth_secret = unb64(&row.auth).map_err(|err| (false, err))?;
    let secret = SecretKey::from_slice(&vapid.private).map_err(|err| (false, err.to_string()))?;
    let body = encrypt(&peer_public, &auth_secret, &secret, body_text.as_bytes())
        .map_err(|err| (false, err))?;
    let auth = vapid_header(vapid, &row.endpoint).map_err(|err| (false, err))?;
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5));
    if is_local_endpoint(&row.endpoint) {
        builder = builder.no_proxy();
    }
    let client = builder.build()
        .map_err(|err| (false, err.to_string()))?;
    let response = client
        .post(&row.endpoint)
        .header("Authorization", auth)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", "86400")
        .header("Urgency", "normal")
        .body(body)
        .send()
        .await;
    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            if (200..300).contains(&status) {
                Ok(true)
            } else if status == 404 || status == 410 {
                Err((true, format!("订阅已失效（{status}）")))
            } else {
                Err((false, format!("推送失败（{status}）")))
            }
        }
        Err(err) => Err((false, err.to_string())),
    }
}

pub struct PushPayload {
    pub title: String,
    pub body: String,
    pub session: String,
}

async fn deliver_rows(state: &SharedState, rows: Vec<store::PushRow>, payload: &PushPayload) {
    if rows.is_empty() {
        return;
    }
    let Ok(vapid) = vapid(state).await else {
        return;
    };
    let text = json!({
        "title": payload.title,
        "body": payload.body,
        "session": payload.session,
    })
    .to_string();
    for row in rows {
        match send_one(vapid, &row, &text).await {
            Ok(_) => {}
            Err((gone, message)) => {
                if gone {
                    let _ = store::push_remove(&state.db, &row.user_id, &row.endpoint).await;
                } else {
                    tracing::warn!("push send failed: {message}");
                }
            }
        }
    }
}

async fn blocked(state: &SharedState, user_id: &str, session: &str) -> bool {
    let settings = prefs::load(state, user_id).await;
    if settings.muted_sessions.iter().any(|item| item == session) {
        return true;
    }
    prefs::window_active(&settings)
}

pub fn deliver(state: SharedState, user_ids: Vec<String>, payload: PushPayload) {
    tokio::spawn(async move {
        let mut unique: Vec<String> = Vec::new();
        for id in user_ids {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        let mut targets: Vec<String> = Vec::new();
        for id in unique {
            if state.hub.is_online(&id).await {
                continue;
            }
            if blocked(&state, &id, &payload.session).await {
                continue;
            }
            targets.push(id);
        }
        if targets.is_empty() {
            return;
        }
        let rows = store::push_of_users(&state.db, &targets)
            .await
            .unwrap_or_default();
        deliver_rows(&state, rows, &payload).await;
    });
}

pub fn deliver_all(state: SharedState, payload: PushPayload, except_user: String) {
    tokio::spawn(async move {
        let rows = store::push_of_all(&state.db).await.unwrap_or_default();
        let mut targets: Vec<store::PushRow> = Vec::new();
        for row in rows {
            if row.user_id == except_user {
                continue;
            }
            if state.hub.is_online(&row.user_id).await {
                continue;
            }
            if blocked(&state, &row.user_id, &payload.session).await {
                continue;
            }
            targets.push(row);
        }
        deliver_rows(&state, targets, &payload).await;
    });
}

fn preview_of(kind: &str, content: &str, file_name: Option<&str>) -> String {
    match kind {
        "image" => "[图片]".to_string(),
        "audio" => "[语音]".to_string(),
        "video" => "[视频]".to_string(),
        "merge" => "[合并转发]".to_string(),
        "moment" => "[动态分享]".to_string(),
        "redpacket" => "[红包]".to_string(),
        "transfer" => "[转账]".to_string(),
        "aabill" => "[AA 账单]".to_string(),
        "notice" => "[群公告]".to_string(),
        "file" => match file_name {
            Some(name) if !name.is_empty() => format!("[文件] {name}"),
            _ => "[文件]".to_string(),
        },
        _ => content.chars().take(80).collect(),
    }
}

pub fn preview(kind: &str, content: &str, file_name: Option<&str>) -> String {
    preview_of(kind, content, file_name)
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "push.info",
        handler(|state, conn, _params| async move {
            let user = require_user(&conn)?;
            let public = match vapid(&state).await {
                Ok(value) => value.public.clone(),
                Err(_) => String::new(),
            };
            let subscriptions = store::push_of_user(&state.db, &user.id).await?.len();
            Ok(json!({ "publicKey": public, "subscriptions": subscriptions }))
        }),
    );

    registry.add(
        "push.subscribe",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let subscription = params.get("subscription").cloned().unwrap_or(Value::Null);
            let endpoint = subscription
                .get("endpoint")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let p256dh = subscription
                .get("keys")
                .and_then(|value| value.get("p256dh"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let auth = subscription
                .get("keys")
                .and_then(|value| value.get("auth"))
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if endpoint.is_empty() || p256dh.is_empty() || auth.is_empty() {
                return Err("订阅信息不完整".to_string());
            }
            store::push_save(&state.db, &user.id, &endpoint, &p256dh, &auth).await?;
            let subscriptions = store::push_of_user(&state.db, &user.id).await?.len();
            Ok(json!({ "subscriptions": subscriptions }))
        }),
    );

    registry.add(
        "push.unsubscribe",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let endpoint = params
                .get("endpoint")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if !endpoint.is_empty() {
                store::push_remove(&state.db, &user.id, &endpoint).await?;
            }
            let subscriptions = store::push_of_user(&state.db, &user.id).await?.len();
            Ok(json!({ "subscriptions": subscriptions }))
        }),
    );

    registry.add(
        "push.test",
        handler(|state, conn, _params| async move {
            let user = require_user(&conn)?;
            let rows = store::push_of_user(&state.db, &user.id).await?;
            if rows.is_empty() {
                return Err("当前设备未开启推送".to_string());
            }
            let payload = PushPayload {
                title: "plugim".to_string(),
                body: "推送测试成功".to_string(),
                session: String::new(),
            };
            let vapid = vapid(&state).await?;
            let text = json!({
                "title": payload.title,
                "body": payload.body,
                "session": payload.session,
            })
            .to_string();
            let mut ok = false;
            for row in rows {
                match send_one(vapid, &row, &text).await {
                    Ok(_) => ok = true,
                    Err((gone, message)) => {
                        if gone {
                            let _ =
                                store::push_remove(&state.db, &row.user_id, &row.endpoint).await;
                        } else {
                            tracing::warn!("push test failed: {message}");
                        }
                    }
                }
            }
            if !ok {
                return Err("推送发送失败".to_string());
            }
            Ok(json!({ "ok": true }))
        }),
    );
}
