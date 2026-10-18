import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    clean: true,
    fixedExtension: false,
    dts: false,
    inputOptions: {
        experimental: { attachDebugInfo: "none" },
    },
    outputOptions: {
        comments: false,
    },
    deps: {
        neverBundle: [
            "better-sqlite3",
            "@node-rs/argon2",
            "ws",
            "postgres",
            "drizzle-orm",
        ],
        alwaysBundle: [/^@plugim\//],
    },
});
