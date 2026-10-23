use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::state::SharedState;

const URL_MAX: usize = 500;
const TEXT_MAX: usize = 200;
const DESC_MAX: usize = 300;
const TIMEOUT_MS: u64 = 5000;
const BYTES_MAX: usize = 512 * 1024;
const REDIRECT_MAX: usize = 3;
const CACHE_TTL_MS: i64 = 600_000;
const CACHE_MAX: usize = 200;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; plugim/1.0; +link-preview)";

struct CacheEntry {
    key: String,
    at: i64,
    value: Value,
}

static CACHE: Mutex<Vec<CacheEntry>> = Mutex::new(Vec::new());

fn cache_get(key: &str) -> Option<Value> {
    let now = crate::util::now_ms();
    let guard = CACHE.lock().ok()?;
    guard
        .iter()
        .find(|entry| entry.key == key && now - entry.at < CACHE_TTL_MS)
        .map(|entry| entry.value.clone())
}

fn cache_put(key: &str, value: &Value) {
    let Ok(mut guard) = CACHE.lock() else {
        return;
    };
    guard.retain(|entry| entry.key != key);
    if guard.len() >= CACHE_MAX {
        guard.remove(0);
    }
    guard.push(CacheEntry {
        key: key.to_string(),
        at: crate::util::now_ms(),
        value: value.clone(),
    });
}

fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 169 && octets[1] == 254)
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(mapped));
            }
            let head = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (head & 0xfe00) == 0xfc00
                || (head & 0xffc0) == 0xfe80
        }
    }
}

fn is_private_host(host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if host.is_empty() {
        return true;
    }
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
    {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private(ip);
    }
    if host.parse::<Ipv6Addr>().is_ok() || host.parse::<Ipv4Addr>().is_ok() {
        return true;
    }
    !host.contains('.')
}

fn in_list(host: &str, list: &[String]) -> bool {
    list.iter()
        .any(|entry| host == entry || host.ends_with(&format!(".{entry}")))
}

fn decode_html(raw: &str) -> String {
    let named = [
        ("amp", "&"),
        ("apos", "'"),
        ("gt", ">"),
        ("lt", "<"),
        ("nbsp", " "),
        ("quot", "\""),
    ];
    let bytes: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != '&' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        let mut end = index + 1;
        let mut found = false;
        while end < bytes.len() && end <= index + 12 {
            if bytes[end] == ';' {
                found = true;
                break;
            }
            end += 1;
        }
        if !found {
            out.push('&');
            index += 1;
            continue;
        }
        let code: String = bytes[index + 1..end].iter().collect();
        let lower = code.to_lowercase();
        let replaced = if let Some(hex) = lower.strip_prefix("#x") {
            u32::from_str_radix(hex, 16)
                .ok()
                .filter(|value| (1..=0x10ffff).contains(value))
                .and_then(char::from_u32)
                .map(|value| value.to_string())
        } else if let Some(dec) = lower.strip_prefix('#') {
            dec.parse::<u32>()
                .ok()
                .filter(|value| (1..=0x10ffff).contains(value))
                .and_then(char::from_u32)
                .map(|value| value.to_string())
        } else {
            named
                .iter()
                .find(|(name, _)| *name == lower)
                .map(|(_, value)| value.to_string())
        };
        match replaced {
            Some(value) => {
                out.push_str(&value);
                index = end + 1;
            }
            None => {
                out.push_str(&bytes[index..=end].iter().collect::<String>());
                index = end + 1;
            }
        }
    }
    out
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let bytes = lower.as_bytes();
    let mut index = 0;
    while let Some(found) = lower[index..].find(name) {
        let at = index + found;
        let before_ok = at == 0
            || !bytes[at - 1].is_ascii_alphanumeric() && bytes[at - 1] != b'-' && bytes[at - 1] != b':';
        let mut cursor = at + name.len();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if before_ok && cursor < bytes.len() && bytes[cursor] == b'=' {
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor >= bytes.len() {
                return None;
            }
            let quote = bytes[cursor];
            if quote == b'"' || quote == b'\'' {
                let start = cursor + 1;
                if let Some(end) = lower[start..].find(quote as char) {
                    return Some(tag[start..start + end].to_string());
                }
                return None;
            }
            let start = cursor;
            let mut end = start;
            while end < bytes.len() && !bytes[end].is_ascii_whitespace() && bytes[end] != b'>' {
                end += 1;
            }
            return Some(tag[start..end].to_string());
        }
        index = at + name.len();
        if index >= lower.len() {
            break;
        }
    }
    None
}

fn meta_content(html: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let lower = html.to_lowercase();
    let mut index = 0;
    while let Some(found) = lower[index..].find("<meta") {
        let start = index + found;
        let Some(close) = lower[start..].find('>') else {
            break;
        };
        let tag = &html[start..start + close];
        let key = attr_value(tag, "property")
            .or_else(|| attr_value(tag, "name"))
            .unwrap_or_default()
            .to_lowercase();
        let content = attr_value(tag, "content");
        if let (false, Some(content)) = (key.is_empty(), content) {
            if !out.iter().any(|(name, _)| *name == key) {
                out.push((key, decode_html(&content).trim().to_string()));
            }
        }
        index = start + close;
        if index >= lower.len() {
            break;
        }
    }
    out
}

fn meta_of(meta: &[(String, String)], key: &str) -> Option<String> {
    meta.iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
        .filter(|value| !value.is_empty())
}

fn title_tag(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let end = lower[open_end..].find("</title>")? + open_end;
    Some(decode_html(&html[open_end..end]).trim().to_string())
}

fn resolve_image(value: &str, base: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let base_url = reqwest::Url::parse(base).ok()?;
    let url = base_url.join(value).ok()?;
    match url.scheme() {
        "http" | "https" => Some(url.to_string()),
        _ => None,
    }
}

fn first_url_in(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let mut search = 0;
    while let Some(found) = lower[search..].find("http") {
        let start = search + found;
        let rest = &text[start..];
        if !(rest.starts_with("http://") || rest.starts_with("https://")) {
            search = start + 4;
            continue;
        }
        let end = rest
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '<' | '>' | '"' | '\''))
            .unwrap_or(rest.len());
        let candidate = rest[..end].trim_end_matches(|ch: char| {
            matches!(
                ch,
                ')' | ',' | '.' | ';' | '!' | '?' | '，' | '。' | '；' | '！' | '？' | '、' | '）' | '】'
            )
        });
        if candidate.len() > 9 {
            return Some(candidate.to_string());
        }
        search = start + 4;
    }
    None
}

async fn resolve_ip(host: &str, port: u16) -> Result<Vec<IpAddr>, String> {
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "无法解析该域名".to_string())?;
    let list: Vec<IpAddr> = addrs.map(|addr| addr.ip()).collect();
    if list.is_empty() {
        return Err("无法解析该域名".to_string());
    }
    Ok(list)
}

async fn guard(state: &SharedState, raw: &str) -> Result<(reqwest::Url, IpAddr), String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "链接地址无效".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("仅支持 http/https 链接".to_string()),
    }
    let default_port = if url.scheme() == "https" { 443 } else { 80 };
    if let Some(port) = url.port() {
        if port != default_port && !state.cfg.link_allow_private {
            return Err("仅支持 80/443 端口".to_string());
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("链接不能包含账号密码".to_string());
    }
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if host.is_empty() {
        return Err("链接地址无效".to_string());
    }
    let deny = &state.cfg.link_deny_hosts;
    let allow = &state.cfg.link_allow_hosts;
    if !deny.is_empty() && in_list(&host, deny) {
        return Err("该域名已被禁止访问".to_string());
    }
    if !allow.is_empty() && !in_list(&host, allow) {
        return Err("该域名不在允许的抓取范围内".to_string());
    }
    if !state.cfg.link_allow_private && is_private_host(&host) {
        return Err("不支持访问内网地址".to_string());
    }
    let ips = resolve_ip(&host, url.port_or_known_default().unwrap_or(default_port)).await?;
    if !state.cfg.link_allow_private && ips.iter().any(|ip| is_private(*ip)) {
        return Err("不支持访问内网地址".to_string());
    }
    Ok((url, ips[0]))
}

async fn fetch(
    target: &reqwest::Url,
    ip: IpAddr,
) -> Result<(u16, Option<String>, String, String), String> {
    let host = target.host_str().unwrap_or("").to_string();
    let port = target.port_or_known_default().unwrap_or(80);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(TIMEOUT_MS))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(&host, SocketAddr::new(ip, port))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client
        .get(target.clone())
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|_| "链接无法访问".to_string())?;
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                body.extend_from_slice(&chunk);
                if body.len() > BYTES_MAX {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => return Err("链接读取失败".to_string()),
        }
    }
    Ok((status, location, content_type, String::from_utf8_lossy(&body).to_string()))
}

pub async fn preview(state: &SharedState, raw_url: &str) -> Result<Value, String> {
    let candidate = raw_url.trim();
    if candidate.is_empty() {
        return Err("请输入链接地址".to_string());
    }
    if candidate.chars().count() > URL_MAX {
        return Err(format!("链接不能超过 {URL_MAX} 个字符"));
    }
    let requested = if candidate.contains("://") {
        candidate.to_string()
    } else {
        format!("https://{candidate}")
    };
    if let Some(hit) = cache_get(&requested) {
        return Ok(hit);
    }

    let mut current = requested.clone();
    let mut result: Option<(u16, Option<String>, String, String)> = None;
    for hop in 0..=REDIRECT_MAX {
        let (target, ip) = guard(state, &current).await?;
        let response = fetch(&target, ip).await?;
        if !(300..400).contains(&response.0) {
            result = Some(response);
            break;
        }
        let location = match response.1.clone() {
            Some(value) => value,
            None => return Err("链接无法访问".to_string()),
        };
        if hop == REDIRECT_MAX {
            return Err("链接重定向次数过多".to_string());
        }
        current = target
            .join(&location)
            .map_err(|_| "链接地址无效".to_string())?
            .to_string();
    }
    let (status, _, content_type, html) = result.ok_or_else(|| "链接无法访问".to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!("链接无法访问（{status}）"));
    }
    if !content_type.to_lowercase().contains("text/html") {
        return Err("链接不是网页".to_string());
    }

    let meta = meta_content(&html);
    let host = reqwest::Url::parse(&current)
        .ok()
        .and_then(|url| url.host_str().map(|value| value.to_string()))
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_string();
    let title = meta_of(&meta, "og:title")
        .or_else(|| meta_of(&meta, "twitter:title"))
        .or_else(|| title_tag(&html))
        .unwrap_or_default()
        .chars()
        .take(TEXT_MAX)
        .collect::<String>();
    let description = meta_of(&meta, "og:description")
        .or_else(|| meta_of(&meta, "description"))
        .or_else(|| meta_of(&meta, "twitter:description"))
        .unwrap_or_default()
        .chars()
        .take(DESC_MAX)
        .collect::<String>();
    let image = meta_of(&meta, "og:image")
        .or_else(|| meta_of(&meta, "og:image:url"))
        .or_else(|| meta_of(&meta, "twitter:image"))
        .and_then(|value| resolve_image(&value, &current));
    let site = meta_of(&meta, "og:site_name")
        .map(|value| value.chars().take(TEXT_MAX).collect::<String>())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| host.clone());

    let value = json!({
        "url": current,
        "title": if title.is_empty() { host } else { title },
        "description": description,
        "image": match image {
            Some(key) => json!(key),
            None => Value::Null,
        },
        "site": site,
    });
    cache_put(&requested, &value);
    Ok(value)
}

pub async fn preview_of_text(state: &SharedState, content: &str) -> Option<Value> {
    let url = first_url_in(content)?;
    preview(state, &url).await.ok()
}

pub fn has_link(content: &str) -> bool {
    first_url_in(content).is_some()
}
