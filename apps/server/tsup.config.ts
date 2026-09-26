import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    platform: "node",
    clean: true,
    external: [
        "better-sqlite3",
        "@node-rs/argon2",
        "ws",
        "postgres",
        "drizzle-orm",
    ],
    noExternal: ["@plugim/core", "@plugim/protocol"],
});
