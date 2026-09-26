import type { Plugin } from "@plugim/core";
import type {
    CallKind,
    ScreenSignal,
    ScreenSignalType,
} from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    FriendsStore,
    GatewayService,
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

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const RELAY_TYPES: ScreenSignalType[] = ["offer", "answer", "ice"];

export const screenPlugin: Plugin = {
    name: "screen",
    description: "1v1 通话(屏幕共享/语音)信令中继",
    provides: ["screen-rpc"],
    inject: ["gateway", "accounts", "friendships", "config"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
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
            if (callOf(me.id)) throw new Error("你正在进行通话");
            if (callOf(peer.id)) throw new Error("对方正忙");
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
        const cleanupForOffline = (userId: string) => {
            const call = callOf(userId);
            if (!call) return;
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
        };

        const offOffline = gateway.onOffline(cleanupForOffline);
        return () => {
            offOffline();
        };
    },
};
