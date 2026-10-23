#!/usr/bin/env bash
set -uo pipefail

REPO="${PLUGIM_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATUS="${PLUGIM_STATUS:-$REPO/data/update-status.json}"
BRANCH="${PLUGIM_BRANCH:-main}"
PID="${PLUGIM_PID:-0}"
ENTRY="${PLUGIM_ENTRY:-apps/server/target/release/plugim-server}"
LOG="${PLUGIM_UPDATE_LOG:-$REPO/data/update.log}"

mkdir -p "$(dirname "$STATUS")" "$(dirname "$LOG")"

stage=""
started=0

write_status() {
    local phase="$1" message="$2" current="${3:-}" target="${4:-}"
    printf '{"phase":"%s","message":"%s","current":"%s","target":"%s","time":%s}\n' \
        "$phase" "$message" "$current" "$target" "$(date +%s)" >"$STATUS"
}

log() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"
}

fail() {
    log "FAILED: $*"
    write_status "error" "$*"
    exit 1
}

run() {
    started=$((started + 1))
    log "run ($started): $*"
    if ! "$@" >>"$LOG" 2>&1; then
        return 1
    fi
    return 0
}

wait_for_exit() {
    local target="$1" waited=0
    while kill -0 "$target" 2>/dev/null; do
        if [ "$waited" -ge 200 ]; then
            log "process $target still alive after 20s, sending SIGKILL"
            kill -KILL "$target" 2>/dev/null
            sleep 1
            return 1
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    return 0
}

cd "$REPO" || fail "仓库目录不存在：$REPO"

OLD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
write_status "fetching" "正在获取远端最新提交…" "$OLD_COMMIT"

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    fail "工作区有未提交的改动，已中止更新，请先处理后重试"
fi

if ! command -v git >/dev/null 2>&1; then
    fail "未找到 git 命令，无法自动更新"
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
    fail "当前不是 git 仓库，无法自动更新"
fi

if ! run git fetch origin "$BRANCH"; then
    fail "拉取远端失败，请检查网络或仓库凭据"
fi

TARGET_COMMIT="$(git rev-parse --short "origin/$BRANCH" 2>/dev/null || echo unknown)"
if [ "$OLD_COMMIT" = "$TARGET_COMMIT" ]; then
    log "already up to date at $OLD_COMMIT"
    write_status "done" "已是最新版本" "$OLD_COMMIT" "$TARGET_COMMIT"
    exit 0
fi

write_status "pulling" "正在更新到 $TARGET_COMMIT…" "$OLD_COMMIT" "$TARGET_COMMIT"

if ! run git merge --ff-only "origin/$BRANCH"; then
    fail "本地分支与远端已分叉，无法自动合并，请手动处理"
fi

write_status "installing" "正在安装依赖…" "$OLD_COMMIT" "$TARGET_COMMIT"

PKG_MGR=pnpm
command -v pnpm >/dev/null 2>&1 || PKG_MGR=npm

if [ "$PKG_MGR" = "npm" ]; then
    run npm install --no-audit --no-fund || fail "依赖安装失败"
else
    run pnpm install --frozen-lockfile --prefer-offline || run pnpm install --prefer-offline || fail "依赖安装失败"
fi

write_status "building" "正在构建前端与服务端…" "$OLD_COMMIT" "$TARGET_COMMIT"

if [ -f "$REPO/apps/server/Cargo.toml" ] && ! command -v cargo >/dev/null 2>&1; then
    fail "未找到 cargo 命令，无法构建 Rust 服务端，请先安装 Rust 工具链"
fi

if [ "$PKG_MGR" = "npm" ]; then
    run npm run build || BUILD_FAILED=1
else
    run pnpm run build || BUILD_FAILED=1
fi

if [ "${BUILD_FAILED:-0}" = "1" ]; then
    log "build failed, rolling back to $OLD_COMMIT"
    git checkout --force "$OLD_COMMIT" >>"$LOG" 2>&1
    if [ "$PKG_MGR" = "npm" ]; then
        npm install --no-audit --no-fund >>"$LOG" 2>&1
        npm run build >>"$LOG" 2>&1 || log "rollback build failed, artifacts may be inconsistent"
    else
        run pnpm install --prefer-offline
        run pnpm run build || log "rollback build failed, artifacts may be inconsistent"
    fi
    fail "构建失败，已回滚到原版本 $OLD_COMMIT，请查看 $LOG"
fi

write_status "restarting" "构建完成，正在重启服务…" "$OLD_COMMIT" "$TARGET_COMMIT"

if [ "$PID" -gt 0 ] 2>/dev/null && kill -0 "$PID" 2>/dev/null; then
    PM2_HOME_DIR="${PM2_HOME:-$HOME/.pm2}"
    MANAGED_BY=""
    if command -v pm2 >/dev/null 2>&1 && pm2 describe plugim >/dev/null 2>&1; then
        MANAGED_BY=pm2
    elif command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service --all 2>/dev/null | grep -q 'plugim.service'; then
        MANAGED_BY=systemd
    fi

    if [ "$MANAGED_BY" = "pm2" ]; then
        pm2 restart plugim --update-env >>"$LOG" 2>&1 || log "pm2 restart failed, falling back to signal"
    elif [ "$MANAGED_BY" = "systemd" ]; then
        systemctl restart plugim.service >>"$LOG" 2>&1 || log "systemctl restart failed, falling back to signal"
    else
        log "no process manager detected, sending SIGTERM to $PID"
        kill -TERM "$PID" 2>/dev/null
        wait_for_exit "$PID"
        nohup "$REPO/$ENTRY" >>"$LOG" 2>&1 &
        disown 2>/dev/null || true
    fi
    log "restart dispatched (manager=$MANAGED_BY)"
else
    log "server process $PID not running, starting directly"
    nohup "$REPO/$ENTRY" >>"$LOG" 2>&1 &
    disown 2>/dev/null || true
fi

write_status "done" "更新完成，已升级到 $TARGET_COMMIT" "$TARGET_COMMIT" "$TARGET_COMMIT"
log "update finished: $OLD_COMMIT -> $TARGET_COMMIT"
exit 0
