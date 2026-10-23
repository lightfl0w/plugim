use chrono::Timelike;
use serde_json::{json, Value};

use crate::plugins::auth::require_user;
use crate::state::{handler, Registry, SharedState};
use crate::store;
use crate::util;

#[derive(Debug, Clone)]
pub struct DndSettings {
    pub enabled: bool,
    pub start: String,
    pub end: String,
    pub muted_sessions: Vec<String>,
}

fn default_dnd() -> DndSettings {
    DndSettings {
        enabled: false,
        start: "22:00".to_string(),
        end: "08:00".to_string(),
        muted_sessions: Vec::new(),
    }
}

fn valid_hhmm(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let Ok(hour) = value[0..2].parse::<u32>() else {
        return false;
    };
    let Ok(minute) = value[3..5].parse::<u32>() else {
        return false;
    };
    hour < 24 && minute < 60
}

fn normalize(raw: &Value) -> DndSettings {
    let mut out = default_dnd();
    let Some(object) = raw.as_object() else {
        return out;
    };
    out.enabled = object
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if let Some(start) = object.get("start").and_then(|value| value.as_str()) {
        if valid_hhmm(start) {
            out.start = start.to_string();
        }
    }
    if let Some(end) = object.get("end").and_then(|value| value.as_str()) {
        if valid_hhmm(end) {
            out.end = end.to_string();
        }
    }
    if let Some(list) = object.get("mutedSessions").and_then(|value| value.as_array()) {
        let mut muted: Vec<String> = Vec::new();
        for item in list {
            if let Some(name) = item.as_str() {
                if !muted.contains(&name.to_string()) && muted.len() < 500 {
                    muted.push(name.to_string());
                }
            }
        }
        out.muted_sessions = muted;
    }
    out
}

fn minutes_of(value: &str) -> i64 {
    let hour: i64 = value.get(0..2).and_then(|raw| raw.parse().ok()).unwrap_or(0);
    let minute: i64 = value.get(3..5).and_then(|raw| raw.parse().ok()).unwrap_or(0);
    hour * 60 + minute
}

pub fn window_active(settings: &DndSettings) -> bool {
    if !settings.enabled {
        return false;
    }
    let now = chrono::Local::now();
    let current = now.hour() as i64 * 60 + now.minute() as i64;
    let start = minutes_of(&settings.start);
    let end = minutes_of(&settings.end);
    if start == end {
        return false;
    }
    if start < end {
        return current >= start && current < end;
    }
    current >= start || current < end
}

fn next_start(settings: &DndSettings) -> Option<String> {
    if !settings.enabled {
        return None;
    }
    let now = chrono::Local::now();
    let current = now.hour() as i64 * 60 + now.minute() as i64;
    let start = minutes_of(&settings.start);
    if current < start {
        let at = now
            .date_naive()
            .and_hms_opt((start / 60) as u32, (start % 60) as u32, 0)?;
        let at = at.and_local_timezone(chrono::Local).single()?;
        return Some(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    None
}

fn state_json(settings: &DndSettings) -> Value {
    json!({
        "settings": {
            "enabled": settings.enabled,
            "start": settings.start,
            "end": settings.end,
            "mutedSessions": settings.muted_sessions,
        },
        "active": window_active(settings),
        "nextStartAt": next_start(settings),
    })
}

pub async fn load(state: &SharedState, user_id: &str) -> DndSettings {
    let raw = store::settings_get(&state.db, &format!("dnd:{user_id}"))
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    normalize(&parsed)
}

pub async fn save(
    state: &SharedState,
    user_id: &str,
    settings: &DndSettings,
) -> Result<Value, String> {
    let payload = json!({
        "enabled": settings.enabled,
        "start": settings.start,
        "end": settings.end,
        "mutedSessions": settings.muted_sessions,
    });
    store::settings_set(&state.db, &format!("dnd:{user_id}"), &payload.to_string()).await?;
    Ok(state_json(settings))
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "dnd.get",
        handler(|state, conn, _params| async move {
            let user = require_user(&conn)?;
            let settings = load(&state, &user.id).await;
            Ok(state_json(&settings))
        }),
    );

    registry.add(
        "dnd.set",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let current = load(&state, &user.id).await;
            let mut next = current.clone();
            if let Some(enabled) = params.get("enabled").and_then(|value| value.as_bool()) {
                next.enabled = enabled;
            }
            let start = util::str_param(&params, "start");
            if valid_hhmm(&start) {
                next.start = start;
            }
            let end = util::str_param(&params, "end");
            if valid_hhmm(&end) {
                next.end = end;
            }
            if let Some(list) = params.get("mutedSessions").and_then(|value| value.as_array()) {
                let mut muted: Vec<String> = Vec::new();
                for item in list {
                    if let Some(name) = item.as_str() {
                        if muted.len() < 500 {
                            muted.push(name.to_string());
                        }
                    }
                }
                next.muted_sessions = muted;
            }
            save(&state, &user.id, &next).await
        }),
    );

    registry.add(
        "dnd.mute",
        handler(|state, conn, params| async move {
            let user = require_user(&conn)?;
            let target = util::str_param(&params, "session").trim().to_string();
            if target.is_empty() {
                return Err("缺少会话".to_string());
            }
            let mut current = load(&state, &user.id).await;
            let on = params
                .get("on")
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            if on {
                if !current.muted_sessions.contains(&target) {
                    current.muted_sessions.push(target);
                }
            } else {
                current.muted_sessions.retain(|item| item != &target);
            }
            save(&state, &user.id, &current).await
        }),
    );

}
