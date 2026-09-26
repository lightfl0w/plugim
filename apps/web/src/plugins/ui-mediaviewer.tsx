import type { Context } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
import { DownloadIcon, FileIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { UiService } from "./ui-types";

const mimeOf = (dataUrl: string) => {
    const match = /^data:([^;,]+)/.exec(dataUrl);
    return match?.[1] ?? "";
};

export const uiMediaViewerSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");

    const MediaViewer = () => {
        const [message, setMessage] = useState<ChatMessage | null>(null);
        const cardRef = useRef<HTMLDivElement>(null);

        useEffect(() => {
            const dispose = ctx.on("ui:media:preview", (payload) => {
                setMessage((payload as { message: ChatMessage }).message);
            });
            return () => {
                void dispose();
            };
        }, []);

        useEffect(() => {
            if (!message) return undefined;
            const onKey = (e: KeyboardEvent) => {
                if (e.key === "Escape") setMessage(null);
            };
            const onDown = (e: MouseEvent) => {
                if (!cardRef.current?.contains(e.target as Node))
                    setMessage(null);
            };
            window.addEventListener("keydown", onKey);
            window.addEventListener("mousedown", onDown);
            return () => {
                window.removeEventListener("keydown", onKey);
                window.removeEventListener("mousedown", onDown);
            };
        }, [message]);

        if (!message) return null;

        const mime = message.file?.mime || mimeOf(message.content);
        const isVideo = message.kind === "video" || mime.startsWith("video/");
        const isAudio = message.kind === "audio" || mime.startsWith("audio/");
        const isImage = message.kind === "image" || mime.startsWith("image/");
        const isPdf = mime === "application/pdf";

        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6">
                <div
                    ref={cardRef}
                    role="dialog"
                    aria-label="媒体预览"
                    className="relative flex max-h-full w-full max-w-4xl flex-col items-center gap-3"
                >
                    <div className="flex w-full items-center justify-between gap-3 text-sm text-white/90">
                        <span className="min-w-0 truncate">
                            {message.file?.name ?? `${message.sender} 的分享`}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                            <a
                                href={message.content}
                                download={
                                    message.file?.name ??
                                    `${message.id.slice(0, 8)}`
                                }
                                className="rounded-md p-1.5 hover:bg-white/10"
                                title="下载"
                            >
                                <DownloadIcon className="size-5" />
                            </a>
                            <button
                                type="button"
                                className="rounded-md p-1.5 hover:bg-white/10"
                                onClick={() => setMessage(null)}
                                title="关闭"
                            >
                                <XIcon className="size-5" />
                            </button>
                        </span>
                    </div>
                    {isImage ? (
                        <img
                            src={message.content}
                            alt={message.file?.name ?? "图片"}
                            className="max-h-[80vh] w-auto max-w-full rounded-lg object-contain"
                        />
                    ) : isVideo ? (
                        <video
                            src={message.content}
                            controls
                            autoPlay
                            className="max-h-[80vh] w-full max-w-3xl rounded-lg bg-black"
                        >
                            <track kind="captions" src="" label="字幕" />
                        </video>
                    ) : isAudio ? (
                        <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl bg-white/10 p-8">
                            <FileIcon className="size-12 text-white/80" />
                            <audio src={message.content} controls autoPlay>
                                <track kind="captions" src="" label="字幕" />
                            </audio>
                        </div>
                    ) : isPdf ? (
                        <iframe
                            src={message.content}
                            title={message.file?.name ?? "PDF 预览"}
                            className="h-[80vh] w-full rounded-lg bg-white"
                        />
                    ) : (
                        <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl bg-white/10 p-8 text-white/90">
                            <FileIcon className="size-12" />
                            <p className="max-w-full truncate text-sm">
                                {message.file?.name ?? "未知文件"}
                            </p>
                            <p className="text-xs text-white/60">
                                该类型暂不支持在线预览，请下载后查看
                            </p>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return ui.register("overlay", MediaViewer, 20);
};
