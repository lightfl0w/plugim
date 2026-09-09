import { hash, verify } from "@node-rs/argon2";
import type { Plugin } from "@plugim/core";
import type { AuthSuccess, User } from "@plugim/protocol";
import { jwtVerify, SignJWT } from "jose";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    GatewayService,
} from "../types";
import type { AppConfig } from "./config";

const USERNAME_RE = /^[a-z0-9_]{2,24}$/;
const TOKEN_TTL = "30d";

const unauthorized = (): Error => new Error("未登录或登录已过期");

export const authPlugin: Plugin = {
    name: "auth",
    description: "注册登录",
    provides: ["auth"],
    inject: ["gateway", "store", "config"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const config = ctx.get<AppConfig>("config");
        const secret = new TextEncoder().encode(config.jwtSecret);

        const signToken = async (user: AuthUser): Promise<string> =>
            new SignJWT({ username: user.username })
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
                if (typeof id !== "string" || typeof username !== "string")
                    return null;
                return { id, username };
            } catch {
                return null;
            }
        };

        gateway.setAuthenticator(verifyToken);

        const requireUser = (conn: ConnInfo): AuthUser => {
            if (!conn.user) throw unauthorized();
            return conn.user;
        };

        const toAuthSuccess = (user: User, token: string): AuthSuccess => ({
            token,
            user,
        });

        gateway.rpc("auth.register", async (raw) => {
            const params = raw as unknown as {
                username: string;
                password: string;
            };
            const username = String(params.username ?? "")
                .trim()
                .toLowerCase();
            const password = String(params.password ?? "");
            if (!USERNAME_RE.test(username))
                throw new Error("用户名需为 2-24 位小写字母、数字或下划线");
            if (password.length < 6) throw new Error("密码至少需要 6 位");
            if (await accounts.byUsername(username))
                throw new Error("用户名已被占用");
            const passwordHash = await hash(password);
            const user = await accounts.create(username, passwordHash);
            return toAuthSuccess(user, await signToken(user));
        });

        gateway.rpc("auth.login", async (raw) => {
            const params = raw as unknown as {
                username: string;
                password: string;
            };
            const username = String(params.username ?? "")
                .trim()
                .toLowerCase();
            const row = await accounts.byUsername(username);
            if (!row) throw new Error("用户名或密码错误");
            const ok = await verify(
                row.passwordHash,
                String(params.password ?? ""),
            ).catch(() => false);
            if (!ok) throw new Error("用户名或密码错误");
            const user: User = {
                id: row.id,
                username: row.username,
                createdAt: row.createdAt,
            };
            return toAuthSuccess(user, await signToken(user));
        });

        gateway.rpc("auth.me", async (_raw, conn) => requireUser(conn));

        ctx.provide("auth", {
            verifyToken,
            requireUser,
        });
        return undefined;
    },
};
