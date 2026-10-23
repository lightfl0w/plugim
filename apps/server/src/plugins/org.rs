use std::collections::HashSet;

use serde_json::{json, Value};

use crate::plugins::auth::{require_admin, require_user};
use crate::state::{handler, Registry, SharedState};
use crate::store::{self, DepartmentRow};
use crate::util;

const MAX_DEPTH: usize = 5;
const NAME_LIMIT: usize = 30;
const TITLE_LIMIT: usize = 20;

fn chain_depth(rows: &[DepartmentRow], id: Option<&str>) -> usize {
    let mut depth = 0;
    let mut current = id.and_then(|id| rows.iter().find(|row| row.id == id));
    while let Some(row) = current {
        depth += 1;
        current = row
            .parent_id
            .as_ref()
            .and_then(|parent| rows.iter().find(|item| &item.id == parent));
        if depth > 32 {
            break;
        }
    }
    depth
}

fn descendants_of(rows: &[DepartmentRow], id: &str) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::new();
    let mut queue = vec![id.to_string()];
    while let Some(current) = queue.pop() {
        for row in rows {
            if row.parent_id.as_deref() != Some(current.as_str()) || out.contains(&row.id) {
                continue;
            }
            out.insert(row.id.clone());
            queue.push(row.id.clone());
        }
    }
    out
}

fn subtree_height(rows: &[DepartmentRow], id: &str) -> usize {
    let mut height = 0;
    fn walk(rows: &[DepartmentRow], current: &str, level: usize, height: &mut usize) {
        if level > *height {
            *height = level;
        }
        for row in rows {
            if row.parent_id.as_deref() == Some(current) {
                walk(rows, &row.id, level + 1, height);
            }
        }
    }
    walk(rows, id, 1, &mut height);
    height
}

fn clean_name(raw: &str) -> Result<String, String> {
    let name: String = raw.trim().chars().take(NAME_LIMIT).collect();
    if name.is_empty() {
        return Err("请输入部门名称".to_string());
    }
    Ok(name)
}

async fn require_enterprise(state: &SharedState) -> Result<(), String> {
    if store::settings_get(&state.db, "app_mode")
        .await
        .ok()
        .flatten()
        .as_deref()
        == Some("chat")
    {
        return Err("当前为聊天模式，企业通讯录功能未开放".to_string());
    }
    Ok(())
}

async fn tree_data(state: &SharedState) -> Result<Vec<Value>, String> {
    let rows = store::departments_all(&state.db).await?;
    let counts = store::department_member_counts(&state.db).await?;
    Ok(rows
        .iter()
        .map(|row| {
            json!({
                "id": row.id,
                "name": row.name,
                "parentId": row.parent_id,
                "sort": row.sort,
                "groupId": row.group_id,
                "memberCount": counts.get(&row.id).copied().unwrap_or(0),
                "createdAt": util::iso_from_ms(row.created_at),
            })
        })
        .collect())
}

async fn notify_group(state: &SharedState, group_id: &str) {
    if let Ok(ids) = store::group_member_ids(&state.db, group_id).await {
        for id in ids {
            state
                .hub
                .emit_to_user(&id, "group:update", json!({ "groupId": group_id }))
                .await;
        }
    }
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "org.tree",
        handler(|state, conn, _params| async move {
            require_enterprise(&state).await?;
            require_user(&conn)?;
            Ok(json!(tree_data(&state).await?))
        }),
    );

    registry.add(
        "org.directory",
        handler(|state, conn, _params| async move {
            require_enterprise(&state).await?;
            require_user(&conn)?;
            let departments = tree_data(&state).await?;
            let users = store::all_users(&state.db).await?;
            let online: Vec<String> = state.hub.online_user_ids().await;
            let members: Vec<Value> = users
                .iter()
                .filter(|user| !user.banned)
                .map(|user| {
                    json!({
                        "id": user.id,
                        "username": user.username,
                        "deptId": user.dept_id,
                        "title": user.title,
                        "createdAt": util::iso_from_ms(user.created_at),
                        "online": online.contains(&user.id),
                    })
                })
                .collect();
            Ok(json!({ "departments": departments, "members": members }))
        }),
    );

    registry.add(
        "admin.department.create",
        handler(|state, conn, params| async move {
            require_enterprise(&state).await?;
            let me = require_admin(&state, &conn).await?;
            let name = clean_name(&util::str_param(&params, "name"))?;
            let parent_id = {
                let raw = util::str_param(&params, "parentId");
                if raw.is_empty() {
                    None
                } else {
                    Some(raw)
                }
            };
            let rows = store::departments_all(&state.db).await?;
            if let Some(parent) = parent_id.as_ref() {
                if !rows.iter().any(|row| &row.id == parent) {
                    return Err("上级部门不存在".to_string());
                }
            }
            if chain_depth(&rows, parent_id.as_deref()) >= MAX_DEPTH {
                return Err(format!("部门层级不能超过 {MAX_DEPTH} 级"));
            }
            if rows
                .iter()
                .any(|row| row.parent_id == parent_id && row.name == name)
            {
                return Err("同级已存在同名部门".to_string());
            }
            let row = store::department_create(&state.db, &name, parent_id.as_deref()).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "org.dept.create",
                &format!("新建部门「{name}」"),
            )
            .await?;
            Ok(json!({
                "id": row.id,
                "name": row.name,
                "parentId": row.parent_id,
                "sort": row.sort,
                "groupId": row.group_id,
                "memberCount": 0,
                "createdAt": util::iso_from_ms(row.created_at),
            }))
        }),
    );

    registry.add(
        "admin.department.rename",
        handler(|state, conn, params| async move {
            require_enterprise(&state).await?;
            let me = require_admin(&state, &conn).await?;
            let id = util::str_param(&params, "id");
            let name = clean_name(&util::str_param(&params, "name"))?;
            let rows = store::departments_all(&state.db).await?;
            let Some(row) = rows.iter().find(|row| row.id == id) else {
                return Err("部门不存在".to_string());
            };
            if rows
                .iter()
                .any(|item| item.parent_id == row.parent_id && item.name == name && item.id != id)
            {
                return Err("同级已存在同名部门".to_string());
            }
            let old_name = row.name.clone();
            store::department_rename(&state.db, &id, &name).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "org.dept.rename",
                &format!("部门「{old_name}」更名为「{name}」"),
            )
            .await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "admin.department.move",
        handler(|state, conn, params| async move {
            require_enterprise(&state).await?;
            let me = require_admin(&state, &conn).await?;
            let id = util::str_param(&params, "id");
            let parent_id = {
                let raw = util::str_param(&params, "parentId");
                if raw.is_empty() {
                    None
                } else {
                    Some(raw)
                }
            };
            let rows = store::departments_all(&state.db).await?;
            let Some(row) = rows.iter().find(|row| row.id == id) else {
                return Err("部门不存在".to_string());
            };
            if parent_id.as_deref() == Some(id.as_str()) {
                return Err("不能移动到自身".to_string());
            }
            let mut parent_name = String::new();
            if let Some(parent) = parent_id.as_ref() {
                let Some(target) = rows.iter().find(|item| &item.id == parent) else {
                    return Err("目标部门不存在".to_string());
                };
                parent_name = target.name.clone();
                if descendants_of(&rows, &id).contains(parent) {
                    return Err("不能移动到自己的子部门".to_string());
                }
                if chain_depth(&rows, Some(parent)) + subtree_height(&rows, &id) > MAX_DEPTH {
                    return Err(format!("部门层级不能超过 {MAX_DEPTH} 级"));
                }
            }
            if rows
                .iter()
                .any(|item| item.parent_id == parent_id && item.name == row.name && item.id != id)
            {
                return Err("目标部门下已存在同名部门".to_string());
            }
            store::department_move(&state.db, &id, parent_id.as_deref()).await?;
            let detail = if parent_name.is_empty() {
                format!("部门「{}」移动到根级", row.name)
            } else {
                format!("部门「{}」移入「{}」", row.name, parent_name)
            };
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "org.dept.move",
                &detail,
            )
            .await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "admin.department.delete",
        handler(|state, conn, params| async move {
            require_enterprise(&state).await?;
            let me = require_admin(&state, &conn).await?;
            let id = util::str_param(&params, "id");
            let rows = store::departments_all(&state.db).await?;
            let Some(row) = rows.iter().find(|row| row.id == id) else {
                return Err("部门不存在".to_string());
            };
            if rows.iter().any(|item| item.parent_id.as_deref() == Some(&id)) {
                return Err("请先删除或移走子部门".to_string());
            }
            let users = store::all_users(&state.db).await?;
            if users.iter().any(|user| user.dept_id.as_deref() == Some(&id)) {
                return Err("部门内仍有成员，请先转移成员".to_string());
            }
            let name = row.name.clone();
            store::department_delete(&state.db, &id).await?;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "org.dept.delete",
                &format!("删除部门「{name}」"),
            )
            .await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "admin.user.assign",
        handler(|state, conn, params| async move {
            require_enterprise(&state).await?;
            let me = require_admin(&state, &conn).await?;
            let user_id = util::str_param(&params, "userId");
            let Some(target) = store::user_by_id(&state.db, &user_id).await? else {
                return Err("用户不存在".to_string());
            };
            let dept_id = {
                let raw = util::str_param(&params, "deptId");
                if raw.is_empty() {
                    None
                } else {
                    Some(raw)
                }
            };
            let mut dept_name = String::new();
            if let Some(id) = dept_id.as_ref() {
                let Some(dept) = store::department_by_id(&state.db, id).await? else {
                    return Err("部门不存在".to_string());
                };
                dept_name = dept.name;
            }
            let title: String = util::str_param(&params, "title")
                .trim()
                .chars()
                .take(TITLE_LIMIT)
                .collect();
            let title_value = if title.is_empty() { None } else { Some(title.as_str()) };
            store::set_org(&state.db, &user_id, dept_id.as_deref(), title_value).await?;
            let scope = if dept_name.is_empty() {
                "移出部门".to_string()
            } else {
                format!("调入「{dept_name}」")
            };
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "org.member.assign",
                &format!(
                    "将 {} {}{}",
                    target.username,
                    scope,
                    if title.is_empty() {
                        String::new()
                    } else {
                        format!("，职位「{title}」")
                    }
                ),
            )
            .await?;
            Ok(json!(true))
        }),
    );

    registry.add(
        "admin.department.group",
        handler(|state, conn, params| async move {
            require_enterprise(&state).await?;
            let me = require_admin(&state, &conn).await?;
            let id = util::str_param(&params, "id");
            let rows = store::departments_all(&state.db).await?;
            let Some(row) = rows.iter().find(|item| item.id == id) else {
                return Err("部门不存在".to_string());
            };
            if let Some(group_id) = row.group_id.as_ref() {
                if store::group_by_id(&state.db, group_id).await?.is_some() {
                    return Ok(json!({ "groupId": group_id, "created": false }));
                }
            }
            let mut scope: HashSet<String> = descendants_of(&rows, &id);
            scope.insert(id.clone());
            let users = store::all_users(&state.db).await?;
            let group = store::group_create(&state.db, &format!("{}群", row.name), &me.id).await?;
            store::group_add_member(&state.db, &group.id, &me.id).await?;
            store::group_set_role(&state.db, &group.id, &me.id, "owner").await?;
            for user in users {
                if user.id == me.id || user.banned {
                    continue;
                }
                match user.dept_id.as_ref() {
                    Some(dept) if scope.contains(dept) => {
                        store::group_add_member(&state.db, &group.id, &user.id).await?;
                    }
                    _ => {}
                }
            }
            let name = row.name.clone();
            store::department_set_group(&state.db, &id, Some(&group.id)).await?;
            notify_group(&state, &group.id).await;
            store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "org.dept.group",
                &format!("为部门「{name}」创建部门群"),
            )
            .await?;
            Ok(json!({ "groupId": group.id, "created": true }))
        }),
    );

    registry.add(
        "admin.department.group.sync",
        handler(|state, conn, params| async move {
            require_enterprise(&state).await?;
            let me = require_admin(&state, &conn).await?;
            let id = util::str_param(&params, "id");
            let rows = store::departments_all(&state.db).await?;
            let Some(row) = rows.iter().find(|item| item.id == id) else {
                return Err("部门不存在".to_string());
            };
            let Some(group_id) = row.group_id.clone() else {
                return Err("该部门还没有部门群".to_string());
            };
            if store::group_by_id(&state.db, &group_id).await?.is_none() {
                return Err("部门群已不存在".to_string());
            }
            let mut scope: HashSet<String> = descendants_of(&rows, &id);
            scope.insert(id.clone());
            let users = store::all_users(&state.db).await?;
            let existing: HashSet<String> = store::group_member_ids(&state.db, &group_id)
                .await?
                .into_iter()
                .collect();
            let mut added = 0;
            for user in users {
                if user.banned || existing.contains(&user.id) {
                    continue;
                }
                match user.dept_id.as_ref() {
                    Some(dept) if scope.contains(dept) => {
                        store::group_add_member(&state.db, &group_id, &user.id).await?;
                        added += 1;
                    }
                    _ => {}
                }
            }
            if added > 0 {
                notify_group(&state, &group_id).await;
                store::audit(
                    &state.db,
                    Some(&me.id),
                    &me.username,
                    "org.dept.group",
                    &format!("部门「{}」群同步加入 {added} 名成员", row.name),
                )
                .await?;
            }
            Ok(json!({ "added": added }))
        }),
    );
}

