import type { Context } from "@plugim/core";
import { useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { UiService } from "./ui-types";

export const uiForcedPasswordSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");
    const rpc = ctx.get<RpcService>("rpc");

    const ForcedPasswordDialog = () => {
        const user = useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.user(),
        );
        const [oldPassword, setOldPassword] = useState("");
        const [newPassword, setNewPassword] = useState("");
        const [confirm, setConfirm] = useState("");
        const [error, setError] = useState("");
        const [busy, setBusy] = useState(false);

        if (!user?.mustChangePassword) return null;

        const submit = async () => {
            if (busy) return;
            if (newPassword.length < 6) {
                setError("新密码至少需要 6 位");
                return;
            }
            if (newPassword !== confirm) {
                setError("两次输入的新密码不一致");
                return;
            }
            if (newPassword === oldPassword) {
                setError("新密码不能与原密码相同");
                return;
            }
            setBusy(true);
            setError("");
            try {
                const result = (await rpc.call("auth.password", {
                    oldPassword,
                    newPassword,
                })) as { token: string };
                auth.setToken(result.token);
                await auth.refresh();
            } catch (err) {
                setError(err instanceof Error ? err.message : "修改失败");
            } finally {
                setBusy(false);
            }
        };

        return (
            <div
                className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/60 p-4"
                role="dialog"
                aria-modal="true"
                aria-label="请修改初始密码"
            >
                <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
                    <p className="text-base font-semibold">请修改初始密码</p>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                        首次登录需要设置新密码后才能继续使用。
                    </p>
                    <div className="mt-4 flex flex-col gap-2">
                        <Input
                            type="password"
                            value={oldPassword}
                            placeholder="当前密码（初始密码）"
                            autoComplete="current-password"
                            onChange={(e) => setOldPassword(e.target.value)}
                        />
                        <Input
                            type="password"
                            value={newPassword}
                            placeholder="新密码（至少 6 位）"
                            autoComplete="new-password"
                            onChange={(e) => setNewPassword(e.target.value)}
                        />
                        <Input
                            type="password"
                            value={confirm}
                            placeholder="确认新密码"
                            autoComplete="new-password"
                            onChange={(e) => setConfirm(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void submit();
                            }}
                        />
                    </div>
                    {error ? (
                        <p className="mt-2 text-xs text-red-500">{error}</p>
                    ) : null}
                    <Button
                        className="mt-4 w-full"
                        disabled={busy}
                        onClick={() => void submit()}
                    >
                        {busy ? "提交中…" : "确认修改"}
                    </Button>
                </div>
            </div>
        );
    };

    return ui.register("global-overlay", ForcedPasswordDialog, 0);
};
