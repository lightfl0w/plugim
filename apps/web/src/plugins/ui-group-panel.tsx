import type { Context } from "@plugim/core";
import type { GroupInfo, GroupMember } from "@plugim/protocol";
import {
    CrownIcon,
    PinOffIcon,
    ShieldIcon,
    UserMinusIcon,
    UserPlusIcon,
    Volume2Icon,
    VolumeXIcon,
    XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/ui/user-avatar";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { PresenceService } from "./presence";
import type { UiService } from "./ui-types";

interface MembersResult {
    members: GroupMember[];
    online: number;
}

export const uiGroupPanelSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const rpc = ctx.get<RpcService>("rpc");
    const auth = ctx.get<AuthService>("auth");
    const friends = ctx.get<FriendsService>("friends");
    const presence = ctx.get<PresenceService>("presence");

    const GroupPanel = () => {
        const [groupId, setGroupId] = useState<string | null>(null);
        const [info, setInfo] = useState<GroupInfo | null>(null);
        const [members, setMembers] = useState<GroupMember[]>([]);
        const [noticeDraft, setNoticeDraft] = useState<string | null>(null);
        const [nameDraft, setNameDraft] = useState<string | null>(null);
        const [adding, setAdding] = useState(false);
        const [selected, setSelected] = useState<string[]>([]);
        const [busy, setBusy] = useState(false);
        const panelRef = useRef<HTMLDivElement>(null);
        const nameInputRef = useRef<HTMLInputElement>(null);

        const load = async (id: string) => {
            try {
                const [nextInfo, nextMembers] = await Promise.all([
                    rpc.call("group.info", {
                        groupId: id,
                    }) as Promise<GroupInfo>,
                    rpc.call("group.members", {
                        groupId: id,
                    }) as Promise<MembersResult>,
                ]);
                setInfo(nextInfo);
                setMembers(nextMembers.members);
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
                void loadRef.current(id);
            });
            const disposeUpdate = ctx.on("server:group:update", (payload) => {
                const { groupId: changed } = payload as {
                    groupId: string;
                };
                if (changed === groupId) void loadRef.current(groupId);
            });
            return () => {
                void dispose();
                void disposeUpdate();
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

                        {privileged ? (
                            <section className="flex items-center gap-3 border-b border-border px-4 py-3">
                                <p className="flex-1 text-sm">全员禁言</p>
                                <Button
                                    size="sm"
                                    variant={
                                        info.muteAll ? "default" : "outline"
                                    }
                                    disabled={busy}
                                    onClick={() =>
                                        void act("group.muteAll", {
                                            on: !info.muteAll,
                                        })
                                    }
                                >
                                    {info.muteAll ? (
                                        <VolumeXIcon />
                                    ) : (
                                        <Volume2Icon />
                                    )}
                                    {info.muteAll ? "禁言中" : "已开启"}
                                </Button>
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

    return ui.register("overlay", GroupPanel, 30);
};
