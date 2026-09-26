import type { Context } from "@plugim/core";
import type { FriendListResult } from "@plugim/protocol";
import {
    MessageSquareIcon,
    PencilIcon,
    UserCheckIcon,
    UserPlusIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/ui/user-avatar";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import { displayName } from "./ui-shared";
import type { UiService } from "./ui-types";

interface CardState {
    username: string;
    x: number;
    y: number;
}

export const uiProfileCardSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");
    const rpc = ctx.get<RpcService>("rpc");
    const friends = ctx.get<FriendsService>("friends");

    const ProfileCard = () => {
        const [card, setCard] = useState<CardState | null>(null);
        const [createdAt, setCreatedAt] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        const [hint, setHint] = useState("");
        const [remarkOpen, setRemarkOpen] = useState(false);
        const [remarkDraft, setRemarkDraft] = useState("");
        const [, setRemarkTick] = useState(0);
        const cardRef = useRef<HTMLDivElement>(null);
        const remarkInputRef = useRef<HTMLInputElement>(null);
        const navigate = useNavigate();

        useEffect(
            () => friends.onUpdate(() => setRemarkTick((t) => t + 1)),
            [],
        );

        useEffect(() => {
            const dispose = ctx.on("ui:profile:open", (payload) => {
                const data = payload as CardState;
                setCard(data);
                setCreatedAt(null);
                setHint("");
                setRemarkOpen(false);
                setRemarkDraft(friends.remarkOf(data.username) ?? "");
                void rpc
                    .call("user.info", { username: data.username })
                    .then((result) => {
                        const info = result as { createdAt: string };
                        setCreatedAt(info.createdAt ?? null);
                    })
                    .catch(() => undefined);
            });
            return () => {
                void dispose();
            };
        }, []);

        useEffect(() => {
            if (remarkOpen) remarkInputRef.current?.focus();
        }, [remarkOpen]);

        useEffect(() => {
            if (!card) return undefined;
            const onDocClick = (e: MouseEvent) => {
                if (!cardRef.current?.contains(e.target as Node)) {
                    setCard(null);
                }
            };
            const onKey = (e: KeyboardEvent) => {
                if (e.key === "Escape") setCard(null);
            };
            window.addEventListener("mousedown", onDocClick);
            window.addEventListener("keydown", onKey);
            return () => {
                window.removeEventListener("mousedown", onDocClick);
                window.removeEventListener("keydown", onKey);
            };
        }, [card]);

        if (!card) return null;

        const me = auth.user()?.username ?? "";
        const isSelf = card.username === me;
        const relation: FriendListResult | null = friends.cached();
        const isFriend =
            !isSelf && (relation?.friends.includes(card.username) ?? false);
        const isOutgoing =
            !isSelf && (relation?.outgoing.includes(card.username) ?? false);
        const isIncoming =
            !isSelf && (relation?.incoming.includes(card.username) ?? false);

        const startChat = () => {
            ctx.emit("ui:chat:open", {
                session: `p2p:${card.username}`,
                title: displayName(card.username, relation?.remarks),
            });
            navigate("/chat");
            setCard(null);
        };

        const submitRemark = async () => {
            const remark = remarkDraft.trim();
            setBusy(true);
            setHint("");
            try {
                await friends.setRemark(card.username, remark);
                setRemarkOpen(false);
            } catch (err) {
                setHint(err instanceof Error ? err.message : "操作失败");
            } finally {
                setBusy(false);
            }
        };

        const act = async (fn: () => Promise<void>) => {
            setBusy(true);
            setHint("");
            try {
                await fn();
            } catch (err) {
                setHint(err instanceof Error ? err.message : "操作失败");
            } finally {
                setBusy(false);
            }
        };

        const remark = relation?.remarks?.[card.username] ?? "";
        const registered = createdAt ? new Date(createdAt) : null;

        return (
            <div
                ref={cardRef}
                className="pointer-events-auto fixed z-50 w-60 overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
                style={{
                    left: Math.min(card.x, window.innerWidth - 260),
                    top: Math.min(card.y, window.innerHeight - 240),
                }}
            >
                <div className="h-14 bg-primary/10" />
                <div className="-mt-7 flex flex-col items-center gap-1 px-4 pb-3">
                    <span className="rounded-full ring-4 ring-popover">
                        <UserAvatar name={card.username} size="lg" />
                    </span>
                    <p className="text-sm font-semibold">{card.username}</p>
                    {isFriend && !remarkOpen ? (
                        <button
                            type="button"
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => {
                                setRemarkDraft(remark);
                                setRemarkOpen(true);
                            }}
                        >
                            <PencilIcon className="size-3" />
                            {remark ? `备注：${remark}` : "添加备注"}
                        </button>
                    ) : null}
                    {remarkOpen ? (
                        <div className="flex w-full items-center gap-1">
                            <input
                                ref={remarkInputRef}
                                value={remarkDraft}
                                maxLength={24}
                                placeholder="备注名"
                                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-xs outline-none focus:border-primary"
                                onChange={(e) => setRemarkDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") void submitRemark();
                                    if (e.key === "Escape")
                                        setRemarkOpen(false);
                                }}
                            />
                            <button
                                type="button"
                                disabled={busy}
                                className="shrink-0 rounded-md px-2 py-1 text-xs text-primary hover:bg-accent disabled:opacity-50"
                                onClick={() => void submitRemark()}
                            >
                                保存
                            </button>
                        </div>
                    ) : null}
                    {registered ? (
                        <p className="text-xs text-muted-foreground">
                            注册于{" "}
                            {`${registered.getFullYear()}-${String(registered.getMonth() + 1).padStart(2, "0")}-${String(registered.getDate()).padStart(2, "0")}`}
                        </p>
                    ) : null}
                </div>
                {hint ? (
                    <p className="border-t border-border px-3 py-2 text-xs text-red-500">
                        {hint}
                    </p>
                ) : null}
                <div className="flex gap-2 border-t border-border p-3">
                    {isSelf ? (
                        <Button
                            size="sm"
                            className="w-full"
                            onClick={() => {
                                navigate("/me");
                                setCard(null);
                            }}
                        >
                            我的资料
                        </Button>
                    ) : isFriend ? (
                        <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            onClick={startChat}
                        >
                            <MessageSquareIcon />
                            发起会话
                        </Button>
                    ) : isIncoming ? (
                        <Button
                            size="sm"
                            className="w-full"
                            disabled={busy}
                            onClick={() =>
                                void act(() => friends.accept(card.username))
                            }
                        >
                            <UserCheckIcon />
                            同意好友
                        </Button>
                    ) : isOutgoing ? (
                        <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            disabled
                        >
                            等待验证
                        </Button>
                    ) : (
                        <Button
                            size="sm"
                            className="w-full"
                            disabled={busy}
                            onClick={() =>
                                void act(() => friends.request(card.username))
                            }
                        >
                            <UserPlusIcon />
                            加好友
                        </Button>
                    )}
                </div>
            </div>
        );
    };

    return ui.register("overlay", ProfileCard, 10);
};
