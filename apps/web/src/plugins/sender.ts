import type { Plugin } from "@plugim/core";
import type {
    ChatMessage,
    FileMeta,
    MessageKind,
    MessageQuote,
} from "@plugim/protocol";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";

export interface PendingMessage {
    tempId: string;
    session: string;
    sender: string;
    content: string;
    quote: MessageQuote | null;
    mentions: string[] | null;
    kind: MessageKind;
    file: FileMeta | null;
    createdAt: string;
    state: "sending" | "failed";
    error?: string;
}

export interface PendingEvent {
    type: "add" | "fail" | "remove";
    pending: PendingMessage;
}

export interface SenderService {
    send(
        session: string,
        content: string,
        quote?: MessageQuote | null,
        mentions?: string[] | null,
        kind?: MessageKind,
        file?: FileMeta | null,
    ): Promise<ChatMessage>;
    retry(tempId: string): Promise<void>;
}

export const senderPlugin: Plugin = {
    name: "sender",
    description: "消息发送能力(乐观状态与重发)",
    provides: ["sender"],
    inject: ["rpc", "auth"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const auth = ctx.get<AuthService>("auth");
        const registry = new Map<string, PendingMessage>();

        const requestNotifyPermission = () => {
            if (
                typeof Notification !== "undefined" &&
                Notification.permission === "default"
            ) {
                void Notification.requestPermission();
            }
        };

        const service: SenderService = {
            async send(session, content, quote, mentions, kind, file) {
                requestNotifyPermission();
                const pending: PendingMessage = {
                    tempId: `tmp-${crypto.randomUUID()}`,
                    session,
                    sender: auth.user()?.username ?? "",
                    content,
                    quote: quote ?? null,
                    mentions: mentions ?? null,
                    kind: kind ?? "text",
                    file: file ?? null,
                    createdAt: new Date().toISOString(),
                    state: "sending",
                };
                registry.set(pending.tempId, pending);
                ctx.emit("chat:pending", {
                    type: "add",
                    pending,
                } satisfies PendingEvent);
                try {
                    const result = (await rpc.call("message.send", {
                        session,
                        content,
                        quote: quote ?? null,
                        mentions: mentions ?? null,
                        kind: kind ?? "text",
                        file: file ?? null,
                    })) as ChatMessage;
                    registry.delete(pending.tempId);
                    ctx.emit("chat:pending", {
                        type: "remove",
                        pending,
                    } satisfies PendingEvent);
                    return result;
                } catch (err) {
                    const failed: PendingMessage = {
                        ...pending,
                        state: "failed",
                        error: String(err instanceof Error ? err.message : err),
                    };
                    ctx.emit("chat:pending", {
                        type: "fail",
                        pending: failed,
                    } satisfies PendingEvent);
                    throw err;
                }
            },
            async retry(tempId) {
                const old = registry.get(tempId);
                if (!old) return;
                registry.delete(tempId);
                ctx.emit("chat:pending", {
                    type: "remove",
                    pending: old,
                } satisfies PendingEvent);
                await service
                    .send(
                        old.session,
                        old.content,
                        old.quote,
                        old.mentions,
                        old.kind,
                        old.file,
                    )
                    .catch(() => undefined);
            },
        };

        ctx.provide<SenderService>("sender", service);
        return undefined;
    },
};
