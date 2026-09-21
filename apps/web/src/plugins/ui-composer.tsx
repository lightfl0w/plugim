import type { Plugin } from "@plugim/core";
import type { FileMeta, MessageKind, MessageQuote } from "@plugim/protocol";
import {
    ImageIcon,
    MicIcon,
    PaperclipIcon,
    SmileIcon,
    SquareIcon,
    XIcon,
} from "lucide-react";
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

const LIMITS: Record<MessageKind, number> = {
    text: 0,
    image: 1.5 * 1024 * 1024,
    audio: 8 * 1024 * 1024,
    video: 8 * 1024 * 1024,
    file: 20 * 1024 * 1024,
};

const MENTION_TOKEN_RE = /(^|\s)@([a-z0-9_]*)$/;

const kindFor = (mime: string): MessageKind => {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    return "file";
};

const readAsDataUrl = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
        reader.readAsDataURL(blob);
    });

export const uiComposerPlugin: Plugin = {
    name: "ui-composer",
    description: "消息输入区(表情 / 图片 / 文件 / 语音 / @提及 / 引用)",
    inject: ["ui", "rpc", "sender"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");
        const sender = ctx.get<SenderService>("sender");
        let currentSession = "";
        const sessionListeners = new Set<() => void>();
        const bumpSession = () => {
            for (const cb of sessionListeners) cb();
        };

        const disposeOpen = ctx.on("ui:chat:open", (payload) => {
            currentSession = (payload as { session: string }).session;
            bumpSession();
        });

        const Composer = () => {
            const [draft, setDraft] = useState("");
            const [quote, setQuote] = useState<MessageQuote | null>(null);
            const [status, setStatus] = useState<ConnStatus>(rpc.status());
            const [sending, setSending] = useState(false);
            const [emojiOpen, setEmojiOpen] = useState(false);
            const [mentionIndex, setMentionIndex] = useState(0);
            const [recording, setRecording] = useState(false);
            const [groupMembers, setGroupMembers] = useState<string[]>([]);
            const textareaRef = useRef<HTMLTextAreaElement>(null);
            const fileRef = useRef<HTMLInputElement>(null);
            const recorderRef = useRef<MediaRecorder | null>(null);
            const chunksRef = useRef<Blob[]>([]);

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

            useEffect(() => {
                void status;
                const load = () => {
                    if (!currentSession.startsWith("g:")) {
                        setGroupMembers([]);
                        return;
                    }
                    void rpc
                        .call("group.members", {
                            groupId: currentSession.slice(2),
                        })
                        .then((result) => {
                            const { members } = result as {
                                members: { username: string }[];
                            };
                            setGroupMembers(members.map((m) => m.username));
                        })
                        .catch(() => setGroupMembers([]));
                };
                load();
                sessionListeners.add(load);
                const dispose = ctx.on("server:group:update", load);
                return () => {
                    sessionListeners.delete(load);
                    void dispose();
                };
            }, [status]);

            const autoGrow = () => {
                const el = textareaRef.current;
                if (!el) return;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            };

            const isGroup = currentSession.startsWith("g:");
            const mentionMatch = isGroup ? MENTION_TOKEN_RE.exec(draft) : null;
            const mentionQuery = mentionMatch?.[2]?.toLowerCase() ?? null;
            const mentionPool = isGroup ? groupMembers : [];
            const candidates =
                mentionQuery === null
                    ? []
                    : mentionPool
                          .filter((name) => name.startsWith(mentionQuery))
                          .slice(0, 8);

            useEffect(() => {
                void mentionQuery;
                setMentionIndex(0);
            }, [mentionQuery]);

            const collectMentions = (text: string): string[] =>
                mentionPool.filter((name) =>
                    new RegExp(`@${name}($|\\s|[^a-z0-9_])`).test(text),
                );

            const insertMention = (name: string) => {
                setDraft((prev) =>
                    prev.replace(
                        MENTION_TOKEN_RE,
                        (_m, head: string) => `${head}@${name} `,
                    ),
                );
                requestAnimationFrame(() => {
                    textareaRef.current?.focus();
                    autoGrow();
                });
            };

            const submit = async () => {
                const content = draft.trim();
                if (!content || sending || !currentSession) return;
                setSending(true);
                try {
                    await sender.send(
                        currentSession,
                        content,
                        quote,
                        isGroup ? collectMentions(content) : null,
                    );
                    setDraft("");
                    setQuote(null);
                    autoGrow();
                } catch {
                    setDraft("");
                    setQuote(null);
                    autoGrow();
                } finally {
                    setSending(false);
                }
            };

            const sendFile = async (file: File) => {
                if (status !== "open" || sending || !currentSession) return;
                const kind = kindFor(file.type);
                if (file.size > LIMITS[kind]) {
                    alert(
                        `文件过大，${kind === "image" ? "图片" : kind === "file" ? "文件" : "音视频"}上限 ${Math.floor(LIMITS[kind] / 1024 / 1024) || Math.floor(LIMITS[kind] / 1024)}MB`,
                    );
                    return;
                }
                setSending(true);
                try {
                    const dataUrl = await readAsDataUrl(file);
                    const meta: FileMeta = { name: file.name, size: file.size };
                    await sender.send(
                        currentSession,
                        dataUrl,
                        null,
                        null,
                        kind,
                        meta,
                    );
                } catch {
                } finally {
                    setSending(false);
                }
            };

            const toggleRecording = async () => {
                if (recording) {
                    recorderRef.current?.stop();
                    return;
                }
                if (status !== "open" || sending) return;
                if (
                    typeof MediaRecorder === "undefined" ||
                    !navigator.mediaDevices?.getUserMedia
                ) {
                    alert("当前浏览器不支持录音");
                    return;
                }
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: true,
                    });
                    const recorder = new MediaRecorder(stream);
                    chunksRef.current = [];
                    recorder.ondataavailable = (e) => {
                        if (e.data.size > 0) chunksRef.current.push(e.data);
                    };
                    recorder.onstop = async () => {
                        stream.getTracks().forEach((t) => {
                            t.stop();
                        });
                        setRecording(false);
                        const blob = new Blob(chunksRef.current, {
                            type: recorder.mimeType || "audio/webm",
                        });
                        if (blob.size === 0) return;
                        if (blob.size > LIMITS.audio) {
                            alert("录音过长，请分段发送");
                            return;
                        }
                        setSending(true);
                        try {
                            const dataUrl = await readAsDataUrl(blob);
                            await sender.send(
                                currentSession,
                                dataUrl,
                                null,
                                null,
                                "audio",
                                { name: "语音消息.webm", size: blob.size },
                            );
                        } catch {
                        } finally {
                            setSending(false);
                        }
                    };
                    recorderRef.current = recorder;
                    recorder.start();
                    setRecording(true);
                } catch {
                    alert("无法访问麦克风");
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
                        active && "bg-red-50 text-red-500 hover:bg-red-100",
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

                    {candidates.length > 0 ? (
                        <div className="absolute bottom-full left-10 z-20 mb-1 w-48 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-lg">
                            <p className="px-3 py-1 text-xs text-muted-foreground">
                                群成员
                            </p>
                            {candidates.map((name, index) => (
                                <button
                                    key={name}
                                    type="button"
                                    className={cn(
                                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                                        index === mentionIndex
                                            ? "bg-accent"
                                            : "hover:bg-accent/60",
                                    )}
                                    onMouseEnter={() => setMentionIndex(index)}
                                    onClick={() => insertMention(name)}
                                >
                                    <span className="truncate">{name}</span>
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
                            () => {
                                if (fileRef.current)
                                    fileRef.current.accept = "image/*";
                                fileRef.current?.click();
                            },
                        )}
                        {toolButton(
                            "文件",
                            <PaperclipIcon className="size-5" />,
                            () => {
                                if (fileRef.current)
                                    fileRef.current.accept =
                                        "audio/*,video/*,.pdf,.zip,.rar,.7z,.txt,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx";
                                fileRef.current?.click();
                            },
                        )}
                        {toolButton(
                            recording ? "停止录音并发送" : "语音消息",
                            recording ? (
                                <SquareIcon className="size-5" />
                            ) : (
                                <MicIcon className="size-5" />
                            ),
                            () => void toggleRecording(),
                            recording,
                        )}
                        {recording ? (
                            <span className="ml-1 animate-pulse text-xs text-red-500">
                                录音中，点击停止发送
                            </span>
                        ) : null}
                        <input
                            ref={fileRef}
                            type="file"
                            className="hidden"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (file) void sendFile(file);
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
                            if (candidates.length > 0) {
                                if (e.key === "ArrowDown") {
                                    e.preventDefault();
                                    setMentionIndex(
                                        (i) => (i + 1) % candidates.length,
                                    );
                                    return;
                                }
                                if (e.key === "ArrowUp") {
                                    e.preventDefault();
                                    setMentionIndex(
                                        (i) =>
                                            (i - 1 + candidates.length) %
                                            candidates.length,
                                    );
                                    return;
                                }
                                if (e.key === "Enter" || e.key === "Tab") {
                                    e.preventDefault();
                                    insertMention(candidates[mentionIndex]);
                                    return;
                                }
                                if (e.key === "Escape") {
                                    e.preventDefault();
                                    setDraft((prev) => `${prev} `);
                                    return;
                                }
                            }
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
