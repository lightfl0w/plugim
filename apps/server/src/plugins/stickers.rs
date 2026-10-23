use serde_json::{json, Value};

use crate::plugins::auth::require_user;
use crate::state::{handler, Registry};
use crate::store;
use crate::util;

const MAX_STICKERS: usize = 60;

fn valid_item(item: &Value) -> bool {
    let url = item.get("url").and_then(|value| value.as_str()).unwrap_or("");
    let name = item.get("name").and_then(|value| value.as_str()).unwrap_or("");
    let mime = item.get("mime").and_then(|value| value.as_str()).unwrap_or("");
    item.get("size").and_then(|value| value.as_f64()).is_some()
        && url.starts_with("/files/")
        && url.len() < 200
        && !name.is_empty()
        && name.len() < 64
        && mime.starts_with("image/")
}

async fn read_items(
    state: &crate::state::SharedState,
    user_id: &str,
) -> Result<Vec<Value>, String> {
    let raw = store::settings_get(&state.db, &format!("stickers:{user_id}"))
        .await?
        .unwrap_or_default();
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let list = parsed.as_array().cloned().unwrap_or_default();
    Ok(list.into_iter().filter(valid_item).take(MAX_STICKERS).collect())
}

async fn save_items(
    state: &crate::state::SharedState,
    user_id: &str,
    items: &[Value],
) -> Result<(), String> {
    store::settings_set(
        &state.db,
        &format!("stickers:{user_id}"),
        &Value::Array(items.to_vec()).to_string(),
    )
    .await
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "stickers.list",
        handler(|state, conn, _params| async move {
            let me = require_user(&conn)?;
            Ok(json!({ "stickers": read_items(&state, &me.id).await? }))
        }),
    );

    registry.add(
        "stickers.add",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            if !valid_item(&params) {
                return Err("无效的表情数据".to_string());
            }
            let mut list = read_items(&state, &me.id).await?;
            if list.len() >= MAX_STICKERS {
                return Err(format!("最多收藏 {MAX_STICKERS} 个表情"));
            }
            let url = util::str_param(&params, "url");
            if !list
                .iter()
                .any(|item| item.get("url").and_then(|value| value.as_str()) == Some(&url))
            {
                list.push(json!({
                    "url": url,
                    "name": util::str_param(&params, "name"),
                    "mime": util::str_param(&params, "mime"),
                    "size": util::i64_param(&params, "size").unwrap_or(0),
                }));
                save_items(&state, &me.id, &list).await?;
            }
            Ok(json!({ "stickers": list }))
        }),
    );

    registry.add(
        "stickers.remove",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let url = util::str_param(&params, "url");
            if url.is_empty() {
                return Err("缺少表情地址".to_string());
            }
            let list: Vec<Value> = read_items(&state, &me.id)
                .await?
                .into_iter()
                .filter(|item| item.get("url").and_then(|value| value.as_str()) != Some(&url))
                .collect();
            save_items(&state, &me.id, &list).await?;
            Ok(json!({ "stickers": list }))
        }),
    );
}
