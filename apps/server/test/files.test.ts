import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileService } from "../src/plugins/files";
import type { MediaFilesStore } from "../src/types";
import { createTestApp, uploadFile } from "./helpers";

describe("media files", () => {
    it("serves uploaded files back with the stored mime and bytes", async () => {
        const app = await createTestApp();
        const root = await app.register("root");
        const uploaded = await uploadFile(
            app,
            root.token,
            "报告 2026.pdf",
            "application/pdf",
            32,
        );
        expect(uploaded.key).toMatch(/^[a-f0-9]{32}$/);
        expect(uploaded.url).toBe(`/files/${uploaded.key}`);
        expect(uploaded.name).toBe("报告 2026.pdf");
        expect(uploaded.size).toBe(32);

        const res = await app.app.request(`/files/${uploaded.key}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/pdf");
        expect(res.headers.get("content-length")).toBe("32");
        expect((await res.arrayBuffer()).byteLength).toBe(32);

        const missing = await app.app.request(`/files/${"a".repeat(32)}`);
        expect(missing.status).toBe(404);
        const bad = await app.app.request("/files/../../etc/passwd");
        expect(bad.status).toBe(404);
    });

    it("rejects anonymous uploads and files over the limit", async () => {
        const app = await createTestApp({ admins: ["root"] });
        const root = await app.register("root");

        const anonymous = await app.app.request("/upload", {
            method: "POST",
            headers: { "x-file-name": "a.png" },
            body: new Uint8Array(4),
        });
        expect(anonymous.status).toBe(401);

        const info = (await app.call("files.info", {}, root.user)) as {
            uploadLimitMb: number;
            driver: string;
        };
        expect(info).toMatchObject({ uploadLimitMb: 20, driver: "local" });

        await app.call("files.config.set", { uploadLimitMb: 1 }, root.user);
        const big = await app.app.request("/upload", {
            method: "POST",
            headers: {
                authorization: `Bearer ${root.token}`,
                "content-type": "image/png",
                "x-file-name": "big.png",
            },
            body: new Uint8Array(1_200_000),
        });
        expect(big.status).toBe(413);
        await expect(
            app.call("files.config.set", { uploadLimitMb: 0 }, root.user),
        ).rejects.toThrow("上传上限");
    });

    it("guards storage config and stores the selected driver", async () => {
        const app = await createTestApp({ admins: ["root"] });
        const root = await app.register("root");
        const vic = await app.register("vic");

        await expect(
            app.call("files.config.get", {}, vic.user),
        ).rejects.toThrow("管理员");
        await expect(
            app.call("files.config.set", { driver: "oss" }, root.user),
        ).rejects.toThrow("local 或 s3");
        await expect(
            app.call("files.config.set", { driver: "s3" }, root.user),
        ).rejects.toThrow("Bucket");
        await expect(
            app.call("files.config.get", {}, root.user),
        ).resolves.toMatchObject({ driver: "local", secretKeySet: false });

        const files = app.ctx.get<FileService>("files");
        const dir = mkdtempSync(join(tmpdir(), "plugim-uploads-"));
        await app.call(
            "files.config.set",
            {
                dir,
                bucket: "bucket",
                accessKey: "key",
                secretKey: "secret",
                driver: "local",
            },
            root.user,
        );
        const config = (await app.call("files.config.get", {}, root.user)) as {
            dir: string;
            secretKeySet: boolean;
        };
        expect(config.dir).toBe(dir);
        expect(config.secretKeySet).toBe(true);
        const uploaded = await uploadFile(
            app,
            root.token,
            "a.txt",
            "text/plain",
            6,
        );
        expect(existsSync(join(dir, uploaded.key))).toBe(true);
        expect((await files.config()).dir).toBe(dir);

        await files.remove(uploaded.key);
        expect(existsSync(join(dir, uploaded.key))).toBe(false);
        await expect(
            app.call("files.config.test", {}, root.user),
        ).resolves.toMatchObject({
            ok: true,
        });
    });

    it("sweeps stale unreferenced media rows", async () => {
        const app = await createTestApp({ admins: ["root"] });
        const root = await app.register("root");
        const mediaFiles = app.ctx.get<MediaFilesStore>("mediaFiles");
        await mediaFiles.save({
            key: "b".repeat(32),
            name: "gone.png",
            mime: "image/png",
            size: 10,
            uploaderId: root.user.id,
            createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        });
        const uploaded = await uploadFile(
            app,
            root.token,
            "keep.png",
            "image/png",
            8,
        );
        await app.call(
            "message.send",
            {
                session: "general",
                content: uploaded.url,
                kind: "image",
                file: { name: "keep.png", size: 8, mime: "image/png" },
            },
            root.user,
        );
        const result = (await app.call(
            "admin.task.run",
            { name: "media-sweep" },
            root.user,
        )) as { lastMessage: string; lastStatus: string };
        expect(result.lastStatus).toBe("ok");
        expect(result.lastMessage).toContain("清理 1 个未引用文件");
        expect(await mediaFiles.count()).toBe(1);
    });
});
