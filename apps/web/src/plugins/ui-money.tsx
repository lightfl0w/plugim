import type {
    AABillDetail,
    AABillInfo,
    ChatMessage,
    TransferInfo,
    TransferSummary,
} from "@plugim/protocol";
import {
    ArrowRightLeftIcon,
    CheckIcon,
    LoaderCircleIcon,
    ReceiptIcon,
    XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { formatMoney, parseMoneyInput } from "./ui-redpacket";
import { usePopupClose } from "./ui-shared";

const STATE_LABEL: Record<TransferInfo["state"], string> = {
    pending: "待收款",
    accepted: "已收款",
    rejected: "已拒绝",
    refunded: "已退回",
};

export const TransferCard = ({
    message,
    mine,
    states,
    onOpen,
}: {
    message: ChatMessage;
    mine: boolean;
    states?: Record<string, TransferInfo["state"]>;
    onOpen: (transferId: string) => void;
}) => {
    const info = message.transfer;
    if (!info) return null;
    const state = states?.[info.id] ?? info.state;
    return (
        <button
            type="button"
            onClick={() => onOpen(info.id)}
            className={cn(
                "flex w-56 flex-col gap-1 rounded-lg p-2.5 text-left transition-colors",
                mine
                    ? "bg-amber-500/90 text-white hover:bg-amber-500"
                    : "bg-amber-500 text-white hover:bg-amber-600",
            )}
        >
            <span className="flex items-center gap-1.5">
                <ArrowRightLeftIcon className="size-4 shrink-0" />
                <span className="truncate text-sm">
                    {info.message || "转账"}
                </span>
            </span>
            <span className="text-sm font-semibold tabular-nums">
                {formatMoney(info.amount)}
            </span>
            <span className="text-xs text-white/80">{STATE_LABEL[state]}</span>
        </button>
    );
};

export const TransferCreateDialog = ({
    open,
    sessionId,
    toUsername,
    balance,
    busy,
    onClose,
    onSubmit,
    onTopup,
}: {
    open: boolean;
    sessionId: string;
    toUsername: string;
    balance: number | null;
    busy: boolean;
    onClose: () => void;
    onSubmit: (params: {
        sessionId: string;
        toUsername: string;
        amount: number;
        message?: string;
    }) => Promise<void>;
    onTopup: (amount: number) => Promise<void>;
}) => {
    const [amount, setAmount] = useState("");
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [showTopup, setShowTopup] = useState(false);
    const [topupAmount, setTopupAmount] = useState("100");

    useEffect(() => {
        if (open) {
            setAmount("");
            setMessage("");
            setError("");
            setShowTopup(false);
            setTopupAmount("100");
        }
    }, [open]);

    if (!open) return null;
    const cents = parseMoneyInput(amount);
    const short =
        balance !== null && cents !== null && cents > balance
            ? `余额不足，还差 ${formatMoney(cents - balance)}`
            : "";
    const topupCents = parseMoneyInput(topupAmount);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
            <DialogShell title="转账" onClose={onClose}>
                <p className="mb-3 text-sm text-muted-foreground">
                    转给 <span className="text-foreground">{toUsername}</span>
                    {balance !== null ? (
                        <span className="ml-2 tabular-nums">
                            余额 {formatMoney(balance)}
                        </span>
                    ) : null}
                </p>
                <label
                    htmlFor="transfer-amount"
                    className="flex flex-col gap-1.5"
                >
                    <span className="text-sm text-muted-foreground">
                        转账金额（元）
                    </span>
                    <Input
                        id="transfer-amount"
                        value={amount}
                        inputMode="decimal"
                        placeholder="0.00"
                        className={cn(short && "border-destructive")}
                        onChange={(e) => setAmount(e.target.value)}
                    />
                    {short ? (
                        <span className="text-xs text-destructive">
                            {short}
                        </span>
                    ) : null}
                </label>
                <label
                    htmlFor="transfer-message"
                    className="mt-3 flex flex-col gap-1.5"
                >
                    <span className="text-sm text-muted-foreground">
                        转账说明（选填）
                    </span>
                    <Input
                        id="transfer-message"
                        value={message}
                        maxLength={50}
                        placeholder="给点零花钱"
                        onChange={(e) => setMessage(e.target.value)}
                    />
                </label>

                {short ? (
                    <button
                        type="button"
                        className="mt-3 text-xs text-primary underline-offset-2 hover:underline"
                        onClick={() => setShowTopup((v) => !v)}
                    >
                        {showTopup ? "收起充值" : "余额不足，去充值"}
                    </button>
                ) : null}

                {showTopup ? (
                    <div className="mt-2 flex items-end gap-2 rounded-lg bg-muted p-2.5">
                        <label
                            htmlFor="transfer-topup"
                            className="flex flex-1 flex-col gap-1"
                        >
                            <span className="text-xs text-muted-foreground">
                                充值金额（元，演示用，不涉及真实支付）
                            </span>
                            <Input
                                id="transfer-topup"
                                value={topupAmount}
                                inputMode="decimal"
                                onChange={(e) => setTopupAmount(e.target.value)}
                            />
                        </label>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={topupCents === null}
                            onClick={async () => {
                                if (topupCents === null) return;
                                setError("");
                                try {
                                    await onTopup(topupCents);
                                } catch (err) {
                                    setError(
                                        err instanceof Error
                                            ? err.message
                                            : "充值失败",
                                    );
                                }
                            }}
                        >
                            充值
                        </Button>
                    </div>
                ) : null}

                {error ? (
                    <p className="mt-3 text-sm text-destructive">{error}</p>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose}>
                        取消
                    </Button>
                    <Button
                        disabled={busy || cents === null || short !== ""}
                        onClick={async () => {
                            if (cents === null) return;
                            setError("");
                            try {
                                await onSubmit({
                                    sessionId,
                                    toUsername,
                                    amount: cents,
                                    message: message.trim() || undefined,
                                });
                            } catch (err) {
                                setError(
                                    err instanceof Error
                                        ? err.message
                                        : "转账失败",
                                );
                            }
                        }}
                    >
                        {busy ? (
                            <LoaderCircleIcon className="size-4 animate-spin" />
                        ) : (
                            <ArrowRightLeftIcon className="size-4" />
                        )}
                        确认转账
                    </Button>
                </div>
            </DialogShell>
        </div>
    );
};

export const TransferOpenDialog = ({
    open,
    transferId,
    myId,
    service,
    onClose,
    onSettled,
}: {
    open: boolean;
    transferId: string;
    myId: string;
    service: {
        detail(params: {
            transferId: string;
        }): Promise<{ transfer: TransferSummary }>;
        accept(params: {
            transferId: string;
        }): Promise<{ transfer: TransferSummary; myBalance: number }>;
        reject(params: {
            transferId: string;
        }): Promise<{ transfer: TransferSummary; myBalance: number }>;
    };
    onClose: () => void;
    onSettled: (transferId: string, state: TransferInfo["state"]) => void;
}) => {
    const [item, setItem] = useState<TransferSummary | null>(null);
    const [loading, setLoading] = useState(false);
    const [acting, setActing] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        if (!open || !transferId) return;
        setLoading(true);
        setError("");
        try {
            const next = await service.detail({ transferId });
            setItem(next.transfer);
        } catch (err) {
            setError(err instanceof Error ? err.message : "转账加载失败");
        } finally {
            setLoading(false);
        }
    }, [open, transferId, service]);

    useEffect(() => {
        if (open) {
            setItem(null);
            void load();
        }
    }, [open, load]);

    if (!open) return null;
    const receivable = item !== null && item.toId === myId;
    const pending = item?.state === "pending";

    const act = async (action: "accept" | "reject") => {
        if (acting || !item) return;
        setActing(true);
        setError("");
        try {
            const next =
                action === "accept"
                    ? await service.accept({ transferId: item.id })
                    : await service.reject({ transferId: item.id });
            setItem(next.transfer);
            onSettled(item.id, next.transfer.state);
        } catch (err) {
            setError(err instanceof Error ? err.message : "操作失败");
            await load();
        } finally {
            setActing(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
            <DialogShell title="转账详情" onClose={onClose}>
                {item ? (
                    <div className="flex flex-col gap-3">
                        <div className="rounded-lg bg-muted p-3">
                            <p className="text-xs text-muted-foreground">
                                {item.fromName} 转给 {item.toName}
                            </p>
                            <p className="mt-1 text-2xl font-semibold tabular-nums">
                                {formatMoney(item.amount)}
                            </p>
                            {item.message ? (
                                <p className="mt-1 text-sm">{item.message}</p>
                            ) : null}
                        </div>
                        <p className="text-sm text-muted-foreground">
                            状态：{STATE_LABEL[item.state]}
                        </p>
                        {receivable && pending ? (
                            <div className="flex gap-2">
                                <Button
                                    className="flex-1"
                                    disabled={acting}
                                    onClick={() => void act("accept")}
                                >
                                    {acting ? (
                                        <LoaderCircleIcon className="size-4 animate-spin" />
                                    ) : (
                                        <CheckIcon className="size-4" />
                                    )}
                                    收款
                                </Button>
                                <Button
                                    className="flex-1"
                                    variant="outline"
                                    disabled={acting}
                                    onClick={() => void act("reject")}
                                >
                                    退还
                                </Button>
                            </div>
                        ) : null}
                        {!receivable && pending ? (
                            <p className="text-xs text-muted-foreground">
                                等待对方确认收款
                            </p>
                        ) : null}
                        {error ? (
                            <p className="text-sm text-destructive">{error}</p>
                        ) : null}
                    </div>
                ) : loading ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        加载中…
                    </p>
                ) : (
                    <p className="py-6 text-center text-sm text-destructive">
                        {error || "转账不存在"}
                    </p>
                )}
            </DialogShell>
        </div>
    );
};

export const AABillCard = ({
    message,
    mine,
    states,
    settled,
    onOpen,
}: {
    message: ChatMessage;
    mine: boolean;
    states?: Record<string, "pending" | "settled" | "cancelled">;
    settled?: Record<string, number>;
    onOpen: (billId: string) => void;
}) => {
    const info: AABillInfo | null | undefined = message.aaBill;
    if (!info) return null;
    const status = states?.[info.id] ?? info.status;
    const doneAmount = settled?.[info.id] ?? info.settledAmount;
    return (
        <button
            type="button"
            onClick={() => onOpen(info.id)}
            className={cn(
                "flex w-60 flex-col gap-1 rounded-lg p-2.5 text-left transition-colors",
                mine
                    ? "bg-emerald-500/90 text-white hover:bg-emerald-500"
                    : "bg-emerald-600 text-white hover:bg-emerald-700",
            )}
        >
            <span className="flex items-center gap-1.5">
                <ReceiptIcon className="size-4 shrink-0" />
                <span className="truncate text-sm">
                    {info.description || "AA 账单"}
                </span>
            </span>
            <span className="text-sm font-semibold tabular-nums">
                总额 {formatMoney(info.totalAmount)}
            </span>
            <span className="text-xs text-white/85">
                {status === "settled"
                    ? "已结清"
                    : status === "cancelled"
                      ? "已取消"
                      : `已收 ${formatMoney(doneAmount)} ${info.participantIds.length} 人`}
            </span>
        </button>
    );
};

export const AABillCreateDialog = ({
    open,
    sessionId,
    busy,
    members,
    onClose,
    onSubmit,
}: {
    open: boolean;
    sessionId: string;
    busy: boolean;
    members: { userId: string; username: string }[];
    onClose: () => void;
    onSubmit: (params: {
        sessionId: string;
        description: string;
        totalAmount: number;
        participantIds: string[];
        splitType: "equal" | "custom";
        customSplits?: Record<string, number>;
    }) => Promise<void>;
}) => {
    const [description, setDescription] = useState("");
    const [total, setTotal] = useState("");
    const [error, setError] = useState("");
    const [picked, setPicked] = useState<Record<string, boolean>>({});
    const [custom, setCustom] = useState<Record<string, string>>({});

    useEffect(() => {
        if (open) {
            setDescription("");
            setTotal("");
            setError("");
            setPicked({});
            setCustom({});
        }
    }, [open]);

    if (!open) return null;
    const cents = parseMoneyInput(total);
    const chosen = members.filter((m) => picked[m.userId]);
    const splitType = Object.values(custom).some(
        (v) => parseMoneyInput(v) !== null,
    )
        ? "custom"
        : "equal";
    const customSplits =
        splitType === "custom"
            ? Object.fromEntries(
                  chosen
                      .map((m) => [
                          m.userId,
                          parseMoneyInput(custom[m.userId] ?? ""),
                      ])
                      .filter(
                          (entry): entry is [string, number] =>
                              entry[1] !== null,
                      ),
              )
            : undefined;
    const customSum =
        customSplits === undefined
            ? 0
            : Object.values(customSplits).reduce((a, b) => a + b, 0);
    const splitError =
        splitType === "custom"
            ? customSplits &&
              Object.keys(customSplits).length === chosen.length &&
              cents !== null &&
              customSum !== cents
                ? `自定义分摊之和（${formatMoney(customSum)}）需等于总额`
                : ""
            : cents !== null && chosen.length > 0 && cents < chosen.length
              ? "总额不足以按人数均分"
              : "";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
            <DialogShell title="发起 AA 账单" onClose={onClose}>
                <label
                    htmlFor="aa-description"
                    className="flex flex-col gap-1.5"
                >
                    <span className="text-sm text-muted-foreground">
                        账单说明
                    </span>
                    <Input
                        id="aa-description"
                        value={description}
                        maxLength={50}
                        placeholder="周末聚餐"
                        onChange={(e) => setDescription(e.target.value)}
                    />
                </label>
                <label
                    htmlFor="aa-total"
                    className="mt-3 flex flex-col gap-1.5"
                >
                    <span className="text-sm text-muted-foreground">
                        账单总额（元）
                    </span>
                    <Input
                        id="aa-total"
                        value={total}
                        inputMode="decimal"
                        placeholder="0.00"
                        onChange={(e) => setTotal(e.target.value)}
                    />
                </label>

                <div className="mt-3">
                    <span className="text-sm text-muted-foreground">
                        参与分摊的人（默认按人数均分，填入金额可单独指定）
                    </span>
                    <ul className="mt-1.5 max-h-52 overflow-y-auto rounded-lg border border-border">
                        {members.length === 0 ? (
                            <li className="px-3 py-3 text-sm text-muted-foreground">
                                还没有可选的成员
                            </li>
                        ) : null}
                        {members.map((member) => (
                            <li
                                key={member.userId}
                                className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                            >
                                <input
                                    type="checkbox"
                                    className="size-4"
                                    checked={!!picked[member.userId]}
                                    onChange={(e) =>
                                        setPicked((prev) => ({
                                            ...prev,
                                            [member.userId]: e.target.checked,
                                        }))
                                    }
                                />
                                <span className="min-w-0 flex-1 truncate text-sm">
                                    {member.username}
                                </span>
                                <Input
                                    className="h-8 w-24 text-sm"
                                    placeholder={
                                        cents !== null && picked[member.userId]
                                            ? formatMoney(
                                                  Math.floor(
                                                      cents /
                                                          (chosen.length || 1),
                                                  ),
                                              )
                                            : "均分"
                                    }
                                    inputMode="decimal"
                                    value={custom[member.userId] ?? ""}
                                    onChange={(e) =>
                                        setCustom((prev) => ({
                                            ...prev,
                                            [member.userId]: e.target.value,
                                        }))
                                    }
                                />
                            </li>
                        ))}
                    </ul>
                    {splitError ? (
                        <span className="mt-1 text-xs text-destructive">
                            {splitError}
                        </span>
                    ) : null}
                </div>

                {error ? (
                    <p className="mt-3 text-sm text-destructive">{error}</p>
                ) : null}
                <div className="mt-4 flex justify-end gap-2">
                    <Button variant="outline" onClick={onClose}>
                        取消
                    </Button>
                    <Button
                        disabled={
                            busy ||
                            cents === null ||
                            chosen.length === 0 ||
                            splitError !== ""
                        }
                        onClick={async () => {
                            if (cents === null) return;
                            setError("");
                            try {
                                await onSubmit({
                                    sessionId,
                                    description:
                                        description.trim() || "AA 账单",
                                    totalAmount: cents,
                                    participantIds: chosen.map((m) => m.userId),
                                    splitType,
                                    customSplits,
                                });
                            } catch (err) {
                                setError(
                                    err instanceof Error
                                        ? err.message
                                        : "创建失败",
                                );
                            }
                        }}
                    >
                        {busy ? (
                            <LoaderCircleIcon className="size-4 animate-spin" />
                        ) : (
                            <ReceiptIcon className="size-4" />
                        )}
                        发起账单
                    </Button>
                </div>
            </DialogShell>
        </div>
    );
};

export const AABillOpenDialog = ({
    open,
    billId,
    myId,
    service,
    onClose,
    onChanged,
}: {
    open: boolean;
    billId: string;
    myId: string;
    service: {
        detail(params: { billId: string }): Promise<AABillDetail>;
        pay(params: {
            billId: string;
            amount?: number;
        }): Promise<{ detail: AABillDetail; myBalance: number }>;
        cancel(params: { billId: string }): Promise<{ detail: AABillDetail }>;
    };
    onClose: () => void;
    onChanged: (billId: string, detail: AABillDetail) => void;
}) => {
    const [detail, setDetail] = useState<AABillDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [acting, setActing] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        if (!open || !billId) return;
        setLoading(true);
        setError("");
        try {
            setDetail(await service.detail({ billId }));
        } catch (err) {
            setError(err instanceof Error ? err.message : "账单加载失败");
        } finally {
            setLoading(false);
        }
    }, [open, billId, service]);

    useEffect(() => {
        if (open) {
            setDetail(null);
            void load();
        }
    }, [open, load]);

    if (!open) return null;
    const bill = detail?.bill;
    const isCreator = bill?.creatorId === myId;
    const canPay =
        detail !== null &&
        !detail.paid &&
        detail.share > 0 &&
        detail.bill.status === "pending";

    const run = async (fn: () => Promise<{ detail: AABillDetail }>) => {
        if (acting) return;
        setActing(true);
        setError("");
        try {
            const next = await fn();
            setDetail(next.detail);
            if (bill) onChanged(bill.id, next.detail);
        } catch (err) {
            setError(err instanceof Error ? err.message : "操作失败");
            await load();
        } finally {
            setActing(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
            <DialogShell title="AA 账单" onClose={onClose}>
                {detail && bill ? (
                    <div className="flex flex-col gap-3">
                        <div className="rounded-lg bg-muted p-3">
                            <p className="text-sm font-medium">
                                {bill.description}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {detail.creatorName} 发起 总额{" "}
                                <span className="tabular-nums">
                                    {formatMoney(bill.totalAmount)}
                                </span>
                            </p>
                            <p className="mt-1 text-sm">
                                已收{" "}
                                <span className="tabular-nums">
                                    {formatMoney(detail.bill.settledAmount)}
                                </span>
                                {bill.status === "settled"
                                    ? " 已结清"
                                    : bill.status === "cancelled"
                                      ? " 已取消"
                                      : detail.overdue
                                        ? " 已逾期"
                                        : ""}
                            </p>
                        </div>

                        <ul className="divide-y divide-border rounded-lg border border-border">
                            {detail.members.map((member) => (
                                <li
                                    key={member.userId}
                                    className="flex items-center justify-between px-3 py-2 text-sm"
                                >
                                    <span className="flex items-center gap-1.5">
                                        {member.paid ? (
                                            <CheckIcon className="size-3.5 text-emerald-500" />
                                        ) : (
                                            <span className="inline-block size-3.5" />
                                        )}
                                        <span className="truncate">
                                            {member.username}
                                        </span>
                                    </span>
                                    <span className="tabular-nums text-muted-foreground">
                                        {formatMoney(member.share)}
                                        {member.paid ? " 已付" : " 未付"}
                                    </span>
                                </li>
                            ))}
                        </ul>

                        {error ? (
                            <p className="text-sm text-destructive">{error}</p>
                        ) : null}

                        <div className="flex gap-2">
                            {canPay ? (
                                <Button
                                    className="flex-1"
                                    disabled={acting}
                                    onClick={() =>
                                        void run(() =>
                                            service.pay({
                                                billId: bill.id,
                                                amount: detail?.share,
                                            }),
                                        )
                                    }
                                >
                                    {acting ? (
                                        <LoaderCircleIcon className="size-4 animate-spin" />
                                    ) : (
                                        <CheckIcon className="size-4" />
                                    )}
                                    我已付款
                                </Button>
                            ) : null}
                            {isCreator && bill.status === "pending" ? (
                                <Button
                                    variant="outline"
                                    disabled={acting}
                                    onClick={() =>
                                        void run(() =>
                                            service.cancel({ billId: bill.id }),
                                        )
                                    }
                                >
                                    取消账单
                                </Button>
                            ) : null}
                        </div>
                        {detail.paid ? (
                            <p className="text-xs text-muted-foreground">
                                你已支付 {formatMoney(detail.paidAmount)}
                            </p>
                        ) : null}
                    </div>
                ) : loading ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        加载中…
                    </p>
                ) : (
                    <p className="py-6 text-center text-sm text-destructive">
                        {error || "账单不存在"}
                    </p>
                )}
            </DialogShell>
        </div>
    );
};

const DialogShell = ({
    title,
    onClose,
    children,
}: {
    title: string;
    onClose: () => void;
    children: ReactNode;
}) => {
    const ref = useRef<HTMLDivElement>(null);
    usePopupClose(ref, true, onClose);
    return (
        <div
            ref={ref}
            className="w-full max-w-sm rounded-xl bg-background p-4 shadow-xl"
        >
            <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold">{title}</h2>
                <button
                    type="button"
                    aria-label="关闭"
                    className="rounded p-1 text-muted-foreground hover:bg-accent"
                    onClick={onClose}
                >
                    <XIcon className="size-4" />
                </button>
            </div>
            {children}
        </div>
    );
};
