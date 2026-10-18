import type { Plugin } from "@plugim/core";
import type {
    ChatMessage,
    ChatPokeParams,
    FileMeta,
    HistoryParams,
    LinkPreview,
    MergePayload,
    MessageEditedEvent,
    MessageEditParams,
    MessageKind,
    MessageReactions,
    MessageReactParams,
    MessageSearchParams,
    ReadParams,
    ReadUpdateEvent,
    RecallParams,
    SendMessageParams,
    SessionListParams,
    SyncDeltaParams,
    SyncDeltaSession,
    TypingEvent,
    TypingParams,
} from "@plugim/protocol";
import { MENTION_ALL, REACTION_EMOJIS } from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ChatSendPayload,
    ChatService,
    ConnInfo,
    FriendsStore,
    GatewayService,
    GroupsStore,
    LinkPreviewService,
    MessageStore,
    ReadsStore,
    RedPacketStore,
} from "../types";
import type { BotsService } from "./bots";
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
    "redpacket",
];

const LINK_BUDGET_MS = 2000;
const MERGE_LINK_MAX = 5;
const REACTIONS_MAX = 8;
const CONTENT_MAX = 8000;
const EDIT_WINDOW_MS = 10 * 60 * 1000;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const FILE_URL_RE = /^\/files\/[a-f0-9]{32}$/;

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
        "link-preview",
        "redPackets",
        "bots",
    ],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const store = ctx.get<MessageStore>("store");
        const config = ctx.get<AppConfig>("config");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const groups = ctx.get<GroupsStore>("groups");
        const redPackets = ctx.get<RedPacketStore>("redPackets");
        const reads = ctx.get<ReadsStore>("reads");
        const push = ctx.get<PushService>("push");
        const linkPreview = ctx.get<LinkPreviewService>("link-preview");
        const bots = ctx.get<BotsService>("botEvents");

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

        const broadcastMessage = async (message: ChatMessage) => {
            if (message.session.startsWith("p2p:")) {
                const [a, b] = message.session.slice(4).split("|");
                const userA = await accounts.byUsername(a);
                const userB = await accounts.byUsername(b);
                if (userA)
                    gateway.emitToUser(userA.id, "message:update", {
                        message: { ...message, session: `p2p:${b}` },
                    });
                if (userB)
                    gateway.emitToUser(userB.id, "message:update", {
                        message: { ...message, session: `p2p:${a}` },
                    });
                return;
            }
            if (message.session.startsWith("g:")) {
                const ids = await groups.memberIdsOf(message.session.slice(2));
                for (const uid of ids)
                    gateway.emitToUser(uid, "message:update", { message });
                return;
            }
            gateway.broadcast("message:update", { message });
        };

        const previewOf = (payload: ChatSendPayload): string => {
            if (payload.kind === "image") return "[图片]";
            if (payload.kind === "audio") return "[语音]";
            if (payload.kind === "video") return "[视频]";
            if (payload.kind === "merge") return "[合并转发]";
            if (payload.kind === "moment") return "[动态分享]";
            if (payload.kind === "redpacket") return "[红包]";
            if (payload.kind === "transfer") return "[转账]";
            if (payload.kind === "aabill") return "[AA 账单]";
            if (payload.kind === "notice") return "[群公告]";
            if (payload.kind === "file")
                return payload.file?.name
                    ? `[文件] ${payload.file.name}`
                    : "[文件]";
            return payload.content.slice(0, 80);
        };

        const linkOfText = async (
            content: string,
        ): Promise<LinkPreview | null> => {
            if (!content.includes("://")) return null;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const budget = new Promise<LinkPreview | null>((resolve) => {
                timer = setTimeout(() => resolve(null), LINK_BUDGET_MS);
            });
            try {
                return await Promise.race([
                    linkPreview.previewOfText(content),
                    budget,
                ]);
            } catch {
                return null;
            } finally {
                clearTimeout(timer);
            }
        };

        const sendTo = async (
            user: AuthUser,
            rawSession: string,
            payload: ChatSendPayload,
        ): Promise<ChatMessage> => {
            if (
                !rawSession.startsWith("p2p:") &&
                !rawSession.startsWith("g:") &&
                rawSession !== config.defaultSession
            )
                throw new Error("会话不存在");
            const link =
                payload.kind === "text"
                    ? await linkOfText(payload.content)
                    : null;
            if (rawSession.startsWith("p2p:")) {
                const peer = await resolveP2p(user, rawSession);
                const saved = await store.save({
                    session: p2pKey(user.username, peer.username),
                    sender: user.username,
                    ...payload,
                    link,
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
                bots.emit("message.new", {
                    session: `p2p:${user.username}`,
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
                    link,
                });
                const ids = await groups.memberIdsOf(row.id);
                for (const id of ids)
                    gateway.emitToUser(id, "message:new", {
                        message: saved,
                    });
                bots.emit("message.new", {
                    session: rawSession,
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
                link,
            });
            gateway.broadcast("message:new", { message: saved });
            bots.emit("message.new", { session: rawSession, message: saved });
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
            if (!params.content?.trim() && params.kind !== "redpacket")
                throw new Error("消息内容不能为空");
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
            const content = String(params.content).slice(0, CONTENT_MAX);
            if (
                kind === "image" ||
                kind === "audio" ||
                kind === "video" ||
                kind === "file"
            ) {
                if (!FILE_URL_RE.test(content))
                    throw new Error("媒体消息必须引用已上传的文件");
            }
            const rawMime = String(params.file?.mime ?? "");
            const file: FileMeta | null =
                params.file &&
                typeof params.file.name === "string" &&
                typeof params.file.size === "number"
                    ? {
                          name: params.file.name.slice(0, 200),
                          size: Math.max(
                              0,
                              Math.floor(
                                  Number.isFinite(params.file.size)
                                      ? params.file.size
                                      : 0,
                              ),
                          ),
                          mime: MIME_RE.test(rawMime)
                              ? rawMime.slice(0, 100)
                              : "application/octet-stream",
                      }
                    : null;
            return sendTo(user, rawSession, {
                content,
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

        const pokeGate = new Map<string, number>();
        const POKE_COOLDOWN_MS = 10_000;

        gateway.rpc("chat.poke", async (raw, conn) => {
            const user = requireUser(conn);
            const { session, target } = raw as unknown as ChatPokeParams;
            const rawSession = String(session ?? "").trim();
            if (!rawSession) throw new Error("缺少会话");
            if (!rawSession.startsWith("p2p:") && !rawSession.startsWith("g:"))
                throw new Error("该会话不支持戳一戳");
            let targetName = "";
            let peerId: string | null = null;
            if (rawSession.startsWith("p2p:")) {
                const peer = await resolveP2p(user, rawSession);
                targetName = peer.username;
                peerId = peer.id;
            } else {
                await resolveGroup(user, rawSession);
                if (target) {
                    const members = await groups.membersOf(rawSession.slice(2));
                    const targetUser = await accounts.byUsername(
                        String(target).toLowerCase(),
                    );
                    if (
                        !targetUser ||
                        !members.some((m) => m.userId === targetUser.id)
                    )
                        throw new Error("对方不在该群中");
                    targetName = targetUser.username;
                }
            }
            const gateKey = `${user.id}:${rawSession}:${targetName}`;
            const now = Date.now();
            if (now - (pokeGate.get(gateKey) ?? 0) < POKE_COOLDOWN_MS)
                throw new Error("戳得太快了，休息一下吧");
            pokeGate.set(gateKey, now);
            const saved = await store.save({
                session: rawSession.startsWith("p2p:")
                    ? p2pKey(user.username, targetName)
                    : rawSession,
                sender: user.username,
                content: targetName
                    ? `${user.username} 戳了戳 ${targetName}`
                    : `${user.username} 戳了戳大家`,
                quote: null,
                mentions: null,
                kind: "system",
                file: null,
                link: null,
            });
            if (rawSession.startsWith("p2p:") && peerId) {
                gateway.emitToUser(user.id, "message:new", {
                    message: { ...saved, session: `p2p:${targetName}` },
                });
                gateway.emitToUser(peerId, "message:new", {
                    message: { ...saved, session: `p2p:${user.username}` },
                });
            } else {
                const ids = await groups.memberIdsOf(rawSession.slice(2));
                for (const id of ids)
                    gateway.emitToUser(id, "message:new", { message: saved });
            }
            return rawSession.startsWith("p2p:")
                ? { ...saved, session: `p2p:${targetName}` }
                : saved;
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
            const linkContents = [
                ...new Set(
                    sources
                        .filter((m) => (m.kind ?? "text") === "text")
                        .map((m) => m.content)
                        .filter((content) => content.includes("://")),
                ),
            ].slice(0, MERGE_LINK_MAX);
            const linkByContent = new Map<string, LinkPreview | null>();
            await Promise.all(
                linkContents.map(async (content) => {
                    linkByContent.set(content, await linkOfText(content));
                }),
            );
            const merged: SendMessageParams | null =
                sources.length > 1
                    ? {
                          session: "",
                          content: JSON.stringify({
                              merge: 1,
                              title: `${sources.length} 条转发消息`,
                              list: sources.map((m) => {
                                  const kind = m.kind ?? "text";
                                  if (kind === "merge") {
                                      let nested: MergePayload | null = null;
                                      try {
                                          const parsed = JSON.parse(
                                              m.content,
                                          ) as MergePayload;
                                          if (
                                              parsed &&
                                              parsed.merge === 1 &&
                                              Array.isArray(parsed.list)
                                          )
                                              nested = parsed;
                                      } catch {}
                                      return {
                                          sender: m.sender,
                                          content: "[聊天记录]",
                                          kind,
                                          merge: nested,
                                          link: null,
                                          createdAt: m.createdAt,
                                      };
                                  }
                                  if (
                                      kind === "image" ||
                                      kind === "audio" ||
                                      kind === "video" ||
                                      kind === "file"
                                  )
                                      return {
                                          sender: m.sender,
                                          content: m.content.slice(0, 500),
                                          kind,
                                          file: m.file ?? null,
                                          link: null,
                                          createdAt: m.createdAt,
                                      };
                                  if (kind === "moment")
                                      return {
                                          sender: m.sender,
                                          content: "[动态]",
                                          kind,
                                          link: null,
                                          createdAt: m.createdAt,
                                      };
                                  return {
                                      sender: m.sender,
                                      content: m.content.slice(0, 500),
                                      kind,
                                      link:
                                          linkByContent.get(m.content) ?? null,
                                      createdAt: m.createdAt,
                                  };
                              }),
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
            return historyFor(
                user,
                params.session || config.defaultSession,
                Math.min(Number(params.limit ?? 50), 200),
                params,
            );
        });

        const historyFor = async (
            user: AuthUser,
            rawSession: string,
            limit: number,
            params?: HistoryParams,
        ): Promise<ChatMessage[]> => {
            let session = rawSession;
            if (rawSession.startsWith("p2p:")) {
                const peer = await resolveP2p(user, rawSession);
                session = p2pKey(user.username, peer.username);
            } else if (rawSession.startsWith("g:")) {
                await resolveGroup(user, rawSession);
            } else if (rawSession && rawSession !== config.defaultSession) {
                throw new Error("会话不存在");
            }
            return store.list(session, limit, {
                before: params?.before,
                after: params?.after,
                beforeId: params?.beforeId,
                afterId: params?.afterId,
                beforeSeq: params?.beforeSeq,
                afterSeq: params?.afterSeq,
            });
        };

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

            if (message.redPacket) {
                const packetId = message.redPacket.id;
                const revoked = await redPackets.claimBack(packetId, {
                    at: recalledAt,
                });
                gateway.broadcast("redpacket:update", {
                    id: packetId,
                    status: revoked.status,
                    remaining: revoked.remaining,
                    remainCount: revoked.remainCount,
                    claimedCount: revoked.claimedCount,
                });
            }

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
            bots.emit("message.recalled", {
                id,
                session: message.session,
                recalledAt,
            });
            return { id, recalledAt };
        });
        gateway.rpc("message.react", async (raw, conn) => {
            const user = requireUser(conn);
            const { id, emoji } = raw as unknown as MessageReactParams;
            if (
                typeof emoji !== "string" ||
                !(REACTION_EMOJIS as readonly string[]).includes(emoji)
            )
                throw new Error("不支持的回应表情");
            const message = await store.byId(id);
            if (!message) throw new Error("消息不存在");
            if (message.recalledAt) throw new Error("消息已撤回");
            const visible = message.session.startsWith("p2p:")
                ? message.session.slice(4).split("|").includes(user.username)
                : message.session.startsWith("g:")
                  ? (
                        await groups.memberIdsOf(message.session.slice(2))
                    ).includes(user.id)
                  : true;
            if (!visible) throw new Error("无权回应该消息");
            const reactions: MessageReactions = {};
            for (const [key, users] of Object.entries(message.reactions ?? {}))
                reactions[key] = [...users];
            const mine = reactions[emoji] ?? [];
            const removing = mine.includes(user.username);
            if (removing) {
                const rest = mine.filter((name) => name !== user.username);
                if (rest.length > 0) reactions[emoji] = rest;
                else delete reactions[emoji];
            } else {
                if (
                    !(emoji in reactions) &&
                    Object.keys(reactions).length >= REACTIONS_MAX
                )
                    throw new Error("回应表情种类已达上限");
                reactions[emoji] = [...mine, user.username];
            }
            const updated = await store.setReactions(
                id,
                Object.keys(reactions).length > 0 ? reactions : null,
            );
            if (!updated) throw new Error("消息不存在");
            await broadcastMessage(updated);
            return { message: updated };
        });

        gateway.rpc("message.edit", async (raw, conn) => {
            const user = requireUser(conn);
            const { id } = raw as unknown as MessageEditParams;
            const content = String(
                (raw as unknown as MessageEditParams).content ?? "",
            ).trim();
            if (!id) throw new Error("缺少消息");
            if (!content) throw new Error("消息内容不能为空");
            if (content.length > CONTENT_MAX)
                throw new Error(`消息内容不能超过 ${CONTENT_MAX} 字`);
            const message = await store.byId(id);
            if (!message) throw new Error("消息不存在");
            if (message.recalledAt) throw new Error("消息已撤回");
            if (message.sender !== user.username)
                throw new Error("只能编辑自己的消息");
            const kind = message.kind ?? "text";
            if (kind !== "text") throw new Error("只能编辑文字消息");
            if (Date.now() - Date.parse(message.createdAt) > EDIT_WINDOW_MS)
                throw new Error("已超过可编辑时限");
            if (message.content === content) throw new Error("内容没有变化");
            const editedAt = new Date().toISOString();
            const updated = await store.edit(id, content, editedAt);
            if (!updated) throw new Error("消息不存在");
            await broadcastMessage(updated);
            const payload = {
                id: updated.id,
                session: updated.session,
                content: updated.content,
                editedAt,
                editCount: updated.editCount ?? 1,
            } satisfies MessageEditedEvent;
            gateway.broadcast("message:edited", payload);
            bots.emit("message.edited", payload);
            return {
                message: updated,
                editedAt,
                editCount: updated.editCount ?? 1,
            };
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

        const storageSessionOf = async (
            me: AuthUser,
            rawSession: string,
        ): Promise<string> => {
            if (rawSession.startsWith("p2p:")) {
                const peer = await resolveP2p(me, rawSession);
                return p2pKey(me.username, peer.username);
            }
            if (rawSession.startsWith("g:")) {
                await resolveGroup(me, rawSession);
                return rawSession;
            }
            if (rawSession && rawSession !== config.defaultSession)
                throw new Error("会话不存在");
            return config.defaultSession;
        };

        const visibleSessions = async (
            me: AuthUser,
            requested?: string[],
        ): Promise<string[]> => {
            if (Array.isArray(requested) && requested.length > 0) {
                const out: string[] = [];
                for (const raw of requested.slice(0, 200))
                    out.push(await storageSessionOf(me, String(raw ?? "")));
                return [...new Set(out)];
            }
            const out = [config.defaultSession];
            const edges = await friendships.edgesOf(me.id);
            const friendIds = [
                ...new Set(
                    edges
                        .filter((edge) => edge.status === "accepted")
                        .map((edge) =>
                            edge.requesterId === me.id
                                ? edge.addresseeId
                                : edge.requesterId,
                        ),
                ),
            ];
            for (const friend of await accounts.byIds(friendIds))
                out.push(p2pKey(me.username, friend.username));
            for (const group of await groups.groupsOf(me.id))
                out.push(`g:${group.id}`);
            return [...new Set(out)];
        };

        gateway.rpc("chat.read", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as ReadParams;
            const rawSession = String(params.session ?? "").trim();
            if (!rawSession) throw new Error("缺少会话");
            const session = await storageSessionOf(user, rawSession);
            const lastSeq = await store.lastSeq(session);
            const target = Math.min(
                Math.max(0, Math.floor(Number(params.seq ?? lastSeq)) || 0),
                lastSeq,
            );
            const at = new Date().toISOString();
            const before = await reads.cursorsOf(user.id);
            const previous = before[session] ?? 0;
            await reads.set(user.id, session, at, target);
            const effective = Math.max(previous, target);
            const payload = {
                session: rawSession,
                username: user.username,
                seq: effective,
                at,
            } satisfies ReadUpdateEvent;
            if (rawSession.startsWith("p2p:")) {
                const peer = await accounts.byUsername(rawSession.slice(4));
                if (peer) gateway.emitToUser(peer.id, "read:update", payload);
            } else if (rawSession.startsWith("g:")) {
                const ids = await groups.memberIdsOf(rawSession.slice(2));
                for (const uid of ids) {
                    if (uid === user.id) continue;
                    gateway.emitToUser(uid, "read:update", payload);
                }
            }
            gateway.emitToUser(user.id, "read:update", payload);
            bots.emit("read.update", {
                ...payload,
                storageSession: session,
            });
            return { seq: effective, at };
        });

        const rawOf = (username: string, storage: string): string => {
            if (!storage.startsWith("p2p:"))
                return storage === config.defaultSession
                    ? config.defaultSession
                    : storage;
            const peer = storage
                .slice(4)
                .split("|")
                .find((name) => name !== username);
            return `p2p:${peer ?? ""}`;
        };

        const deltaOf = async (
            raw: string,
            storage: string,
            cursor: number,
            cursors: Record<string, number>,
            limit: number,
        ): Promise<SyncDeltaSession> => {
            const rows = await store.since({
                session: storage,
                seq: cursor,
                limit: limit + 1,
            });
            const hasMore = rows.length > limit;
            const messages = hasMore ? rows.slice(0, limit) : rows;
            return {
                session: raw,
                messages,
                lastSeq:
                    messages.length > 0
                        ? (messages[messages.length - 1].seq ?? 0)
                        : cursor,
                readSeq: cursors[storage] ?? 0,
                hasMore,
            };
        };

        gateway.rpc("chat.sessionList", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as SessionListParams;
            const sessions = await visibleSessions(user, params.sessions);
            const rows = await store.summaries({
                userId: user.id,
                username: user.username,
                sessions,
            });
            return rows.map((row) => ({
                ...row,
                session: rawOf(user.username, row.session),
            }));
        });

        gateway.rpc("sync.delta", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as SyncDeltaParams;
            const limit = Math.min(
                Math.max(1, Math.floor(Number(params.limit ?? 200))),
                500,
            );
            const requested = Array.isArray(params.cursors)
                ? params.cursors
                      .filter(
                          (item) =>
                              item &&
                              typeof item.session === "string" &&
                              Number.isFinite(Number(item.seq)),
                      )
                      .slice(0, 200)
                : [];
            const cursorByRaw = new Map(
                requested.map((item) => [
                    item.session,
                    Math.max(0, Math.floor(Number(item.seq))),
                ]),
            );
            const cursors = await reads.cursorsOf(user.id);
            const out: SyncDeltaSession[] = [];
            if (requested.length > 0) {
                for (const rawSession of cursorByRaw.keys()) {
                    let storage: string;
                    try {
                        storage = await storageSessionOf(user, rawSession);
                    } catch {
                        continue;
                    }
                    out.push(
                        await deltaOf(
                            rawSession,
                            storage,
                            cursorByRaw.get(rawSession) ?? 0,
                            cursors,
                            limit,
                        ),
                    );
                }
                return { sessions: out, at: new Date().toISOString() };
            }
            for (const storage of await visibleSessions(user)) {
                out.push(
                    await deltaOf(
                        rawOf(user.username, storage),
                        storage,
                        0,
                        cursors,
                        limit,
                    ),
                );
            }
            return { sessions: out, at: new Date().toISOString() };
        });

        ctx.provide<ChatService>("chat", { sendTo, listFor: historyFor });
        return undefined;
    },
};
