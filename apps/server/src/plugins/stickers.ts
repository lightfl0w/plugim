import type { Plugin } from "@plugim/core";
import type { StickerItem, StickerListResult } from "@plugim/protocol";
import type {
    AuthUser,
    ConnInfo,
    GatewayService,
    SettingsStore,
} from "../types";

const MAX_STICKERS = 60;

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const isValidItem = (value: unknown): value is StickerItem => {
    if (typeof value !== "object" || value === null) return false;
    const item = value as Record<string, unknown>;
    return (
        typeof item.url === "string" &&
        item.url.startsWith("/files/") &&
        item.url.length < 200 &&
        typeof item.name === "string" &&
        item.name.length < 64 &&
        typeof item.mime === "string" &&
        item.mime.startsWith("image/") &&
        typeof item.size === "number"
    );
};

export const stickersPlugin: Plugin = {
    name: "stickers",
    description: "用户自定义表情包 RPC",
    provides: ["stickers-rpc"],
    inject: ["gateway", "settings"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const settings = ctx.get<SettingsStore>("settings");

        const keyOf = (userId: string) => `stickers:${userId}`;
        const read = async (userId: string): Promise<StickerItem[]> => {
            const raw = await settings.get(keyOf(userId));
            if (!raw) return [];
            try {
                const parsed: unknown = JSON.parse(raw);
                if (!Array.isArray(parsed)) return [];
                return parsed.filter(isValidItem).slice(0, MAX_STICKERS);
            } catch {
                return [];
            }
        };
        const save = async (userId: string, stickers: StickerItem[]) => {
            await settings.set(keyOf(userId), JSON.stringify(stickers));
        };

        gateway.rpc("stickers.list", async (_raw, conn) => {
            const me = requireUser(conn);
            return {
                stickers: await read(me.id),
            } satisfies StickerListResult;
        });

        gateway.rpc("stickers.add", async (raw, conn) => {
            const me = requireUser(conn);
            const item = raw as unknown as Partial<StickerItem> | null;
            if (!isValidItem(item)) throw new Error("无效的表情数据");
            const list = await read(me.id);
            if (list.length >= MAX_STICKERS)
                throw new Error(`最多收藏 ${MAX_STICKERS} 个表情`);
            if (!list.some((s) => s.url === item.url)) {
                list.push({
                    url: item.url,
                    name: item.name,
                    mime: item.mime,
                    size: item.size,
                });
                await save(me.id, list);
            }
            return { stickers: list } satisfies StickerListResult;
        });

        gateway.rpc("stickers.remove", async (raw, conn) => {
            const me = requireUser(conn);
            const url = String((raw as { url?: unknown } | null)?.url ?? "");
            if (!url) throw new Error("缺少表情地址");
            const list = (await read(me.id)).filter((s) => s.url !== url);
            await save(me.id, list);
            return { stickers: list } satisfies StickerListResult;
        });

        return undefined;
    },
};
