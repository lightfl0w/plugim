import type { Plugin } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
import { createRoot } from "react-dom/client";
import { App } from "./chat-ui/App";
import type { RpcService } from "./connection";
import type { SenderService } from "./sender";

interface ChatUiProps {
    rpc: RpcService;
    sender: SenderService;
    onMessageNew(cb: (message: ChatMessage) => void): () => void;
    defaultSession: string;
}

export const chatUiPlugin: Plugin = {
    name: "chat-ui",
    inject: ["rpc", "sender"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const sender = ctx.get<SenderService>("sender");
        const props: ChatUiProps = {
            rpc,
            sender,
            onMessageNew: (cb) =>
                ctx.on("server:message:new", (payload) =>
                    cb((payload as { message: ChatMessage }).message),
                ),
            defaultSession: "general",
        };
        const root = document.getElementById("root");
        if (!root) throw new Error("missing #root element");
        createRoot(root).render(<App {...props} />);
        return undefined;
    },
};
