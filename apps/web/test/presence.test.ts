import { Context } from "@plugim/core";
import type { PresenceStatus } from "@plugim/protocol";
import { describe, expect, it, vi } from "vitest";
import type { RpcService } from "../src/plugins/connection";
import { type PresenceService, presencePlugin } from "../src/plugins/presence";

const makePresence = (
    online: string[],
    statuses: Record<string, PresenceStatus> = {},
) => {
    const ctx = new Context();
    const sets: PresenceStatus[] = [];
    ctx.provide<RpcService>("rpc", {
        call: async (method: string, params?: unknown) => {
            if (method === "presence.list") return { online, statuses };
            if (method === "presence.status") return { status: "online" };
            if (method === "presence.status.set") {
                const status = (params as { status: PresenceStatus }).status;
                sets.push(status);
                return { status };
            }
            return null;
        },
        status: () => "open",
        onStatus: () => () => undefined,
    });
    ctx.provide("auth", { user: () => ({ username: "me" }) });
    ctx.plugin(presencePlugin);
    return ctx.start().then(() => ({
        presence: ctx.get<PresenceService>("presence"),
        ctx,
        sets,
    }));
};

describe("presence service", () => {
    it("loads the initial list and applies server updates", async () => {
        const { presence, ctx } = await makePresence(["alice"]);
        await vi.waitFor(() => expect(presence.isOnline("alice")).toBe(true));
        expect(presence.isOnline("bob")).toBe(false);
        ctx.emit("server:presence:update", {
            username: "bob",
            online: true,
        });
        expect(presence.isOnline("bob")).toBe(true);
        ctx.emit("server:presence:update", {
            username: "alice",
            online: false,
        });
        expect(presence.isOnline("alice")).toBe(false);
    });

    it("notifies subscribers on every change", async () => {
        const { presence, ctx } = await makePresence([]);
        let ticks = 0;
        const dispose = presence.onChange(() => {
            ticks += 1;
        });
        ctx.emit("server:presence:update", { username: "x", online: true });
        expect(ticks).toBe(1);
        dispose();
        ctx.emit("server:presence:update", { username: "y", online: true });
        expect(ticks).toBe(1);
    });

    it("tracks per-user status modes", async () => {
        const { presence, ctx } = await makePresence(["alice"], {
            alice: "busy",
        });
        await vi.waitFor(() => expect(presence.statusOf("alice")).toBe("busy"));
        ctx.emit("server:presence:update", {
            username: "bob",
            online: true,
            status: "dnd",
        });
        expect(presence.statusOf("bob")).toBe("dnd");
        ctx.emit("server:presence:update", {
            username: "bob",
            online: false,
        });
        expect(presence.statusOf("bob")).toBeNull();
        expect(presence.statusOf("ghost")).toBeNull();
    });

    it("sets my own status and hides me when invisible", async () => {
        const { presence, sets } = await makePresence(["me", "alice"]);
        await vi.waitFor(() => expect(presence.isOnline("me")).toBe(true));
        await presence.setMyStatus("busy");
        expect(sets).toEqual(["busy"]);
        expect(presence.myStatus()).toBe("busy");
        expect(presence.statusOf("me")).toBe("busy");
        await presence.setMyStatus("invisible");
        expect(sets).toEqual(["busy", "invisible"]);
        expect(presence.myStatus()).toBe("invisible");
        expect(presence.isOnline("me")).toBe(false);
        expect(presence.statusOf("me")).toBeNull();
        expect(presence.isOnline("alice")).toBe(true);
    });

    it("syncs my status from server broadcasts", async () => {
        const { presence, ctx } = await makePresence(["me"]);
        await vi.waitFor(() => expect(presence.isOnline("me")).toBe(true));
        ctx.emit("server:presence:update", {
            username: "me",
            online: true,
            status: "away",
        });
        expect(presence.myStatus()).toBe("away");
    });
});
