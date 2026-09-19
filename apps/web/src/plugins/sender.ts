import type { Plugin } from "@plugim/core";
import type { ChatMessage, MessageQuote } from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface SenderService {
    send(
        session: string,
        content: string,
        quote?: MessageQuote | null,
    ): Promise<ChatMessage>;
}

export const senderPlugin: Plugin = {
    name: "sender",
    description: "消息发送能力",
    provides: ["sender"],
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        ctx.provide<SenderService>("sender", {
            send(session, content, quote) {
                if (
                    typeof Notification !== "undefined" &&
                    Notification.permission === "default"
                ) {
                    void Notification.requestPermission();
                }
                return rpc.call("message.send", {
                    session,
                    content,
                    quote: quote ?? null,
                }) as Promise<ChatMessage>;
            },
        });
        return undefined;
    },
};
