import type {
    MouseEvent as ReactMouseEvent,
    TouchEvent as ReactTouchEvent,
} from "react";
import { describe, expect, it, vi } from "vitest";
import {
    currentChatTarget,
    currentShellPane,
    longPressMenu,
    messageLabel,
    onChatTarget,
    onShellPane,
    openChat,
    setShellPane,
} from "../src/plugins/ui-shared";

const touch = (x: number, y: number) =>
    ({ touches: [{ clientX: x, clientY: y }] }) as unknown as ReactTouchEvent;

const click = () =>
    ({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    }) as unknown as ReactMouseEvent;

describe("shell pane", () => {
    it("starts on the session list and notifies only on real changes", () => {
        expect(currentShellPane()).toBe("list");
        const seen: string[] = [];
        const dispose = onShellPane(() => seen.push(currentShellPane()));
        setShellPane("chat");
        expect(currentShellPane()).toBe("chat");
        expect(seen).toEqual(["chat"]);
        setShellPane("chat");
        expect(seen).toEqual(["chat"]);
        setShellPane("list");
        expect(seen).toEqual(["chat", "list"]);
        dispose();
        setShellPane("chat");
        expect(seen).toEqual(["chat", "list"]);
        setShellPane("list");
    });
});

describe("chat target", () => {
    it("defaults to the general channel and remembers the last open", () => {
        const emit = vi.fn();
        const ctx = { emit } as unknown as Parameters<typeof openChat>[0];
        openChat(ctx, { session: "p2p:bob", title: "小明" });
        expect(currentChatTarget()).toEqual({
            session: "p2p:bob",
            title: "小明",
        });
        expect(emit).toHaveBeenCalledWith("ui:chat:open", {
            session: "p2p:bob",
            title: "小明",
        });
        openChat(ctx, { session: "general", title: "综合频道" });
        expect(currentChatTarget().session).toBe("general");
    });

    it("notifies subscribers until they unsubscribe", () => {
        const emit = vi.fn();
        const ctx = { emit } as unknown as Parameters<typeof openChat>[0];
        const seen: string[] = [];
        const dispose = onChatTarget(() =>
            seen.push(currentChatTarget().title),
        );
        openChat(ctx, { session: "g:1", title: "测试群" });
        expect(seen).toEqual(["测试群"]);
        dispose();
        openChat(ctx, { session: "general", title: "综合频道" });
        expect(seen).toEqual(["测试群"]);
    });
});

describe("long press menu", () => {
    it("opens after the hold delay and swallows the trailing click", () => {
        vi.useFakeTimers();
        const opened: number[][] = [];
        const handlers = longPressMenu((x, y) => opened.push([x, y]));
        handlers.onTouchStart(touch(12, 30));
        vi.advanceTimersByTime(200);
        expect(opened).toEqual([]);
        vi.advanceTimersByTime(280);
        expect(opened).toEqual([[12, 30]]);
        const event = click();
        handlers.onClickCapture(event);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.stopPropagation).toHaveBeenCalled();
        vi.useRealTimers();
    });

    it("cancels when the finger moves before the delay", () => {
        vi.useFakeTimers();
        const opened: number[][] = [];
        const handlers = longPressMenu((x, y) => opened.push([x, y]));
        handlers.onTouchStart(touch(10, 10));
        handlers.onTouchMove(touch(10, 40));
        vi.advanceTimersByTime(600);
        expect(opened).toEqual([]);
        vi.useRealTimers();
    });

    it("does not swallow a click that follows a cancelled press", () => {
        vi.useFakeTimers();
        const handlers = longPressMenu(() => undefined);
        handlers.onTouchStart(touch(5, 5));
        handlers.onTouchEnd();
        vi.advanceTimersByTime(600);
        const event = click();
        handlers.onClickCapture(event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});

describe("message label", () => {
    it("maps non-text kinds to bracket labels", () => {
        expect(messageLabel("notice", "周五开会")).toBe("[群公告]");
        expect(messageLabel("system", "own 禁言了 mem")).toBeNull();
        expect(messageLabel("moment", "{}")).toBe("[动态]");
        expect(messageLabel("merge", "{}")).toBe("[聊天记录]");
        expect(messageLabel("file", "/files/a", "报告.pdf")).toBe(
            "[文件] 报告.pdf",
        );
    });

    it("keeps plain text and legacy data urls readable", () => {
        expect(messageLabel("text", "你好")).toBeNull();
        expect(messageLabel(undefined, "data:image/png;base64,AA")).toBe(
            "[图片]",
        );
    });
});
