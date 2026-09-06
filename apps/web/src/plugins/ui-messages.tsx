import type { Plugin } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
import { useEffect, useRef, useState } from "react";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import {
    Message,
    MessageAvatar,
    MessageContent,
    MessageGroup,
    MessageHeader,
} from "../components/ui/message";
import { UserAvatar } from "../components/ui/user-avatar";
import type { AuthService } from "./auth";
import type { ConnStatus, RpcService } from "./connection";
import type { UiService } from "./shell";

function formatTime(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Group {
    sender: string;
    mine: boolean;
    items: ChatMessage[];
}

function groupMessages(messages: ChatMessage[], me: string): Group[] {
    const groups: Group[] = [];
    for (const message of messages) {
        const last = groups[groups.length - 1];
        if (last && last.sender === message.sender) {
            last.items.push(message);
        } else {
            groups.push({
                sender: message.sender,
                mine: message.sender === me,
                items: [message],
            });
        }
    }
    return groups;
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

            const groups = groupMessages(messages, user?.username ?? "");

            return (
                <div className="flex flex-col gap-4">
                    {groups.map((group) => (
                        <MessageGroup key={group.sender + group.items[0].id}>
                            {group.items.map((message) => {
                                const mine = group.mine;
                                return (
                                    <Message
                                        key={message.id}
                                        align={mine ? "end" : "start"}
                                    >
                                        <MessageAvatar>
                                            <UserAvatar name={message.sender} />
                                        </MessageAvatar>
                                        <MessageContent>
                                            <MessageHeader>
                                                {message.sender}{" "}
                                                {formatTime(message.createdAt)}
                                            </MessageHeader>
                                            <Bubble
                                                variant={
                                                    mine ? "default" : "muted"
                                                }
                                                align={mine ? "end" : "start"}
                                            >
                                                <BubbleContent
                                                    className={
                                                        mine
                                                            ? "rounded-2xl rounded-br-none"
                                                            : "rounded-2xl rounded-bl-none"
                                                    }
                                                >
                                                    {message.content}
                                                </BubbleContent>
                                            </Bubble>
                                        </MessageContent>
                                    </Message>
                                );
                            })}
                        </MessageGroup>
                    ))}
                    <div ref={bottomRef} />
                </div>
            );
        };

        ui.register("messages", Messages);
        return () => disposeChatOpen();
    },
};
