import { Context } from "@plugim/core";
import { describe, expect, it, vi } from "vitest";
import {
    presencePlugin,
    type PresenceService,
} from "../src/plugins/presence";
import type { RpcService } from "../src/plugins/connection";

const makePresence = (online: string[]) => {
    const ctx = new Context();
    ctx.provide<RpcService>("rpc", {
        call: async () => online,
        status: () => "open",
        onStatus: () => () => undefined,
    });
    ctx.plugin(presencePlugin);
    return ctx.start().then(() => ({
        presence: ctx.get<PresenceService>("presence"),
        ctx,
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
});
