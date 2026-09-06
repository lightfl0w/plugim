import type { ChatMessage } from "@plugim/protocol";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import type { ConnStatus, RpcService } from "../connection";
import type { SenderService } from "../sender";

interface AppProps {
    rpc: RpcService;
    sender: SenderService;
    onMessageNew(cb: (message: ChatMessage) => void): () => void;
    defaultSession: string;
}

const statusLabel: Record<
    ConnStatus,
    { text: string; variant: "success" | "muted" }
> = {
    open: { text: "已连接", variant: "success" },
    connecting: { text: "连接中", variant: "muted" },
    closed: { text: "已断开", variant: "muted" },
};

function formatTime(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function App({ rpc, sender, onMessageNew, defaultSession }: AppProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [draft, setDraft] = useState("");
    const [status, setStatus] = useState<ConnStatus>(rpc.status());
    const [sending, setSending] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => rpc.onStatus(setStatus), [rpc]);

    useEffect(() => {
        void rpc
            .call("history.list", { session: defaultSession, limit: 50 })
            .then((result) => setMessages(result as ChatMessage[]))
            .catch(() => undefined);
    }, [rpc, defaultSession]);

    useEffect(
        () =>
            onMessageNew((message) =>
                setMessages((prev) => [...prev, message]),
            ),
        [onMessageNew],
    );

    const messageCount = messages.length;

    useEffect(() => {
        if (messageCount > 0) {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        }
    }, [messageCount]);

    const submit = async () => {
        const content = draft.trim();
        if (!content || sending) return;
        setSending(true);
        try {
            await sender.send(defaultSession, content);
            setDraft("");
        } finally {
            setSending(false);
        }
    };

    const badge = statusLabel[status];

    return (
        <div className="flex h-full items-center justify-center p-4">
            <Card className="flex h-full max-h-[720px] w-full max-w-xl flex-col">
                <CardHeader className="flex-row items-center justify-between border-b border-border">
                    <Badge variant={badge.variant}>{badge.text}</Badge>
                </CardHeader>
                <CardContent className="flex-1 overflow-y-auto p-4">
                    <div className="flex flex-col gap-3">
                        {messages.map((message) => {
                            const mine = message.sender === "me";
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
                </CardContent>
                <CardFooter className="gap-2 border-t border-border py-4">
                    <Input
                        value={draft}
                        placeholder={
                            status === "open" ? "输入消息…" : "等待连接…"
                        }
                        disabled={status !== "open"}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void submit();
                        }}
                    />
                    <Button
                        disabled={status !== "open" || sending || !draft.trim()}
                        onClick={() => void submit()}
                        className="whitespace-nowrap"
                    >
                        发送
                    </Button>
                </CardFooter>
            </Card>
        </div>
    );
}
