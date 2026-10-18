import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        proxy: {
            "/rpc": "http://localhost:3000",
            "/upload": "http://localhost:3000",
            "/files": "http://localhost:3000",
            "/site": "http://localhost:3000",
            "/auth": "http://localhost:3000",
            "/open": "http://localhost:3000",
            "/health": "http://localhost:3000",
            "/version": "http://localhost:3000",
            "/ws": { target: "ws://localhost:3000", ws: true },
        },
    },
});
