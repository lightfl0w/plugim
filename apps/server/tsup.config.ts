import { readFile, writeFile } from "node:fs/promises";
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
    onSuccess: async () => {
        const file = "dist/index.js";
        const source = await readFile(file, "utf8");
        await writeFile(
            file,
            source
                .replace(/^\/\/ [^\n]*\.(?:ts|tsx|js|jsx|mjs|cjs)\n?/gm, "")
                .replace(/\/\* @__PURE__ \*\/ ?/g, ""),
        );
    },
});
