import { randomBytes } from "node:crypto";
import {
    createReadStream,
    existsSync,
    mkdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Plugin } from "@plugim/core";
import type {
    AccountsStore,
    ConnInfo,
    GatewayService,
    MediaFileRow,
    MediaFilesStore,
    SettingsStore,
} from "../types";
import type { AppConfig } from "./config";

const KEY_RE = /^[a-f0-9]{32}$/;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const DIR_RE = /^[\w./-]{1,256}$/;
const TEXT_LIMIT = 512;

const SETTINGS = {
    driver: "storage_driver",
    dir: "storage_dir",
    limit: "upload_limit_mb",
    endpoint: "s3_endpoint",
    region: "s3_region",
    bucket: "s3_bucket",
    accessKey: "s3_access_key",
    secretKey: "s3_secret_key",
    pathStyle: "s3_path_style",
    publicBase: "s3_public_base",
} as const;

export interface FileStoreConfig {
    driver: "local" | "s3";
    dir: string;
    uploadLimitMb: number;
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    pathStyle: boolean;
    publicBase: string;
}

export interface UploadInput {
    name: string;
    mime: string;
    data: Uint8Array;
    uploaderId: string;
}

export interface FileService {
    config(): Promise<FileStoreConfig>;
    reload(): Promise<FileStoreConfig>;
    put(input: UploadInput): Promise<MediaFileRow>;
    remove(key: string): Promise<void>;
    url(key: string): string;
}

const sanitizeName = (raw: string): string => {
    const name = raw
        .replace(/[\\/]/g, "_")
        .split("")
        .filter((ch) => ch.charCodeAt(0) > 31)
        .join("");
    return name.trim().slice(0, 200) || "file";
};

const decodeName = (raw: string | undefined): string => {
    const value = (raw ?? "").trim();
    if (!value) return "file";
    try {
        return sanitizeName(decodeURIComponent(value));
    } catch {
        return sanitizeName(value);
    }
};

export const filesPlugin: Plugin = {
    name: "files",
    description: "媒体文件上传与存储(本地磁盘 / S3)",
    provides: ["files"],
    inject: ["config", "gateway", "mediaFiles", "settings", "accounts"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        const gateway = ctx.get<GatewayService>("gateway");
        const mediaFiles = ctx.get<MediaFilesStore>("mediaFiles");
        const settings = ctx.get<SettingsStore>("settings");
        const accounts = ctx.get<AccountsStore>("accounts");

        const pick = async (key: string, fallback: string) => {
            const raw = await settings.get(key);
            return raw === null ? fallback.trim() : raw.trim();
        };

        const readConfig = async (): Promise<FileStoreConfig> => {
            const driver = await pick(SETTINGS.driver, config.storageDriver);
            const limit = Number(
                await pick(SETTINGS.limit, String(config.uploadLimitMb)),
            );
            return {
                driver: driver === "s3" ? "s3" : "local",
                dir: await pick(SETTINGS.dir, config.storageDir),
                uploadLimitMb:
                    Number.isFinite(limit) && limit > 0
                        ? Math.min(Math.floor(limit), 1024)
                        : 20,
                endpoint: await pick(SETTINGS.endpoint, config.s3Endpoint),
                region:
                    (await pick(SETTINGS.region, config.s3Region)) ||
                    "us-east-1",
                bucket: await pick(SETTINGS.bucket, config.s3Bucket),
                accessKey: await pick(SETTINGS.accessKey, config.s3AccessKey),
                secretKey: await pick(SETTINGS.secretKey, config.s3SecretKey),
                pathStyle:
                    (await pick(SETTINGS.pathStyle, config.s3PathStyle)) ===
                    "true",
                publicBase: (
                    await pick(SETTINGS.publicBase, config.s3PublicBase)
                ).replace(/\/+$/, ""),
            };
        };

        const uploadDir = (cfg: FileStoreConfig) =>
            resolve(process.cwd(), cfg.dir || "data/uploads");

        const clients = new Map<string, S3Client>();
        const s3Client = (cfg: FileStoreConfig) => {
            if (!cfg.bucket) throw new Error("S3 未配置 Bucket");
            if (!cfg.accessKey || !cfg.secretKey)
                throw new Error("S3 未配置访问密钥");
            const key = [
                cfg.endpoint,
                cfg.region,
                cfg.accessKey,
                cfg.secretKey,
                String(cfg.pathStyle),
            ].join("|");
            let client = clients.get(key);
            if (!client) {
                client = new S3Client({
                    region: cfg.region,
                    endpoint: cfg.endpoint || undefined,
                    forcePathStyle: cfg.pathStyle,
                    credentials: {
                        accessKeyId: cfg.accessKey,
                        secretAccessKey: cfg.secretKey,
                    },
                });
                clients.set(key, client);
            }
            return client;
        };

        let current = await readConfig();

        const put = async (input: UploadInput): Promise<MediaFileRow> => {
            const cfg = current;
            const key = randomBytes(16).toString("hex");
            if (cfg.driver === "s3") {
                await s3Client(cfg).send(
                    new PutObjectCommand({
                        Bucket: cfg.bucket,
                        Key: key,
                        Body: input.data,
                        ContentType: input.mime,
                        ContentLength: input.data.byteLength,
                        CacheControl: "public, max-age=31536000, immutable",
                    }),
                );
            } else {
                const dir = uploadDir(cfg);
                mkdirSync(dir, { recursive: true });
                writeFileSync(resolve(dir, key), input.data);
            }
            return {
                key,
                name: input.name,
                mime: input.mime,
                size: input.data.byteLength,
                uploaderId: input.uploaderId,
                createdAt: new Date().toISOString(),
            };
        };

        const remove = async (key: string): Promise<void> => {
            const cfg = current;
            if (cfg.driver === "s3") {
                try {
                    await s3Client(cfg).send(
                        new DeleteObjectCommand({
                            Bucket: cfg.bucket,
                            Key: key,
                        }),
                    );
                } catch (err) {
                    ctx.log.warn(`s3 delete failed: ${key}`, err);
                }
                return;
            }
            const file = resolve(uploadDir(cfg), key);
            try {
                if (existsSync(file)) unlinkSync(file);
            } catch (err) {
                ctx.log.warn(`file delete failed: ${key}`, err);
            }
        };

        const requireAdmin = async (conn: ConnInfo) => {
            if (!conn.user) throw new Error("未登录或登录已过期");
            const row = await accounts.fullById(conn.user.id);
            if (!row?.isAdmin) throw new Error("需要管理员权限");
            return conn.user;
        };

        const publicConfig = async () => {
            const cfg = await readConfig();
            return {
                driver: cfg.driver,
                dir: cfg.dir,
                uploadLimitMb: cfg.uploadLimitMb,
                endpoint: cfg.endpoint,
                region: cfg.region,
                bucket: cfg.bucket,
                accessKey: cfg.accessKey,
                secretKeySet: cfg.secretKey !== "",
                pathStyle: cfg.pathStyle,
                publicBase: cfg.publicBase,
            };
        };

        const app = gateway.hono();

        app.post("/upload", async (c) => {
            const header = c.req.header("authorization");
            const user = await gateway.verify(
                header?.startsWith("Bearer ") ? header.slice(7) : null,
            );
            if (!user)
                return c.json(
                    { ok: false, message: "未登录或登录已过期" },
                    401,
                );
            const limit = current.uploadLimitMb * 1024 * 1024;
            const oversize = `文件超过 ${current.uploadLimitMb} MB 上限`;
            if (Number(c.req.header("content-length") ?? 0) > limit)
                return c.json({ ok: false, message: oversize }, 413);
            const data = new Uint8Array(await c.req.arrayBuffer());
            if (data.byteLength === 0)
                return c.json({ ok: false, message: "上传内容为空" }, 400);
            if (data.byteLength > limit)
                return c.json({ ok: false, message: oversize }, 413);
            const rawMime = (c.req.header("content-type") ?? "")
                .split(";")[0]
                .trim()
                .toLowerCase();
            const mime = MIME_RE.test(rawMime)
                ? rawMime
                : "application/octet-stream";
            try {
                const row = await put({
                    name: decodeName(c.req.header("x-file-name")),
                    mime,
                    data,
                    uploaderId: user.id,
                });
                await mediaFiles.save(row);
                return c.json({
                    ok: true,
                    result: {
                        key: row.key,
                        url: `/files/${row.key}`,
                        name: row.name,
                        size: row.size,
                        mime: row.mime,
                    },
                });
            } catch (err) {
                return c.json(
                    {
                        ok: false,
                        message: String(
                            err instanceof Error ? err.message : err,
                        ),
                    },
                    400,
                );
            }
        });

        app.get("/files/:key", async (c) => {
            const key = c.req.param("key");
            if (!KEY_RE.test(key))
                return c.json({ ok: false, message: "文件不存在" }, 404);
            const row = await mediaFiles.byKey(key);
            if (!row) return c.json({ ok: false, message: "文件不存在" }, 404);
            const download = c.req.query("download") === "1";
            const disposition = `${
                download ? "attachment" : "inline"
            }; filename*=UTF-8''${encodeURIComponent(row.name)}`;
            const cfg = current;
            if (cfg.driver === "s3") {
                if (cfg.publicBase && !download)
                    return c.redirect(`${cfg.publicBase}/${key}`, 302);
                try {
                    const url = await getSignedUrl(
                        s3Client(cfg),
                        new GetObjectCommand({
                            Bucket: cfg.bucket,
                            Key: key,
                            ResponseContentType:
                                row.mime || "application/octet-stream",
                            ResponseContentDisposition: disposition,
                        }),
                        { expiresIn: 3600 },
                    );
                    return c.redirect(url, 302);
                } catch (err) {
                    ctx.log.warn("s3 sign failed", err);
                    return c.json({ ok: false, message: "文件读取失败" }, 502);
                }
            }
            const file = resolve(uploadDir(cfg), key);
            if (!existsSync(file))
                return c.json({ ok: false, message: "文件不存在" }, 404);
            const stream = Readable.toWeb(
                createReadStream(file),
            ) as unknown as ReadableStream;
            return c.body(stream, 200, {
                "content-type": row.mime || "application/octet-stream",
                "content-length": String(row.size),
                "content-disposition": disposition,
                "cache-control": download
                    ? "private, max-age=0"
                    : "public, max-age=31536000, immutable",
            });
        });

        const service: FileService = {
            config: readConfig,
            reload: async () => {
                current = await readConfig();
                ctx.log.info(
                    `media storage: ${current.driver}` +
                        (current.driver === "s3"
                            ? ` (${current.bucket || "未配置 bucket"})`
                            : ` (${uploadDir(current)})`),
                );
                return current;
            },
            put,
            remove,
            url: (key) => `/files/${key}`,
        };
        ctx.provide<FileService>("files", service);

        gateway.rpc("files.info", async (_raw, conn) => {
            if (!conn.user) throw new Error("未登录或登录已过期");
            return {
                uploadLimitMb: current.uploadLimitMb,
                driver: current.driver,
            };
        });

        gateway.rpc("files.config.get", async (_raw, conn) => {
            await requireAdmin(conn);
            return publicConfig();
        });

        gateway.rpc("files.config.set", async (raw, conn) => {
            await requireAdmin(conn);
            const params = raw as unknown as {
                driver?: unknown;
                dir?: unknown;
                uploadLimitMb?: unknown;
                endpoint?: unknown;
                region?: unknown;
                bucket?: unknown;
                accessKey?: unknown;
                secretKey?: unknown;
                pathStyle?: unknown;
                publicBase?: unknown;
            };
            const text = (
                value: unknown,
                label: string,
                pattern?: RegExp,
            ): string => {
                const out = String(value ?? "").trim();
                if (out.length > TEXT_LIMIT) throw new Error(`${label} 过长`);
                if (pattern && !pattern.test(out))
                    throw new Error(`${label} 格式不正确`);
                return out;
            };
            const writes: [string, string][] = [];
            if (params.driver !== undefined) {
                const driver = String(params.driver);
                if (driver !== "local" && driver !== "s3")
                    throw new Error("存储驱动仅支持 local 或 s3");
                writes.push([SETTINGS.driver, driver]);
            }
            if (params.dir !== undefined)
                writes.push([
                    SETTINGS.dir,
                    text(params.dir, "存储目录", DIR_RE),
                ]);
            if (params.uploadLimitMb !== undefined) {
                const limit = Number(params.uploadLimitMb);
                if (!Number.isInteger(limit) || limit < 1 || limit > 1024)
                    throw new Error("上传上限需为 1 到 1024 之间的整数");
                writes.push([SETTINGS.limit, String(limit)]);
            }
            if (params.endpoint !== undefined)
                writes.push([
                    SETTINGS.endpoint,
                    text(params.endpoint, "Endpoint"),
                ]);
            if (params.region !== undefined)
                writes.push([SETTINGS.region, text(params.region, "Region")]);
            if (params.bucket !== undefined)
                writes.push([SETTINGS.bucket, text(params.bucket, "Bucket")]);
            if (params.accessKey !== undefined)
                writes.push([
                    SETTINGS.accessKey,
                    text(params.accessKey, "Access Key"),
                ]);
            if (params.secretKey !== undefined)
                writes.push([
                    SETTINGS.secretKey,
                    text(params.secretKey, "Secret Key"),
                ]);
            if (params.pathStyle !== undefined)
                writes.push([
                    SETTINGS.pathStyle,
                    params.pathStyle ? "true" : "false",
                ]);
            if (params.publicBase !== undefined)
                writes.push([
                    SETTINGS.publicBase,
                    text(params.publicBase, "公开访问前缀"),
                ]);
            const pending = new Map(writes);
            const resolveValue = async (key: string, fallback: string) => {
                const staged = pending.get(key);
                if (staged !== undefined) return staged;
                return pick(key, fallback);
            };
            if (
                (await resolveValue(SETTINGS.driver, config.storageDriver)) ===
                "s3"
            ) {
                if (!(await resolveValue(SETTINGS.bucket, config.s3Bucket)))
                    throw new Error("S3 需要填写 Bucket");
                if (
                    !(await resolveValue(
                        SETTINGS.accessKey,
                        config.s3AccessKey,
                    )) ||
                    !(await resolveValue(
                        SETTINGS.secretKey,
                        config.s3SecretKey,
                    ))
                )
                    throw new Error("S3 需要填写 Access Key 与 Secret Key");
            } else if (!(await resolveValue(SETTINGS.dir, config.storageDir))) {
                throw new Error("本地存储需要填写目录");
            }
            for (const [key, value] of writes) await settings.set(key, value);
            current = await readConfig();
            ctx.log.info(`media storage switched to: ${current.driver}`);
            return publicConfig();
        });

        gateway.rpc("files.config.test", async (_raw, conn) => {
            await requireAdmin(conn);
            const cfg = await readConfig();
            if (cfg.driver === "s3") {
                await s3Client(cfg).send(
                    new HeadBucketCommand({ Bucket: cfg.bucket }),
                );
                return {
                    ok: true,
                    message: `Bucket ${cfg.bucket} 可访问`,
                };
            }
            const dir = uploadDir(cfg);
            mkdirSync(dir, { recursive: true });
            const probe = resolve(dir, `.probe-${Date.now()}`);
            writeFileSync(probe, "plugim");
            const size = statSync(probe).size;
            unlinkSync(probe);
            return { ok: true, message: `${dir} 可写 (${size} 字节)` };
        });

        ctx.log.info(
            `media storage: ${current.driver}` +
                (current.driver === "s3"
                    ? ` (${current.bucket || "未配置 bucket"})`
                    : ` (${uploadDir(current)})`),
        );
        return undefined;
    },
};
