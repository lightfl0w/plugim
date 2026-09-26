import type { Plugin } from "@plugim/core";
import type {
    CallKind,
    GroupCallEvent,
    GroupCallEventType,
    GroupCallInfo,
    GroupCallSignal,
    ScreenSignal,
    ScreenSignalType,
} from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    FriendsStore,
    GatewayService,
    GroupsStore,
} from "../types";
import type { AppConfig } from "./config";

interface Call {
    id: string;
    fromId: string;
    toId: string;
    fromName: string;
    toName: string;
    kind: CallKind;
    active: boolean;
}

interface Room {
    id: string;
    groupId: string;
    groupName: string;
    kind: CallKind;
    hostId: string;
    members: Map<string, string>;
}

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const RELAY_TYPES: ScreenSignalType[] = ["offer", "answer", "ice"];
const GROUP_SIGNAL_TYPES: GroupCallSignal["type"][] = [
    "offer",
    "answer",
    "ice",
];
const ROOM_LIMIT = 6;

export const screenPlugin: Plugin = {
    name: "screen",
    description: "通话信令中继(1v1 屏幕共享/语音视频、群组通话)",
    provides: ["screen-rpc"],
    inject: ["gateway", "accounts", "friendships", "groups", "config"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const groups = ctx.get<GroupsStore>("groups");
        const config = ctx.get<AppConfig>("config");

        const calls = new Map<string, Call>();
        const callOf = (userId: string) =>
            [...calls.values()].find(
                (call) => call.fromId === userId || call.toId === userId,
            );

        const drop = (call: Call) => {
            calls.delete(call.id);
        };

        const forward = (
            call: Call,
            sender: AuthUser,
            type: ScreenSignalType,
            extra?: { sdp?: string; candidate?: unknown },
        ) => {
            const toId = sender.id === call.fromId ? call.toId : call.fromId;
            const signal: ScreenSignal = {
                type,
                callId: call.id,
                from: sender.username,
                kind: call.kind,
                ...extra,
            };
            gateway.emitToUser(toId, "screen:signal", signal);
            return toId;
        };

        const areFriends = async (me: AuthUser, otherId: string) => {
            const edges = await friendships.edgesOf(me.id);
            return edges.some(
                (edge) =>
                    edge.status === "accepted" &&
                    ((edge.requesterId === me.id &&
                        edge.addresseeId === otherId) ||
                        (edge.requesterId === otherId &&
                            edge.addresseeId === me.id)),
            );
        };

        gateway.rpc("screen.config", async (_raw, conn) => {
            requireUser(conn);
            return config.iceServers;
        });

        gateway.rpc("screen.invite", async (raw, conn) => {
            const me = requireUser(conn);
            const { to, kind } = raw as unknown as {
                to: string;
                kind?: CallKind;
            };
            const callKind: CallKind =
                kind === "voice" || kind === "video" ? kind : "screen";
            const peer = await accounts.byUsername(
                String(to ?? "")
                    .trim()
                    .toLowerCase(),
            );
            if (!peer || peer.id === me.id) throw new Error("用户不存在");
            if (!(await areFriends(me, peer.id)))
                throw new Error("只能向好友发起通话");
            if (callOf(me.id) || roomOf(me.id))
                throw new Error("你正在进行通话");
            if (callOf(peer.id) || roomOf(peer.id)) throw new Error("对方正忙");
            if (!gateway.isUserOnline(peer.id)) throw new Error("对方不在线");
            const call: Call = {
                id: crypto.randomUUID(),
                fromId: me.id,
                toId: peer.id,
                fromName: me.username,
                toName: peer.username,
                kind: callKind,
                active: false,
            };
            calls.set(call.id, call);
            gateway.emitToUser(peer.id, "screen:signal", {
                type: "invite",
                callId: call.id,
                from: me.username,
                kind: callKind,
            } satisfies ScreenSignal);
            return { callId: call.id, kind: callKind };
        });

        gateway.rpc("screen.accept", async (raw, conn) => {
            const me = requireUser(conn);
            const { callId } = raw as unknown as { callId: string };
            const call = calls.get(callId);
            if (!call || call.toId !== me.id)
                throw new Error("通话不存在或已结束");
            call.active = true;
            forward(call, me, "accept");
            return true;
        });

        gateway.rpc("screen.decline", async (raw, conn) => {
            const me = requireUser(conn);
            const { callId } = raw as unknown as { callId: string };
            const call = calls.get(callId);
            if (!call) return true;
            forward(call, me, "decline");
            drop(call);
            return true;
        });

        gateway.rpc("screen.hangup", async (raw, conn) => {
            const me = requireUser(conn);
            const { callId } = raw as unknown as { callId: string };
            const call = calls.get(callId);
            if (!call) return true;
            if (call.fromId !== me.id && call.toId !== me.id)
                throw new Error("无权结束该通话");
            forward(call, me, "hangup");
            drop(call);
            return true;
        });

        gateway.rpc("screen.signal", async (raw, conn) => {
            const me = requireUser(conn);
            const { callId, type, sdp, candidate } = raw as unknown as {
                callId: string;
                type: ScreenSignalType;
                sdp?: string;
                candidate?: unknown;
            };
            if (!RELAY_TYPES.includes(type)) throw new Error("非法信令类型");
            const call = calls.get(callId);
            if (!call) throw new Error("通话不存在或已结束");
            if (call.fromId !== me.id && call.toId !== me.id)
                throw new Error("无权转发该信令");
            if (!call.active) throw new Error("通话尚未接通");
            if (type === "ice" && typeof candidate !== "object")
                throw new Error("非法 ICE 候选");
            if (
                (type === "offer" || type === "answer") &&
                typeof sdp !== "string"
            )
                throw new Error("缺少 SDP");
            forward(call, me, type, {
                sdp:
                    typeof sdp === "string"
                        ? sdp.slice(0, 32 * 1024)
                        : undefined,
                candidate: type === "ice" ? candidate : undefined,
            });
            return true;
        });
        const rooms = new Map<string, Room>();
        const roomOf = (userId: string) =>
            [...rooms.values()].find((room) => room.members.has(userId));
        const roomOfGroup = (groupId: string) =>
            [...rooms.values()].find((room) => room.groupId === groupId);

        const roomInfo = (room: Room): GroupCallInfo => ({
            roomId: room.id,
            groupId: room.groupId,
            groupName: room.groupName,
            kind: room.kind,
            host: room.members.get(room.hostId) ?? "",
            members: [...room.members.values()],
        });

        const emitRoom = (
            room: Room,
            type: GroupCallEventType,
            from: string,
            to?: string[],
        ) => {
            const payload: GroupCallEvent = {
                type,
                roomId: room.id,
                groupId: room.groupId,
                groupName: room.groupName,
                kind: room.kind,
                from,
            };
            for (const id of to ?? [...room.members.keys()])
                gateway.emitToUser(id, "group:call", payload);
        };

        const requireGroup = async (groupId: string, me: AuthUser) => {
            const row = await groups.byId(groupId);
            if (!row) throw new Error("群组不存在");
            const members = await groups.membersOf(groupId);
            if (!members.some((member) => member.userId === me.id))
                throw new Error("你不在该群中");
            return { row, members };
        };

        gateway.rpc("call.group.info", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId } = raw as unknown as { groupId?: string };
            await requireGroup(String(groupId ?? ""), me);
            const room = roomOfGroup(String(groupId ?? ""));
            return room ? roomInfo(room) : null;
        });

        gateway.rpc("call.group.start", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, kind } = raw as unknown as {
                groupId?: string;
                kind?: CallKind;
            };
            const callKind: CallKind = kind === "video" ? "video" : "voice";
            const { row, members } = await requireGroup(
                String(groupId ?? ""),
                me,
            );
            if (callOf(me.id) || roomOf(me.id))
                throw new Error("你正在进行通话");
            if (roomOfGroup(row.id)) throw new Error("该群已有通话进行中");
            const room: Room = {
                id: crypto.randomUUID(),
                groupId: row.id,
                groupName: row.name,
                kind: callKind,
                hostId: me.id,
                members: new Map([[me.id, me.username]]),
            };
            rooms.set(room.id, room);
            emitRoom(
                room,
                "invite",
                me.username,
                members
                    .map((member) => member.userId)
                    .filter((id) => id !== me.id),
            );
            return roomInfo(room);
        });

        gateway.rpc("call.group.join", async (raw, conn) => {
            const me = requireUser(conn);
            const { roomId } = raw as unknown as { roomId?: string };
            const room = rooms.get(String(roomId ?? ""));
            if (!room) throw new Error("通话已结束");
            await requireGroup(room.groupId, me);
            if (callOf(me.id)) throw new Error("你正在进行通话");
            const current = roomOf(me.id);
            if (current && current.id !== room.id)
                throw new Error("你正在进行其他群通话");
            const others = [...room.members.entries()].filter(
                ([id]) => id !== me.id,
            );
            if (!room.members.has(me.id)) {
                if (room.members.size >= ROOM_LIMIT)
                    throw new Error(`群通话最多 ${ROOM_LIMIT} 人`);
                room.members.set(me.id, me.username);
                emitRoom(
                    room,
                    "join",
                    me.username,
                    others.map(([id]) => id),
                );
            }
            return {
                room: roomInfo(room),
                others: others.map(([, name]) => name),
            };
        });

        gateway.rpc("call.group.leave", async (raw, conn) => {
            const me = requireUser(conn);
            const { roomId } = raw as unknown as { roomId?: string };
            const room = rooms.get(String(roomId ?? ""));
            if (!room?.members.has(me.id)) return true;
            room.members.delete(me.id);
            if (room.hostId === me.id || room.members.size === 0) {
                emitRoom(room, "end", me.username);
                rooms.delete(room.id);
                return true;
            }
            emitRoom(room, "leave", me.username);
            return true;
        });

        gateway.rpc("call.group.end", async (raw, conn) => {
            const me = requireUser(conn);
            const { roomId } = raw as unknown as { roomId?: string };
            const room = rooms.get(String(roomId ?? ""));
            if (!room) return true;
            if (room.hostId !== me.id)
                throw new Error("只有发起人可以结束通话");
            emitRoom(room, "end", me.username);
            rooms.delete(room.id);
            return true;
        });

        gateway.rpc("call.group.signal", async (raw, conn) => {
            const me = requireUser(conn);
            const { roomId, to, type, sdp, candidate } = raw as unknown as {
                roomId?: string;
                to?: string;
                type?: GroupCallSignal["type"];
                sdp?: string;
                candidate?: unknown;
            };
            const signalType = String(type ?? "") as GroupCallSignal["type"];
            if (!GROUP_SIGNAL_TYPES.includes(signalType))
                throw new Error("非法信令类型");
            const room = rooms.get(String(roomId ?? ""));
            if (!room) throw new Error("通话已结束");
            if (!room.members.has(me.id)) throw new Error("你不在该通话中");
            const targetName = String(to ?? "").trim();
            const target = [...room.members.entries()].find(
                ([id, name]) => name === targetName && id !== me.id,
            );
            if (!target) throw new Error("对方不在该通话中");
            if (signalType === "ice" && typeof candidate !== "object")
                throw new Error("非法 ICE 候选");
            if (signalType !== "ice" && typeof sdp !== "string")
                throw new Error("缺少 SDP");
            gateway.emitToUser(target[0], "group:call:signal", {
                type: signalType,
                roomId: room.id,
                from: me.username,
                sdp:
                    typeof sdp === "string"
                        ? sdp.slice(0, 32 * 1024)
                        : undefined,
                candidate: signalType === "ice" ? candidate : undefined,
            } satisfies GroupCallSignal);
            return true;
        });

        const cleanupForOffline = (userId: string) => {
            const call = callOf(userId);
            if (call) {
                const goneName =
                    call.fromId === userId ? call.fromName : call.toName;
                const toId = call.fromId === userId ? call.toId : call.fromId;
                gateway.emitToUser(toId, "screen:signal", {
                    type: "hangup",
                    callId: call.id,
                    from: goneName,
                    kind: call.kind,
                } satisfies ScreenSignal);
                drop(call);
            }
            const room = roomOf(userId);
            if (!room) return;
            const goneName = room.members.get(userId) ?? "";
            room.members.delete(userId);
            if (room.hostId === userId || room.members.size === 0) {
                emitRoom(room, "end", goneName);
                rooms.delete(room.id);
                return;
            }
            emitRoom(room, "leave", goneName);
        };

        const offOffline = gateway.onOffline(cleanupForOffline);
        return () => {
            offOffline();
        };
    },
};
