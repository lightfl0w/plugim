import type { Plugin } from "@plugim/core";
import { useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import type { AuthService } from "./auth";
import type { UiService } from "./shell";

export const uiAuthPlugin: Plugin = {
    name: "ui-auth",
    inject: ["ui", "auth"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");

        const AuthCard = () => {
            const [mode, setMode] = useState<"login" | "register">("login");
            const [username, setUsername] = useState("");
            const [password, setPassword] = useState("");
            const [error, setError] = useState("");
            const [busy, setBusy] = useState(false);

            const submit = async () => {
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                    if (mode === "login") await auth.login(username, password);
                    else await auth.register(username, password);
                } catch (err) {
                    setError(err instanceof Error ? err.message : "failed");
                } finally {
                    setBusy(false);
                }
            };

            return (
                <Card className="w-full">
                    <CardHeader className="flex-row items-center justify-between border-b border-border">
                        <span className="text-sm font-semibold">Plugim</span>
                        <Badge variant="secondary">
                            {mode === "login" ? "登录" : "注册"}
                        </Badge>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3 p-6">
                        <Input
                            placeholder="用户名（a-z 0-9 _）"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                        />
                        <Input
                            type="password"
                            placeholder="密码（至少 6 位）"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void submit();
                            }}
                        />
                        {error ? (
                            <p className="text-xs text-red-500">{error}</p>
                        ) : null}
                    </CardContent>
                    <CardFooter className="flex-col gap-2 border-t border-border py-4">
                        <Button
                            className="w-full"
                            disabled={
                                busy || !username.trim() || password.length < 6
                            }
                            onClick={() => void submit()}
                        >
                            {mode === "login" ? "登录" : "注册"}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                setMode(
                                    mode === "login" ? "register" : "login",
                                );
                                setError("");
                            }}
                        >
                            {mode === "login"
                                ? "没有账号？去注册"
                                : "已有账号？去登录"}
                        </Button>
                    </CardFooter>
                </Card>
            );
        };

        ui.register("auth", AuthCard);
        return undefined;
    },
};
