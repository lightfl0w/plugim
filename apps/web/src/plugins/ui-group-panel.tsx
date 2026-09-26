import type { Context } from "@plugim/core";
import type {
    GroupCallInfo,
    GroupFileItem,
    GroupInfo,
    GroupJoinRequest,
    GroupJoinResult,
    GroupMember,
} from "@plugim/protocol";
import {
    CheckIcon,
    CrownIcon,
    DownloadIcon,
    FileIcon,
    LinkIcon,
    PhoneIcon,
    PinOffIcon,
    ShieldIcon,
    Trash2Icon,
    UploadIcon,
    UserMinusIcon,
    UserPlusIcon,
    UserXIcon,
    VideoIcon,
    Volume2Icon,
    VolumeXIcon,
    XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { UserAvatar } from "../components/ui/user-avatar";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { GroupsService } from "./groups";
import type { PresenceService } from "./presence";
import type { SenderService } from "./sender";
import { formatBytes } from "./ui-shared";
import type { UiService } from "./ui-types";

interface MembersResult {
    members: GroupMember[];
    online: number;
}

type InviteExpiry = "never" | "7d" | "30d";

const INVITE_EXPIRY_OPTIONS: { value: InviteExpiry; label: string }[] = [
    { value: "never", label: "永久有效" },
    { value: "7d", label: "7 天有效" },
    { value: "30d", label: "30 天有效" },
];

const JOIN_KEY = "plugim:join-code";

const consumeJoinLink = () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("join");
    if (!code) return;
    params.delete("join");
    const query = params.toString();
    window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    sessionStorage.setItem(JOIN_KEY, code.trim().toUpperCase());
};

export const uiGroupPanelSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const rpc = ctx.get<RpcService>("rpc");
    const auth = ctx.get<AuthService>("auth");
    const friends = ctx.get<FriendsService>("friends");
    const groups = ctx.get<GroupsService>("groups");
    const presence = ctx.get<PresenceService>("presence");
    const sender = ctx.get<SenderService>("sender");
    let uploadLimitMb = 20;
    void rpc
        .call("files.info", {})
        .then((result) => {
            const { uploadLimitMb: value } = result as {
                uploadLimitMb: number;
            };
            if (value > 0) uploadLimitMb = value;
        })
        .catch(() => undefined);

    consumeJoinLink();

    const JoinBridge = () => {
        useEffect(() => {
            let ticks = 0;
            const timer = window.setInterval(() => {
                ticks += 1;
                const code = sessionStorage.getItem(JOIN_KEY);
                if (!code || ticks > 200) {
                    window.clearInterval(timer);
                    return;
                }
                if (!auth.user() || rpc.status() !== "open") return;
                sessionStorage.removeItem(JOIN_KEY);
                window.clearInterval(timer);
                void (async () => {
                    try {
                        const result = (await rpc.call("group.join", {
                            code,
                        })) as GroupJoinResult;
                        await groups.refresh().catch(() => undefined);
                        alert(
                            result.status === "joined"
                                ? `已加入群「${result.name}」`
                                : `已提交加群申请，等待「${result.name}」管理员同意`,
                        );
                    } catch (err) {
                        alert(String(err instanceof Error ? err.message : err));
                    }
                })();
            }, 300);
            return () => window.clearInterval(timer);
        }, []);
        return null;
    };

    const GroupPanel = () => {
        const [groupId, setGroupId] = useState<string | null>(null);
        const [info, setInfo] = useState<GroupInfo | null>(null);
        const [members, setMembers] = useState<GroupMember[]>([]);
        const [noticeDraft, setNoticeDraft] = useState<string | null>(null);
        const [nameDraft, setNameDraft] = useState<string | null>(null);
        const [adding, setAdding] = useState(false);
        const [selected, setSelected] = useState<string[]>([]);
        const [busy, setBusy] = useState(false);
        const [files, setFiles] = useState<GroupFileItem[]>([]);
        const [total, setTotal] = useState(0);
        const [uploading, setUploading] = useState("");
        const [call, setCall] = useState<GroupCallInfo | null>(null);
        const [requests, setRequests] = useState<GroupJoinRequest[]>([]);
        const [expiry, setExpiry] = useState<InviteExpiry>("never");
        const panelRef = useRef<HTMLDivElement>(null);
        const nameInputRef = useRef<HTMLInputElement>(null);
        const fileRef = useRef<HTMLInputElement>(null);

        const load = async (id: string) => {
            try {
                const [nextInfo, nextMembers, nextFiles, nextCall] =
                    await Promise.all([
                        rpc.call("group.info", {
                            groupId: id,
                        }) as Promise<GroupInfo>,
                        rpc.call("group.members", {
                            groupId: id,
                        }) as Promise<MembersResult>,
                        rpc
                            .call("group.file.list", {
                                groupId: id,
                                limit: 50,
                            })
                            .catch(() => null) as Promise<{
                            files: GroupFileItem[];
                            total: number;
                        } | null>,
                        rpc
                            .call("call.group.info", { groupId: id })
                            .catch(() => null) as Promise<GroupCallInfo | null>,
                    ]);
                setInfo(nextInfo);
                setMembers(nextMembers.members);
                setFiles(nextFiles?.files ?? []);
                setTotal(nextFiles?.total ?? 0);
                setCall(nextCall);
                const manager =
                    nextInfo.myRole === "owner" || nextInfo.myRole === "admin";
                setRequests(
                    manager
                        ? ((await rpc.call("group.requests", {
                              groupId: id,
                          })) as GroupJoinRequest[])
                        : [],
                );
            } catch {
                setGroupId(null);
            }
        };

        const loadRef = useRef(load);
        loadRef.current = load;

        useEffect(() => {
            const dispose = ctx.on("ui:group:manage", (payload) => {
                const id = (payload as { groupId: string }).groupId;
                setGroupId(id);
                setAdding(false);
                setSelected([]);
                setNoticeDraft(null);
                setNameDraft(null);
                setRequests([]);
                void loadRef.current(id);
            });
            const disposeUpdate = ctx.on("server:group:update", (payload) => {
                const { groupId: changed } = payload as {
                    groupId: string;
                };
                if (changed === groupId) void loadRef.current(groupId);
            });
            const disposeRequest = ctx.on("server:group:request", (payload) => {
                const { groupId: changed } = payload as {
                    groupId: string;
                };
                if (changed === groupId) void loadRef.current(groupId);
            });
            const disposeCall = ctx.on("server:group:call", (payload) => {
                const { groupId: changed } = payload as {
                    groupId: string;
                };
                if (changed === groupId) void loadRef.current(groupId);
            });
            return () => {
                void dispose();
                void disposeUpdate();
                void disposeRequest();
                void disposeCall();
            };
        }, [groupId]);

        useEffect(() => {
            if (nameDraft !== null) nameInputRef.current?.focus();
        }, [nameDraft]);

        useEffect(() => {
            if (!groupId) return undefined;
            const onKey = (e: KeyboardEvent) => {
                if (e.key === "Escape") setGroupId(null);
            };
            const onDown = (e: MouseEvent) => {
                if (!panelRef.current?.contains(e.target as Node))
                    setGroupId(null);
            };
            window.addEventListener("keydown", onKey);
            window.addEventListener("mousedown", onDown);
            return () => {
                window.removeEventListener("keydown", onKey);
                window.removeEventListener("mousedown", onDown);
            };
        }, [groupId]);

        if (!groupId || !info) return null;

        const me = auth.user()?.username ?? "";
        const privileged = info.myRole === "owner" || info.myRole === "admin";
        const memberNames = new Set(members.map((m) => m.username));
        const addable = (friends.cached()?.friends ?? []).filter(
            (name) => !memberNames.has(name),
        );

        const act = async (method: string, params: Record<string, unknown>) => {
            setBusy(true);
            try {
                await rpc.call(method, { groupId, ...params });
                await load(groupId);
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
            } finally {
                setBusy(false);
            }
        };

        const uploadFile = async (file: File) => {
            if (!groupId) return;
            if (file.size > uploadLimitMb * 1024 * 1024) {
                alert(`文件超过 ${uploadLimitMb} MB 上限`);
                return;
            }
            setUploading(file.name);
            try {
                const { key } = await sender.upload(file, file.name);
                await rpc.call("group.file.add", { groupId, key });
                await load(groupId);
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
            } finally {
                setUploading("");
            }
        };

        const removeFile = async (file: GroupFileItem) => {
            if (!groupId) return;
            if (!confirm(`确定删除群文件「${file.name}」吗？`)) return;
            setBusy(true);
            try {
                await rpc.call("group.file.delete", {
                    groupId,
                    key: file.key,
                });
                await load(groupId);
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
            } finally {
                setBusy(false);
            }
        };

        const startCall = (kind: "voice" | "video", room?: string) => {
            if (!groupId) return;
            const target = groupId;
            setGroupId(null);
            ctx.emit("ui:group:call", { groupId: target, kind, roomId: room });
        };

        const roleBadge = (member: GroupMember) =>
            member.role === "owner" ? (
                <span className="flex items-center gap-0.5 text-xs text-amber-500">
                    <CrownIcon className="size-3" />
                    群主
                </span>
            ) : member.role === "admin" ? (
                <span className="flex items-center gap-0.5 text-xs text-primary">
                    <ShieldIcon className="size-3" />
                    管理员
                </span>
            ) : member.muted ? (
                <span className="text-xs text-red-500">已禁言</span>
            ) : null;

        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label="群管理"
                    className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-card shadow-xl"
                >
                    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                        <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                            {nameDraft === null ? info.name : null}
                        </p>
                        {nameDraft !== null ? (
                            <input
                                ref={nameInputRef}
                                value={nameDraft}
                                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-sm outline-none focus:border-primary"
                                onChange={(e) => setNameDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        void act("group.rename", {
                                            name: nameDraft,
                                        });
                                        setNameDraft(null);
                                    }
                                    if (e.key === "Escape") setNameDraft(null);
                                }}
                            />
                        ) : null}
                        <span className="shrink-0 text-xs text-muted-foreground">
                            {info.memberCount} 人
                        </span>
                        <button
                            type="button"
                            title="关闭"
                            className="rounded-md p-1 hover:bg-accent"
                            onClick={() => setGroupId(null)}
                        >
                            <XIcon className="size-4" />
                        </button>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <section className="border-b border-border p-4">
                            <div className="mb-1 flex items-center justify-between">
                                <p className="text-xs font-semibold text-muted-foreground">
                                    群公告
                                </p>
                                {privileged && noticeDraft === null ? (
                                    <button
                                        type="button"
                                        className="text-xs text-primary"
                                        onClick={() =>
                                            setNoticeDraft(info.notice)
                                        }
                                    >
                                        编辑
                                    </button>
                                ) : null}
                            </div>
                            {noticeDraft !== null ? (
                                <div className="flex flex-col gap-2">
                                    <textarea
                                        value={noticeDraft}
                                        rows={3}
                                        placeholder="发布群公告..."
                                        className="w-full resize-none rounded-md border border-border bg-transparent p-2 text-sm outline-none focus:border-primary"
                                        onChange={(e) =>
                                            setNoticeDraft(e.target.value)
                                        }
                                    />
                                    <div className="flex justify-end gap-2">
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => setNoticeDraft(null)}
                                        >
                                            取消
                                        </Button>
                                        <Button
                                            size="sm"
                                            disabled={busy}
                                            onClick={async () => {
                                                await act("group.notice.set", {
                                                    notice: noticeDraft,
                                                });
                                                setNoticeDraft(null);
                                            }}
                                        >
                                            发布
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <p className="text-sm whitespace-pre-wrap">
                                    {info.notice || (
                                        <span className="text-xs text-muted-foreground">
                                            暂无公告
                                        </span>
                                    )}
                                </p>
                            )}
                        </section>

                        <section className="border-b border-border p-4">
                            <p className="mb-2 text-xs font-semibold text-muted-foreground">
                                群通话
                            </p>
                            {call ? (
                                <div className="flex items-center gap-2.5 rounded-lg bg-emerald-500/10 px-3 py-2">
                                    <span className="shrink-0 text-emerald-600">
                                        {call.kind === "video" ? (
                                            <VideoIcon className="size-4" />
                                        ) : (
                                            <PhoneIcon className="size-4" />
                                        )}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm">
                                            {call.kind === "video"
                                                ? "视频通话"
                                                : "语音通话"}
                                            进行中
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {call.host} 发起 ·{" "}
                                            {call.members.length} 人
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            startCall(
                                                call.kind === "video"
                                                    ? "video"
                                                    : "voice",
                                                call.roomId,
                                            )
                                        }
                                    >
                                        加入
                                    </Button>
                                </div>
                            ) : (
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => startCall("voice")}
                                    >
                                        <PhoneIcon />
                                        发起语音
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => startCall("video")}
                                    >
                                        <VideoIcon />
                                        发起视频
                                    </Button>
                                </div>
                            )}
                        </section>

                        <section className="border-b border-border p-4">
                            <div className="mb-2 flex items-center justify-between">
                                <p className="text-xs font-semibold text-muted-foreground">
                                    群文件
                                    {total > files.length
                                        ? ` (${files.length}/${total})`
                                        : ""}
                                </p>
                                <button
                                    type="button"
                                    className="flex items-center gap-1 text-xs text-primary disabled:text-muted-foreground"
                                    disabled={Boolean(uploading)}
                                    onClick={() => fileRef.current?.click()}
                                >
                                    <UploadIcon className="size-3.5" />
                                    {uploading ? "上传中..." : "上传文件"}
                                </button>
                            </div>
                            <input
                                ref={fileRef}
                                type="file"
                                className="hidden"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = "";
                                    if (file) void uploadFile(file);
                                }}
                            />
                            {files.length === 0 ? (
                                <p className="py-1 text-xs text-muted-foreground">
                                    暂无文件
                                </p>
                            ) : (
                                <div className="flex flex-col gap-1">
                                    {files.map((file) => (
                                        <div
                                            key={file.key}
                                            className="flex items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5"
                                        >
                                            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm">
                                                    {file.name}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    {formatBytes(file.size)} ·{" "}
                                                    {file.uploader}
                                                </p>
                                            </div>
                                            <a
                                                title="下载"
                                                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                                                href={`/files/${file.key}?download=1`}
                                                download={file.name}
                                            >
                                                <DownloadIcon className="size-4" />
                                            </a>
                                            {privileged ||
                                            file.uploader === me ? (
                                                <button
                                                    type="button"
                                                    title="删除"
                                                    className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        void removeFile(file)
                                                    }
                                                >
                                                    <Trash2Icon className="size-4" />
                                                </button>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        {privileged ? (
                            <section className="border-b border-border p-4">
                                <div className="mb-2 flex items-center justify-between">
                                    <p className="text-xs font-semibold text-muted-foreground">
                                        邀请与审批
                                    </p>
                                    {info.inviteExpiresAt ? (
                                        <span className="text-xs text-muted-foreground">
                                            有效期至{" "}
                                            {new Date(
                                                info.inviteExpiresAt,
                                            ).toLocaleDateString()}
                                        </span>
                                    ) : null}
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm">入群审批</p>
                                        <p className="text-xs text-muted-foreground">
                                            开启后通过邀请链接申请，需要管理员同意
                                        </p>
                                    </div>
                                    <Switch
                                        checked={info.joinApproval}
                                        disabled={busy}
                                        onToggle={() =>
                                            void act("group.joinApproval", {
                                                on: !info.joinApproval,
                                            })
                                        }
                                    />
                                </div>
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <select
                                        className="h-8 rounded-md border border-border bg-transparent px-2 text-xs"
                                        value={expiry}
                                        onChange={(e) =>
                                            setExpiry(
                                                e.target.value as InviteExpiry,
                                            )
                                        }
                                    >
                                        {INVITE_EXPIRY_OPTIONS.map((option) => (
                                            <option
                                                key={option.value}
                                                value={option.value}
                                            >
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() =>
                                            void act("group.invite.set", {
                                                expiresIn: expiry,
                                            })
                                        }
                                    >
                                        <LinkIcon />
                                        {info.inviteCode
                                            ? "重新生成"
                                            : "生成邀请码"}
                                    </Button>
                                    {info.inviteCode ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() =>
                                                void act(
                                                    "group.invite.disable",
                                                    {},
                                                )
                                            }
                                        >
                                            关闭邀请
                                        </Button>
                                    ) : null}
                                    {info.inviteCode ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                                const link = `${window.location.origin}/?join=${info.inviteCode}`;
                                                void navigator.clipboard
                                                    .writeText(link)
                                                    .then(() =>
                                                        alert(
                                                            `邀请链接已复制\n${link}`,
                                                        ),
                                                    )
                                                    .catch(() => alert(link));
                                            }}
                                        >
                                            <CheckIcon />
                                            复制链接
                                        </Button>
                                    ) : null}
                                </div>
                                {info.inviteCode ? (
                                    <p className="mt-2 truncate rounded-lg bg-muted/40 px-2 py-1.5 font-mono text-xs">
                                        {window.location.origin}/?join=
                                        {info.inviteCode}
                                    </p>
                                ) : (
                                    <p className="mt-2 text-xs text-muted-foreground">
                                        未开启邀请链接，成员只能由管理员手动拉入
                                    </p>
                                )}
                                <div className="mt-3">
                                    <p className="mb-1 text-xs text-muted-foreground">
                                        加群申请 {requests.length} 条
                                    </p>
                                    {requests.length === 0 ? (
                                        <p className="text-xs text-muted-foreground">
                                            暂无待审批申请
                                        </p>
                                    ) : (
                                        <div className="flex flex-col gap-1">
                                            {requests.map((item) => (
                                                <div
                                                    key={item.username}
                                                    className="flex items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5"
                                                >
                                                    <UserAvatar
                                                        name={item.username}
                                                        size="sm"
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm">
                                                            {item.username}
                                                        </p>
                                                        <p className="truncate text-xs text-muted-foreground">
                                                            {item.message ||
                                                                "申请加入群聊"}
                                                        </p>
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            void act(
                                                                "group.request.approve",
                                                                {
                                                                    username:
                                                                        item.username,
                                                                    on: true,
                                                                },
                                                            )
                                                        }
                                                    >
                                                        同意
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            void act(
                                                                "group.request.approve",
                                                                {
                                                                    username:
                                                                        item.username,
                                                                    on: false,
                                                                },
                                                            )
                                                        }
                                                    >
                                                        拒绝
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </section>
                        ) : null}

                        {privileged ? (
                            <section className="border-b border-border">
                                <div className="flex items-center gap-3 px-4 py-3">
                                    <Volume2Icon className="size-4 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm">全员禁言</p>
                                        <p className="text-xs text-muted-foreground">
                                            开启后普通成员无法发送消息
                                        </p>
                                    </div>
                                    <Switch
                                        checked={info.muteAll}
                                        disabled={busy}
                                        onToggle={() =>
                                            void act("group.muteAll", {
                                                on: !info.muteAll,
                                            })
                                        }
                                    />
                                </div>
                                <div className="flex items-center gap-3 border-t border-border px-4 py-3">
                                    <UserXIcon className="size-4 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm">禁止互加好友</p>
                                        <p className="text-xs text-muted-foreground">
                                            成员之间不能发送好友申请
                                        </p>
                                    </div>
                                    <Switch
                                        checked={info.noFriendAdd}
                                        disabled={busy}
                                        onToggle={() =>
                                            void act("group.noFriendAdd", {
                                                on: !info.noFriendAdd,
                                            })
                                        }
                                    />
                                </div>
                            </section>
                        ) : null}

                        <section className="p-4">
                            <div className="mb-2 flex items-center justify-between">
                                <p className="text-xs font-semibold text-muted-foreground">
                                    群成员
                                </p>
                                {privileged ? (
                                    <button
                                        type="button"
                                        className="flex items-center gap-1 text-xs text-primary"
                                        onClick={() => setAdding((v) => !v)}
                                    >
                                        <UserPlusIcon className="size-3.5" />
                                        邀请好友
                                    </button>
                                ) : null}
                            </div>
                            {adding ? (
                                <div className="mb-3 flex flex-col gap-1 rounded-lg bg-muted/50 p-2">
                                    {addable.length === 0 ? (
                                        <p className="py-1 text-xs text-muted-foreground">
                                            没有可邀请的好友
                                        </p>
                                    ) : (
                                        addable.map((name) => (
                                            <label
                                                key={name}
                                                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent/60"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selected.includes(
                                                        name,
                                                    )}
                                                    onChange={(e) =>
                                                        setSelected((prev) =>
                                                            e.target.checked
                                                                ? [
                                                                      ...prev,
                                                                      name,
                                                                  ]
                                                                : prev.filter(
                                                                      (x) =>
                                                                          x !==
                                                                          name,
                                                                  ),
                                                        )
                                                    }
                                                />
                                                {name}
                                            </label>
                                        ))
                                    )}
                                    <Button
                                        size="sm"
                                        className="mt-1"
                                        disabled={busy || selected.length === 0}
                                        onClick={async () => {
                                            await act("group.member.add", {
                                                usernames: selected,
                                            });
                                            setSelected([]);
                                            setAdding(false);
                                        }}
                                    >
                                        邀请 {selected.length || ""} 人
                                    </Button>
                                </div>
                            ) : null}
                            <div className="flex flex-col">
                                {members.map((member) => (
                                    <div
                                        key={member.username}
                                        className="flex items-center gap-2.5 rounded-lg px-1 py-2"
                                    >
                                        <span className="relative">
                                            <UserAvatar
                                                name={member.username}
                                                size="sm"
                                            />
                                            {presence.isOnline(
                                                member.username,
                                            ) ? (
                                                <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-emerald-500 ring-2 ring-card" />
                                            ) : null}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm">
                                                {member.username}
                                                {member.username === me ? (
                                                    <span className="ml-1 text-xs text-muted-foreground">
                                                        (我)
                                                    </span>
                                                ) : null}
                                            </p>
                                            {roleBadge(member)}
                                        </div>
                                        {info.myRole === "owner" &&
                                        member.username !== me &&
                                        member.role !== "owner" ? (
                                            <button
                                                type="button"
                                                title={
                                                    member.role === "admin"
                                                        ? "取消管理员"
                                                        : "设为管理员"
                                                }
                                                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                                                disabled={busy}
                                                onClick={() =>
                                                    void act(
                                                        "group.member.role",
                                                        {
                                                            username:
                                                                member.username,
                                                            role:
                                                                member.role ===
                                                                "admin"
                                                                    ? "member"
                                                                    : "admin",
                                                        },
                                                    )
                                                }
                                            >
                                                <ShieldIcon className="size-4" />
                                            </button>
                                        ) : null}
                                        {privileged &&
                                        member.role === "member" &&
                                        member.username !== me ? (
                                            <button
                                                type="button"
                                                title={
                                                    member.muted
                                                        ? "解除禁言"
                                                        : "禁言"
                                                }
                                                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                                                disabled={busy}
                                                onClick={() =>
                                                    void act(
                                                        "group.member.mute",
                                                        {
                                                            username:
                                                                member.username,
                                                            muted:
                                                                !member.muted,
                                                        },
                                                    )
                                                }
                                            >
                                                {member.muted ? (
                                                    <Volume2Icon className="size-4" />
                                                ) : (
                                                    <VolumeXIcon className="size-4" />
                                                )}
                                            </button>
                                        ) : null}
                                        {(info.myRole === "owner" &&
                                            member.role !== "owner" &&
                                            member.username !== me) ||
                                        (info.myRole === "admin" &&
                                            member.username === me) ? (
                                            <button
                                                type="button"
                                                title={
                                                    member.username === me
                                                        ? "退出群聊"
                                                        : "移出群聊"
                                                }
                                                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                                                disabled={busy}
                                                onClick={() =>
                                                    void act(
                                                        "group.member.remove",
                                                        {
                                                            username:
                                                                member.username,
                                                        },
                                                    )
                                                }
                                            >
                                                <UserMinusIcon className="size-4" />
                                            </button>
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        </section>
                    </div>

                    <div className="flex items-center gap-2 border-t border-border p-3">
                        {privileged ? (
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => setNameDraft(info.name)}
                            >
                                修改群名
                            </Button>
                        ) : null}
                        {info.myRole === "owner" ? (
                            <Button
                                size="sm"
                                variant="destructive"
                                className="ml-auto"
                                disabled={busy}
                                onClick={async () => {
                                    if (
                                        !confirm(
                                            `确定解散群「${info.name}」吗？`,
                                        )
                                    )
                                        return;
                                    await act("group.delete", {});
                                    setGroupId(null);
                                }}
                            >
                                <PinOffIcon />
                                解散群
                            </Button>
                        ) : (
                            <Button
                                size="sm"
                                variant="destructive"
                                className="ml-auto"
                                disabled={busy}
                                onClick={async () => {
                                    if (
                                        !confirm(
                                            `确定退出群「${info.name}」吗？`,
                                        )
                                    )
                                        return;
                                    await act("group.leave", {});
                                    setGroupId(null);
                                }}
                            >
                                退出群聊
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const unregisterPanel = ui.register("overlay", GroupPanel, 30);
    const unregisterJoin = ui.register("overlay", JoinBridge, 31);
    return () => {
        unregisterPanel();
        unregisterJoin();
    };
};
