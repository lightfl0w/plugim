use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

use crate::state::{handler, Registry};
use crate::store;
use crate::util;

fn repo_from(start: PathBuf) -> Option<PathBuf> {
    let mut dir = start;
    for _ in 0..6 {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => break,
        }
    }
    None
}

fn find_repo_root() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("PLUGIM_REPO") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return repo_from(PathBuf::from(trimmed));
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.to_path_buf());
        }
    }
    for candidate in candidates {
        if let Some(root) = repo_from(candidate) {
            return Some(root);
        }
    }
    None
}

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        tracing::warn!("git {:?} failed in {}", args, repo.display());
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn read_status(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn register(registry: &mut Registry) {
    let repo = find_repo_root();
    let status_file = repo
        .as_ref()
        .map(|root| root.join("data").join("update-status.json"));
    let script_file = repo
        .as_ref()
        .map(|root| root.join("scripts").join("self-update.sh"));

    {
        let repo = repo.clone();
        registry.add(
            "admin.update.check",
            handler(move |state, conn, _params| {
                let repo = repo.clone();
                async move {
                    crate::plugins::auth::require_admin(&state, &conn).await?;
                    let Some(root) = repo else {
                        return Ok(json!({
                            "supported": false,
                            "reason": "当前部署不是 git 仓库，无法自动更新",
                        }));
                    };
                    if !root.join(".git").exists() {
                        return Ok(json!({
                            "supported": false,
                            "reason": "当前部署不是 git 仓库，无法自动更新",
                        }));
                    }
                    let branch = "main";
                    if git(&root, &["rev-parse", "--verify", "origin"]).is_none() {
                        return Ok(json!({
                            "supported": false,
                            "reason": "仓库未配置远端，无法自动更新",
                        }));
                    }
                    let current = git(&root, &["rev-parse", "--short", "HEAD"]);
                    if git(&root, &["fetch", "origin", branch]).is_none() {
                        return Ok(json!({
                            "supported": true,
                            "reason": "拉取远端失败，请检查网络或凭据",
                            "current": current,
                            "branch": branch,
                        }));
                    }
                    let remote = format!("origin/{branch}");
                    let target = git(&root, &["rev-parse", "--short", &remote]);
                    let behind = git(&root, &["rev-list", "--count", &format!("HEAD..{remote}")])
                        .and_then(|raw| raw.parse::<i64>().ok())
                        .unwrap_or(0);
                    let dirty = git(&root, &["status", "--porcelain"])
                        .map(|raw| !raw.is_empty())
                        .unwrap_or(false);
                    let commits: Vec<String> = if dirty {
                        Vec::new()
                    } else {
                        git(
                            &root,
                            &["log", "--oneline", "--no-decorate", &format!("HEAD..{remote}")],
                        )
                        .unwrap_or_default()
                        .lines()
                        .map(|line| line.trim().to_string())
                        .filter(|line| !line.is_empty())
                        .take(20)
                        .collect()
                    };
                    Ok(json!({
                        "supported": true,
                        "current": current,
                        "target": target,
                        "branch": branch,
                        "behind": behind,
                        "dirty": dirty,
                        "commits": commits,
                    }))
                }
            }),
        );
    }

    {
        let status_file = status_file.clone();
        registry.add(
            "admin.update.status",
            handler(move |state, conn, _params| {
                let status_file = status_file.clone();
                async move {
                    crate::plugins::auth::require_admin(&state, &conn).await?;
                    let value = status_file
                        .as_ref()
                        .and_then(|file| read_status(file))
                        .unwrap_or(Value::Null);
                    Ok(value)
                }
            }),
        );
    }

    {
        let repo = repo.clone();
        let status_file = status_file.clone();
        let script_file = script_file.clone();
        registry.add(
            "admin.update.apply",
            handler(move |state, conn, _params| {
                let repo = repo.clone();
                let status_file = status_file.clone();
                let script_file = script_file.clone();
                async move {
                    let admin = crate::plugins::auth::require_admin(&state, &conn).await?;
                    let Some(root) = repo else {
                        return Err("当前部署不是 git 仓库，无法自动更新".to_string());
                    };
                    if !root.join(".git").exists() {
                        return Err("当前部署不是 git 仓库，无法自动更新".to_string());
                    }
                    let Some(script) = script_file else {
                        return Err("缺少更新脚本 scripts/self-update.sh".to_string());
                    };
                    if !script.exists() {
                        return Err("缺少更新脚本 scripts/self-update.sh".to_string());
                    }
                    if let Some(last) = status_file.as_ref().and_then(|file| read_status(file)) {
                        let phase = last.get("phase").and_then(|value| value.as_str()).unwrap_or("");
                        let time = last.get("time").and_then(|value| value.as_i64()).unwrap_or(0);
                        let now = util::now_ms() / 1000;
                        if now - time < 60 && phase != "error" && phase != "done" {
                            return Err("更新正在进行中，请稍候".to_string());
                        }
                    }
                    let dirty = git(&root, &["status", "--porcelain"])
                        .map(|raw| !raw.is_empty())
                        .unwrap_or(false);
                    if dirty {
                        return Err("工作区有未提交的改动，请先处理后重试".to_string());
                    }
                    let mut command = Command::new("bash");
                    command
                        .arg(&script)
                        .current_dir(&root)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .env("PLUGIM_REPO", &root)
                        .env(
                            "PLUGIM_STATUS",
                            status_file.clone().unwrap_or_else(|| root.join("data/update-status.json")),
                        )
                        .env("PLUGIM_BRANCH", "main")
                        .env("PLUGIM_PID", std::process::id().to_string());
                    command
                        .spawn()
                        .map_err(|err| format!("启动更新脚本失败: {err}"))?;
                    store::audit(
                        &state.db,
                        Some(&admin.id),
                        &admin.username,
                        "admin.update",
                        "触发一键更新",
                    )
                    .await?;
                    state
                        .hub
                        .broadcast(
                            "system:maintenance",
                            json!({ "active": true, "message": "系统正在升级，请稍候…" }),
                        )
                        .await;
                    Ok(json!({ "started": true }))
                }
            }),
        );
    }
}
