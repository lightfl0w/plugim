import type { Context, Plugin } from "@plugim/core";
import type { StickerItem, StickerListResult } from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface StickersService {
    cached(): StickerItem[];
    refresh(): Promise<StickerItem[]>;
    add(item: StickerItem): Promise<StickerItem[]>;
    remove(url: string): Promise<StickerItem[]>;
}

export const stickersPlugin: Plugin = {
    name: "stickers",
    description: "自定义表情包服务",
    provides: ["stickers"],
    inject: ["rpc"],
    async apply(ctx: Context) {
        const rpc = ctx.get<RpcService>("rpc");
        let cache: StickerItem[] = [];
        const pick = (result: unknown) =>
            (result as StickerListResult).stickers;
        const service: StickersService = {
            cached: () => cache,
            async refresh() {
                cache = pick(await rpc.call("stickers.list", {}));
                return cache;
            },
            async add(item) {
                cache = pick(
                    await rpc.call(
                        "stickers.add",
                        item as unknown as Record<string, unknown>,
                    ),
                );
                return cache;
            },
            async remove(url) {
                cache = pick(await rpc.call("stickers.remove", { url }));
                return cache;
            },
        };
        ctx.provide<StickersService>("stickers", service);
        return undefined;
    },
};
