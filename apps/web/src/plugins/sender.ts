import type { Plugin } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface SenderService {
    send(
        session: string,
        content: string,
        sender?: string,
    ): Promise<ChatMessage>;
}

export const senderPlugin: Plugin = {
    name: "sender",
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        ctx.provide<SenderService>("sender", {
            send(session, content, sender = "me") {
                return rpc.call("message.send", {
                    session,
                    sender,
                    content,
                }) as Promise<ChatMessage>;
            },
        });
        return undefined;
    },
};
