use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(0).unwrap())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn parse_iso(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash_password(password: &str) -> Result<String, String> {
    use argon2::password_hash::rand_core::OsRng;
    use argon2::password_hash::{PasswordHasher, SaltString};
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| err.to_string())
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    argon2::Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub username: String,
    pub v: i64,
    #[serde(default)]
    pub sid: Option<String>,
    pub iat: i64,
    pub exp: i64,
}

const TOKEN_TTL_SECONDS: i64 = 30 * 24 * 3600;

pub fn sign_jwt(
    secret: &[u8],
    sub: &str,
    username: &str,
    version: i64,
    sid: Option<&str>,
) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: sub.to_string(),
        username: username.to_string(),
        v: version,
        sid: sid.map(|value| value.to_string()),
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
    };
    let header = serde_json::json!({ "alg": "HS256", "typ": "JWT" });
    let head = URL_SAFE_NO_PAD.encode(header.to_string().as_bytes());
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_string(&claims).unwrap().as_bytes());
    let payload = format!("{head}.{body}");
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac key");
    mac.update(payload.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{payload}.{sig}")
}

pub fn verify_jwt(secret: &[u8], token: &str) -> Option<Claims> {
    let mut parts = token.split('.');
    let head = parts.next()?;
    let body = parts.next()?;
    let sig = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let raw_header = URL_SAFE_NO_PAD.decode(head).ok()?;
    let header: serde_json::Value = serde_json::from_slice(&raw_header).ok()?;
    if header.get("alg").and_then(|v| v.as_str()) != Some("HS256") {
        return None;
    }
    let signing_input = format!("{head}.{body}");
    let mut mac = HmacSha256::new_from_slice(secret).ok()?;
    mac.update(signing_input.as_bytes());
    let expected = mac.finalize().into_bytes();
    let given = URL_SAFE_NO_PAD.decode(sig).ok()?;
    if expected.len() != given.len() || expected.ct_eq(&given).unwrap_u8() != 1 {
        return None;
    }
    let raw_body = URL_SAFE_NO_PAD.decode(body).ok()?;
    let claims: Claims = serde_json::from_slice(&raw_body).ok()?;
    if claims.exp <= chrono::Utc::now().timestamp() {
        return None;
    }
    Some(claims)
}

const B32_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_encode(raw: &[u8]) -> String {
    let mut bits = 0u32;
    let mut value = 0u32;
    let mut out = String::new();
    for byte in raw {
        value = (value << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            out.push(B32_ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(B32_ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn base32_decode(input: &str) -> Vec<u8> {
    let mut bits = 0u32;
    let mut value = 0u32;
    let mut out = Vec::new();
    for ch in input.to_uppercase().chars() {
        let Some(index) = B32_ALPHABET.iter().position(|c| *c as char == ch) else {
            continue;
        };
        value = (value << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
    }
    out
}

pub fn totp_secret() -> String {
    let mut buf = vec![0u8; 20];
    rand::thread_rng().fill_bytes(&mut buf);
    base32_encode(&buf)
}

pub fn totp_at(secret: &str, counter: u64) -> String {
    let key = base32_decode(secret);
    let mut mac = HmacSha1::new_from_slice(&key).expect("hmac key");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let code = ((u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]))
        % 1_000_000;
    format!("{code:06}")
}

pub fn verify_totp(secret: &str, code: &str) -> bool {
    let value = code.trim();
    if value.len() != 6 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let counter = chrono::Utc::now().timestamp() as u64 / 30;
    (-1i64..=1).any(|drift| {
        let target = (counter as i64 + drift).max(0) as u64;
        totp_at(secret, target).as_bytes().ct_eq(value.as_bytes()).unwrap_u8() == 1
    })
}

pub fn device_label_of(user_agent: &str) -> String {
    let ua = user_agent.trim();
    if ua.is_empty() {
        return "未知设备".to_string();
    }
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("OPR/") {
        "Opera"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("Chrome/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else if ua.contains("curl/") {
        "curl"
    } else {
        "浏览器"
    };
    let os = if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("iPhone") || ua.contains("iPad") || ua.contains("iOS") {
        "iOS"
    } else if ua.contains("Mac OS X") {
        "macOS"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        ""
    };
    if os.is_empty() {
        browser.to_string()
    } else {
        format!("{browser} {os}")
    }
}

pub fn str_param(params: &serde_json::Value, key: &str) -> String {
    params
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

pub fn bool_param(params: &serde_json::Value, key: &str) -> bool {
    params.get(key).and_then(|value| value.as_bool()).unwrap_or(false)
}

pub fn i64_param(params: &serde_json::Value, key: &str) -> Option<i64> {
    params.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
    })
}

pub fn string_list(params: &serde_json::Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}
