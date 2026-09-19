import type { Plugin } from "@plugim/core";
import type { MessageQuote } from "@plugim/protocol";
import { ImageIcon, SmileIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { ConnStatus, RpcService } from "./connection";
import type { SenderService } from "./sender";
import type { UiService } from "./ui";

const EMOJIS = [
    "😀",
    "😂",
    "🤣",
    "😊",
    "😍",
    "🤔",
    "😏",
    "🙄",
    "😅",
    "😭",
    "😤",
    "😢",
    "😡",
    "🥳",
    "😎",
    "🤗",
    "👍",
    "👎",
    "👏",
    "🙏",
    "❤️",
    "💔",
    "🎉",
    "🌹",
];

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

export const uiComposerPlugin: Plugin = {
    name: "ui-composer",
    description: "消息输入区(QQ 风格工具栏 / 表情 / 图片 / 引用回复)",
    inject: ["ui", "rpc", "sender"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");
        const sender = ctx.get<SenderService>("sender");
        let currentSession = "general";

        const disposeOpen = ctx.on("ui:chat:open", (payload) => {
            currentSession = (payload as { session: string }).session;
        });

        const Composer = () => {
            const [draft, setDraft] = useState("");
            const [quote, setQuote] = useState<MessageQuote | null>(null);
            const [status, setStatus] = useState<ConnStatus>(rpc.status());
            const [sending, setSending] = useState(false);
            const [emojiOpen, setEmojiOpen] = useState(false);
            const textareaRef = useRef<HTMLTextAreaElement>(null);
            const fileRef = useRef<HTMLInputElement>(null);

            useEffect(() => rpc.onStatus(setStatus), []);

            useEffect(() => {
                const dispose = ctx.on("ui:chat:quote", (payload) => {
                    const { sender: s, content } = payload as MessageQuote;
                    setQuote({ sender: s, content });
                    setEmojiOpen(false);
                    textareaRef.current?.focus();
                });
                return () => {
                    void dispose();
                };
            }, []);

            const autoGrow = () => {
                const el = textareaRef.current;
                if (!el) return;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            };

            const submit = async () => {
                const content = draft.trim();
                if (!content || sending) return;
                setSending(true);
                try {
                    await sender.send(currentSession, content, quote);
                    setDraft("");
                    setQuote(null);
                    autoGrow();
                } finally {
                    setSending(false);
                }
            };

            const sendImage = async (file: File) => {
                if (file.size > MAX_IMAGE_BYTES || !status || sending) {
                    if (file.size > MAX_IMAGE_BYTES)
                        alert("图片过大，请选择 1.5MB 以内的图片");
                    return;
                }
                setSending(true);
                try {
                    const dataUrl = await new Promise<string>(
                        (resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () =>
                                resolve(reader.result as string);
                            reader.onerror = () =>
                                reject(reader.error ?? new Error("读取失败"));
                            reader.readAsDataURL(file);
                        },
                    );
                    await sender.send(currentSession, dataUrl);
                } catch {
                } finally {
                    setSending(false);
                }
            };

            const toolButton = (
                title: string,
                icon: ReactNode,
                onClick: () => void,
                active = false,
            ) => (
                <button
                    type="button"
                    title={title}
                    onClick={onClick}
                    className={cn(
                        "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                        active && "bg-accent text-foreground",
                    )}
                >
                    {icon}
                </button>
            );

            return (
                <div className="relative flex w-full flex-col">
                    {emojiOpen ? (
                        <div className="absolute bottom-full left-2 z-20 mb-1 grid w-72 grid-cols-8 gap-0.5 rounded-xl border border-border bg-popover p-2 shadow-lg">
                            {EMOJIS.map((emoji) => (
                                <button
                                    key={emoji}
                                    type="button"
                                    className="rounded-md p-1 text-lg leading-none hover:bg-accent"
                                    onClick={() => {
                                        setDraft((prev) => prev + emoji);
                                        textareaRef.current?.focus();
                                        requestAnimationFrame(autoGrow);
                                    }}
                                >
                                    {emoji}
                                </button>
                            ))}
                        </div>
                    ) : null}

                    {quote ? (
                        <div className="mx-1 mb-1 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                            <span className="min-w-0 flex-1 truncate">
                                回复 {quote.sender}：{quote.content}
                            </span>
                            <button
                                type="button"
                                title="取消引用"
                                onClick={() => setQuote(null)}
                                className="shrink-0 rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                            >
                                <XIcon className="size-3.5" />
                            </button>
                        </div>
                    ) : null}

                    <div className="flex items-center gap-0.5 px-1">
                        {toolButton(
                            "表情",
                            <SmileIcon className="size-5" />,
                            () => setEmojiOpen((v) => !v),
                            emojiOpen,
                        )}
                        {toolButton(
                            "图片",
                            <ImageIcon className="size-5" />,
                            () => fileRef.current?.click(),
                        )}
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (file) void sendImage(file);
                            }}
                        />
                    </div>

                    <textarea
                        ref={textareaRef}
                        value={draft}
                        placeholder={
                            status === "open"
                                ? "输入消息，Enter 发送，Shift+Enter 换行"
                                : "等待连接..."
                        }
                        disabled={status !== "open"}
                        rows={2}
                        className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
                        onChange={(e) => {
                            setDraft(e.target.value);
                            autoGrow();
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void submit();
                            }
                        }}
                    />

                    <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-muted-foreground/70">
                            Enter 发送 / Shift+Enter 换行
                        </span>
                        <Button
                            size="sm"
                            className="rounded-md px-4"
                            disabled={
                                status !== "open" || sending || !draft.trim()
                            }
                            onClick={() => void submit()}
                        >
                            {sending ? "发送中" : "发送(S)"}
                        </Button>
                    </div>
                </div>
            );
        };

        const unregister = ui.register("composer", Composer);
        return () => {
            unregister();
            disposeOpen();
        };
    },
};
