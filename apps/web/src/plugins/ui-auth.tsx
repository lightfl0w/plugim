import type { Context } from "@plugim/core";
import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
} from "../components/ui/card";
import {
    Field,
    FieldError,
    FieldGroup,
    FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import type { AuthService, RegisterPolicy } from "./auth";
import type { UiService } from "./ui-types";

export const uiAuthSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");

    const AuthCard = () => {
        const [mode, setMode] = useState<"login" | "register">("login");
        const [username, setUsername] = useState("");
        const [password, setPassword] = useState("");
        const [inviteCode, setInviteCode] = useState("");
        const [error, setError] = useState("");
        const [busy, setBusy] = useState(false);
        const [policy, setPolicy] = useState<RegisterPolicy | null>(null);

        useEffect(() => {
            let alive = true;
            void auth
                .registerPolicy()
                .then((next) => {
                    if (alive) setPolicy(next);
                })
                .catch(() => {
                    if (alive) setPolicy({ requireInvite: false, open: true });
                });
            return () => {
                alive = false;
            };
        }, []);

        const needInvite =
            mode === "register" && policy?.requireInvite === true;
        const registerClosed =
            mode === "register" &&
            policy !== null &&
            !policy.open &&
            !needInvite;

        const submit = async () => {
            if (busy) return;
            setBusy(true);
            setError("");
            try {
                if (mode === "login") await auth.login(username, password);
                else
                    await auth.register(
                        username,
                        password,
                        inviteCode.trim() || undefined,
                    );
            } catch (err) {
                setError(err instanceof Error ? err.message : "failed");
            } finally {
                setBusy(false);
            }
        };

        return (
            <Card className="w-full">
                <CardHeader className="flex-row items-center justify-between">
                    <span className="text-lg font-semibold">Plugim</span>
                    <Badge variant="secondary">
                        {mode === "login" ? "登录" : "注册"}
                    </Badge>
                </CardHeader>
                <CardContent>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            void submit();
                        }}
                    >
                        <FieldGroup>
                            <Field>
                                <FieldLabel htmlFor="auth-username">
                                    用户名
                                </FieldLabel>
                                <Input
                                    id="auth-username"
                                    placeholder="a-z 0-9 _"
                                    autoComplete="username"
                                    value={username}
                                    onChange={(e) =>
                                        setUsername(e.target.value)
                                    }
                                />
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="auth-password">
                                    密码
                                </FieldLabel>
                                <Input
                                    id="auth-password"
                                    type="password"
                                    placeholder="至少 6 位"
                                    autoComplete={
                                        mode === "login"
                                            ? "current-password"
                                            : "new-password"
                                    }
                                    value={password}
                                    onChange={(e) =>
                                        setPassword(e.target.value)
                                    }
                                />
                                {error ? (
                                    <FieldError>{error}</FieldError>
                                ) : null}
                            </Field>
                            {needInvite ? (
                                <Field>
                                    <FieldLabel htmlFor="auth-invite">
                                        邀请码
                                    </FieldLabel>
                                    <Input
                                        id="auth-invite"
                                        placeholder="请输入管理员提供的邀请码"
                                        value={inviteCode}
                                        onChange={(e) =>
                                            setInviteCode(e.target.value)
                                        }
                                    />
                                </Field>
                            ) : null}
                            {registerClosed ? (
                                <FieldError>
                                    该服务器已关闭注册，请联系管理员开通账号
                                </FieldError>
                            ) : null}
                            <Button
                                type="submit"
                                className="w-full"
                                disabled={
                                    busy ||
                                    registerClosed ||
                                    !username.trim() ||
                                    password.length < 6 ||
                                    (needInvite && !inviteCode.trim())
                                }
                            >
                                {mode === "login" ? "登录" : "注册"}
                            </Button>
                        </FieldGroup>
                    </form>
                </CardContent>
                <CardFooter className="justify-center">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            setMode(mode === "login" ? "register" : "login");
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

    return ui.register("auth", AuthCard);
};
