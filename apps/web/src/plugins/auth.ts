import type { Plugin } from "@plugim/core";
import type { AuthSuccess, User } from "@plugim/protocol";

const TOKEN_KEY = "plugim_token";

export interface AuthService {
    token(): string | null;
    user(): User | null;
    login(username: string, password: string): Promise<User>;
    register(username: string, password: string): Promise<User>;
    logout(): void;
    onChange(cb: () => void): () => void;
}

interface AuthResponse {
    ok: boolean;
    result?: AuthSuccess;
    message?: string;
}

const callAuthRpc = async (
    method: string,
    params: Record<string, string>,
): Promise<AuthSuccess> => {
    const res = await fetch(`/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params }),
    });
    const body = (await res.json()) as AuthResponse;
    if (!body.ok || !body.result)
        throw new Error(body.message ?? "request failed");
    return body.result;
};

export const authPlugin: Plugin = {
    name: "auth",
    description: "登录注册与本地会话",
    core: true,
    provides: ["auth"],
    async apply(ctx) {
        let currentToken = localStorage.getItem(TOKEN_KEY);
        let currentUser: User | null = null;
        const listeners = new Set<() => void>();

        const notify = () => {
            for (const cb of listeners) cb();
        };

        const restore = async () => {
            if (!currentToken) return;
            try {
                const res = await fetch("/rpc/auth.me", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        authorization: `Bearer ${currentToken}`,
                    },
                    body: JSON.stringify({ params: {} }),
                });
                const body = (await res.json()) as {
                    ok: boolean;
                    result?: {
                        id: string;
                        username: string;
                        createdAt: string;
                    };
                    message?: string;
                };
                if (body.ok && body.result) {
                    currentUser = body.result;
                    notify();
                } else {
                    localStorage.removeItem(TOKEN_KEY);
                    currentToken = null;
                }
            } catch {
                void 0;
            }
        };

        ctx.provide<AuthService>("auth", {
            token: () => currentToken,
            user: () => currentUser,
            async login(username, password) {
                const success = await callAuthRpc("auth.login", {
                    username,
                    password,
                });
                currentToken = success.token;
                currentUser = success.user;
                localStorage.setItem(TOKEN_KEY, currentToken);
                notify();
                return success.user;
            },
            async register(username, password) {
                const success = await callAuthRpc("auth.register", {
                    username,
                    password,
                });
                currentToken = success.token;
                currentUser = success.user;
                localStorage.setItem(TOKEN_KEY, currentToken);
                notify();
                return success.user;
            },
            logout() {
                currentToken = null;
                currentUser = null;
                localStorage.removeItem(TOKEN_KEY);
                notify();
            },
            onChange(cb) {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
        });

        void restore();
        return undefined;
    },
};
