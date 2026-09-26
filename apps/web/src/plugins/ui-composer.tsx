import type { Context } from "@plugim/core";
import type { GroupRole, MessageQuote, TypingEvent } from "@plugim/protocol";
import { MENTION_ALL, MENTION_ALL_LABEL } from "@plugim/protocol";
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
import type { AuthService } from "./auth";
import type { ConnStatus, RpcService } from "./connection";
import type { SenderService } from "./sender";
import type { UiService } from "./ui-types";

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

const MENTION_TOKEN_RE = /(^|\s)@([a-z0-9_一-龥]*)$/;

export const uiComposerSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const rpc = ctx.get<RpcService>("rpc");
    const sender = ctx.get<SenderService>("sender");
    const auth = ctx.get<AuthService>("auth");
    let currentSession = "";
    let uploadLimitMb = 20;
    void rpc
        .call("files.info", {})
        .then((result) => {
            const { uploadLimitMb: value } = result as {
                uploadLimitMb: number;
            };
            if (value > 0) uploadLimitMb = value;
        })
        .catch(() => undefined);
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
        const [canMentionAll, setCanMentionAll] = useState(false);
        const [typers, setTypers] = useState<Record<string, number>>({});
        const textareaRef = useRef<HTMLTextAreaElement>(null);
        const fileRef = useRef<HTMLInputElement>(null);
        const recorderRef = useRef<MediaRecorder | null>(null);
        const chunksRef = useRef<Blob[]>([]);
        const typingAtRef = useRef(0);

        useEffect(() => rpc.onStatus(setStatus), []);

        useEffect(() => {
            const dispose = ctx.on("server:typing", (payload) => {
                const { session, username } = payload as TypingEvent;
                if (!session || !username) return;
                if (username === (auth.user()?.username ?? "")) return;
                setTypers((prev) => ({
                    ...prev,
                    [`${session}\n${username}`]: Date.now(),
                }));
            });
            const timer = setInterval(() => {
                setTypers((prev) => {
                    const now = Date.now();
                    let dropped = false;
                    const next: Record<string, number> = {};
                    for (const [key, at] of Object.entries(prev)) {
                        if (now - at < 4000) next[key] = at;
                        else dropped = true;
                    }
                    return dropped ? next : prev;
                });
            }, 1000);
            return () => {
                void dispose();
                clearInterval(timer);
            };
        }, []);

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
                            members: { username: string; role: GroupRole }[];
                        };
                        setGroupMembers(members.map((m) => m.username));
                        const me = auth.user()?.username ?? "";
                        const mine = members.find((m) => m.username === me);
                        setCanMentionAll(
                            mine?.role === "owner" || mine?.role === "admin",
                        );
                    })
                    .catch(() => {
                        setGroupMembers([]);
                        setCanMentionAll(false);
                    });
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

        const notifyTyping = (value: string) => {
            if (!value.trim() || !currentSession || status !== "open") return;
            const now = Date.now();
            if (now - typingAtRef.current < 2500) return;
            typingAtRef.current = now;
            void rpc
                .call("typing.send", { session: currentSession })
                .catch(() => undefined);
        };

        const typingNames = Object.keys(typers)
            .filter((key) => key.startsWith(`${currentSession}\n`))
            .map((key) => key.slice(currentSession.length + 1));

        const isGroup = currentSession.startsWith("g:");
        const mentionMatch = isGroup ? MENTION_TOKEN_RE.exec(draft) : null;
        const mentionQuery = mentionMatch?.[2]?.toLowerCase() ?? null;
        const mentionPool = isGroup ? groupMembers : [];
        const candidates =
            mentionQuery === null
                ? []
                : [
                      ...(canMentionAll &&
                      MENTION_ALL_LABEL.startsWith(mentionQuery)
                          ? [MENTION_ALL_LABEL]
                          : []),
                      ...mentionPool
                          .filter((name) => name.startsWith(mentionQuery))
                          .slice(0, 8),
                  ];

        useEffect(() => {
            void mentionQuery;
            setMentionIndex(0);
        }, [mentionQuery]);

        const collectMentions = (text: string): string[] => {
            const found = mentionPool.filter((name) =>
                new RegExp(`@${name}($|\\s|[^a-z0-9_])`).test(text),
            );
            if (canMentionAll && /@全体成员($|\s|[^a-zA-Z0-9_])/.test(text))
                found.push(MENTION_ALL);
            return found;
        };

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
            if (file.size > uploadLimitMb * 1024 * 1024) {
                alert(`文件超过 ${uploadLimitMb} MB 上限`);
                return;
            }
            setSending(true);
            try {
                await sender.sendMedia(currentSession, file, file.name);
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
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
                    if (blob.size > uploadLimitMb * 1024 * 1024) {
                        alert("录音过长，请分段发送");
                        return;
                    }
                    setSending(true);
                    try {
                        await sender.sendMedia(
                            currentSession,
                            blob,
                            "语音消息.webm",
                        );
                    } catch (err) {
                        alert(String(err instanceof Error ? err.message : err));
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
                                <span className="truncate">
                                    {name === MENTION_ALL_LABEL
                                        ? `@${MENTION_ALL_LABEL}`
                                        : name}
                                </span>
                                {name === MENTION_ALL_LABEL ? (
                                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                                        提醒所有人
                                    </span>
                                ) : null}
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
                        notifyTyping(e.target.value);
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
                    {typingNames.length > 0 ? (
                        <span className="mr-auto truncate text-xs text-muted-foreground">
                            {isGroup
                                ? `${typingNames.slice(0, 2).join("、")}${typingNames.length > 2 ? " 等" : ""} 正在输入...`
                                : "对方正在输入..."}
                        </span>
                    ) : null}
                    <span className="text-xs text-muted-foreground/70">
                        Enter 发送 / Shift+Enter 换行
                    </span>
                    <Button
                        size="sm"
                        className="rounded-md px-4"
                        disabled={status !== "open" || sending || !draft.trim()}
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
};
