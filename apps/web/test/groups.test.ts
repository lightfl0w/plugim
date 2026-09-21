import { Context } from "@plugim/core";
import type { GroupInfo } from "@plugim/protocol";
import { describe, expect, it, vi } from "vitest";
import { groupsPlugin, type GroupsService } from "../src/plugins/groups";
import type { ConnStatus, RpcService } from "../src/plugins/connection";

const group = (id: string, name: string): GroupInfo => ({
    id,
    name,
    ownerId: "u1",
    notice: "",
    muteAll: false,
    createdAt: new Date().toISOString(),
    memberCount: 2,
    myRole: "owner",
});

const makeGroups = (list: GroupInfo[]) => {
    const ctx = new Context();
    const spy = vi.fn(async () => list);
    ctx.provide<RpcService>("rpc", {
        call: spy,
        status: () => "connecting",
        onStatus: () => () => undefined,
    });
    ctx.plugin(groupsPlugin);
    return ctx.start().then(() => ({
        service: ctx.get<GroupsService>("groups"),
        spy,
        ctx,
        setStatus(status: ConnStatus) {
            void status;
        },
    }));
};

describe("groups service", () => {
    it("starts empty and does not fetch before the socket opens", async () => {
        const { service, spy } = await makeGroups([]);
        expect(service.cached()).toBeNull();
        expect(spy).not.toHaveBeenCalled();
    });

    it("refresh caches the group list and notifies subscribers", async () => {
        const { service } = await makeGroups([group("g1", "团队")]);
        const updates: number[] = [];
        const dispose = service.onUpdate(() =>
            updates.push(service.cached()?.length ?? 0),
        );
        await service.refresh();
        expect(service.cached()?.map((g) => g.id)).toEqual(["g1"]);
        expect(updates).toEqual([1]);
        dispose();
        await service.refresh();
        expect(updates).toEqual([1]);
    });

    it("deduplicates concurrent refreshes into one rpc call", async () => {
        const { service, spy } = await makeGroups([group("g1", "x")]);
        await Promise.all([service.refresh(), service.refresh()]);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("refetches when the server announces a group update", async () => {
        const { service, spy, ctx } = await makeGroups([group("g1", "x")]);
        await service.refresh();
        expect(spy).toHaveBeenCalledTimes(1);
        ctx.emit("server:group:update", { groupId: "g1" });
        await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    });

    it("surfaces refresh failures to every caller", async () => {
        const ctx = new Context();
        ctx.provide<RpcService>("rpc", {
            call: async () => {
                throw new Error("offline");
            },
            status: () => "connecting",
            onStatus: () => () => undefined,
        });
        ctx.plugin(groupsPlugin);
        await ctx.start();
        const service = ctx.get<GroupsService>("groups");
        await expect(service.refresh()).rejects.toThrow("offline");
        expect(service.cached()).toBeNull();
    });
});
