import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@plugim/core";
import type { AccountsStore, AuditService, GatewayService } from "../types";
import { requireAdmin } from "./admin";

const here = dirname(fileURLToPath(import.meta.url));

const findRepoRoot = (): string | null => {
    for (const candidate of [
        process.env.PLUGIM_REPO,
        resolve(process.cwd()),
        resolve(here, "..", "..", ".."),
        resolve(here, "..", ".."),
    ]) {
        if (!candidate) continue;
        let dir = candidate;
        for (let i = 0; i < 6; i++) {
            if (existsSync(resolve(dir, ".git"))) return dir;
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return null;
};

export interface UpdateStatus {
    phase: string;
    message: string;
    current: string;
    target: string;
    time: number;
}

export const updatePlugin: Plugin = {
    name: "update",
    description: "后台一键更新",
    provides: ["update-rpc"],
    inject: ["gateway", "accounts", "audit"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const audit = ctx.get<AuditService>("audit");

        const git = (repo: string, args: string[]): string | null => {
            try {
                return execFileSync("git", args, {
                    cwd: repo,
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "ignore"],
                    timeout: 20_000,
                }).trim();
            } catch (err) {
                ctx.log.warn(
                    `git ${args[0]} failed in ${repo}: ${String(err)}`,
                );
                return null;
            }
        };

        const repo = findRepoRoot();
        const statusFile = repo
            ? resolve(repo, "data", "update-status.json")
            : "";
        const scriptFile = repo
            ? resolve(repo, "scripts", "self-update.sh")
            : "";

        const readStatus = (): UpdateStatus | null => {
            if (!statusFile || !existsSync(statusFile)) return null;
            try {
                return JSON.parse(
                    readFileSync(statusFile, "utf8"),
                ) as UpdateStatus;
            } catch {
                return null;
            }
        };

        gateway.rpc("admin.update.check", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            if (!repo || !existsSync(resolve(repo, ".git"))) {
                return {
                    supported: false,
                    reason: "当前部署不是 git 仓库，无法自动更新",
                };
            }
            const branch = "main";
            if (!git(repo, ["rev-parse", "--verify", "origin"])) {
                return {
                    supported: false,
                    reason: "仓库未配置远端，无法自动更新",
                };
            }
            const current = git(repo, ["rev-parse", "--short", "HEAD"]);
            if (git(repo, ["fetch", "origin", branch]) === null) {
                return {
                    supported: true,
                    reason: "拉取远端失败，请检查网络或凭据",
                    current,
                    branch,
                };
            }
            const target = git(repo, [
                "rev-parse",
                "--short",
                `origin/${branch}`,
            ]);
            const behind = Number(
                git(repo, ["rev-list", "--count", `HEAD..origin/${branch}`]),
            );
            const dirty =
                (git(repo, ["status", "--porcelain"]) ?? "").length > 0;
            const log = dirty
                ? []
                : (
                      git(repo, [
                          "log",
                          "--oneline",
                          "--no-decorate",
                          `HEAD..origin/${branch}`,
                      ]) ?? ""
                  )
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
                      .slice(0, 20);
            return {
                supported: true,
                current,
                target,
                branch,
                behind: Number.isFinite(behind) ? behind : 0,
                dirty,
                commits: log,
            };
        });

        gateway.rpc("admin.update.status", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            return readStatus();
        });

        gateway.rpc("admin.update.apply", async (_raw, conn) => {
            const me = await requireAdmin(conn, accounts);
            if (!repo || !existsSync(resolve(repo, ".git")))
                throw new Error("当前部署不是 git 仓库，无法自动更新");
            if (!scriptFile || !existsSync(scriptFile))
                throw new Error("缺少更新脚本 scripts/self-update.sh");
            const last = readStatus();
            if (
                last &&
                Date.now() / 1000 - last.time < 60 &&
                last.phase !== "error" &&
                last.phase !== "done"
            )
                throw new Error("更新正在进行中，请稍候");

            const dirty =
                (git(repo, ["status", "--porcelain"]) ?? "").length > 0;
            if (dirty) throw new Error("工作区有未提交的改动，请先处理后重试");

            const child = spawn("bash", [scriptFile], {
                cwd: repo,
                detached: true,
                stdio: "ignore",
                env: {
                    ...process.env,
                    PLUGIM_REPO: repo,
                    PLUGIM_STATUS: statusFile,
                    PLUGIM_BRANCH: "main",
                    PLUGIM_PID: String(process.pid),
                },
            });
            child.unref();
            await audit.log({
                actorId: me.id,
                actor: me.username,
                action: "admin.update",
                detail: "触发一键更新",
            });
            gateway.broadcast("system:maintenance", {
                active: true,
                message: "系统正在升级，请稍候…",
            });
            return { started: true };
        });
        return undefined;
    },
};
