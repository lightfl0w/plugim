import type { Context } from "@plugim/core";
import type {
    GroupCallEvent,
    GroupCallInfo,
    GroupCallSignal,
    IceServerConfig,
} from "@plugim/protocol";
import {
    MicIcon,
    MicOffIcon,
    PhoneIcon,
    PhoneOffIcon,
    VideoIcon,
    VideoOffIcon,
} from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { UiService } from "./ui-types";

type RoomPhase = "idle" | "incoming" | "active";
type RoomMedia = "voice" | "video";

interface PeerTile {
    name: string;
    stream: MediaStream | null;
    state: string;
    video: boolean;
}

interface RoomState {
    phase: RoomPhase;
    roomId: string;
    groupId: string;
    groupName: string;
    kind: RoomMedia;
    from: string;
    host: string;
    tiles: PeerTile[];
    muted: boolean;
    camOff: boolean;
    seconds: number;
    error: string;
}

interface PeerEntry {
    pc: RTCPeerConnection;
    stream: MediaStream | null;
    pending: unknown[];
    remoteReady: boolean;
}

const VIDEO_MAX_BITRATE = 900_000;
const AUDIO_MAX_BITRATE = 48_000;

const kindOf = (value: string): RoomMedia =>
    value === "video" ? "video" : "voice";

export const uiGroupCallSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const rpc = ctx.get<RpcService>("rpc");
    const auth = ctx.get<AuthService>("auth");

    let state: RoomState = {
        phase: "idle",
        roomId: "",
        groupId: "",
        groupName: "",
        kind: "voice",
        from: "",
        host: "",
        tiles: [],
        muted: false,
        camOff: false,
        seconds: 0,
        error: "",
    };
    const subs = new Set<() => void>();
    const set = (patch: Partial<RoomState>) => {
        state = { ...state, ...patch };
        for (const cb of subs) cb();
    };
    const useRoom = () =>
        useSyncExternalStore(
            (cb) => {
                subs.add(cb);
                return () => subs.delete(cb);
            },
            () => state,
        );

    const peers = new Map<string, PeerEntry>();
    const waiting = new Set<string>();
    let localStream: MediaStream | null = null;
    let roomId = "";
    let iceConfig: IceServerConfig[] | null = null;
    let errorTimer: ReturnType<typeof setTimeout> | undefined;
    let tickTimer: ReturnType<typeof setInterval> | undefined;

    const roomLog: string[] = [];
    const trace = (line: string) => {
        roomLog.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
        if (roomLog.length > 200) roomLog.shift();
        console.debug("[group-call]", line);
    };
    (window as unknown as Record<string, string[]>).__groupCallLog = roomLog;

    const flashError = (message: string) => {
        set({ error: message });
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => set({ error: "" }), 3000);
    };

    const syncTiles = () => {
        const names = [...new Set([...waiting, ...peers.keys()])];
        set({
            tiles: names.map((name) => {
                const entry = peers.get(name);
                return {
                    name,
                    stream: entry?.stream ?? null,
                    state: entry?.pc.connectionState ?? "connecting",
                    video: (entry?.stream?.getVideoTracks().length ?? 0) > 0,
                };
            }),
        });
    };

    const startTick = () => {
        clearInterval(tickTimer);
        set({ seconds: 0 });
        tickTimer = setInterval(
            () => set({ seconds: state.seconds + 1 }),
            1000,
        );
    };

    const loadIce = async () => {
        if (!iceConfig)
            iceConfig = (await rpc.call(
                "screen.config",
                {},
            )) as IceServerConfig[];
        return iceConfig;
    };

    const closePeer = (name: string) => {
        const entry = peers.get(name);
        if (!entry) return;
        entry.pc.onicecandidate = null;
        entry.pc.ontrack = null;
        entry.pc.onconnectionstatechange = null;
        entry.pc.close();
        peers.delete(name);
        waiting.delete(name);
        trace(`closed ${name}`);
    };

    const dropPeer = (name: string) => {
        closePeer(name);
        syncTiles();
    };

    const teardown = () => {
        trace(`teardown from ${state.phase}`);
        clearInterval(tickTimer);
        tickTimer = undefined;
        for (const name of [...peers.keys()]) closePeer(name);
        waiting.clear();
        peers.clear();
        localStream?.getTracks().forEach((track) => {
            track.stop();
        });
        localStream = null;
        roomId = "";
        set({
            phase: "idle",
            roomId: "",
            groupName: "",
            kind: "voice",
            from: "",
            host: "",
            tiles: [],
            muted: false,
            camOff: false,
            seconds: 0,
        });
    };

    const sendSignal = async (params: {
        type: string;
        to: string;
        sdp?: string;
        candidate?: unknown;
    }) => {
        if (!roomId) return;
        trace(`send ${params.type} to ${params.to}`);
        await rpc.call("call.group.signal", { roomId, ...params });
    };

    let localPending: Promise<MediaStream> | null = null;

    const openLocal = (): Promise<MediaStream> => {
        if (localStream) return Promise.resolve(localStream);
        if (localPending) return localPending;
        localPending = navigator.mediaDevices
            .getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    channelCount: 1,
                },
                video:
                    state.kind === "video"
                        ? {
                              facingMode: "user",
                              width: { ideal: 640 },
                              height: { ideal: 360 },
                              frameRate: { ideal: 24, max: 30 },
                          }
                        : false,
            })
            .then((stream) => {
                localStream = stream;
                stream.getAudioTracks().forEach((track) => {
                    track.enabled = !state.muted;
                });
                stream.getVideoTracks().forEach((track) => {
                    track.enabled = !state.camOff;
                    track.contentHint = "motion";
                });
                return stream;
            })
            .finally(() => {
                localPending = null;
            });
        return localPending;
    };

    const applyEncodings = (pc: RTCPeerConnection) => {
        for (const sender of pc.getSenders()) {
            const track = sender.track;
            if (!track) continue;
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0)
                params.encodings = [{}];
            const [encoding] = params.encodings;
            if (track.kind === "video") {
                encoding.maxBitrate = VIDEO_MAX_BITRATE;
                encoding.maxFramerate = 24;
            } else {
                encoding.maxBitrate = AUDIO_MAX_BITRATE;
            }
            void sender.setParameters(params).catch(() => undefined);
        }
    };

    const preferHardwareVideo = (pc: RTCPeerConnection) => {
        for (const transceiver of pc.getTransceivers()) {
            if (transceiver.sender.track?.kind !== "video") continue;
            const caps = RTCRtpSender.getCapabilities("video");
            if (!caps) continue;
            const isH264 = (codec: { mimeType: string }) =>
                codec.mimeType.toLowerCase() === "video/h264";
            const h264 = caps.codecs.filter(isH264);
            if (!h264.length) continue;
            const rest = caps.codecs.filter((codec) => !isH264(codec));
            try {
                transceiver.setCodecPreferences([...h264, ...rest]);
            } catch {
                trace("setCodecPreferences rejected");
            }
        }
    };

    const ensurePeer = async (name: string) => {
        const existing = peers.get(name);
        if (existing) return existing;
        const config = await loadIce();
        const pc = new RTCPeerConnection({
            iceServers: config.map((server) => ({
                urls: server.urls,
                username: server.username,
                credential: server.credential,
            })),
        });
        const entry: PeerEntry = {
            pc,
            stream: null,
            pending: [],
            remoteReady: false,
        };
        peers.set(name, entry);
        waiting.delete(name);
        pc.onicecandidate = (e) => {
            if (e.candidate)
                void sendSignal({
                    type: "ice",
                    to: name,
                    candidate: e.candidate.toJSON(),
                }).catch(() => undefined);
        };
        pc.ontrack = (e) => {
            trace(`ontrack ${name} ${e.track.kind}`);
            entry.stream = e.streams[0] ?? new MediaStream([e.track]);
            syncTiles();
        };
        pc.onconnectionstatechange = () => {
            trace(`${name} connection=${pc.connectionState}`);
            if (
                pc.connectionState === "failed" ||
                pc.connectionState === "closed"
            ) {
                dropPeer(name);
                return;
            }
            syncTiles();
        };
        const stream = await openLocal();
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        if (state.kind === "video") preferHardwareVideo(pc);
        syncTiles();
        return entry;
    };

    const flushCandidates = async (entry: PeerEntry) => {
        for (const candidate of entry.pending)
            await entry.pc
                .addIceCandidate(candidate as RTCIceCandidateInit)
                .catch(() => undefined);
        entry.pending = [];
    };

    const offerTo = async (name: string) => {
        try {
            const entry = await ensurePeer(name);
            const offer = await entry.pc.createOffer();
            await entry.pc.setLocalDescription(offer);
            applyEncodings(entry.pc);
            await sendSignal({ type: "offer", to: name, sdp: offer.sdp });
        } catch (err) {
            trace(`offer to ${name} failed: ${String(err)}`);
        }
    };

    const startRoom = async (groupId: string, media: RoomMedia) => {
        if (state.phase !== "idle") return;
        try {
            const info = (await rpc.call("call.group.start", {
                groupId,
                kind: media,
            })) as GroupCallInfo;
            roomId = info.roomId;
            set({
                phase: "active",
                roomId: info.roomId,
                groupId: info.groupId,
                groupName: info.groupName,
                kind: kindOf(info.kind),
                host: info.host,
                from: auth.user()?.username ?? "",
            });
            await openLocal();
            startTick();
            trace(`room ${info.roomId.slice(0, 8)} started`);
        } catch (err) {
            flashError(String(err instanceof Error ? err.message : err));
        }
    };

    const joinRoom = async (targetRoom: string) => {
        if (!targetRoom || state.phase === "active") return;
        try {
            const result = (await rpc.call("call.group.join", {
                roomId: targetRoom,
            })) as { room: GroupCallInfo; others: string[] };
            roomId = result.room.roomId;
            set({
                phase: "active",
                roomId: result.room.roomId,
                groupName: result.room.groupName,
                kind: kindOf(result.room.kind),
                host: result.room.host,
            });
            await openLocal();
            startTick();
            for (const name of result.others) {
                waiting.add(name);
                syncTiles();
                await offerTo(name);
            }
        } catch (err) {
            teardown();
            flashError(String(err instanceof Error ? err.message : err));
        }
    };

    const leaveRoom = async () => {
        const pendingRoom = roomId;
        teardown();
        if (pendingRoom)
            await rpc
                .call("call.group.leave", { roomId: pendingRoom })
                .catch(() => undefined);
    };

    const handleSignal = async (signal: GroupCallSignal) => {
        if (state.phase !== "active" || signal.roomId !== roomId) return;
        if (signal.from === (auth.user()?.username ?? "")) return;
        trace(`recv ${signal.type} from ${signal.from}`);
        if (signal.type === "offer") {
            if (!signal.sdp) return;
            const entry = await ensurePeer(signal.from);
            await entry.pc.setRemoteDescription(
                new RTCSessionDescription({
                    type: "offer",
                    sdp: signal.sdp,
                }),
            );
            entry.remoteReady = true;
            await flushCandidates(entry);
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
            applyEncodings(entry.pc);
            await sendSignal({
                type: "answer",
                to: signal.from,
                sdp: answer.sdp,
            });
            return;
        }
        if (signal.type === "answer") {
            const entry = peers.get(signal.from);
            if (!entry || !signal.sdp) return;
            await entry.pc.setRemoteDescription(
                new RTCSessionDescription({
                    type: "answer",
                    sdp: signal.sdp,
                }),
            );
            entry.remoteReady = true;
            await flushCandidates(entry);
            return;
        }
        const entry = peers.get(signal.from);
        if (!entry || !signal.candidate) return;
        if (!entry.remoteReady) {
            entry.pending.push(signal.candidate);
            return;
        }
        await entry.pc
            .addIceCandidate(signal.candidate as RTCIceCandidateInit)
            .catch(() => undefined);
    };

    const handleEvent = (event: GroupCallEvent) => {
        if (event.type === "invite") {
            if (
                state.phase !== "idle" ||
                (event.kind !== "voice" && event.kind !== "video")
            )
                return;
            trace(`invite from ${event.from}`);
            set({
                phase: "incoming",
                roomId: event.roomId,
                groupId: event.groupId,
                groupName: event.groupName,
                kind: kindOf(event.kind),
                from: event.from,
                host: event.from,
            });
            return;
        }
        if (state.phase === "incoming" && event.roomId === state.roomId) {
            if (event.type === "end") {
                teardown();
                flashError("通话已结束");
            }
            return;
        }
        if (state.phase !== "active" || event.roomId !== roomId) return;
        if (event.type === "join") {
            trace(`${event.from} joined`);
            waiting.add(event.from);
            syncTiles();
            return;
        }
        if (event.type === "leave") {
            trace(`${event.from} left`);
            dropPeer(event.from);
            flashError(`${event.from} 已离开通话`);
            return;
        }
        trace("room ended");
        teardown();
        flashError("通话已结束");
    };

    const toggleMute = () => {
        const next = !state.muted;
        localStream?.getAudioTracks().forEach((track) => {
            track.enabled = !next;
        });
        set({ muted: next });
    };

    const toggleCamera = () => {
        const next = !state.camOff;
        localStream?.getVideoTracks().forEach((track) => {
            track.enabled = !next;
        });
        set({ camOff: next });
    };

    const disposeEvent = ctx.on("server:group:call", (payload) => {
        handleEvent(payload as GroupCallEvent);
    });
    const disposeSignal = ctx.on("server:group:call:signal", (payload) => {
        void handleSignal(payload as GroupCallSignal).catch(() => undefined);
    });
    const disposeStart = ctx.on("ui:group:call", (payload) => {
        const {
            groupId,
            kind,
            roomId: target,
        } = payload as {
            groupId: string;
            kind: RoomMedia;
            roomId?: string;
        };
        if (target) {
            void joinRoom(target);
            return;
        }
        if (groupId)
            void startRoom(groupId, kind === "video" ? "video" : "voice");
    });

    const fmt = (n: number) =>
        `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

    const PeerVideo = ({
        stream,
        muted,
    }: {
        stream: MediaStream;
        muted?: boolean;
    }) => {
        const ref = useRef<HTMLVideoElement>(null);
        useEffect(() => {
            const el = ref.current;
            if (!el || el.srcObject === stream) return;
            el.srcObject = stream;
            void el.play().catch(() => {
                el.muted = true;
                void el.play().catch(() => undefined);
            });
        }, [stream]);
        return (
            <video
                ref={ref}
                autoPlay
                playsInline
                muted={muted}
                className="size-full object-cover"
            >
                <track kind="captions" src="" label="字幕" />
            </video>
        );
    };

    const PeerAudio = ({ stream }: { stream: MediaStream }) => {
        const ref = useRef<HTMLAudioElement>(null);
        useEffect(() => {
            const el = ref.current;
            if (!el || el.srcObject === stream) return;
            el.srcObject = stream;
            void el.play().catch(() => undefined);
        }, [stream]);
        return (
            <audio ref={ref} autoPlay playsInline>
                <track kind="captions" src="" label="字幕" />
            </audio>
        );
    };

    const bindPreview = (el: HTMLVideoElement | null) => {
        if (!el || !localStream || el.srcObject === localStream) return;
        el.srcObject = localStream;
        void el.play().catch(() => undefined);
    };

    const Overlay = () => {
        const s = useRoom();
        const count = s.tiles.length + 1;
        const isHost =
            Boolean(s.host) && s.host === (auth.user()?.username ?? "");
        return (
            <>
                {s.error ? (
                    <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-foreground/90 px-4 py-1.5 text-xs text-background shadow-lg">
                        {s.error}
                    </div>
                ) : null}
                {s.phase === "incoming" ? (
                    <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/40">
                        <div className="flex w-80 flex-col items-center gap-4 rounded-2xl bg-card p-6 shadow-2xl">
                            <span className="flex size-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                                {s.kind === "video" ? (
                                    <VideoIcon className="size-7" />
                                ) : (
                                    <PhoneIcon className="size-7" />
                                )}
                            </span>
                            <div className="text-center">
                                <p className="text-sm font-medium">
                                    {s.from} 邀请你加入群
                                    {s.kind === "video" ? "视频" : "语音"}
                                    通话
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {s.groupName}
                                </p>
                            </div>
                            <div className="flex gap-3">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => teardown()}
                                >
                                    忽略
                                </Button>
                                <Button
                                    size="sm"
                                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                                    onClick={() => void joinRoom(s.roomId)}
                                >
                                    加入通话
                                </Button>
                            </div>
                        </div>
                    </div>
                ) : null}
                {s.phase === "active" ? (
                    <div className="pointer-events-auto absolute right-4 bottom-4 flex w-[22rem] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
                        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                            <p className="min-w-0 flex-1 truncate text-sm font-medium">
                                {s.groupName || "群通话"}
                            </p>
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {count} 人 · {fmt(s.seconds)}
                            </span>
                        </div>
                        <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto p-2">
                            {s.kind === "video" ? (
                                <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
                                    {s.camOff ? (
                                        <span className="flex size-full items-center justify-center">
                                            <UserAvatar
                                                name={
                                                    auth.user()?.username ?? ""
                                                }
                                                size="sm"
                                            />
                                        </span>
                                    ) : (
                                        <video
                                            ref={bindPreview}
                                            autoPlay
                                            playsInline
                                            muted
                                            className="size-full object-cover"
                                        >
                                            <track
                                                kind="captions"
                                                src=""
                                                label="字幕"
                                            />
                                        </video>
                                    )}
                                    <span className="absolute left-1 bottom-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
                                        我
                                    </span>
                                </div>
                            ) : null}
                            {s.tiles.map((tile) => (
                                <div
                                    key={tile.name}
                                    className="relative aspect-video overflow-hidden rounded-lg bg-muted"
                                >
                                    {s.kind === "video" &&
                                    tile.video &&
                                    tile.stream ? (
                                        <PeerVideo stream={tile.stream} />
                                    ) : (
                                        <span className="flex size-full flex-col items-center justify-center gap-1">
                                            <UserAvatar
                                                name={tile.name}
                                                size="sm"
                                            />
                                            <span className="text-[10px] text-muted-foreground">
                                                {tile.state === "connected"
                                                    ? "已连接"
                                                    : "连接中"}
                                            </span>
                                        </span>
                                    )}
                                    <span className="absolute left-1 bottom-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
                                        {tile.name}
                                    </span>
                                    {s.kind === "voice" && tile.stream ? (
                                        <PeerAudio stream={tile.stream} />
                                    ) : null}
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center justify-center gap-3 border-t border-border px-3 py-2">
                            <button
                                type="button"
                                title={s.muted ? "取消静音" : "静音"}
                                onClick={toggleMute}
                                className={cn(
                                    "flex size-9 items-center justify-center rounded-full border border-border",
                                    s.muted
                                        ? "bg-red-50 text-red-500"
                                        : "hover:bg-accent",
                                )}
                            >
                                {s.muted ? (
                                    <MicOffIcon className="size-4" />
                                ) : (
                                    <MicIcon className="size-4" />
                                )}
                            </button>
                            {s.kind === "video" ? (
                                <button
                                    type="button"
                                    title={
                                        s.camOff ? "开启摄像头" : "关闭摄像头"
                                    }
                                    onClick={toggleCamera}
                                    className={cn(
                                        "flex size-9 items-center justify-center rounded-full border border-border",
                                        s.camOff
                                            ? "bg-red-50 text-red-500"
                                            : "hover:bg-accent",
                                    )}
                                >
                                    {s.camOff ? (
                                        <VideoOffIcon className="size-4" />
                                    ) : (
                                        <VideoIcon className="size-4" />
                                    )}
                                </button>
                            ) : null}
                            <button
                                type="button"
                                title={isHost ? "结束通话" : "离开通话"}
                                onClick={() => void leaveRoom()}
                                className="flex size-9 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600"
                            >
                                <PhoneOffIcon className="size-4" />
                            </button>
                        </div>
                    </div>
                ) : null}
            </>
        );
    };

    const unregisterOverlay = ui.register("overlay", Overlay, 42);
    return () => {
        unregisterOverlay();
        disposeEvent();
        disposeSignal();
        disposeStart();
        clearTimeout(errorTimer);
        clearInterval(tickTimer);
        teardown();
    };
};
