import { describe, expect, it, vi } from "vitest";
import { Context, type Dispose, type Plugin } from "../src/index";

const noop = () => undefined;

const makePlugin = (name: string, overrides: Partial<Plugin> = {}): Plugin => ({
    name,
    apply: async () => undefined,
    ...overrides,
});

describe("service container", () => {
    it("provides and gets a service", () => {
        const ctx = new Context();
        ctx.provide("answer", 42);
        expect(ctx.get<number>("answer")).toBe(42);
    });

    it("throws ServiceNotFoundError for missing service", () => {
        const ctx = new Context();
        expect(() => ctx.get("nope")).toThrowError("service not found: nope");
    });

    it("resolves waitFor after the service is provided later", async () => {
        const ctx = new Context();
        const promise = ctx.waitFor<number>("late");
        ctx.provide("late", 7);
        await expect(promise).resolves.toBe(7);
    });

    it("rejects waitFor for a service declared unavailable", async () => {
        const ctx = new Context();
        ctx.plugin(makePlugin("p", { provides: ["gone"] }));
        await ctx.disable("p");
        await expect(ctx.waitFor("gone")).rejects.toThrowError(
            "service not found: gone",
        );
    });
});

describe("event bus", () => {
    it("delivers events to subscribers until disposed", () => {
        const ctx = new Context();
        const fn = vi.fn();
        const dispose = ctx.on("ping", fn);
        ctx.emit("ping", 1);
        dispose();
        ctx.emit("ping", 2);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(1);
    });
});

describe("startup", () => {
    it("starts plugins concurrently and resolves reversed dependencies", async () => {
        const ctx = new Context();
        const order: string[] = [];
        ctx.plugin(
            makePlugin("consumer", {
                inject: ["dep"],
                apply: async () => {
                    order.push("consumer");
                    return undefined;
                },
            }),
        );
        ctx.plugin(
            makePlugin("provider", {
                provides: ["dep"],
                apply: async () => {
                    order.push("provider");
                    ctx.provide("dep", true);
                    return undefined;
                },
            }),
        );
        await ctx.start();
        expect(order).toContain("consumer");
        expect(order).toContain("provider");
        expect(ctx.list().map((p) => p.state)).toEqual(["started", "started"]);
    });

    it("skips plugins listed as disabled", async () => {
        const ctx = new Context({ disabled: ["skipme"] });
        const apply = vi.fn(noop);
        ctx.plugin(makePlugin("skipme", { apply: async () => apply() }));
        ctx.plugin(makePlugin("keep"));
        await ctx.start();
        expect(apply).not.toHaveBeenCalled();
        expect(ctx.list().find((p) => p.name === "skipme")?.state).toBe(
            "disabled",
        );
        expect(ctx.list().find((p) => p.name === "keep")?.state).toBe(
            "started",
        );
    });

    it("marks dependents failed when a disabled plugin provides their deps", async () => {
        const ctx = new Context({ disabled: ["base"] });
        ctx.plugin(makePlugin("base", { provides: ["svc"] }));
        ctx.plugin(makePlugin("child", { inject: ["svc"] }));
        await ctx.start();
        expect(ctx.list().find((p) => p.name === "child")?.state).toBe(
            "failed",
        );
    });

    it("isolates apply failures instead of aborting startup", async () => {
        const ctx = new Context();
        ctx.plugin(
            makePlugin("boom", {
                apply: async () => {
                    throw new Error("boom");
                },
            }),
        );
        const ok = vi.fn();
        ctx.plugin(makePlugin("fine", { apply: async () => ok() }));
        await ctx.start();
        expect(ok).toHaveBeenCalled();
        expect(ctx.list().find((p) => p.name === "boom")?.state).toBe("failed");
        expect(ctx.list().find((p) => p.name === "fine")?.state).toBe(
            "started",
        );
    });

    it("auto-starts plugins registered after start()", async () => {
        const ctx = new Context();
        await ctx.start();
        const apply = vi.fn(noop);
        ctx.plugin(makePlugin("late", { apply: async () => apply() }));
        await vi.waitFor(() => expect(apply).toHaveBeenCalled());
    });
});

describe("stop", () => {
    it("disposes started plugins in reverse order", async () => {
        const ctx = new Context();
        const order: string[] = [];
        ctx.plugin(
            makePlugin("a", {
                apply: async () => () => order.push("dispose:a"),
            }),
        );
        ctx.plugin(
            makePlugin("b", {
                apply: async () => () => order.push("dispose:b"),
            }),
        );
        await ctx.start();
        await ctx.stop();
        expect(order).toEqual(["dispose:b", "dispose:a"]);
        expect(ctx.list().every((p) => p.state === "stopped")).toBe(true);
    });
});

describe("runtime enable / disable", () => {
    it("disposes the plugin and cascades to dependents", async () => {
        const ctx = new Context();
        const disposed: string[] = [];
        const track =
            (name: string): Dispose =>
            () =>
                disposed.push(name);
        ctx.plugin(
            makePlugin("friends", {
                provides: ["friends"],
                apply: async () => {
                    ctx.provide("friends", {});
                    return track("friends");
                },
            }),
        );
        ctx.plugin(
            makePlugin("sidebar", {
                inject: ["friends"],
                apply: async () => track("sidebar"),
            }),
        );
        ctx.plugin(
            makePlugin("panel", {
                inject: ["friends"],
                apply: async () => track("panel"),
            }),
        );
        ctx.plugin(
            makePlugin("independent", {
                apply: async () => track("independent"),
            }),
        );
        await ctx.start();

        const ok = await ctx.disable("friends");
        expect(ok).toBe(true);
        expect(disposed).toContain("friends");
        expect(disposed).toContain("sidebar");
        expect(disposed).toContain("panel");
        expect(disposed).not.toContain("independent");
        for (const name of ["friends", "sidebar", "panel"]) {
            expect(ctx.list().find((p) => p.name === name)?.state).toBe(
                "disabled",
            );
        }
        expect(() => ctx.get("friends")).toThrowError();
    });

    it("allows disabling any plugin (no core lock)", async () => {
        const ctx = new Context();
        ctx.plugin(makePlugin("shell"));
        await ctx.start();
        await expect(ctx.disable("shell")).resolves.toBe(true);
        expect(ctx.list()[0].state).toBe("disabled");
    });

    it("restarts a plugin on enable", async () => {
        const ctx = new Context();
        let count = 0;
        ctx.plugin(
            makePlugin("toggle", {
                provides: ["svc"],
                apply: async () => {
                    count += 1;
                    ctx.provide("svc", count);
                    return undefined;
                },
            }),
        );
        await ctx.start();
        await ctx.disable("toggle");
        const ok = await ctx.enable("toggle");
        expect(ok).toBe(true);
        expect(count).toBe(2);
        expect(ctx.list()[0].state).toBe("started");
        expect(ctx.get("svc")).toBe(2);
    });

    it("refuses to enable a plugin whose dependencies are missing", async () => {
        const ctx = new Context({ disabled: ["base"] });
        ctx.plugin(
            makePlugin("base", {
                provides: ["svc"],
                apply: async () => {
                    ctx.provide("svc", {});
                    return undefined;
                },
            }),
        );
        ctx.plugin(makePlugin("child", { inject: ["svc"] }));
        await ctx.start();
        await expect(ctx.enable("child")).resolves.toBe(false);
        expect(ctx.list().find((p) => p.name === "child")?.state).toBe(
            "failed",
        );
        await expect(ctx.enable("base")).resolves.toBe(true);
        await expect(ctx.enable("child")).resolves.toBe(true);
        expect(ctx.list().find((p) => p.name === "child")?.state).toBe(
            "started",
        );
    });

    it("retries a failed plugin through enable", async () => {
        const ctx = new Context();
        let attempts = 0;
        ctx.plugin(
            makePlugin("flaky", {
                apply: async () => {
                    attempts += 1;
                    if (attempts === 1) throw new Error("first try fails");
                    return undefined;
                },
            }),
        );
        await ctx.start();
        expect(ctx.list()[0].state).toBe("failed");
        await expect(ctx.enable("flaky")).resolves.toBe(true);
        expect(attempts).toBe(2);
        expect(ctx.list()[0].state).toBe("started");
    });
});

describe("plugin inventory", () => {
    it("exposes metadata for the settings page", async () => {
        const ctx = new Context();
        ctx.plugin(
            makePlugin("rpc", {
                provides: ["rpc"],
                apply: async () => {
                    ctx.provide("rpc", {});
                    return undefined;
                },
            }),
        );
        ctx.plugin(
            makePlugin("ui-chat", {
                description: "聊天界面",
                provides: ["chat"],
                inject: ["rpc"],
            }),
        );
        await ctx.start();
        const info = ctx.list().find((p) => p.name === "ui-chat");
        expect(info).toMatchObject({
            name: "ui-chat",
            description: "聊天界面",
            provides: ["chat"],
            inject: ["rpc"],
            state: "started",
        });
    });

    it("notifies listeners when the inventory changes", async () => {
        const ctx = new Context();
        const fn = vi.fn();
        ctx.onPluginsChange(fn);
        ctx.plugin(makePlugin("p"));
        await ctx.start();
        await ctx.disable("p");
        expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
});
