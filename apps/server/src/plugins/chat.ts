import type { Plugin } from "@plugim/core";
import type {
    ChatMessage,
    HistoryParams,
    RecallParams,
    SendMessageParams,
} from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    FriendsStore,
    GatewayService,
    MessageStore,
} from "../types";
import type { AppConfig } from "./config";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const p2pKey = (a: string, b: string) => `p2p:${[a, b].sort().join("|")}`;

export const chatPlugin: Plugin = {
    name: "chat",
    description: "消息收发与历史查询",
    provides: ["chat-rpc"],
    inject: ["gateway", "store", "config", "accounts", "friendships"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const store = ctx.get<MessageStore>("store");
        const config = ctx.get<AppConfig>("config");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");

        const resolveP2p = async (me: AuthUser, rawSession: string) => {
            const peerName = rawSession.slice(4).trim();
            if (!peerName || peerName === me.username)
                throw new Error("会话不存在");
            const peer = await accounts.byUsername(peerName);
            if (!peer) throw new Error(`用户 ${peerName} 不存在`);
            const edges = await friendships.edgesOf(me.id);
            const edge = edges.find(
                (item) =>
                    (item.requesterId === peer.id &&
                        item.addresseeId === me.id) ||
                    (item.requesterId === me.id &&
                        item.addresseeId === peer.id),
            );
            if (edge?.status !== "accepted") throw new Error("只能和好友私聊");
            return peer;
        };

        gateway.rpc("message.send", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as SendMessageParams;
            if (!params.content?.trim()) throw new Error("消息内容不能为空");
            const rawSession = params.session || config.defaultSession;

            if (rawSession.startsWith("p2p:")) {
                const peer = await resolveP2p(user, rawSession);
                const saved = await store.save({
                    session: p2pKey(user.username, peer.username),
                    sender: user.username,
                    content: params.content,
                });
                const mine: ChatMessage = {
                    ...saved,
                    session: `p2p:${peer.username}`,
                };
                const theirs: ChatMessage = {
                    ...saved,
                    session: `p2p:${user.username}`,
                };
                gateway.emitToUser(user.id, "message:new", { message: mine });
                gateway.emitToUser(peer.id, "message:new", {
                    message: theirs,
                });
                return mine;
            }

            const saved = await store.save({
                session: rawSession,
                sender: user.username,
                content: params.content,
            });
            gateway.broadcast("message:new", { message: saved });
            return saved;
        });

        gateway.rpc("history.list", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as HistoryParams;
            const rawSession = params.session || config.defaultSession;
            let session = rawSession;
            if (rawSession.startsWith("p2p:")) {
                const peer = await resolveP2p(user, rawSession);
                session = p2pKey(user.username, peer.username);
            }
            return store.list(
                session,
                Math.min(Number(params.limit ?? 50), 200),
                params.before,
            );
        });

        gateway.rpc("message.recall", async (raw, conn) => {
            const user = requireUser(conn);
            const { id } = raw as unknown as RecallParams;
            const message = await store.byId(id);
            if (!message) throw new Error("消息不存在");
            if (message.sender !== user.username)
                throw new Error("只能撤回自己的消息");
            if (message.recalledAt)
                return { id, recalledAt: message.recalledAt };
            if (Date.now() - Date.parse(message.createdAt) > 2 * 60 * 1000)
                throw new Error("已超过可撤回时限");

            const recalledAt = await store.markRecalled(id);
            if (!recalledAt) throw new Error("消息不存在");

            if (message.session.startsWith("p2p:")) {
                const [a, b] = message.session.slice(4).split("|");
                const userA = await accounts.byUsername(a);
                const userB = await accounts.byUsername(b);
                if (userA)
                    gateway.emitToUser(userA.id, "message:recalled", {
                        id,
                        session: `p2p:${b}`,
                        recalledAt,
                    });
                if (userB)
                    gateway.emitToUser(userB.id, "message:recalled", {
                        id,
                        session: `p2p:${a}`,
                        recalledAt,
                    });
            } else {
                gateway.broadcast("message:recalled", {
                    id,
                    session: message.session,
                    recalledAt,
                });
            }
            return { id, recalledAt };
        });
        return undefined;
    },
};
