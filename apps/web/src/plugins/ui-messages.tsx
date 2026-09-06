import type { Plugin } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
import { useEffect, useRef, useState } from "react";
import type { AuthService } from "./auth";
import type { ConnStatus, RpcService } from "./connection";
import type { UiService } from "./shell";

function formatTime(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const uiMessagesPlugin: Plugin = {
    name: "ui-messages",
    inject: ["ui", "auth", "rpc"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const rpc = ctx.get<RpcService>("rpc");
        let currentSession = "general";

        const disposeChatOpen = ctx.on("ui:chat:open", (payload) => {
            const { session } = payload as { session: string };
            currentSession = session;
        });

        const Messages = () => {
            const [messages, setMessages] = useState<ChatMessage[]>([]);
            const [status, setStatus] = useState<ConnStatus>(rpc.status());
            const bottomRef = useRef<HTMLDivElement>(null);
            const sessionRef = useRef(currentSession);
            sessionRef.current = currentSession;
            const user = auth.user();

            useEffect(() => rpc.onStatus(setStatus), [rpc]);

            useEffect(() => {
                if (status !== "open") return;
                void rpc
                    .call("history.list", {
                        session: sessionRef.current,
                        limit: 50,
                    })
                    .then((result) => setMessages(result as ChatMessage[]))
                    .catch(() => undefined);
            }, [rpc, status]);

            useEffect(() => {
                const dispose = ctx.on("server:message:new", (payload) => {
                    const message = (payload as { message: ChatMessage })
                        .message;
                    if (message.session === sessionRef.current) {
                        setMessages((prev) => [...prev, message]);
                    }
                });
                return () => {
                    void dispose();
                };
            }, [ctx]);

            useEffect(() => {
                const dispose = ctx.on("ui:chat:open", () => {
                    setMessages([]);
                });
                return () => {
                    void dispose();
                };
            }, [ctx]);

            const count = messages.length;

            useEffect(() => {
                if (count > 0) {
                    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
                }
            }, [count]);

            return (
                <div className="flex flex-col gap-3">
                    {messages.map((message) => {
                        const mine = message.sender === user?.username;
                        return (
                            <div
                                key={message.id}
                                className={
                                    mine
                                        ? "flex justify-end"
                                        : "flex justify-start"
                                }
                            >
                                <div
                                    className={
                                        mine
                                            ? "max-w-[75%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground"
                                            : "max-w-[75%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm"
                                    }
                                >
                                    <div
                                        className={
                                            mine
                                                ? "text-xs opacity-70"
                                                : "text-xs text-muted-foreground"
                                        }
                                    >
                                        {message.sender} ·{" "}
                                        {formatTime(message.createdAt)}
                                    </div>
                                    <div className="mt-0.5 break-words">
                                        {message.content}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    <div ref={bottomRef} />
                </div>
            );
        };

        ui.register("messages", Messages);
        return () => disposeChatOpen();
    },
};
