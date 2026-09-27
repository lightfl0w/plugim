import type { Context } from "@plugim/core";
import type {
    ChatMessage,
    LinkPreview,
    MomentPost,
    MomentVisibility,
} from "@plugim/protocol";
import {
    ArrowLeftIcon,
    CheckIcon,
    FilmIcon,
    HeartIcon,
    ImagePlusIcon,
    MessageCircleIcon,
    RefreshCwIcon,
    ShareIcon,
    Trash2Icon,
    XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { FriendsService } from "./friends";
import type { GroupsService } from "./groups";
import type { MomentsService } from "./moments";
import type { SenderService } from "./sender";
import { displayName } from "./ui-shared";
import type { UiService } from "./ui-types";

const MAX_IMAGES = 9;
const EMPTY_NAMES: string[] = [];

const VISIBILITY_OPTIONS: { value: MomentVisibility; label: string }[] = [
    { value: "public", label: "公开" },
    { value: "friends", label: "仅好友" },
    { value: "partial", label: "部分可见" },
    { value: "exclude", label: "不给谁看" },
];

const needsAudience = (visibility: MomentVisibility) =>
    visibility === "partial" || visibility === "exclude";

const visibilityLabel = (post: MomentPost): string => {
    if (post.visibility === "friends") return "仅好友";
    if (post.visibility === "partial")
        return post.audience.length
            ? `部分可见：${post.audience.join("、")}`
            : "部分可见";
    if (post.visibility === "exclude")
        return post.audience.length
            ? `不给 ${post.audience.join("、")} 看`
            : "不给谁看";
    return "";
};

const pad = (value: number) => String(value).padStart(2, "0");

const timeLabel = (iso: string): string => {
    const at = new Date(iso);
    const diff = Date.now() - at.getTime();
    if (!Number.isFinite(diff)) return "";
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    const clock = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return at.getFullYear() === new Date().getFullYear()
        ? clock
        : `${at.getFullYear()}-${clock}`;
};

const gridClass = (count: number) =>
    count === 1
        ? "grid-cols-1"
        : count === 2 || count === 4
          ? "grid-cols-2"
          : "grid-cols-3";

const URL_RE = /https?:\/\/[^\s<>"']+/i;

const detectUrl = (text: string): string | null => {
    const match = URL_RE.exec(text);
    if (!match) return null;
    const url = match[0].replace(/[),.;!?，。；！？、）】]+$/, "");
    if (url.length <= 8) return null;
    try {
        return new URL(url).hostname ? url : null;
    } catch {
        return null;
    }
};

const withoutUrl = (text: string, url: string): string =>
    text.replace(url, "").trim();

const PREVIEW_DELAY_MS = 400;

const requestNotifyPermission = () => {
    if (
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
    ) {
        void Notification.requestPermission();
    }
};

export const uiMomentsSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const moments = ctx.get<MomentsService>("moments");
    const sender = ctx.get<SenderService>("sender");
    const auth = ctx.get<AuthService>("auth");
    const friendService = ctx.get<FriendsService>("friends");
    const groupService = ctx.get<GroupsService>("groups");

    const useMomentsState = () =>
        useSyncExternalStore(
            (cb) => moments.onUpdate(cb),
            () => moments.state(),
            () => moments.state(),
        );

    const useMe = () =>
        useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.user()?.username ?? "",
        );

    const useRestoring = () =>
        useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.restoring(),
        );

    const useFriendNames = () =>
        useSyncExternalStore(
            (cb) => friendService.onUpdate(cb),
            () => friendService.cached()?.friends ?? EMPTY_NAMES,
            () => friendService.cached()?.friends ?? EMPTY_NAMES,
        );

    const useGroups = () =>
        useSyncExternalStore(
            (cb) => groupService.onUpdate(cb),
            () => groupService.cached(),
            () => groupService.cached(),
        );

    const AudienceDialog = ({
        title,
        picked,
        onToggle,
        onClose,
    }: {
        title: string;
        picked: string[];
        onToggle: (name: string) => void;
        onClose: () => void;
    }) => {
        const names = useFriendNames();
        const remarks = friendService.cached()?.remarks ?? {};
        const loaded = friendService.cached() !== null;

        return (
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(event) => {
                    if (event.target === event.currentTarget) onClose();
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") onClose();
                }}
            >
                <div className="flex max-h-[70vh] w-full max-w-sm flex-col rounded-xl border border-border bg-card shadow-xl">
                    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                        <p className="flex-1 text-sm font-semibold">{title}</p>
                        <button
                            type="button"
                            aria-label="关闭"
                            className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                            onClick={onClose}
                        >
                            <XIcon className="size-4" />
                        </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto py-1">
                        {names.length === 0 ? (
                            <p className="py-8 text-center text-xs text-muted-foreground">
                                {loaded
                                    ? "还没有好友，先去添加好友吧"
                                    : "正在加载好友…"}
                            </p>
                        ) : null}
                        {names.map((name) => (
                            <button
                                key={name}
                                type="button"
                                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-accent/60"
                                onClick={() => onToggle(name)}
                            >
                                <UserAvatar name={name} size="sm" />
                                <span className="min-w-0 flex-1 truncate">
                                    {displayName(name, remarks)}
                                </span>
                                {picked.includes(name) ? (
                                    <CheckIcon className="size-4 text-primary" />
                                ) : null}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-2 border-t border-border px-4 py-3">
                        <span className="text-xs text-muted-foreground">
                            已选 {picked.length} 人
                        </span>
                        <Button
                            size="sm"
                            className="ml-auto"
                            disabled={picked.length === 0}
                            onClick={onClose}
                        >
                            确定
                        </Button>
                    </div>
                </div>
            </div>
        );
    };

    const ShareDialog = ({
        post,
        onClose,
    }: {
        post: MomentPost;
        onClose: () => void;
    }) => {
        const names = useFriendNames();
        const groups = useGroups();
        const [picked, setPicked] = useState<string[]>([]);
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const remarks = friendService.cached()?.remarks ?? {};
        const targets = [
            ...names.map((username) => ({
                key: `p2p:${username}`,
                label: displayName(username, remarks),
                group: "好友" as const,
            })),
            ...(groups ?? []).map((group) => ({
                key: `g:${group.id}`,
                label: group.name,
                group: "群组" as const,
            })),
        ];

        useEffect(() => {
            void friendService.refresh().catch(() => undefined);
            void groupService.refresh().catch(() => undefined);
        }, []);

        const toggle = (key: string) =>
            setPicked((prev) =>
                prev.includes(key)
                    ? prev.filter((item) => item !== key)
                    : [...prev, key],
            );

        const submit = async () => {
            setBusy(true);
            setError("");
            try {
                await moments.forward(post.id, picked);
                onClose();
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setBusy(false);
            }
        };

        const summary =
            post.content ||
            (post.images.length
                ? `[图片 ${post.images.length} 张]`
                : post.video
                  ? "[视频动态]"
                  : "[动态]");

        return (
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                role="dialog"
                aria-modal="true"
                aria-label="分享动态"
                onClick={(event) => {
                    if (event.target === event.currentTarget) onClose();
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") onClose();
                }}
            >
                <div className="flex max-h-[70vh] w-full max-w-sm flex-col rounded-xl border border-border bg-card shadow-xl">
                    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                        <p className="flex-1 text-sm font-semibold">分享动态</p>
                        <button
                            type="button"
                            aria-label="关闭"
                            className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                            onClick={onClose}
                        >
                            <XIcon className="size-4" />
                        </button>
                    </div>
                    <p className="truncate border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                        {post.author}: {summary}
                    </p>
                    <div className="min-h-0 flex-1 overflow-y-auto py-1">
                        {targets.length === 0 ? (
                            <p className="py-8 text-center text-xs text-muted-foreground">
                                还没有可分享的会话
                            </p>
                        ) : null}
                        {(["好友", "群组"] as const).map((label) => {
                            const items = targets.filter(
                                (target) => target.group === label,
                            );
                            if (items.length === 0) return null;
                            return (
                                <div key={label}>
                                    <p className="px-4 pt-2 pb-1 text-xs font-semibold text-muted-foreground">
                                        {label}
                                    </p>
                                    {items.map((target) => (
                                        <button
                                            key={target.key}
                                            type="button"
                                            className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-accent/60"
                                            onClick={() => toggle(target.key)}
                                        >
                                            <span
                                                className={cn(
                                                    "flex size-4 items-center justify-center rounded border",
                                                    picked.includes(target.key)
                                                        ? "border-primary bg-primary text-primary-foreground"
                                                        : "border-border",
                                                )}
                                            >
                                                {picked.includes(target.key) ? (
                                                    <CheckIcon className="size-3" />
                                                ) : null}
                                            </span>
                                            <span className="truncate">
                                                {target.label}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                    {error ? (
                        <p className="mx-4 mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex items-center gap-2 border-t border-border px-4 py-3">
                        <p className="flex-1 text-xs text-muted-foreground">
                            已选 {picked.length} 个会话
                        </p>
                        <Button
                            size="sm"
                            disabled={picked.length === 0 || busy}
                            onClick={() => void submit()}
                        >
                            {busy ? "分享中" : "分享"}
                        </Button>
                    </div>
                </div>
            </div>
        );
    };

    const Composer = () => {
        const [content, setContent] = useState("");
        const [images, setImages] = useState<string[]>([]);
        const [video, setVideo] = useState<string | null>(null);
        const [visibility, setVisibility] =
            useState<MomentVisibility>("public");
        const [audience, setAudience] = useState<string[]>([]);
        const [picking, setPicking] = useState(false);
        const [busy, setBusy] = useState(false);
        const [uploading, setUploading] = useState(false);
        const [error, setError] = useState("");
        const [link, setLink] = useState<LinkPreview | null>(null);
        const [linkState, setLinkState] = useState<
            "idle" | "loading" | "ready" | "error"
        >("idle");
        const [linkError, setLinkError] = useState("");
        const [linkDismissed, setLinkDismissed] = useState<string | null>(null);
        const previewSeq = useRef(0);
        const fileRef = useRef<HTMLInputElement>(null);
        const videoRef = useRef<HTMLInputElement>(null);
        const detected = detectUrl(content);
        const canLink = images.length === 0 && !video;

        useEffect(() => {
            void friendService.refresh().catch(() => undefined);
        }, []);

        useEffect(() => {
            previewSeq.current += 1;
            const seq = previewSeq.current;
            setLink(null);
            setLinkState("idle");
            setLinkError("");
            if (!detected) {
                setLinkDismissed(null);
                return;
            }
            if (!canLink || linkDismissed === detected) return;
            setLinkState("loading");
            const timer = window.setTimeout(() => {
                void moments
                    .preview(detected)
                    .then((meta) => {
                        if (previewSeq.current !== seq) return;
                        setLink(meta);
                        setLinkState("ready");
                    })
                    .catch((err) => {
                        if (previewSeq.current !== seq) return;
                        setLinkState("error");
                        setLinkError(
                            err instanceof Error ? err.message : String(err),
                        );
                    });
            }, PREVIEW_DELAY_MS);
            return () => window.clearTimeout(timer);
        }, [detected, linkDismissed, canLink]);

        const pickImages = async (files: FileList) => {
            const room = MAX_IMAGES - images.length;
            if (room <= 0) return;
            setUploading(true);
            setError("");
            try {
                const next = [...images];
                for (const file of Array.from(files).slice(0, room)) {
                    const { key } = await sender.upload(file, file.name);
                    next.push(key);
                }
                setImages(next);
                setVideo(null);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setUploading(false);
            }
        };

        const pickVideo = async (file: File) => {
            setUploading(true);
            setError("");
            try {
                const { key } = await sender.upload(file, file.name);
                setVideo(key);
                setImages([]);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setUploading(false);
            }
        };

        const publish = async () => {
            const text = content.trim();
            if (!text && images.length === 0 && !video) return;
            const attached = link ? detected : null;
            setBusy(true);
            setError("");
            requestNotifyPermission();
            try {
                await moments.publish({
                    content: attached ? withoutUrl(text, attached) : text,
                    images,
                    video,
                    link: link?.url ?? null,
                    visibility,
                    audience: needsAudience(visibility) ? audience : [],
                });
                setContent("");
                setImages([]);
                setVideo(null);
                setLinkDismissed(null);
                setVisibility("public");
                setAudience([]);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setBusy(false);
            }
        };

        const waiting = needsAudience(visibility) && audience.length === 0;

        return (
            <section className="rounded-xl border border-border bg-card p-3">
                <Textarea
                    value={content}
                    placeholder="这一刻的想法"
                    maxLength={1000}
                    className="min-h-20 resize-none border-0 bg-transparent px-0 focus-visible:ring-0 dark:bg-transparent"
                    onChange={(event) => setContent(event.target.value)}
                />
                {canLink && detected && linkState === "loading" ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                        正在获取链接预览…
                    </p>
                ) : null}
                {canLink && detected && linkState === "error" ? (
                    <p className="mt-1 text-xs text-amber-600">{linkError}</p>
                ) : null}
                {canLink && link ? (
                    <div className="relative mt-2 flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-2 pr-8">
                        {link.image ? (
                            <img
                                src={link.image}
                                alt=""
                                referrerPolicy="no-referrer"
                                className="size-14 shrink-0 rounded-md bg-muted object-cover"
                            />
                        ) : null}
                        <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-xs font-medium">
                                {link.title}
                            </p>
                            {link.description ? (
                                <p className="line-clamp-2 text-[11px] text-muted-foreground">
                                    {link.description}
                                </p>
                            ) : null}
                            <p className="text-[11px] text-muted-foreground">
                                {link.site}
                            </p>
                        </div>
                        <button
                            type="button"
                            title="移除链接卡片"
                            className="absolute top-1 right-1 rounded-md p-0.5 text-muted-foreground hover:bg-accent"
                            onClick={() => setLinkDismissed(detected)}
                        >
                            <XIcon className="size-3.5" />
                        </button>
                    </div>
                ) : null}
                {images.length > 0 ? (
                    <div
                        className={cn(
                            "mt-2 grid gap-1",
                            gridClass(images.length),
                        )}
                    >
                        {images.map((key) => (
                            <div
                                key={key}
                                className="relative aspect-square overflow-hidden rounded-lg bg-muted"
                            >
                                <img
                                    src={`/files/${key}`}
                                    alt=""
                                    className="size-full object-cover"
                                />
                                <button
                                    type="button"
                                    title="移除"
                                    className="absolute top-1 right-1 rounded-md bg-black/60 p-0.5 text-white"
                                    onClick={() =>
                                        setImages((prev) =>
                                            prev.filter((item) => item !== key),
                                        )
                                    }
                                >
                                    <XIcon className="size-3.5" />
                                </button>
                            </div>
                        ))}
                    </div>
                ) : null}
                {video ? (
                    <div className="relative mt-2 overflow-hidden rounded-lg bg-black">
                        <video
                            src={`/files/${video}`}
                            controls
                            playsInline
                            className="max-h-72 w-full"
                        >
                            <track kind="captions" label="字幕" />
                        </video>
                        <button
                            type="button"
                            title="移除"
                            className="absolute top-1 right-1 rounded-md bg-black/60 p-0.5 text-white"
                            onClick={() => setVideo(null)}
                        >
                            <XIcon className="size-3.5" />
                        </button>
                    </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                            const files = event.target.files;
                            if (files?.length) void pickImages(files);
                            event.target.value = "";
                        }}
                    />
                    <input
                        ref={videoRef}
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void pickVideo(file);
                            event.target.value = "";
                        }}
                    />
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title={
                            video
                                ? "视频动态不能再选图片"
                                : link
                                  ? "链接动态不能再选图片"
                                  : `添加图片，最多 ${MAX_IMAGES} 张`
                        }
                        disabled={
                            uploading ||
                            !!video ||
                            !!link ||
                            images.length >= MAX_IMAGES
                        }
                        onClick={() => fileRef.current?.click()}
                    >
                        <ImagePlusIcon />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title={
                            images.length > 0
                                ? "图片动态不能再选视频"
                                : link
                                  ? "链接动态不能再选视频"
                                  : "添加视频"
                        }
                        disabled={
                            uploading || !!video || !!link || images.length > 0
                        }
                        onClick={() => videoRef.current?.click()}
                    >
                        <FilmIcon />
                    </Button>
                    <span className="text-xs text-muted-foreground">
                        {uploading
                            ? "上传中"
                            : video
                              ? "1 个视频"
                              : `${images.length}/${MAX_IMAGES}`}
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                        {VISIBILITY_OPTIONS.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                className={cn(
                                    "rounded-md border px-2 py-1 text-xs transition-colors",
                                    visibility === option.value
                                        ? "border-primary bg-primary/10 font-medium text-primary"
                                        : "border-border text-muted-foreground hover:bg-accent/60",
                                )}
                                onClick={() => setVisibility(option.value)}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                    <Button
                        size="sm"
                        disabled={
                            busy ||
                            uploading ||
                            waiting ||
                            linkState === "loading" ||
                            (!content.trim() && images.length === 0 && !video)
                        }
                        onClick={() => void publish()}
                    >
                        {busy ? "发布中" : "发布"}
                    </Button>
                </div>
                {needsAudience(visibility) ? (
                    <div className="mt-2 flex items-center gap-2 text-xs">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0"
                            onClick={() => setPicking(true)}
                        >
                            选择好友
                        </Button>
                        <span
                            className={cn(
                                "min-w-0 flex-1 truncate",
                                audience.length === 0
                                    ? "text-amber-600"
                                    : "text-muted-foreground",
                            )}
                        >
                            {audience.length === 0
                                ? visibility === "partial"
                                    ? "还没有选择可见的好友"
                                    : "还没有选择不可见的好友"
                                : audience.join("、")}
                        </span>
                    </div>
                ) : null}
                {error ? (
                    <p className="pt-2 text-xs text-red-500">{error}</p>
                ) : null}
                {picking ? (
                    <AudienceDialog
                        title={
                            visibility === "partial"
                                ? "选择可见的好友"
                                : "选择不给谁看"
                        }
                        picked={audience}
                        onToggle={(name) =>
                            setAudience((prev) =>
                                prev.includes(name)
                                    ? prev.filter((item) => item !== name)
                                    : [...prev, name],
                            )
                        }
                        onClose={() => setPicking(false)}
                    />
                ) : null}
            </section>
        );
    };

    const MomentCard = ({ post }: { post: MomentPost }) => {
        const me = useMe();
        const [commentOpen, setCommentOpen] = useState(false);
        const [sharing, setSharing] = useState(false);
        const [draft, setDraft] = useState("");
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        const liked = post.likes.some((like) => like.username === me);

        const run = async (fn: () => Promise<void>) => {
            setBusy(true);
            setError("");
            try {
                await fn();
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setBusy(false);
            }
        };

        const submitComment = () =>
            run(async () => {
                const text = draft.trim();
                if (!text) return;
                await moments.comment(post.id, text);
                setDraft("");
                setCommentOpen(false);
            });

        const openMedia = (
            key: string,
            index: number,
            kind: "image" | "video",
        ) => {
            const message: ChatMessage = {
                id: `${post.id}:${index}`,
                session: "moment",
                sender: post.author,
                content: `/files/${key}`,
                createdAt: post.createdAt,
                kind,
            };
            ctx.emit("ui:media:preview", { message });
        };

        const remove = () => {
            if (!window.confirm("删除这条动态？")) return;
            void run(() => moments.remove(post.id));
        };

        const tag = post.author === me ? visibilityLabel(post) : "";
        const video = post.video;

        return (
            <section className="rounded-xl border border-border bg-card p-3">
                <header className="flex items-start gap-3">
                    <button
                        type="button"
                        title="只看这位好友的动态"
                        onClick={() => moments.setAuthor(post.author)}
                    >
                        <UserAvatar name={post.author} />
                    </button>
                    <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-medium">
                            <span className="truncate">{post.author}</span>
                            {tag ? (
                                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                                    {tag}
                                </span>
                            ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {timeLabel(post.createdAt)}
                        </p>
                    </div>
                    {post.author === me ? (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            title="删除"
                            disabled={busy}
                            onClick={remove}
                        >
                            <Trash2Icon />
                        </Button>
                    ) : null}
                </header>
                {post.content ? (
                    <p className="mt-2 text-sm break-words whitespace-pre-wrap">
                        {post.content}
                    </p>
                ) : null}
                {post.link ? (
                    <a
                        href={post.link.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 flex items-center gap-3 overflow-hidden rounded-lg border border-border bg-muted/40 p-2 transition-colors hover:bg-accent/60"
                    >
                        {post.link.image ? (
                            <img
                                src={post.link.image}
                                alt=""
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                className="size-20 shrink-0 rounded-md bg-muted object-cover"
                            />
                        ) : null}
                        <span className="min-w-0 flex-1">
                            <span className="line-clamp-2 block text-sm font-medium">
                                {post.link.title}
                            </span>
                            {post.link.description ? (
                                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                                    {post.link.description}
                                </span>
                            ) : null}
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                {post.link.site}
                            </span>
                        </span>
                    </a>
                ) : null}
                {post.images.length > 0 ? (
                    <div
                        className={cn(
                            "mt-2 grid gap-1",
                            gridClass(post.images.length),
                        )}
                    >
                        {post.images.map((key, index) => (
                            <button
                                key={key}
                                type="button"
                                className={cn(
                                    "overflow-hidden rounded-lg bg-muted",
                                    post.images.length === 1
                                        ? "max-w-64"
                                        : "aspect-square",
                                )}
                                onClick={() => openMedia(key, index, "image")}
                            >
                                <img
                                    src={`/files/${key}`}
                                    alt=""
                                    loading="lazy"
                                    className={cn(
                                        "w-full object-cover",
                                        post.images.length === 1
                                            ? "max-h-72"
                                            : "size-full",
                                    )}
                                />
                            </button>
                        ))}
                    </div>
                ) : null}
                {video ? (
                    <button
                        type="button"
                        title="播放视频"
                        className="mt-2 block w-full max-w-72 overflow-hidden rounded-lg bg-black"
                        onClick={() => openMedia(video, 0, "video")}
                    >
                        <video
                            src={`/files/${video}`}
                            preload="metadata"
                            muted
                            playsInline
                            className="max-h-72 w-full"
                        />
                    </button>
                ) : null}
                <div className="mt-2 flex items-center gap-1 border-t border-border pt-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn("gap-1.5", liked && "text-rose-500")}
                        disabled={busy}
                        onClick={() =>
                            void run(() => moments.like(post.id, !liked))
                        }
                    >
                        <HeartIcon className={cn(liked && "fill-current")} />
                        {post.likes.length > 0 ? post.likes.length : "赞"}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setCommentOpen((prev) => !prev)}
                    >
                        <MessageCircleIcon />
                        {post.comments.length > 0
                            ? post.comments.length
                            : "评论"}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setSharing(true)}
                    >
                        <ShareIcon />
                        分享
                    </Button>
                </div>
                {post.likes.length > 0 ? (
                    <p className="mt-1.5 flex items-start gap-1 text-xs text-muted-foreground">
                        <HeartIcon className="mt-0.5 size-3.5 shrink-0 fill-current text-rose-500" />
                        <span className="break-words">
                            {post.likes.map((like) => like.username).join("、")}
                        </span>
                    </p>
                ) : null}
                {post.comments.length > 0 ? (
                    <div className="mt-1.5 flex flex-col gap-1 rounded-lg bg-muted/50 p-2">
                        {post.comments.map((comment) => (
                            <p key={comment.id} className="text-xs break-words">
                                <span className="font-medium text-primary">
                                    {comment.author}
                                </span>
                                <span className="text-muted-foreground">
                                    ：
                                </span>
                                {comment.content}
                            </p>
                        ))}
                    </div>
                ) : null}
                {commentOpen ? (
                    <div className="mt-2 flex items-center gap-1">
                        <Input
                            value={draft}
                            placeholder="说点什么"
                            maxLength={300}
                            className="h-8"
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") void submitComment();
                            }}
                        />
                        <Button
                            size="sm"
                            className="h-8 shrink-0"
                            disabled={busy || !draft.trim()}
                            onClick={() => void submitComment()}
                        >
                            发送
                        </Button>
                    </div>
                ) : null}
                {error ? (
                    <p className="mt-1.5 text-xs text-red-500">{error}</p>
                ) : null}
                {sharing ? (
                    <ShareDialog
                        post={post}
                        onClose={() => setSharing(false)}
                    />
                ) : null}
            </section>
        );
    };

    const MomentsPage = () => {
        const state = useMomentsState();
        const me = useMe();
        const restoring = useRestoring();
        const navigate = useNavigate();

        useEffect(() => {
            moments.setViewing(true);
            return () => moments.setViewing(false);
        }, []);

        if (restoring && !me) return null;
        if (!me) return <Navigate to="/login" replace />;

        return (
            <div className="relative flex h-full flex-col">
                <div className="flex h-12 min-h-12 shrink-0 items-center gap-1 border-b border-border px-3">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="返回"
                        onClick={() => void navigate(-1)}
                    >
                        <ArrowLeftIcon />
                    </Button>
                    <p className="text-sm font-semibold">朋友圈</p>
                    {state.author ? (
                        <button
                            type="button"
                            title="取消筛选"
                            className="ml-1 flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                            onClick={() => moments.setAuthor(null)}
                        >
                            只看 {state.author}
                            <XIcon className="size-3" />
                        </button>
                    ) : null}
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className="ml-auto"
                        title="刷新"
                        disabled={state.loading}
                        onClick={() => void moments.refresh()}
                    >
                        <RefreshCwIcon
                            className={cn(state.loading && "animate-spin")}
                        />
                    </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
                        {state.author ? null : <Composer />}
                        {state.posts.map((post) => (
                            <MomentCard key={post.id} post={post} />
                        ))}
                        {state.posts.length === 0 && !state.loading ? (
                            <p className="py-10 text-center text-sm text-muted-foreground">
                                {state.author
                                    ? "这位好友还没有发布动态"
                                    : "还没有动态，发布第一条吧"}
                            </p>
                        ) : null}
                        {state.hasMore ? (
                            <Button
                                variant="outline"
                                className="w-full"
                                disabled={state.loading}
                                onClick={() => void moments.loadMore()}
                            >
                                {state.loading ? "加载中" : "加载更多"}
                            </Button>
                        ) : null}
                        {state.error ? (
                            <p className="pb-2 text-center text-xs text-red-500">
                                {state.error}
                            </p>
                        ) : null}
                    </div>
                </div>
                <ui.Slot
                    slot="overlay"
                    className="pointer-events-none absolute inset-0 z-10"
                />
            </div>
        );
    };

    const MomentsAlerts = () => {
        const navigate = useNavigate();
        useEffect(() => {
            const disposeOpen = ctx.on("ui:moments:open", (payload) => {
                const author = (payload as { author?: string } | null)?.author;
                if (author) moments.setAuthor(author);
                void navigate("/moments");
            });
            return () => {
                void disposeOpen();
            };
        }, [navigate]);
        return null;
    };

    const unregisterRoute = ui.registerRoute("/moments", MomentsPage);
    const unregisterAlerts = ui.register("overlay", MomentsAlerts, 15);
    return () => {
        unregisterRoute();
        unregisterAlerts();
    };
};
