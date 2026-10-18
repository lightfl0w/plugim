import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { Plugin } from "@plugim/core";
import type {
    AuthSessionsResult,
    AuthSuccess,
    PresenceStatus,
    TotpSetup,
    User,
} from "@plugim/protocol";
import { jwtVerify, SignJWT } from "jose";
import type {
    AccountsStore,
    AuditService,
    AuthSessionsStore,
    AuthUser,
    ConnInfo,
    DepartmentsStore,
    GatewayService,
    SettingsStore,
} from "../types";
import type { AppConfig } from "./config";

export const USERNAME_RE = /^[a-z0-9_]{2,24}$/;
const TOKEN_TTL = "30d";
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const unauthorized = (): Error => new Error("未登录或登录已过期");

const base32Encode = (raw: Buffer): string => {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of raw) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
};

const base32Decode = (input: string): Buffer => {
    const clean = input
        .toUpperCase()
        .replace(/=+$/, "")
        .replace(/[^A-Z2-7]/g, "");
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const char of clean) {
        const index = B32_ALPHABET.indexOf(char);
        if (index < 0) continue;
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
};

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpAt = (secret: string, counter: number): string => {
    const key = base32Decode(secret);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac("sha1", key).update(buf).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const code =
        (((digest[offset] & 0x7f) << 24) |
            ((digest[offset + 1] & 0xff) << 16) |
            ((digest[offset + 2] & 0xff) << 8) |
            (digest[offset + 3] & 0xff)) %
        10 ** TOTP_DIGITS;
    return code.toString().padStart(TOTP_DIGITS, "0");
};

export const verifyTotp = (
    secret: string,
    code: string,
    now: number = Date.now(),
): boolean => {
    const value = String(code ?? "").trim();
    if (!/^\d{6}$/.test(value)) return false;
    const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
    for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
        const expected = totpAt(secret, counter + drift);
        const a = Buffer.from(expected);
        const b = Buffer.from(value);
        if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    return false;
};

export const deviceLabelOf = (userAgent: string): string => {
    const ua = String(userAgent ?? "").trim();
    if (!ua) return "未知设备";
    const browser = /Edg\//.test(ua)
        ? "Edge"
        : /OPR\//.test(ua)
          ? "Opera"
          : /Firefox\//.test(ua)
            ? "Firefox"
            : /Chrome\//.test(ua)
              ? "Chrome"
              : /Safari\//.test(ua)
                ? "Safari"
                : /curl\//.test(ua)
                  ? "curl"
                  : /node/i.test(ua)
                    ? "Node"
                    : "浏览器";
    const os = /Windows/.test(ua)
        ? "Windows"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad|iOS/.test(ua)
            ? "iOS"
            : /Mac OS X/.test(ua)
              ? "macOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
    return os ? `${browser} · ${os}` : browser;
};

const toStatus = (raw: unknown): PresenceStatus =>
    raw === "busy" || raw === "away" || raw === "dnd" || raw === "invisible"
        ? raw
        : "online";

export const authPlugin: Plugin = {
    name: "auth",
    description: "注册登录",
    provides: ["auth"],
    inject: [
        "gateway",
        "store",
        "config",
        "settings",
        "audit",
        "departments",
        "authSessions",
    ],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const config = ctx.get<AppConfig>("config");
        const settings = ctx.get<SettingsStore>("settings");
        const audit = ctx.get<AuditService>("audit");
        const departments = ctx.get<DepartmentsStore>("departments");
        const authSessions = ctx.get<AuthSessionsStore>("authSessions");
        const secret = new TextEncoder().encode(config.jwtSecret);

        const loginAttempts = new Map<
            string,
            { count: number; resetAt: number }
        >();
        const loginLimited = (key: string): boolean => {
            const entry = loginAttempts.get(key);
            if (!entry) return false;
            if (Date.now() > entry.resetAt) {
                loginAttempts.delete(key);
                return false;
            }
            return entry.count >= LOGIN_MAX_ATTEMPTS;
        };
        const recordLoginFail = (key: string): void => {
            const now = Date.now();
            const entry = loginAttempts.get(key);
            if (!entry || now > entry.resetAt) {
                if (loginAttempts.size >= 10_000) loginAttempts.clear();
                loginAttempts.set(key, {
                    count: 1,
                    resetAt: now + LOGIN_WINDOW_MS,
                });
                return;
            }
            entry.count += 1;
        };

        const signToken = async (
            user: AuthUser,
            tokenVersion: number,
            sessionId?: string,
        ): Promise<string> =>
            new SignJWT({
                username: user.username,
                v: tokenVersion,
                sid: sessionId ?? null,
            })
                .setProtectedHeader({ alg: "HS256" })
                .setSubject(user.id)
                .setIssuedAt()
                .setExpirationTime(TOKEN_TTL)
                .sign(secret);

        const verifyToken = async (
            token: string | null,
        ): Promise<AuthUser | null> => {
            if (!token) return null;
            try {
                const { payload } = await jwtVerify(token, secret);
                const id = payload.sub;
                const username = payload.username;
                const version = payload.v;
                if (typeof id !== "string" || typeof username !== "string")
                    return null;
                const row = await accounts.fullById(id);
                if (!row || row.banned) return null;
                if (
                    (typeof version === "number" ? version : 0) !==
                    row.tokenVersion
                )
                    return null;
                const sessionId =
                    typeof payload.sid === "string" ? payload.sid : null;
                if (sessionId && !(await authSessions.isActive(id, sessionId)))
                    return null;
                return {
                    id,
                    username,
                    mustChange: row.mustChangePassword,
                    sessionId: sessionId ?? undefined,
                };
            } catch {
                return null;
            }
        };

        gateway.setAuthenticator(verifyToken);

        gateway.onConnect((user) => {
            if (!user.sessionId) return;
            void authSessions.touch(user.sessionId).catch(() => undefined);
        });

        const ensureBootstrapAdmin = async (username: string) => {
            if (!config.bootstrapAdmins.includes(username)) return;
            const row = await accounts.byUsername(username);
            if (row && !row.isAdmin)
                await accounts.setFlag(row.id, "isAdmin", true);
        };
        for (const name of config.bootstrapAdmins)
            void ensureBootstrapAdmin(name);

        const requireUser = (conn: ConnInfo): AuthUser => {
            if (!conn.user) throw unauthorized();
            return conn.user;
        };

        const issueSession = async (
            userId: string,
            username: string,
            tokenVersion: number,
            conn: ConnInfo,
        ): Promise<string> => {
            const userAgent = String(conn.userAgent ?? "").slice(0, 400);
            const ip = String(conn.ip ?? "").slice(0, 64);
            const id = randomBytes(18).toString("base64url");
            await authSessions.create({
                id,
                userId,
                label: deviceLabelOf(userAgent),
                userAgent,
                ip,
            });
            await audit.log({
                actorId: userId,
                actor: username,
                action: "auth.session.create",
                detail: deviceLabelOf(userAgent),
            });
            return signToken({ id: userId, username }, tokenVersion, id);
        };

        const toAuthSuccess = (user: User, token: string): AuthSuccess => ({
            token,
            user,
        });

        const registerPolicy = async () => {
            const rawInvite = await settings.get("invite_code");
            const rawAllow = await settings.get("allow_register");
            return {
                inviteCode:
                    rawInvite === null ? config.inviteCode : rawInvite.trim(),
                allowRegister:
                    rawAllow === null
                        ? config.allowRegister
                        : rawAllow !== "false",
            };
        };

        gateway.hono().get("/auth/register-policy", async (c) => {
            const policy = await registerPolicy();
            const hasUsers = (await accounts.count()) > 0;
            return c.json({
                requireInvite: hasUsers && Boolean(policy.inviteCode),
                open:
                    !hasUsers || !policy.inviteCode
                        ? policy.allowRegister
                        : false,
            });
        });

        gateway.rpc("auth.register", async (raw, conn) => {
            const params = raw as unknown as {
                username: string;
                password: string;
                inviteCode?: unknown;
            };
            const username = String(params.username ?? "")
                .trim()
                .toLowerCase();
            const password = String(params.password ?? "");
            if (!USERNAME_RE.test(username))
                throw new Error("用户名需为 2-24 位小写字母、数字或下划线");
            if (password.length < 6) throw new Error("密码至少需要 6 位");
            const hasUsers = (await accounts.count()) > 0;
            const policy = await registerPolicy();
            if (hasUsers) {
                if (policy.inviteCode) {
                    const invite = String(params.inviteCode ?? "").trim();
                    if (invite !== policy.inviteCode)
                        throw new Error("邀请码错误或未填写");
                } else if (!policy.allowRegister)
                    throw new Error("已关闭注册，请联系管理员");
            }
            if (await accounts.byUsername(username))
                throw new Error("用户名已被占用");
            const passwordHash = await hash(password);
            const user = await accounts.create(username, passwordHash);
            if (!hasUsers) await ensureBootstrapAdmin(username);
            await audit.log({
                actorId: user.id,
                actor: user.username,
                action: "auth.register",
            });
            return toAuthSuccess(
                user,
                await issueSession(user.id, user.username, 0, conn),
            );
        });

        gateway.rpc("auth.login", async (raw, conn) => {
            const params = raw as unknown as {
                username: string;
                password: string;
                totp?: unknown;
            };
            const username = String(params.username ?? "")
                .trim()
                .toLowerCase();
            if (loginLimited(username))
                throw new Error("尝试过于频繁，请一分钟后再试");
            const row = await accounts.byUsername(username);
            if (!row) {
                recordLoginFail(username);
                await audit.log({
                    actorId: null,
                    actor: username || "未知",
                    action: "auth.login.failed",
                    detail: "用户名不存在",
                });
                throw new Error("用户名或密码错误");
            }
            const ok = await verify(
                row.passwordHash,
                String(params.password ?? ""),
            ).catch(() => false);
            if (!ok) {
                recordLoginFail(username);
                await audit.log({
                    actorId: null,
                    actor: username,
                    action: "auth.login.failed",
                    detail: "密码错误",
                });
                throw new Error("用户名或密码错误");
            }
            if (row.banned) {
                await audit.log({
                    actorId: row.id,
                    actor: username,
                    action: "auth.login.failed",
                    detail: "账号已封禁",
                });
                throw new Error("账号已被封禁");
            }
            loginAttempts.delete(username);
            const secret = await accounts.totpOf(row.id);
            if (secret && !verifyTotp(secret, String(params.totp ?? ""))) {
                recordLoginFail(username);
                await audit.log({
                    actorId: row.id,
                    actor: username,
                    action: "auth.login.failed",
                    detail: "动态口令错误",
                });
                throw new Error("动态口令错误或已失效");
            }
            const user: User = {
                id: row.id,
                username: row.username,
                createdAt: row.createdAt,
                deptId: row.deptId,
                title: row.title,
                mustChangePassword: row.mustChangePassword,
            };
            await audit.log({
                actorId: row.id,
                actor: username,
                action: "auth.login",
            });
            return toAuthSuccess(
                user,
                await issueSession(
                    row.id,
                    row.username,
                    row.tokenVersion,
                    conn,
                ),
            );
        });

        gateway.rpc("auth.password", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as {
                oldPassword?: unknown;
                newPassword?: unknown;
            };
            const oldPassword = String(params.oldPassword ?? "");
            const newPassword = String(params.newPassword ?? "");
            if (newPassword.length < 6) throw new Error("新密码至少需要 6 位");
            if (newPassword === oldPassword)
                throw new Error("新密码不能与原密码相同");
            const row = await accounts.fullById(user.id);
            if (!row) throw new Error(unauthorized().message);
            const ok = await verify(row.passwordHash, oldPassword).catch(
                () => false,
            );
            if (!ok) throw new Error("原密码不正确");
            const passwordHash = await hash(newPassword);
            const version = await accounts.setPassword(user.id, passwordHash);
            await accounts.setMustChange(user.id, false);
            await audit.log({
                actorId: row.id,
                actor: row.username,
                action: "auth.password",
            });
            setTimeout(() => gateway.kickUser(user.id), 1000);
            const sessionId = user.sessionId;
            if (sessionId) {
                await authSessions.revoke(user.id, sessionId);
                return {
                    token: await issueSession(
                        row.id,
                        row.username,
                        version,
                        conn,
                    ),
                };
            }
            return { token: await signToken(row, version) };
        });

        gateway.rpc("auth.sessions", async (_raw, conn) => {
            const user = requireUser(conn);
            const rows = await authSessions.list(user.id);
            const result: AuthSessionsResult = {
                devices: rows
                    .filter((row) => !row.revoked)
                    .map((row) => ({
                        id: row.id,
                        label: row.label,
                        userAgent: row.userAgent,
                        ip: row.ip,
                        createdAt: row.createdAt,
                        lastSeenAt: row.lastSeenAt,
                        current: row.id === user.sessionId,
                    })),
                totpEnabled: Boolean(await accounts.totpOf(user.id)),
            };
            return result;
        });

        gateway.rpc("auth.session.rename", async (raw, conn) => {
            const user = requireUser(conn);
            const { id, label } = raw as unknown as {
                id?: unknown;
                label?: unknown;
            };
            const target = String(id ?? "").trim();
            const name = String(label ?? "")
                .trim()
                .slice(0, 60);
            if (!target) throw new Error("缺少设备");
            if (!name) throw new Error("设备名称不能为空");
            if (!(await authSessions.rename(user.id, target, name)))
                throw new Error("设备不存在");
            return { ok: true };
        });

        gateway.rpc("auth.session.revoke", async (raw, conn) => {
            const user = requireUser(conn);
            const { id } = raw as unknown as { id?: unknown };
            const target = String(id ?? "").trim();
            if (!target) throw new Error("缺少设备");
            if (target === user.sessionId)
                throw new Error("不能下线当前设备，请使用「下线其他设备」");
            if (!(await authSessions.revoke(user.id, target)))
                throw new Error("设备不存在");
            await audit.log({
                actorId: user.id,
                actor: user.username,
                action: "auth.session.revoke",
            });
            gateway.kickSession(target);
            return { ok: true };
        });

        gateway.rpc("auth.sessions.revokeOthers", async (_raw, conn) => {
            const user = requireUser(conn);
            if (!user.sessionId) throw new Error("当前会话未绑定设备");
            const others = (await authSessions.list(user.id)).filter(
                (row) => !row.revoked && row.id !== user.sessionId,
            );
            const revoked = await authSessions.revokeOthers(
                user.id,
                user.sessionId,
            );
            for (const row of others) gateway.kickSession(row.id);
            await audit.log({
                actorId: user.id,
                actor: user.username,
                action: "auth.sessions.revokeOthers",
                detail: `${revoked} 台`,
            });
            return { revoked };
        });

        gateway.rpc("auth.totp.enable", async (raw, conn) => {
            const user = requireUser(conn);
            const { code } = raw as unknown as { code?: unknown };
            const pendingKey = `totp:pending:${user.id}`;
            const pending = await settings.get(pendingKey);
            if (!pending) throw new Error("请先生成密钥");
            if (!verifyTotp(pending, String(code ?? "")))
                throw new Error("动态口令不正确");
            await accounts.setTotp(user.id, pending);
            await settings.set(pendingKey, "");
            await audit.log({
                actorId: user.id,
                actor: user.username,
                action: "auth.totp.enable",
            });
            return { totpEnabled: true };
        });

        gateway.rpc("auth.totp.setup", async (_raw, conn) => {
            const user = requireUser(conn);
            if (await accounts.totpOf(user.id))
                throw new Error("动态口令已开启");
            const secret = generateTotpSecret();
            await settings.set(`totp:pending:${user.id}`, secret);
            const issuer = encodeURIComponent("plugim");
            const label = encodeURIComponent(user.username);
            return {
                secret,
                otpauth: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`,
            } satisfies TotpSetup;
        });

        gateway.rpc("auth.totp.disable", async (raw, conn) => {
            const user = requireUser(conn);
            const { password } = raw as unknown as { password?: unknown };
            const row = await accounts.fullById(user.id);
            if (!row) throw new Error(unauthorized().message);
            const ok = await verify(
                row.passwordHash,
                String(password ?? ""),
            ).catch(() => false);
            if (!ok) throw new Error("密码不正确");
            await accounts.setTotp(user.id, null);
            await audit.log({
                actorId: user.id,
                actor: user.username,
                action: "auth.totp.disable",
            });
            return { totpEnabled: false };
        });

        gateway.rpc("auth.me", async (_raw, conn) => {
            const user = requireUser(conn);
            const row = await accounts.byId(user.id);
            return row ?? user;
        });

        gateway.rpc("presence.list", async (_raw, conn) => {
            requireUser(conn);
            const users = await accounts.byIds(gateway.onlineUserIds());
            const online: string[] = [];
            const statuses: Record<string, PresenceStatus> = {};
            for (const user of users) {
                const status = toStatus(
                    await settings.get(`presence:${user.id}`),
                );
                if (status === "invisible") continue;
                online.push(user.username);
                statuses[user.username] = status;
            }
            return { online, statuses };
        });

        gateway.rpc("presence.status", async (_raw, conn) => {
            const user = requireUser(conn);
            const status = toStatus(await settings.get(`presence:${user.id}`));
            return { status };
        });

        gateway.rpc("presence.status.set", async (raw, conn) => {
            const user = requireUser(conn);
            const status = toStatus((raw as { status?: unknown }).status);
            await settings.set(`presence:${user.id}`, status);
            if (status !== "invisible")
                gateway.broadcast("presence:update", {
                    username: user.username,
                    online: true,
                    status,
                });
            return { status };
        });

        gateway.rpc("user.info", async (raw, conn) => {
            requireUser(conn);
            const username = String(
                (raw as { username?: unknown }).username ?? "",
            )
                .trim()
                .toLowerCase();
            if (!username) throw new Error("缺少用户名");
            const row = await accounts.byUsername(username);
            if (!row) throw new Error("用户不存在");
            const dept = row.deptId ? await departments.byId(row.deptId) : null;
            return {
                username: row.username,
                createdAt: row.createdAt,
                deptId: row.deptId,
                title: row.title,
                deptName: dept?.name ?? null,
            };
        });

        ctx.provide("auth", {
            verifyToken,
            requireUser,
        });
        return undefined;
    },
};
