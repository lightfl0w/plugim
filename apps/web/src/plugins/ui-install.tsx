import type { Context } from "@plugim/core";
import {
    CheckCircle2Icon,
    DatabaseIcon,
    KeyRoundIcon,
    ShieldCheckIcon,
    UserRoundIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import {
    Field,
    FieldError,
    FieldGroup,
    FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { UiService } from "./ui-types";

export interface InstallStatus {
    installed: boolean;
    hasUsers: boolean;
    dbDriver: string;
    dbFile: string;
    databaseUrlSet: boolean;
    logDir: string;
    allowRegister: boolean;
    inviteRequired: boolean;
}

export interface DbOptions {
    dbDriver: "sqlite" | "postgres";
    dbFile: string;
    databaseUrl: string;
    logDir: string;
}

export interface InstallService {
    status(): InstallStatus | null;
    loading(): boolean;
    reload(): Promise<InstallStatus | null>;
    testDb(opts: DbOptions): Promise<void>;
    saveDb(opts: DbOptions): Promise<void>;
    finish(opts: {
        allowRegister: boolean;
        inviteCode?: string;
    }): Promise<void>;
    onChange(cb: () => void): () => void;
}

interface RpcResponse {
    ok: boolean;
    result?: unknown;
    message?: string;
}

const callInstallRpc = async (
    method: string,
    params: Record<string, unknown>,
): Promise<unknown> => {
    const res = await fetch(`/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params }),
    });
    const body = (await res.json()) as RpcResponse;
    if (!body.ok) throw new Error(body.message ?? "request failed");
    return body.result;
};

const POLICY_OPTIONS = [
    { value: "open", label: "开放注册", hint: "任何人都可以注册新账号" },
    { value: "invite", label: "邀请码注册", hint: "注册必须填写正确邀请码" },
    { value: "closed", label: "关闭注册", hint: "停止一切新账号注册" },
] as const;

type PolicyValue = (typeof POLICY_OPTIONS)[number]["value"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const staleGuard = async (
    err: unknown,
    reload: () => Promise<InstallStatus | null>,
): Promise<string> => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("完成初始化")) {
        await reload();
        return "系统已初始化，正在跳转登录页...";
    }
    return message;
};

export const uiInstallSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");

    let status: InstallStatus | null = null;
    let loading = true;
    const subs = new Set<() => void>();
    const notify = () => {
        for (const cb of subs) cb();
    };

    const reload = async (): Promise<InstallStatus | null> => {
        try {
            status = (await callInstallRpc(
                "install.status",
                {},
            )) as InstallStatus;
        } catch {
            status = null;
        }
        loading = false;
        notify();
        return status;
    };
    void reload();

    const finish = async (opts: {
        allowRegister: boolean;
        inviteCode?: string;
    }) => {
        await callInstallRpc("install.finish", {
            allowRegister: opts.allowRegister,
            ...(opts.inviteCode !== undefined
                ? { inviteCode: opts.inviteCode }
                : {}),
        });
        await reload();
    };

    ctx.provide<InstallService>("install", {
        status: () => status,
        loading: () => loading,
        reload,
        async testDb(opts) {
            await callInstallRpc("install.testdb", { ...opts });
        },
        async saveDb(opts) {
            await callInstallRpc("install.savedb", { ...opts });
        },
        finish,
        onChange(cb) {
            subs.add(cb);
            return () => subs.delete(cb);
        },
    });

    const useInstall = () =>
        useSyncExternalStore(
            (cb) => {
                subs.add(cb);
                return () => subs.delete(cb);
            },
            () => status,
        );

    const STEPS = ["数据库与日志", "创建管理员", "注册策略"];

    const InstallPage = () => {
        const s = useInstall();
        const navigate = useNavigate();
        const [step, setStep] = useState(0);
        const [driver, setDriver] = useState<"sqlite" | "postgres">("sqlite");
        const [dbFile, setDbFile] = useState("data/plugim.db");
        const [dbUrl, setDbUrl] = useState("");
        const [logDir, setLogDir] = useState("logs");
        const [testing, setTesting] = useState(false);
        const [restartNote, setRestartNote] = useState("");
        const [username, setUsername] = useState("");
        const [password, setPassword] = useState("");
        const [confirm, setConfirm] = useState("");
        const [policy, setPolicy] = useState<PolicyValue>("open");
        const [invite, setInvite] = useState("");
        const [error, setError] = useState("");
        const [busy, setBusy] = useState(false);
        const prefilled = useRef(false);

        useEffect(() => {
            if (s?.installed) navigate("/login", { replace: true });
        }, [s, navigate]);

        useEffect(() => {
            if (!s || prefilled.current) return;
            prefilled.current = true;
            if (s.dbDriver === "postgres" || s.dbDriver === "sqlite")
                setDriver(s.dbDriver);
            if (s.dbFile) setDbFile(s.dbFile);
            setLogDir(s.logDir ?? "");
        }, [s]);

        const dbOptions = (): DbOptions => ({
            dbDriver: driver,
            dbFile: dbFile.trim(),
            databaseUrl: dbUrl.trim(),
            logDir: logDir.trim(),
        });

        const runTest = async () => {
            setError("");
            setTesting(true);
            try {
                await ctx.get<InstallService>("install").testDb(dbOptions());
                setRestartNote("连接正常");
            } catch (err) {
                setRestartNote("");
                setError(await staleGuard(err, reload));
            } finally {
                setTesting(false);
            }
        };

        const runSaveAndRestart = async () => {
            setError("");
            setBusy(true);
            try {
                await ctx.get<InstallService>("install").saveDb(dbOptions());
                setRestartNote("配置已保存，服务器正在重启...");
                await sleep(1200);
                let back: InstallStatus | null = null;
                for (let i = 0; i < 40; i++) {
                    back = await reload();
                    if (back) break;
                    await sleep(700);
                }
                if (!back) throw new Error("服务器未能恢复，请查看服务端日志");
                setRestartNote("");
                setStep(back.hasUsers ? 2 : 1);
            } catch (err) {
                setRestartNote("");
                setError(await staleGuard(err, reload));
            } finally {
                setBusy(false);
            }
        };

        const submitAdmin = async () => {
            setError("");
            if (!/^[a-z0-9_]{2,24}$/.test(username.trim())) {
                setError("用户名需为 2-24 位小写字母、数字或下划线");
                return;
            }
            if (password.length < 6) {
                setError("密码至少需要 6 位");
                return;
            }
            if (password !== confirm) {
                setError("两次输入的密码不一致");
                return;
            }
            setBusy(true);
            try {
                await auth.register(username.trim(), password);
                setStep(2);
            } catch (err) {
                setError(err instanceof Error ? err.message : "创建失败");
            } finally {
                setBusy(false);
            }
        };

        const submitPolicy = async () => {
            setError("");
            if (policy === "invite" && !invite.trim()) {
                setError("请设置邀请码");
                return;
            }
            setBusy(true);
            try {
                await finish({
                    allowRegister: policy !== "closed",
                    inviteCode: policy === "invite" ? invite.trim() : undefined,
                });
                navigate("/chat", { replace: true });
            } catch (err) {
                setError(await staleGuard(err, reload));
            } finally {
                setBusy(false);
            }
        };

        const driverButton = (
            value: "sqlite" | "postgres",
            label: string,
            hint: string,
        ) => (
            <button
                type="button"
                onClick={() => setDriver(value)}
                className={cn(
                    "flex flex-1 flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left",
                    driver === value
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent/60",
                )}
            >
                <span className="text-sm font-medium">{label}</span>
                <span className="text-xs text-muted-foreground">{hint}</span>
            </button>
        );

        return (
            <div className="flex h-full items-center justify-center overflow-y-auto p-4">
                <Card className="w-full max-w-md">
                    <CardHeader className="flex-row items-center justify-between">
                        <span className="text-lg font-semibold">
                            Plugim 安装向导
                        </span>
                        <span className="text-xs text-muted-foreground">
                            第 {step + 1}/3 步：{STEPS[step]}
                        </span>
                    </CardHeader>
                    <CardContent>
                        <div className="mb-4 flex gap-1">
                            {STEPS.map((label, index) => (
                                <div
                                    key={label}
                                    className={cn(
                                        "h-1 flex-1 rounded-full",
                                        index <= step
                                            ? "bg-primary"
                                            : "bg-muted",
                                    )}
                                />
                            ))}
                        </div>
                        {step === 0 ? (
                            <div className="flex flex-col gap-3">
                                <div className="flex gap-2">
                                    {driverButton(
                                        "sqlite",
                                        "SQLite",
                                        "单文件数据库，开箱即用",
                                    )}
                                    {driverButton(
                                        "postgres",
                                        "PostgreSQL",
                                        "生产部署推荐",
                                    )}
                                </div>
                                {driver === "sqlite" ? (
                                    <Field>
                                        <FieldLabel htmlFor="ins-dbfile">
                                            <DatabaseIcon className="size-3.5" />
                                            数据库文件名
                                        </FieldLabel>
                                        <Input
                                            id="ins-dbfile"
                                            placeholder="data/plugim.db"
                                            value={dbFile}
                                            onChange={(e) =>
                                                setDbFile(e.target.value)
                                            }
                                        />
                                    </Field>
                                ) : (
                                    <Field>
                                        <FieldLabel htmlFor="ins-dburl">
                                            <DatabaseIcon className="size-3.5" />
                                            Postgres 连接串
                                        </FieldLabel>
                                        <Input
                                            id="ins-dburl"
                                            type="password"
                                            placeholder={
                                                s?.databaseUrlSet
                                                    ? "已配置，重新输入以覆盖"
                                                    : "postgres://user:pass@host:5432/plugim"
                                            }
                                            value={dbUrl}
                                            onChange={(e) =>
                                                setDbUrl(e.target.value)
                                            }
                                        />
                                    </Field>
                                )}
                                <Field>
                                    <FieldLabel htmlFor="ins-logdir">
                                        日志目录
                                    </FieldLabel>
                                    <Input
                                        id="ins-logdir"
                                        placeholder="logs（留空则不写文件日志）"
                                        value={logDir}
                                        onChange={(e) =>
                                            setLogDir(e.target.value)
                                        }
                                    />
                                </Field>
                                {error ? (
                                    <FieldError>{error}</FieldError>
                                ) : null}
                                {restartNote ? (
                                    <p className="text-xs text-primary">
                                        {restartNote}
                                    </p>
                                ) : null}
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        className="flex-1"
                                        disabled={testing || busy}
                                        onClick={() => void runTest()}
                                    >
                                        {testing ? "测试中..." : "测试连接"}
                                    </Button>
                                    <Button
                                        className="flex-1"
                                        disabled={busy || testing}
                                        onClick={() => void runSaveAndRestart()}
                                    >
                                        {busy ? "保存并重启..." : "保存并继续"}
                                    </Button>
                                </div>
                            </div>
                        ) : null}
                        {step === 1 ? (
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    void submitAdmin();
                                }}
                            >
                                <FieldGroup>
                                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                        <UserRoundIcon className="size-4 text-primary" />
                                        在{" "}
                                        {driver === "sqlite"
                                            ? `SQLite（${dbFile || "data/plugim.db"}）`
                                            : "PostgreSQL"}{" "}
                                        上创建第一个管理员账号
                                    </p>
                                    <Field>
                                        <FieldLabel htmlFor="ins-user">
                                            管理员用户名
                                        </FieldLabel>
                                        <Input
                                            id="ins-user"
                                            placeholder="a-z 0-9 _"
                                            autoComplete="username"
                                            value={username}
                                            onChange={(e) =>
                                                setUsername(e.target.value)
                                            }
                                        />
                                    </Field>
                                    <Field>
                                        <FieldLabel htmlFor="ins-pass">
                                            密码
                                        </FieldLabel>
                                        <Input
                                            id="ins-pass"
                                            type="password"
                                            placeholder="至少 6 位"
                                            autoComplete="new-password"
                                            value={password}
                                            onChange={(e) =>
                                                setPassword(e.target.value)
                                            }
                                        />
                                    </Field>
                                    <Field>
                                        <FieldLabel htmlFor="ins-confirm">
                                            确认密码
                                        </FieldLabel>
                                        <Input
                                            id="ins-confirm"
                                            type="password"
                                            placeholder="再输入一次"
                                            autoComplete="new-password"
                                            value={confirm}
                                            onChange={(e) =>
                                                setConfirm(e.target.value)
                                            }
                                        />
                                    </Field>
                                    {error ? (
                                        <FieldError>{error}</FieldError>
                                    ) : null}
                                    <Button
                                        type="submit"
                                        className="w-full"
                                        disabled={busy}
                                    >
                                        {busy ? "创建中..." : "创建并继续"}
                                    </Button>
                                </FieldGroup>
                            </form>
                        ) : null}
                        {step === 2 ? (
                            <div className="flex flex-col gap-3">
                                <p className="flex items-center gap-2 text-sm">
                                    <ShieldCheckIcon className="size-4 text-primary" />
                                    设置注册策略后完成安装
                                </p>
                                <div className="flex flex-col gap-2">
                                    {POLICY_OPTIONS.map((opt) => (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            onClick={() => setPolicy(opt.value)}
                                            className={cn(
                                                "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left",
                                                policy === opt.value
                                                    ? "border-primary bg-primary/5"
                                                    : "border-border hover:bg-accent/60",
                                            )}
                                        >
                                            {policy === opt.value ? (
                                                <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
                                            ) : (
                                                <span className="size-4 shrink-0 rounded-full border border-muted-foreground/40" />
                                            )}
                                            <span className="min-w-0">
                                                <span className="block text-sm font-medium">
                                                    {opt.label}
                                                </span>
                                                <span className="block truncate text-xs text-muted-foreground">
                                                    {opt.hint}
                                                </span>
                                            </span>
                                        </button>
                                    ))}
                                </div>
                                {policy === "invite" ? (
                                    <Field>
                                        <FieldLabel htmlFor="ins-invite">
                                            <KeyRoundIcon className="size-3.5" />
                                            邀请码
                                        </FieldLabel>
                                        <Input
                                            id="ins-invite"
                                            placeholder="设置一个告知好友的邀请码"
                                            value={invite}
                                            onChange={(e) =>
                                                setInvite(e.target.value)
                                            }
                                        />
                                    </Field>
                                ) : null}
                                {error ? (
                                    <FieldError>{error}</FieldError>
                                ) : null}
                                <Button
                                    className="w-full"
                                    disabled={busy}
                                    onClick={() => void submitPolicy()}
                                >
                                    {busy ? "保存中..." : "完成安装"}
                                </Button>
                            </div>
                        ) : null}
                    </CardContent>
                </Card>
            </div>
        );
    };

    const unregisterRoute = ui.registerRoute("/install", InstallPage);
    return () => {
        unregisterRoute();
    };
};
