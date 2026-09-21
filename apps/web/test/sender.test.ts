import { Context } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
import { describe, expect, it } from "vitest";
import type { AuthService } from "../src/plugins/auth";
import type { RpcService } from "../src/plugins/connection";
import {
    senderPlugin,
    type PendingEvent,
    type SenderService,
} from "../src/plugins/sender";

const serverMessage = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: "server-id",
    session: "s1",
    sender: "me",
    content: "hi",
    createdAt: new Date().toISOString(),
    ...over,
});

interface RpcCall {
    method: string;
    params: Record<string, unknown>;
}

const makeSender = (
    behavior: (call: RpcCall, attempt: number) => Promise<unknown>,
) => {
    const ctx = new Context();
    const events: PendingEvent[] = [];
    const calls: RpcCall[] = [];
    ctx.on("chat:pending", (payload) => events.push(payload as PendingEvent));
    ctx.provide<RpcService>("rpc", {
        call: (method, params) => {
            const call = { method, params };
            calls.push(call);
            return behavior(call, calls.length);
        },
        status: () => "open",
        onStatus: () => () => undefined,
    });
    ctx.provide<AuthService>("auth", {
        token: () => null,
        user: () => ({ id: "u1", username: "me", createdAt: "" }),
        restoring: () => false,
        login: async () => {
            throw new Error("unused");
        },
        register: async () => {
            throw new Error("unused");
        },
        logout: () => undefined,
        onChange: () => () => undefined,
    });
    ctx.plugin(senderPlugin);
    return ctx.start().then(() => ({
        sender: ctx.get<SenderService>("sender"),
        events,
        calls,
    }));
};

describe("sender optimistic lifecycle", () => {
    it("emits add then remove on success and forwards fields", async () => {
        const { sender, events, calls } = await makeSender(async () =>
            serverMessage(),
        );
        const result = await sender.send("s1", "hi", {
            sender: "bob",
            content: "quoted",
        });
        expect(result.id).toBe("server-id");
        expect(events.map((e) => e.type)).toEqual(["add", "remove"]);
        expect(events[0].pending.state).toBe("sending");
        expect(calls[0].params).toMatchObject({
            session: "s1",
            content: "hi",
            quote: { sender: "bob", content: "quoted" },
            mentions: null,
            kind: "text",
            file: null,
        });
    });

    it("emits fail with error and rejects when rpc fails", async () => {
        const { sender, events } = await makeSender(async () => {
            throw new Error("connection not open");
        });
        await expect(sender.send("s1", "hi")).rejects.toThrow(
            "connection not open",
        );
        expect(events.map((e) => e.type)).toEqual(["add", "fail"]);
        expect(events[1].pending.state).toBe("failed");
        expect(events[1].pending.error).toBe("connection not open");
    });

    it("retry drops the failed bubble and resends the same payload", async () => {
        let failNext = true;
        let tempId = "";
        const { sender, events, calls } = await makeSender(async () => {
            if (failNext) {
                failNext = false;
                throw new Error("boom");
            }
            return serverMessage();
        });
        await sender.send("s1", "retry me", null, ["x"]).catch(() => undefined);
        tempId = events[0].pending.tempId;
        expect(events.map((e) => e.type)).toEqual(["add", "fail"]);

        await sender.retry(tempId);
        expect(events.map((e) => e.type)).toEqual([
            "add",
            "fail",
            "remove",
            "add",
            "remove",
        ]);
        expect(calls[1].params).toMatchObject({
            content: "retry me",
            mentions: ["x"],
        });
    });

    it("retry ignores unknown temp ids", async () => {
        const { sender, events } = await makeSender(async () =>
            serverMessage(),
        );
        await sender.retry("missing");
        expect(events).toHaveLength(0);
    });

    it("carries kind and file metadata through pending state", async () => {
        const { sender, events } = await makeSender(async () =>
            serverMessage({ kind: "file" }),
        );
        await sender.send(
            "s1",
            "data:application/pdf;base64,x",
            null,
            null,
            "file",
            { name: "a.pdf", size: 10 },
        );
        expect(events[0].pending.kind).toBe("file");
        expect(events[0].pending.file).toEqual({ name: "a.pdf", size: 10 });
    });
});
