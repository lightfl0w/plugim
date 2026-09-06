import type { Plugin } from "@plugim/core";
import type { HistoryParams, SendMessageParams } from "@plugim/protocol";
import type { GatewayService, MessageStore } from "../types";
import type { AppConfig } from "./config";

const requireUser = (conn: {
    user: { id: string; username: string } | null;
}) => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

export const chatPlugin: Plugin = {
    name: "chat",
    inject: ["gateway", "store", "config"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const store = ctx.get<MessageStore>("store");
        const config = ctx.get<AppConfig>("config");

        gateway.rpc("message.send", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as SendMessageParams;
            if (!params.content) throw new Error("消息内容不能为空");
            const session = params.session || config.defaultSession;
            const saved = await store.save({
                session,
                sender: user.username,
                content: params.content,
            });
            gateway.broadcast("message:new", { message: saved });
            return saved;
        });

        gateway.rpc("history.list", (raw, conn) => {
            requireUser(conn);
            const params = raw as unknown as HistoryParams;
            return store.list(
                params.session || config.defaultSession,
                Math.min(Number(params.limit ?? 50), 200),
            );
        });
        return undefined;
    },
};
