import type {
    ChatMessage,
    RedPacketDetail,
    RedPacketSummary,
} from "@plugim/protocol";
import {
    CheckCircle2Icon,
    GiftIcon,
    HandCoinsIcon,
    LoaderCircleIcon,
    XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { usePopupClose } from "./ui-shared";

export const formatMoney = (cents: number): string => {
    const yuan = Math.floor(cents / 100);
    const rest = cents % 100;
    if (yuan === 0) return `${(cents / 100).toFixed(2)} 元`;
    if (rest === 0) return `${yuan} 元`;
    return `${yuan}.${String(rest).padStart(2, "0")} 元`;
};

export const parseMoneyInput = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value <= 0) return null;
    const cents = Math.round(value * 100);
    return cents >= 1 ? cents : null;
};

const luckySplit = (total: number, count: number): number[] => {
    const amounts = Array.from({ length: count }, () => 1);
    let left = total - count;
    for (let i = 0; i < count && left > 0; i++) {
        const max = Math.floor(left / (count - i));
        const add = 1 + Math.floor(Math.random() * Math.max(1, max));
        const take = Math.min(add, left);
        amounts[i] += take;
        left -= take;
    }
    return amounts;
};

interface RedPacketService {
    create(params: {
        sessionId: string;
        type: "normal" | "lucky";
        totalAmount: number;
        totalCount: number;
        message?: string;
    }): Promise<{ packet: RedPacketSummary }>;
    claim(params: {
        redPacketId: string;
    }): Promise<{ amount: number; packet: RedPacketSummary }>;
    detail(params: { redPacketId: string }): Promise<RedPacketDetail>;
}

export const RedPacketCard = ({
    message,
    mine,
    claimedAmount,
    live,
    onOpen,
}: {
    message: ChatMessage;
    mine: boolean;
    claimedAmount?: number | null;
    live?: {
        status: "active" | "exhausted" | "expired";
        claimedCount: number;
    };
    onOpen: (packetId: string) => void;
}) => {
    const packet = message.redPacket;
    if (!packet) return null;
    const status = live?.status ?? packet.status;
    const done =
        claimedAmount !== undefined && claimedAmount !== null
            ? true
            : status !== "active";
    const label = done
        ? claimedAmount != null
            ? `已领取 ${formatMoney(claimedAmount)}`
            : status === "expired"
              ? "已过期"
              : "已被领完"
        : status === "active" && (live?.claimedCount ?? 0) > 0
          ? `点击领取 · 已领 ${live?.claimedCount}/${packet.totalCount}`
          : "点击领取";
    return (
        <button
            type="button"
            onClick={() => onOpen(packet.id)}
            className={cn(
                "flex w-60 flex-col gap-1 rounded-lg p-2.5 text-left transition-colors",
                done && claimedAmount == null && !mine
                    ? "bg-rose-500/70 text-white/90 hover:bg-rose-500/70"
                    : mine
                      ? "bg-rose-500/90 text-white hover:bg-rose-500"
                      : "bg-rose-500 text-white hover:bg-rose-600",
            )}
        >
            <span className="flex items-center gap-1.5">
                <GiftIcon className="size-4 shrink-0" />
                <span className="truncate text-sm">
                    {message.content || packet.message || "恭喜发财，大吉大利"}
                </span>
            </span>
            <span className="text-xs text-white/80">{label}</span>
        </button>
    );
};

export const RedPacketCreateDialog = ({
    open,
    sessionId,
    busy,
    onClose,
    onSubmit,
}: {
    open: boolean;
    sessionId: string;
    busy: boolean;
    onClose: () => void;
    onSubmit: (params: {
        sessionId: string;
        type: "normal" | "lucky";
        totalAmount: number;
        totalCount: number;
        message?: string;
    }) => Promise<void>;
}) => {
    const [kind, setKind] = useState<"normal" | "lucky">("normal");
    const [total, setTotal] = useState("");
    const [count, setCount] = useState("1");
    const [blessing, setBlessing] = useState("");
    const [error, setError] = useState("");
    const dialogRef = useRef<HTMLDivElement>(null);
    usePopupClose(dialogRef, open, onClose);

    useEffect(() => {
        if (open) {
            setKind("normal");
            setTotal("");
            setCount("1");
            setBlessing("");
            setError("");
        }
    }, [open]);

    if (!open) return null;
    const cents = parseMoneyInput(total);
    const countNum = Number(count);
    const amountError =
        total.trim() && cents === null ? "金额格式不正确，最多两位小数" : "";
    const countError =
        count.trim() &&
        (!Number.isInteger(countNum) ||
            countNum < 1 ||
            countNum > 200 ||
            (cents !== null && countNum > cents))
            ? "个数需为 1-200 的整数，且不能超过总金额（分）"
            : "";

    const submit = async () => {
        if (busy) return;
        setError("");
        if (cents === null) {
            setError("请输入正确的红包金额");
            return;
        }
        if (!Number.isInteger(countNum) || countNum < 1) {
            setError("红包个数至少为 1");
            return;
        }
        try {
            await onSubmit({
                sessionId,
                type: kind,
                totalAmount: cents,
                totalCount: countNum,
                message: blessing.trim() || undefined,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : "发送红包失败");
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
            <div
                ref={dialogRef}
                className="w-full max-w-sm rounded-xl bg-background p-4 shadow-xl"
            >
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-base font-semibold">发红包</h2>
                    <button
                        type="button"
                        aria-label="关闭"
                        className="rounded p-1 text-muted-foreground hover:bg-accent"
                        onClick={onClose}
                    >
                        <XIcon className="size-4" />
                    </button>
                </div>

                <div className="mb-3 flex rounded-lg bg-muted p-1">
                    {(
                        [
                            ["normal", "普通红包"],
                            ["lucky", "拼手气红包"],
                        ] as const
                    ).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            className={cn(
                                "flex-1 rounded-md py-1.5 text-sm transition-colors",
                                kind === value
                                    ? "bg-background shadow-sm"
                                    : "text-muted-foreground",
                            )}
                            onClick={() => setKind(value)}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <div className="flex flex-col gap-3">
                    <label htmlFor="rp-amount" className="flex flex-col gap-1.5">
                        <span className="text-sm text-muted-foreground">
                            红包金额（元）
                        </span>
                        <Input
                            id="rp-amount"
                            value={total}
                            inputMode="decimal"
                            placeholder="0.00"
                            className={cn(amountError && "border-destructive")}
                            onChange={(e) => setTotal(e.target.value)}
                        />
                        {amountError ? (
                            <span className="text-xs text-destructive">
                                {amountError}
                            </span>
                        ) : null}
                    </label>

                    <label htmlFor="rp-count" className="flex flex-col gap-1.5">
                        <span className="text-sm text-muted-foreground">
                            红包个数
                        </span>
                        <Input
                            id="rp-count"
                            value={count}
                            inputMode="numeric"
                            className={cn(countError && "border-destructive")}
                            onChange={(e) => setCount(e.target.value)}
                        />
                        {countError ? (
                            <span className="text-xs text-destructive">
                                {countError}
                            </span>
                        ) : null}
                        {kind === "normal" && cents && countNum > 0 ? (
                            <span className="text-xs text-muted-foreground">
                                {luckySplit(cents, countNum).length > 0 &&
                                cents % countNum === 0
                                    ? `每人 ${formatMoney(cents / countNum)}`
                                    : `每人约 ${formatMoney(
                                          Math.floor(cents / countNum),
                                      )}`}
                            </span>
                        ) : null}
                    </label>

                    <label htmlFor="rp-message" className="flex flex-col gap-1.5">
                        <span className="text-sm text-muted-foreground">
                            留言
                        </span>
                        <Textarea
                            id="rp-message"
                            value={blessing}
                            rows={2}
                            maxLength={50}
                            placeholder="恭喜发财，大吉大利"
                            onChange={(e) => setBlessing(e.target.value)}
                        />
                    </label>
                </div>

                {error ? (
                    <p className="mt-3 text-sm text-destructive">{error}</p>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose}>
                        取消
                    </Button>
                    <Button
                        onClick={() => void submit()}
                        disabled={
                            busy ||
                            amountError !== "" ||
                            countError !== "" ||
                            cents === null
                        }
                    >
                        {busy ? (
                            <LoaderCircleIcon className="size-4 animate-spin" />
                        ) : (
                            <HandCoinsIcon className="size-4" />
                        )}
                        塞钱进红包
                    </Button>
                </div>
            </div>
        </div>
    );
};

export const RedPacketOpenDialog = ({
    open,
    redPacketId,
    mine,
    service,
    onClose,
    onClaimed,
}: {
    open: boolean;
    redPacketId: string;
    mine: boolean;
    service: RedPacketService;
    onClose: () => void;
    onClaimed: (packetId: string, amount: number | null) => void;
}) => {
    const [detail, setDetail] = useState<RedPacketDetail | null>(null);
    const [amount, setAmount] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [error, setError] = useState("");
    const dialogRef = useRef<HTMLDivElement>(null);
    usePopupClose(dialogRef, open && !claiming, onClose);

    const load = useCallback(async () => {
        if (!open || !redPacketId) return;
        setLoading(true);
        setError("");
        try {
            const next = await service.detail({ redPacketId });
            setDetail(next);
            setAmount(next.packet.myAmount ?? null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "红包加载失败");
        } finally {
            setLoading(false);
        }
    }, [open, redPacketId, service]);

    useEffect(() => {
        if (open) {
            setDetail(null);
            setAmount(null);
            void load();
        }
    }, [open, load]);

    if (!open) return null;
    const packet = detail?.packet;
    const claimed = amount !== null;
    const finished = packet ? packet.status !== "active" : false;
    const canClaim = packet && !mine && !claimed && packet.status === "active";
    const ordered = detail
        ? [
              ...detail.records.filter((r) => r.isMe),
              ...detail.records.filter((r) => !r.isMe),
          ]
        : [];

    const claim = async () => {
        if (claiming) return;
        setClaiming(true);
        setError("");
        try {
            const res = await service.claim({ redPacketId });
            setAmount(res.amount);
            onClaimed(redPacketId, res.amount);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "领取失败");
            await load();
        } finally {
            setClaiming(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div
                ref={dialogRef}
                className="w-full max-w-xs overflow-hidden rounded-xl bg-background shadow-xl"
            >
                <div className="relative bg-gradient-to-b from-rose-500 to-rose-600 px-5 pb-8 pt-6 text-white">
                    <button
                        type="button"
                        aria-label="关闭"
                        className="absolute top-3 right-3 rounded p-1 text-white/80 hover:bg-white/15"
                        onClick={onClose}
                    >
                        <XIcon className="size-4" />
                    </button>
                    <p className="text-sm text-white/80">
                        {mine
                            ? "你发出的红包"
                            : claimed
                              ? "已领取"
                              : "恭喜发财，大吉大利"}
                    </p>
                    {claimed ? (
                        <p className="mt-2 text-3xl font-semibold tabular-nums">
                            {formatMoney(amount ?? 0)}
                        </p>
                    ) : (
                        <p className="mt-2 text-lg">
                            {packet
                                ? finished
                                    ? "手慢了，红包已被领完"
                                    : "点击开启红包"
                                : loading
                                  ? "加载中…"
                                  : "红包"}
                        </p>
                    )}
                </div>

                <div className="max-h-72 overflow-y-auto">
                    {error ? (
                        <p className="border-b border-border px-4 py-2 text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                    {canClaim ? (
                        <div className="border-b border-border p-3">
                            <Button
                                className="w-full"
                                onClick={() => void claim()}
                                disabled={claiming}
                            >
                                {claiming ? (
                                    <LoaderCircleIcon className="size-4 animate-spin" />
                                ) : (
                                    <GiftIcon className="size-4" />
                                )}
                                开
                            </Button>
                        </div>
                    ) : null}
                    {ordered.length > 0 ? (
                        <ul className="divide-y divide-border">
                            {ordered.map((record) => (
                                <li
                                    key={`${record.userId}-${record.claimedAt}`}
                                    className={cn(
                                        "flex items-center justify-between px-4 py-2.5",
                                        record.isMe &&
                                            "bg-amber-50/70 dark:bg-amber-950/30",
                                    )}
                                >
                                    <span className="flex min-w-0 items-center gap-1.5">
                                        <CheckCircle2Icon className="size-4 shrink-0 text-amber-500" />
                                        <span
                                            className={cn(
                                                "truncate text-sm",
                                                record.isMe &&
                                                    "font-medium text-amber-700 dark:text-amber-400",
                                            )}
                                        >
                                            {record.username}
                                        </span>
                                        {record.isBest ? (
                                            <span className="shrink-0 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                                                手气最佳
                                            </span>
                                        ) : null}
                                    </span>
                                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                                        {formatMoney(record.amount)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        !loading && (
                            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                                还没有人领取
                            </p>
                        )
                    )}
                </div>

                {packet ? (
                    <p className="border-t border-border px-4 py-2 text-center text-xs text-muted-foreground">
                        {packet.totalCount} 个红包 ·{" "}
                        {formatMoney(packet.totalAmount)} · 已被领{" "}
                        {packet.claimedCount} 个
                    </p>
                ) : null}
            </div>
        </div>
    );
};
