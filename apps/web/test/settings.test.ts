import { Context } from "@plugim/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type SettingsService, settingsPlugin } from "../src/plugins/settings";

const backing = new Map<string, string>();
const storage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => {
        backing.set(k, v);
    },
    removeItem: (k: string) => {
        backing.delete(k);
    },
};

Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
});

let settings: SettingsService;

beforeEach(async () => {
    backing.clear();
    const ctx = new Context();
    ctx.plugin(settingsPlugin);
    await ctx.start();
    settings = ctx.get<SettingsService>("settings");
    settings.define("demo", "演示", [
        { key: "color", label: "颜色", kind: "color", default: "#ff0000" },
        { key: "size", label: "大小", kind: "number", default: 4 },
        { key: "on", label: "开关", kind: "boolean", default: true },
    ]);
});

describe("plugin settings", () => {
    it("falls back to the schema default", () => {
        expect(settings.get("demo", "color")).toBe("#ff0000");
        expect(settings.get("demo", "size")).toBe(4);
        expect(settings.isDefault("demo", "on")).toBe(true);
    });

    it("persists overrides and reports them as non-default", () => {
        settings.set("demo", "size", 9);
        expect(settings.get("demo", "size")).toBe(9);
        expect(settings.isDefault("demo", "size")).toBe(false);
        expect(
            JSON.parse(backing.get("plugim_plugin_settings") ?? "{}"),
        ).toEqual({ demo: { size: 9 } });
    });

    it("notifies scoped and wildcard listeners on every change", () => {
        let scoped = 0;
        let all = 0;
        settings.onChange("demo", () => scoped++);
        settings.onChange("*", () => all++);
        settings.set("demo", "color", "#00ff00");
        settings.reset("demo", "color");
        expect(scoped).toBe(2);
        expect(all).toBe(2);
        expect(settings.get("demo", "color")).toBe("#ff0000");
    });

    it("resets a whole plugin group", () => {
        settings.set("demo", "size", 2);
        settings.set("demo", "on", false);
        settings.resetPlugin("demo");
        expect(settings.get("demo", "size")).toBe(4);
        expect(settings.get("demo", "on")).toBe(true);
    });

    it("keeps registered groups visible after define", () => {
        settings.define("other", "另一个", []);
        expect(settings.groups().map((g) => g.plugin)).toEqual([
            "demo",
            "other",
        ]);
    });
});
