import type { Plugin } from "@plugim/core";
import type {
    ChatMessage,
    FileMeta,
    HistoryParams,
    MessageKind,
    RecallParams,
    SendMessageParams,
} from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    FriendsStore,
    GatewayService,
    GroupsStore,
    MessageStore,
    ReadsStore,
} from "../types";
import type { AppConfig } from "./config";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const p2pKey = (a: string, b: string) => `p2p:${[a, b].sort().join("|")}`;

const KINDS: MessageKind[] = ["text", "image", "audio", "video", "file"];

export const chatPlugin: Plugin = {
    name: "chat",
    description: "消息收发、历史查询与回执",
    provides: ["chat-rpc"],
    inject: [
        "gateway",
        "store",
        "config",
        "accounts",
        "friendships",
        "groups",
        "reads",
    ],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const store = ctx.get<MessageStore>("store");
        const config = ctx.get<AppConfig>("config");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const groups = ctx.get<GroupsStore>("groups");
        const reads = ctx.get<ReadsStore>("reads");

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

        const resolveGroup = async (me: AuthUser, rawSession: string) => {
            const groupId = rawSession.slice(2).trim();
            if (!groupId) throw new Error("群组不存在");
            const row = await groups.byId(groupId);
            if (!row) throw new Error("群组不存在");
            const members = await groups.membersOf(groupId);
            const mine = members.find((m) => m.userId === me.id);
            if (!mine) throw new Error("你不在该群中");
            return { row, mine: mine.role };
        };

        gateway.rpc("message.send", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as SendMessageParams;
            if (!params.content?.trim()) throw new Error("消息内容不能为空");
            const rawSession = params.session || config.defaultSession;
            const quote =
                params.quote &&
                typeof params.quote.sender === "string" &&
                typeof params.quote.content === "string"
                    ? {
                          sender: params.quote.sender.slice(0, 64),
                          content: params.quote.content.slice(0, 200),
                      }
                    : null;
            const mentions = Array.isArray(params.mentions)
                ? [
                      ...new Set(
                          params.mentions
                              .filter((m): m is string => typeof m === "string")
                              .map((m) => m.slice(0, 64)),
                      ),
                  ].slice(0, 50)
                : null;
            const kind: MessageKind =
                params.kind && KINDS.includes(params.kind)
                    ? params.kind
                    : "text";
            const file: FileMeta | null =
                params.file &&
                typeof params.file.name === "string" &&
                typeof params.file.size === "number"
                    ? {
                          name: params.file.name.slice(0, 200),
                          size: params.file.size,
                      }
                    : null;

            if (rawSession.startsWith("p2p:")) {
                const peer = await resolveP2p(user, rawSession);
                const saved = await store.save({
                    session: p2pKey(user.username, peer.username),
                    sender: user.username,
                    content: params.content,
                    quote,
                    mentions,
                    kind,
                    file,
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

            if (rawSession.startsWith("g:")) {
                const { row, mine } = await resolveGroup(user, rawSession);
                const privileged = mine === "owner" || mine === "admin";
                if (!privileged) {
                    if (mine === "member" && row.muteAll)
                        throw new Error("群主已开启全员禁言");
                    const members = await groups.membersOf(row.id);
                    const self = members.find((m) => m.userId === user.id);
                    if (self?.muted) throw new Error("你已被禁言");
                }
                const saved = await store.save({
                    session: rawSession,
                    sender: user.username,
                    content: params.content,
                    quote,
                    mentions,
                    kind,
                    file,
                });
                const ids = await groups.memberIdsOf(row.id);
                for (const id of ids)
                    gateway.emitToUser(id, "message:new", {
                        message: saved,
                    });
                return saved;
            }

            const saved = await store.save({
                session: rawSession,
                sender: user.username,
                content: params.content,
                quote,
                mentions,
                kind,
                file,
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
            } else if (rawSession.startsWith("g:")) {
                await resolveGroup(user, rawSession);
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
            const isSelf = message.sender === user.username;
            if (!isSelf) {
                if (!message.session.startsWith("g:"))
                    throw new Error("只能撤回自己的消息");
                const { mine } = await resolveGroup(user, message.session);
                if (mine !== "owner" && mine !== "admin")
                    throw new Error("只有管理员可以撤回他人消息");
            }
            if (message.recalledAt)
                return { id, recalledAt: message.recalledAt };
            if (
                isSelf &&
                Date.now() - Date.parse(message.createdAt) > 2 * 60 * 1000
            )
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
            } else if (message.session.startsWith("g:")) {
                const ids = await groups.memberIdsOf(message.session.slice(2));
                for (const uid of ids)
                    gateway.emitToUser(uid, "message:recalled", {
                        id,
                        session: message.session,
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

        gateway.rpc("receipt.read", async (raw, conn) => {
            const user = requireUser(conn);
            const { session } = raw as unknown as { session: string };
            if (!session) throw new Error("缺少会话");
            const at = new Date().toISOString();
            if (session.startsWith("p2p:")) {
                const peerName = session.slice(4).trim();
                const peer = await accounts.byUsername(peerName);
                if (!peer) throw new Error("用户不存在");
                await reads.set(user.id, p2pKey(user.username, peerName), at);
                gateway.emitToUser(peer.id, "receipt:update", {
                    session: `p2p:${user.username}`,
                    username: user.username,
                    at,
                });
            } else if (session.startsWith("g:")) {
                const groupId = session.slice(2);
                await resolveGroup(user, session);
                await reads.set(user.id, session, at);
                const ids = await groups.memberIdsOf(groupId);
                for (const uid of ids) {
                    if (uid === user.id) continue;
                    gateway.emitToUser(uid, "receipt:update", {
                        session,
                        username: user.username,
                        at,
                    });
                }
            } else {
                await reads.set(user.id, session, at);
            }
            return { at };
        });

        gateway.rpc("receipt.list", async (raw, conn) => {
            const user = requireUser(conn);
            const { session } = raw as unknown as { session: string };
            let storageSession = session;
            if (session.startsWith("p2p:")) {
                const peerName = session.slice(4).trim();
                const peer = await accounts.byUsername(peerName);
                if (!peer) throw new Error("用户不存在");
                storageSession = p2pKey(user.username, peerName);
            } else if (session.startsWith("g:")) {
                await resolveGroup(user, session);
            }
            const rows = await reads.ofSession(storageSession);
            const names = await accounts.byIds(rows.map((row) => row.userId));
            const nameById = new Map(
                names.map((row) => [row.id, row.username]),
            );
            return rows.map((row) => ({
                username: nameById.get(row.userId) ?? row.userId,
                at: row.at,
            }));
        });
        return undefined;
    },
};
