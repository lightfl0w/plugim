import type { Context } from "@plugim/core";
import type {
    ChatMessage,
    MomentPost,
    MomentVisibility,
} from "@plugim/protocol";
import {
    ArrowLeftIcon,
    HeartIcon,
    ImagePlusIcon,
    MessageCircleIcon,
    RefreshCwIcon,
    Trash2Icon,
    XIcon,
} from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { MomentsService } from "./moments";
import type { SenderService } from "./sender";
import type { UiService } from "./ui-types";

const MAX_IMAGES = 9;

const VISIBILITY_OPTIONS: { value: MomentVisibility; label: string }[] = [
    { value: "public", label: "公开" },
    { value: "friends", label: "仅好友" },
];

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

export const uiMomentsSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const moments = ctx.get<MomentsService>("moments");
    const sender = ctx.get<SenderService>("sender");
    const auth = ctx.get<AuthService>("auth");

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

    const Composer = () => {
        const [content, setContent] = useState("");
        const [images, setImages] = useState<string[]>([]);
        const [visibility, setVisibility] =
            useState<MomentVisibility>("public");
        const [busy, setBusy] = useState(false);
        const [uploading, setUploading] = useState(false);
        const [error, setError] = useState("");
        const fileRef = useRef<HTMLInputElement>(null);

        const pick = async (files: FileList) => {
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
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setUploading(false);
            }
        };

        const publish = async () => {
            const text = content.trim();
            if (!text && images.length === 0) return;
            setBusy(true);
            setError("");
            try {
                await moments.publish({ content: text, images, visibility });
                setContent("");
                setImages([]);
                setVisibility("public");
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setBusy(false);
            }
        };

        return (
            <section className="rounded-xl border border-border bg-card p-3">
                <Textarea
                    value={content}
                    placeholder="这一刻的想法"
                    maxLength={1000}
                    className="min-h-20 resize-none border-0 bg-transparent px-0 focus-visible:ring-0 dark:bg-transparent"
                    onChange={(event) => setContent(event.target.value)}
                />
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
                <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                            const files = event.target.files;
                            if (files?.length) void pick(files);
                            event.target.value = "";
                        }}
                    />
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title={`添加图片，最多 ${MAX_IMAGES} 张`}
                        disabled={uploading || images.length >= MAX_IMAGES}
                        onClick={() => fileRef.current?.click()}
                    >
                        <ImagePlusIcon />
                    </Button>
                    <span className="text-xs text-muted-foreground">
                        {uploading
                            ? "上传中"
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
                            (!content.trim() && images.length === 0)
                        }
                        onClick={() => void publish()}
                    >
                        {busy ? "发布中" : "发布"}
                    </Button>
                </div>
                {error ? (
                    <p className="pt-2 text-xs text-red-500">{error}</p>
                ) : null}
            </section>
        );
    };

    const MomentCard = ({ post }: { post: MomentPost }) => {
        const me = useMe();
        const [commentOpen, setCommentOpen] = useState(false);
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

        const openImage = (key: string, index: number) => {
            const message: ChatMessage = {
                id: `${post.id}:${index}`,
                session: "moment",
                sender: post.author,
                content: `/files/${key}`,
                createdAt: post.createdAt,
                kind: "image",
            };
            ctx.emit("ui:media:preview", { message });
        };

        const remove = () => {
            if (!window.confirm("删除这条动态？")) return;
            void run(() => moments.remove(post.id));
        };

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
                            {post.visibility === "friends" &&
                            post.author === me ? (
                                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                                    仅好友
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
                                onClick={() => openImage(key, index)}
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
            </section>
        );
    };

    const MomentsPage = () => {
        const state = useMomentsState();
        const me = useMe();
        const restoring = useRestoring();
        const navigate = useNavigate();

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

    return ui.registerRoute("/moments", MomentsPage);
};
