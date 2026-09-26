import type { Plugin } from "@plugim/core";
import type {
    ChatMessage,
    FileMeta,
    HistoryParams,
    MergePayload,
    MessageKind,
    MessageSearchParams,
    RecallParams,
    SendMessageParams,
    TypingEvent,
    TypingParams,
} from "@plugim/protocol";
import { MENTION_ALL } from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ChatSendPayload,
    ChatService,
    ConnInfo,
    FriendsStore,
    GatewayService,
    GroupsStore,
    MessageStore,
    ReadsStore,
} from "../types";
import type { AppConfig } from "./config";
import type { PushService } from "./push";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const p2pKey = (a: string, b: string) => `p2p:${[a, b].sort().join("|")}`;

const KINDS: MessageKind[] = [
    "text",
    "image",
    "audio",
    "video",
    "file",
    "merge",
];

export const chatPlugin: Plugin = {
    name: "chat",
    description: "消息收发、历史查询与回执",
    provides: ["chat-rpc", "chat"],
    inject: [
        "gateway",
        "store",
        "config",
        "accounts",
        "friendships",
        "groups",
        "reads",
        "push",
    ],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const store = ctx.get<MessageStore>("store");
        const config = ctx.get<AppConfig>("config");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const groups = ctx.get<GroupsStore>("groups");
        const reads = ctx.get<ReadsStore>("reads");
        const push = ctx.get<PushService>("push");

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

        const previewOf = (payload: ChatSendPayload): string => {
            if (payload.kind === "image") return "[图片]";
            if (payload.kind === "audio") return "[语音]";
            if (payload.kind === "video") return "[视频]";
            if (payload.kind === "merge") return "[合并转发]";
            if (payload.kind === "file")
                return payload.file?.name
                    ? `[文件] ${payload.file.name}`
                    : "[文件]";
            return payload.content.slice(0, 80);
        };

        const sendTo = async (
            user: AuthUser,
            rawSession: string,
            payload: ChatSendPayload,
        ): Promise<ChatMessage> => {
            if (rawSession.startsWith("p2p:")) {
                const peer = await resolveP2p(user, rawSession);
                const saved = await store.save({
                    session: p2pKey(user.username, peer.username),
                    sender: user.username,
                    ...payload,
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
                push.deliver([peer.id], {
                    title: user.username,
                    body: previewOf(payload),
                    session: `p2p:${user.username}`,
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
                    ...payload,
                });
                const ids = await groups.memberIdsOf(row.id);
                for (const id of ids)
                    gateway.emitToUser(id, "message:new", {
                        message: saved,
                    });
                push.deliver(
                    ids.filter((id) => id !== user.id),
                    {
                        title: row.name,
                        body: `${user.username}: ${previewOf(payload)}`,
                        session: rawSession,
                    },
                );
                return saved;
            }

            const saved = await store.save({
                session: rawSession,
                sender: user.username,
                ...payload,
            });
            gateway.broadcast("message:new", { message: saved });
            push.deliverAll(
                {
                    title: user.username,
                    body: previewOf(payload),
                    session: rawSession,
                },
                user.id,
            );
            return saved;
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
            if (mentions?.includes(MENTION_ALL)) {
                if (!rawSession.startsWith("g:"))
                    throw new Error("只有群聊支持 @全体成员");
                const { mine } = await resolveGroup(user, rawSession);
                if (mine !== "owner" && mine !== "admin")
                    throw new Error("只有群主或管理员可以 @全体成员");
            }
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
                          mime: String(params.file.mime ?? "").slice(0, 100),
                      }
                    : null;
            return sendTo(user, rawSession, {
                content: params.content,
                quote,
                mentions,
                kind,
                file,
            });
        });

        const typingGate = new Map<string, number>();

        gateway.rpc("typing.send", async (raw, conn) => {
            const user = requireUser(conn);
            const rawSession = String(
                (raw as unknown as TypingParams).session ?? "",
            ).trim();
            if (!rawSession) return false;
            const now = Date.now();
            if (now - (typingGate.get(user.id) ?? 0) < 1500) return false;
            typingGate.set(user.id, now);
            if (rawSession.startsWith("p2p:")) {
                const peer = await resolveP2p(user, rawSession);
                gateway.emitToUser(peer.id, "typing", {
                    session: `p2p:${user.username}`,
                    username: user.username,
                } satisfies TypingEvent);
                return true;
            }
            if (rawSession.startsWith("g:")) {
                const { row } = await resolveGroup(user, rawSession);
                const ids = await groups.memberIdsOf(row.id);
                for (const id of ids) {
                    if (id === user.id) continue;
                    gateway.emitToUser(id, "typing", {
                        session: rawSession,
                        username: user.username,
                    } satisfies TypingEvent);
                }
                return true;
            }
            gateway.broadcast("typing", {
                session: rawSession,
                username: user.username,
            } satisfies TypingEvent);
            return true;
        });

        gateway.rpc("message.forward", async (raw, conn) => {
            const user = requireUser(conn);
            const { ids, id, sessions } = raw as unknown as {
                ids?: string[];
                id?: string;
                sessions: string[];
            };
            const list = (
                Array.isArray(ids) && ids.length
                    ? ids
                    : typeof id === "string"
                      ? [id]
                      : []
            )
                .filter((x): x is string => typeof x === "string")
                .slice(0, 100);
            if (!Array.isArray(sessions) || sessions.length === 0)
                throw new Error("请选择转发目标");
            if (sessions.length > 50) throw new Error("一次最多转发 50 个会话");
            if (list.length === 0) throw new Error("请选择要转发的消息");
            const sources: ChatMessage[] = [];
            for (const mid of list) {
                const message = await store.byId(mid);
                if (!message || message.recalledAt)
                    throw new Error("消息不存在或已撤回");
                const visible = message.session.startsWith("p2p:")
                    ? message.session
                          .slice(4)
                          .split("|")
                          .includes(user.username)
                    : message.session.startsWith("g:")
                      ? (
                            await groups.memberIdsOf(message.session.slice(2))
                        ).includes(user.id)
                      : true;
                if (!visible) throw new Error("无权转发该消息");
                sources.push(message);
            }
            sources.sort(
                (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
            );
            const merged: SendMessageParams | null =
                sources.length > 1
                    ? {
                          session: "",
                          content: JSON.stringify({
                              merge: 1,
                              title: `${sources.length} 条转发消息`,
                              list: sources.map((m) => ({
                                  sender: m.sender,
                                  content:
                                      m.kind && m.kind !== "text"
                                          ? `[${m.kind}]`
                                          : m.content.slice(0, 500),
                                  kind: m.kind ?? "text",
                                  createdAt: m.createdAt,
                              })),
                          } satisfies MergePayload),
                          kind: "merge",
                      }
                    : null;
            const targets = [...new Set(sessions.map((s) => String(s)))];
            const sent: ChatMessage[] = [];
            for (const target of targets) {
                const rawSession = target || config.defaultSession;
                if (
                    rawSession.startsWith("p2p:") &&
                    `p2p:${user.username}` === rawSession
                )
                    continue;
                if (merged) {
                    sent.push(
                        await sendTo(user, rawSession, {
                            content: merged.content,
                            quote: null,
                            mentions: null,
                            kind: "merge",
                            file: null,
                        }),
                    );
                    continue;
                }
                for (const message of sources) {
                    sent.push(
                        await sendTo(user, rawSession, {
                            content: message.content,
                            quote: null,
                            mentions: null,
                            kind: message.kind ?? "text",
                            file: message.file ?? null,
                        }),
                    );
                }
            }
            if (sent.length === 0) throw new Error("没有有效的转发目标");
            return sent;
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
                params.after,
                params.beforeId,
                params.afterId,
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

        gateway.rpc("message.search", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as MessageSearchParams;
            const keyword = String(params.keyword ?? "").trim();
            if (!keyword) throw new Error("请输入搜索关键词");
            const offset = Math.max(0, Math.floor(Number(params.offset ?? 0)));
            const limit = Math.min(
                100,
                Math.max(1, Math.floor(Number(params.limit ?? 20))),
            );
            const scope = String(params.session ?? "").trim();
            let session: string | undefined;
            let visible: string[] | undefined;
            if (scope) {
                session = scope;
                if (scope.startsWith("p2p:")) {
                    const peer = await resolveP2p(user, scope);
                    session = p2pKey(user.username, peer.username);
                } else if (scope.startsWith("g:")) {
                    await resolveGroup(user, scope);
                }
            } else {
                visible = [config.defaultSession];
                const edges = await friendships.edgesOf(user.id);
                const friendIds = [
                    ...new Set(
                        edges
                            .filter((edge) => edge.status === "accepted")
                            .map((edge) =>
                                edge.requesterId === user.id
                                    ? edge.addresseeId
                                    : edge.requesterId,
                            ),
                    ),
                ];
                for (const friend of await accounts.byIds(friendIds))
                    visible.push(p2pKey(user.username, friend.username));
                for (const group of await groups.groupsOf(user.id))
                    visible.push(`g:${group.id}`);
            }
            const result = await store.search({
                keyword,
                session,
                sessions: visible,
                offset,
                limit,
            });
            return { hits: result.rows, total: result.total };
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

        ctx.provide<ChatService>("chat", { sendTo });
        return undefined;
    },
};
