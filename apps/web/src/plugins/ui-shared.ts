export const messageLabel = (
    kind: string | undefined,
    content: string,
    fileName?: string | null,
): string | null => {
    const type =
        kind && kind !== "text"
            ? kind
            : content.startsWith("data:image/")
              ? "image"
              : content.startsWith("data:audio/")
                ? "audio"
                : content.startsWith("data:video/")
                  ? "video"
                  : content.startsWith("data:")
                    ? "file"
                    : null;
    if (type === "image") return "[图片]";
    if (type === "audio") return "[语音]";
    if (type === "video") return "[视频]";
    if (type === "file") return fileName ? `[文件] ${fileName}` : "[文件]";
    if (type === "merge") return "[聊天记录]";
    return null;
};

export const formatBytes = (size: number): string => {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024)
        return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const soundKey = (owner: string) => `plugim_sound:${owner}`;

export const isSoundEnabled = (owner: string): boolean =>
    localStorage.getItem(soundKey(owner)) !== "0";

export const setSoundEnabled = (owner: string, on: boolean) => {
    localStorage.setItem(soundKey(owner), on ? "1" : "0");
};
