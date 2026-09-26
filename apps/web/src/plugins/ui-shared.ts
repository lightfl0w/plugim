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
