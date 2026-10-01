import type { Context } from "@plugim/core";
import type { PresenceStatus } from "@plugim/protocol";
import type {
    MouseEvent as ReactMouseEvent,
    TouchEvent as ReactTouchEvent,
    RefObject,
} from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";

export interface PresenceStatusOption {
    value: PresenceStatus;
    label: string;
    dot: string;
}

export const PRESENCE_STATUS_OPTIONS: PresenceStatusOption[] = [
    { value: "online", label: "在线", dot: "bg-emerald-500" },
    { value: "busy", label: "忙碌", dot: "bg-red-500" },
    { value: "away", label: "离开", dot: "bg-amber-500" },
    { value: "dnd", label: "请勿打扰", dot: "bg-sky-500" },
    { value: "invisible", label: "隐身", dot: "bg-gray-400" },
];

export const presenceStatusMeta = (
    status: PresenceStatus,
): PresenceStatusOption =>
    PRESENCE_STATUS_OPTIONS.find((item) => item.value === status) ??
    PRESENCE_STATUS_OPTIONS[0];

let audioCtx: AudioContext | undefined;

export const playBeep = () => {
    try {
        audioCtx ??= new AudioContext();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(
            0.001,
            audioCtx.currentTime + 0.18,
        );
        osc.connect(gain).connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.2);
    } catch {}
};

export interface ChatTarget {
    session: string;
    title: string;
}

export type ShellPane = "list" | "chat";

let shellPane: ShellPane = "list";
const shellPaneListeners = new Set<() => void>();

export const currentShellPane = (): ShellPane => shellPane;

export const setShellPane = (next: ShellPane) => {
    if (shellPane === next) return;
    shellPane = next;
    for (const cb of shellPaneListeners) cb();
};

export const onShellPane = (cb: () => void) => {
    shellPaneListeners.add(cb);
    return () => {
        shellPaneListeners.delete(cb);
    };
};

export const useShellPane = (): ShellPane =>
    useSyncExternalStore(onShellPane, currentShellPane, currentShellPane);

let chatTarget: ChatTarget = { session: "general", title: "综合频道" };
const chatTargetListeners = new Set<() => void>();

export const currentChatTarget = (): ChatTarget => chatTarget;

export const onChatTarget = (cb: () => void) => {
    chatTargetListeners.add(cb);
    return () => {
        chatTargetListeners.delete(cb);
    };
};

export const useChatTarget = (): ChatTarget =>
    useSyncExternalStore(onChatTarget, currentChatTarget, currentChatTarget);

export const openChat = (ctx: Context, target: ChatTarget) => {
    chatTarget = target;
    for (const cb of chatTargetListeners) cb();
    ctx.emit("ui:chat:open", target);
};

export const isPopupWindow = (): boolean =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("popup") === "1";

export const detachedChatUrl = (session: string): string => {
    const url = new URL("/chat", window.location.origin);
    url.searchParams.set("session", session);
    url.searchParams.set("popup", "1");
    return url.toString();
};

export const openDetachedChat = (session: string) => {
    const width = 420;
    const height = 680;
    const left = Math.max(
        0,
        Math.round((window.screen.availWidth - width) / 2),
    );
    const top = Math.max(
        0,
        Math.round((window.screen.availHeight - height) / 2),
    );
    window.open(
        detachedChatUrl(session),
        `plugim-chat-${session.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    );
};

let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressHandler: ((x: number, y: number) => void) | undefined;
let pressX = 0;
let pressY = 0;
let pressFired = false;

const cancelPress = () => {
    if (pressTimer !== undefined) clearTimeout(pressTimer);
    pressTimer = undefined;
    pressHandler = undefined;
};

export const longPressMenu = (open: (x: number, y: number) => void) => ({
    onTouchStart: (event: ReactTouchEvent) => {
        const touch = event.touches[0];
        if (!touch) return;
        pressX = touch.clientX;
        pressY = touch.clientY;
        pressFired = false;
        cancelPress();
        pressHandler = open;
        pressTimer = setTimeout(() => {
            pressTimer = undefined;
            pressFired = true;
            pressHandler?.(pressX, pressY);
            pressHandler = undefined;
        }, 480);
    },
    onTouchMove: (event: ReactTouchEvent) => {
        const touch = event.touches[0];
        if (!touch) return;
        if (
            Math.abs(touch.clientX - pressX) > 8 ||
            Math.abs(touch.clientY - pressY) > 8
        )
            cancelPress();
    },
    onTouchEnd: cancelPress,
    onTouchCancel: cancelPress,
    onClickCapture: (event: ReactMouseEvent) => {
        if (!pressFired) return;
        pressFired = false;
        event.preventDefault();
        event.stopPropagation();
    },
});

export const usePopupClose = (
    refs: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
    open: boolean,
    close: () => void,
    wheel = false,
) => {
    const closeRef = useRef(close);
    closeRef.current = close;
    const refsRef = useRef(refs);
    refsRef.current = refs;
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            const inside = (r: RefObject<HTMLElement | null>) =>
                r.current?.contains(target) ?? false;
            const list = refsRef.current;
            if (Array.isArray(list) ? list.some(inside) : inside(list)) return;
            closeRef.current();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeRef.current();
        };
        window.addEventListener("mousedown", onDown);
        window.addEventListener("keydown", onKey);
        let onWheel: (() => void) | undefined;
        if (wheel) {
            onWheel = () => closeRef.current();
            window.addEventListener("wheel", onWheel, { passive: true });
        }
        return () => {
            window.removeEventListener("mousedown", onDown);
            window.removeEventListener("keydown", onKey);
            if (onWheel) window.removeEventListener("wheel", onWheel);
        };
    }, [open, wheel]);
};

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
    if (type === "moment") return "[动态]";
    if (type === "notice") return "[群公告]";
    return null;
};

export const formatBytes = (size: number): string => {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024)
        return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

export const clientSessionOf = (session: string, me: string): string => {
    if (!session.startsWith("p2p:")) return session;
    const names = session.slice(4).split("|");
    if (names.length !== 2) return session;
    return `p2p:${names[0] === me ? names[1] : names[0]}`;
};

export const displayName = (
    username: string,
    remarks?: Record<string, string> | null,
): string => remarks?.[username] || username;

const soundKey = (owner: string) => `plugim_sound:${owner}`;

export const isSoundEnabled = (owner: string): boolean =>
    localStorage.getItem(soundKey(owner)) !== "0";

export const setSoundEnabled = (owner: string, on: boolean) => {
    localStorage.setItem(soundKey(owner), on ? "1" : "0");
};

export interface UIAlert {
    title: string;
    message: string;
}

let alertState: UIAlert | null = null;
const alertListeners = new Set<() => void>();

export const showAlert = (message: string, title = "提示") => {
    alertState = { title, message };
    for (const cb of alertListeners) cb();
};

export const closeAlert = () => {
    if (!alertState) return;
    alertState = null;
    for (const cb of alertListeners) cb();
};

export const currentAlert = (): UIAlert | null => alertState;

export const onAlert = (cb: () => void) => {
    alertListeners.add(cb);
    return () => {
        alertListeners.delete(cb);
    };
};

export interface UIConfirm {
    title: string;
    message: string;
    onAccept: () => void;
}

let confirmState: UIConfirm | null = null;
const confirmListeners = new Set<() => void>();

export const showConfirm = (
    message: string,
    onAccept: () => void,
    title = "确认操作",
) => {
    confirmState = { title, message, onAccept };
    for (const cb of confirmListeners) cb();
};

export const acceptConfirm = () => {
    if (!confirmState) return;
    const { onAccept } = confirmState;
    confirmState = null;
    for (const cb of confirmListeners) cb();
    onAccept();
};

export const cancelConfirm = () => {
    if (!confirmState) return;
    confirmState = null;
    for (const cb of confirmListeners) cb();
};

export const currentConfirm = (): UIConfirm | null => confirmState;

export const onConfirmChange = (cb: () => void) => {
    confirmListeners.add(cb);
    return () => {
        confirmListeners.delete(cb);
    };
};
