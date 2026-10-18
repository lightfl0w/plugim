import type { Context } from "@plugim/core";
import type {
    IceServerConfig,
    ScreenCallState,
    ScreenSignal,
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
import type { RpcService } from "./connection";
import type { UiService } from "./ui-types";

type Phase = "idle" | "outgoing" | "incoming" | "active";
type CallMedia = "voice" | "video";

interface CallState {
    phase: Phase;
    media: CallMedia;
    peer: string;
    incomingFrom: string;
    error: string;
    seconds: number;
    muted: boolean;
    camOff: boolean;
    weak: boolean;
    net: string;
}

export const uiCallSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const rpc = ctx.get<RpcService>("rpc");

    let state: CallState = {
        phase: "idle",
        media: "voice",
        peer: "",
        incomingFrom: "",
        error: "",
        seconds: 0,
        muted: false,
        camOff: false,
        weak: false,
        net: "",
    };
    const subs = new Set<() => void>();
    const set = (patch: Partial<CallState>) => {
        state = { ...state, ...patch };
        for (const cb of subs) cb();
    };
    const useCall = () =>
        useSyncExternalStore(
            (cb) => {
                subs.add(cb);
                return () => subs.delete(cb);
            },
            () => state,
        );

    let pc: RTCPeerConnection | null = null;
    let localStream: MediaStream | null = null;
    let remoteStream: MediaStream | null = null;
    let callId = "";
    let isCaller = false;
    let iceConfig: IceServerConfig[] | null = null;
    let pendingCandidates: unknown[] = [];
    let remoteDescSet = false;
    let errorTimer: ReturnType<typeof setTimeout> | undefined;
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    let statsTimer: ReturnType<typeof setInterval> | undefined;
    let restartCount = 0;
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let weakStreak = 0;

    const flashError = (message: string) => {
        set({ error: message });
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => set({ error: "" }), 3000);
    };

    const callLog: string[] = [];
    const trace = (line: string) => {
        callLog.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
        if (callLog.length > 200) callLog.shift();
        console.debug("[call]", line);
    };
    const w = window as unknown as Record<string, string[]>;
    w.__callLog = callLog;
    w.__voiceLog = callLog;

    const sendSignal = async (params: Record<string, unknown>) => {
        trace(`send ${String(params.type)}`);
        await rpc.call("screen.signal", params);
    };

    const loadIce = async () => {
        if (!iceConfig)
            iceConfig = (await rpc.call(
                "screen.config",
                {},
            )) as IceServerConfig[];
        return iceConfig;
    };

    const startTick = () => {
        clearInterval(tickTimer);
        set({ seconds: 0 });
        tickTimer = setInterval(
            () => set({ seconds: state.seconds + 1 }),
            1000,
        );
    };

    let bindMedia: () => void = () => undefined;
    const setBinder = (fn: () => void) => {
        bindMedia = fn;
    };

    const createPeer = async () => {
        const config = await loadIce();
        const peer = new RTCPeerConnection({
            iceServers: config.map((server) => ({
                urls: server.urls,
                username: server.username,
                credential: server.credential,
            })),
        });
        peer.onicecandidate = (e) => {
            if (!e.candidate) return;
            const c = e.candidate;
            if (c.candidate.includes("typ relay"))
                trace("local candidate: relay (TURN)");
            void sendSignal({
                callId,
                type: "ice",
                candidate: c.toJSON(),
            }).catch(() => undefined);
        };
        peer.ontrack = (e) => {
            trace(`ontrack kind=${e.track.kind}`);
            remoteStream = e.streams[0] ?? new MediaStream([e.track]);
            bindMedia();
        };
        peer.oniceconnectionstatechange = () => {
            const st = peer.iceConnectionState;
            trace(`iceConnectionState=${st}`);
            if (st === "disconnected") {
                clearTimeout(disconnectTimer);
                disconnectTimer = setTimeout(() => {
                    if (
                        pc &&
                        (pc.iceConnectionState === "disconnected" ||
                            pc.iceConnectionState === "failed")
                    )
                        void restartIce();
                }, 3000);
            }
            if (st === "failed") void restartIce();
        };
        peer.onconnectionstatechange = () => {
            trace(`connectionState=${peer.connectionState}`);
            if (peer.connectionState === "closed") teardown();
            if (peer.connectionState === "failed") void restartIce();
        };
        return peer;
    };

    const VIDEO_MAX_BITRATE = 900_000;
    const AUDIO_MAX_BITRATE = 48_000;
    let currentVideoBitrate = VIDEO_MAX_BITRATE;

    const restartIce = async () => {
        if (!pc || state.phase !== "active") return;
        if (restartCount >= 2) {
            flashError("网络不稳定，请尝试重新拨打");
            return;
        }
        restartCount += 1;
        weakStreak = 0;
        trace(`ice restart #${restartCount}`);
        try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            applyEncodings();
            await sendSignal({ callId, type: "offer", sdp: offer.sdp });
        } catch (err) {
            trace(`ice restart failed: ${String(err)}`);
        }
    };

    const sampleStats = async () => {
        if (!pc || state.phase !== "active") return;
        try {
            const report = await pc.getStats();
            let rtt: number | null = null;
            let relay = false;
            let lost = 0;
            let recv = 0;
            const pairs: Record<string, unknown>[] = [];
            report.forEach((stat) => {
                const item = stat as unknown as Record<string, unknown>;
                if (item.type === "candidate-pair") pairs.push(item);
                if (
                    item.type === "inbound-rtp" &&
                    (item.kind === "video" || item.mediaType === "video")
                ) {
                    lost += Number(item.packetsLost ?? 0);
                    recv += Number(item.packetsReceived ?? 0);
                }
            });
            const pair =
                pairs.find((item) => item.selected === true) ??
                pairs.find(
                    (item) =>
                        item.state === "succeeded" && item.nominated === true,
                );
            if (pair) {
                if (pair.currentRoundTripTime != null)
                    rtt = Number(pair.currentRoundTripTime) * 1000;
                const local = report.get(
                    pair.localCandidateId as string,
                ) as unknown as Record<string, unknown> | undefined;
                relay = local?.candidateType === "relay";
            }
            const lossPct = recv + lost > 0 ? (lost / (recv + lost)) * 100 : 0;
            const weak = (rtt ?? 0) > 400 || lossPct > 8;
            if (weak) weakStreak += 1;
            else weakStreak = 0;
            if (weakStreak >= 3 && currentVideoBitrate > 300_000) {
                currentVideoBitrate = 300_000;
                applyEncodings();
                trace("weak network: video bitrate -> 300kbps");
            }
            const parts: string[] = [];
            if (relay) parts.push("中继");
            if (rtt != null) parts.push(`RTT ${Math.round(rtt)}ms`);
            if (recv + lost > 0) parts.push(`丢包 ${lossPct.toFixed(1)}%`);
            set({ weak, net: parts.join(" ") });
        } catch {
            void 0;
        }
    };

    const startMonitor = () => {
        stopMonitor();
        statsTimer = setInterval(() => void sampleStats(), 2000);
    };

    const stopMonitor = () => {
        clearInterval(statsTimer);
        statsTimer = undefined;
        clearTimeout(disconnectTimer);
        disconnectTimer = undefined;
        weakStreak = 0;
        restartCount = 0;
        currentVideoBitrate = VIDEO_MAX_BITRATE;
        set({ weak: false, net: "" });
    };

    const applyEncodings = () => {
        for (const sender of pc?.getSenders() ?? []) {
            const track = sender.track;
            if (!track) continue;
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0)
                params.encodings = [{}];
            const [encoding] = params.encodings;
            if (track.kind === "video") {
                encoding.maxBitrate = currentVideoBitrate;
                encoding.maxFramerate = 24;
            } else {
                encoding.maxBitrate = AUDIO_MAX_BITRATE;
            }
            void sender
                .setParameters(params)
                .then(() =>
                    trace(
                        `encodings ${track.kind} maxBitrate=${encoding.maxBitrate ?? "-"} maxFramerate=${encoding.maxFramerate ?? "-"}`,
                    ),
                )
                .catch(() => undefined);
        }
    };

    const preferHardwareVideo = (peer: RTCPeerConnection) => {
        for (const transceiver of peer.getTransceivers()) {
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
                trace("video codec prefers H264");
            } catch {
                trace("setCodecPreferences rejected");
            }
        }
    };

    const openMedia = async (peer: RTCPeerConnection) => {
        const wantsVideo = state.media === "video";
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                channelCount: 1,
            },
            video: wantsVideo
                ? {
                      facingMode: "user",
                      width: { ideal: 640 },
                      height: { ideal: 360 },
                      frameRate: { ideal: 24, max: 30 },
                  }
                : false,
        });
        localStream = stream;
        stream.getAudioTracks().forEach((track) => {
            track.enabled = !state.muted;
            peer.addTrack(track, stream);
        });
        stream.getVideoTracks().forEach((track) => {
            track.enabled = !state.camOff;
            track.contentHint = "motion";
            peer.addTrack(track, stream);
        });
        if (wantsVideo) preferHardwareVideo(peer);
        bindMedia();
    };

    const teardown = () => {
        trace(`teardown from phase=${state.phase}`);
        stopMonitor();
        clearInterval(tickTimer);
        tickTimer = undefined;
        pc?.close();
        pc = null;
        localStream?.getTracks().forEach((t) => {
            t.stop();
        });
        localStream = null;
        remoteStream = null;
        callId = "";
        isCaller = false;
        pendingCandidates = [];
        remoteDescSet = false;
        set({
            phase: "idle",
            media: "voice",
            incomingFrom: "",
            seconds: 0,
            muted: false,
            camOff: false,
            weak: false,
            net: "",
        });
    };

    const flushCandidates = async () => {
        for (const candidate of pendingCandidates) {
            await pc?.addIceCandidate(candidate as RTCIceCandidateInit);
        }
        pendingCandidates = [];
    };

    const hangup = async () => {
        if (callId)
            await rpc.call("screen.hangup", { callId }).catch(() => undefined);
        teardown();
    };

    const deviceLabel = () =>
        state.media === "video" ? "摄像头/麦克风" : "麦克风";

    const beginCall = async () => {
        try {
            pc = await createPeer();
            await openMedia(pc);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            applyEncodings();
            await sendSignal({
                callId,
                type: "offer",
                sdp: offer.sdp,
            });
            startTick();
            startMonitor();
            set({ phase: "active" });
        } catch (err) {
            trace(`beginCall failed: ${String(err)}`);
            await rpc.call("screen.hangup", { callId }).catch(() => undefined);
            teardown();
            flashError(`无法访问${deviceLabel()}`);
        }
    };

    const startOutgoing = async (peer: string, media: CallMedia) => {
        try {
            set({ media });
            const result = (await rpc.call("screen.invite", {
                to: peer,
                kind: media,
            })) as { callId: string };
            callId = result.callId;
            isCaller = true;
            trace(`invite ${media} sent to ${peer}`);
            set({ phase: "outgoing", peer });
        } catch (err) {
            flashError(String(err instanceof Error ? err.message : err));
            set({ media: "voice" });
        }
    };

    const acceptIncoming = async () => {
        try {
            isCaller = false;
            pc = await createPeer();
            await openMedia(pc);
            await rpc.call("screen.accept", { callId });
            trace(`accepted, callId=${callId.slice(0, 8)}`);
            set({ phase: "active" });
        } catch (err) {
            trace(`accept failed: ${String(err)}`);
            teardown();
            flashError(`无法访问${deviceLabel()}`);
        }
    };

    const declineIncoming = async () => {
        if (callId)
            await rpc.call("screen.decline", { callId }).catch(() => undefined);
        teardown();
    };

    const toggleMute = () => {
        const next = !state.muted;
        localStream?.getAudioTracks().forEach((t) => {
            t.enabled = !next;
        });
        trace(`mute=${next}`);
        set({ muted: next });
    };

    const toggleCamera = () => {
        const next = !state.camOff;
        localStream?.getVideoTracks().forEach((t) => {
            t.enabled = !next;
        });
        trace(`cameraOff=${next}`);
        set({ camOff: next });
    };

    const handleSignal = async (signal: ScreenSignal) => {
        if (signal.kind !== "voice" && signal.kind !== "video") return;
        const guarded = signal.callId !== callId && signal.type !== "invite";
        trace(
            `recv ${signal.type} from ${signal.from}${guarded ? " (ignored)" : ""}`,
        );
        if (guarded) return;
        switch (signal.type) {
            case "invite": {
                if (state.phase !== "idle") {
                    const mine = (await rpc
                        .call("screen.state", {})
                        .catch(() => null)) as ScreenCallState | null;
                    if (mine && mine.callId === callId && !mine.active) {
                        await rpc
                            .call("screen.decline", {
                                callId: signal.callId,
                            })
                            .catch(() => undefined);
                        return;
                    }
                    teardown();
                }
                callId = signal.callId;
                set({
                    phase: "incoming",
                    media: signal.kind === "video" ? "video" : "voice",
                    incomingFrom: signal.from,
                });
                break;
            }
            case "accept": {
                if (isCaller) await beginCall();
                break;
            }
            case "decline": {
                if (state.phase === "outgoing")
                    flashError(`${signal.from} 拒绝了通话`);
                teardown();
                break;
            }
            case "timeout": {
                if (state.phase === "outgoing") flashError("对方无应答");
                teardown();
                break;
            }
            case "hangup": {
                if (state.phase === "active") flashError("对方已挂断");
                teardown();
                break;
            }
            case "offer": {
                if (!pc || !signal.sdp) return;
                if (isCaller && !remoteDescSet) return;
                await pc.setRemoteDescription(
                    new RTCSessionDescription({
                        type: "offer",
                        sdp: signal.sdp,
                    }),
                );
                remoteDescSet = true;
                await flushCandidates();
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                applyEncodings();
                await sendSignal({
                    callId,
                    type: "answer",
                    sdp: answer.sdp,
                });
                startTick();
                startMonitor();
                break;
            }
            case "answer": {
                if (!isCaller || !pc || !signal.sdp) return;
                await pc.setRemoteDescription(
                    new RTCSessionDescription({
                        type: "answer",
                        sdp: signal.sdp,
                    }),
                );
                remoteDescSet = true;
                await flushCandidates();
                break;
            }
            case "ice": {
                if (!pc || !signal.candidate) return;
                if (!remoteDescSet) {
                    pendingCandidates.push(signal.candidate);
                    return;
                }
                await pc
                    .addIceCandidate(signal.candidate as RTCIceCandidateInit)
                    .catch(() => undefined);
                break;
            }
        }
    };

    const disposeSignal = ctx.on("server:screen:signal", (payload) => {
        void handleSignal(payload as ScreenSignal).catch(() => undefined);
    });

    const disposeOpen = ctx.on("ui:chat:open", (payload) => {
        const session = (payload as { session: string }).session;
        const peer = session.startsWith("p2p:") ? session.slice(4) : "";
        set({ peer });
    });

    const restore = async () => {
        if (state.phase !== "idle") return;
        const info = (await rpc.call(
            "screen.state",
            {},
        )) as ScreenCallState | null;
        if (!info || info.active) return;
        if (info.kind !== "voice" && info.kind !== "video") return;
        if (state.phase !== "idle") return;
        callId = info.callId;
        isCaller = !info.incoming;
        trace(`restore ${info.kind} as ${info.incoming ? "callee" : "caller"}`);
        set({
            phase: info.incoming ? "incoming" : "outgoing",
            media: info.kind === "video" ? "video" : "voice",
            incomingFrom: info.peer,
            peer: info.peer,
        });
    };

    const onStatus = (status: string) => {
        if (status === "open") void restore().catch(() => undefined);
    };
    const disposeStatus = rpc.onStatus(onStatus);
    if (rpc.status() === "open") void restore().catch(() => undefined);

    const fmt = (n: number) =>
        `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

    const CallButtons = () => {
        const s = useCall();
        if (!s.peer || s.phase !== "idle") return null;
        return (
            <>
                <Button
                    size="sm"
                    variant="ghost"
                    title={`与 ${s.peer} 语音通话`}
                    onClick={() => void startOutgoing(s.peer, "voice")}
                >
                    <PhoneIcon />
                    语音通话
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    title={`与 ${s.peer} 视频通话`}
                    onClick={() => void startOutgoing(s.peer, "video")}
                >
                    <VideoIcon />
                    视频通话
                </Button>
            </>
        );
    };

    const Overlay = () => {
        const s = useCall();
        const audioRef = useRef<HTMLAudioElement>(null);
        const videoRef = useRef<HTMLVideoElement>(null);
        const previewRef = useRef<HTMLVideoElement>(null);
        useEffect(() => {
            setBinder(() => {
                const a = audioRef.current;
                if (a && remoteStream && a.srcObject !== remoteStream) {
                    a.srcObject = remoteStream;
                    void a.play().catch(() => undefined);
                }
                const v = videoRef.current;
                if (v && remoteStream && v.srcObject !== remoteStream) {
                    v.srcObject = remoteStream;
                    void v.play().catch(() => {
                        v.muted = true;
                        void v.play().catch(() => undefined);
                    });
                }
                const p = previewRef.current;
                if (p && localStream && p.srcObject !== localStream) {
                    p.srcObject = localStream;
                    void p.play().catch(() => undefined);
                }
            });
            return () => setBinder(() => undefined);
        }, []);
        useEffect(() => {
            void s.phase;
            void s.media;
            void s.seconds;
            bindMedia();
        }, [s.phase, s.media, s.seconds]);

        const who = s.incomingFrom || s.peer;
        const mediaLabel = s.media === "video" ? "视频" : "语音";
        const showAvatarPanel =
            s.phase === "outgoing" ||
            (s.phase === "active" && s.media === "voice");
        const showVideoPanel = s.phase === "active" && s.media === "video";
        return (
            <>
                {s.error ? (
                    <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-foreground/90 px-4 py-1.5 text-xs text-background shadow-lg">
                        {s.error}
                    </div>
                ) : null}
                {s.phase === "incoming" ? (
                    <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/40">
                        <div className="flex w-72 flex-col items-center gap-4 rounded-2xl bg-card p-6 shadow-2xl">
                            <span className="flex size-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                                {s.media === "video" ? (
                                    <VideoIcon className="size-7" />
                                ) : (
                                    <PhoneIcon className="size-7" />
                                )}
                            </span>
                            <p className="text-sm font-medium">
                                {who} 邀请你{mediaLabel}通话
                            </p>
                            <div className="flex gap-3">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-red-500"
                                    onClick={() => void declineIncoming()}
                                >
                                    拒绝
                                </Button>
                                <Button
                                    size="sm"
                                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                                    onClick={() => void acceptIncoming()}
                                >
                                    接听
                                </Button>
                            </div>
                        </div>
                    </div>
                ) : null}
                {showAvatarPanel ? (
                    <div className="pointer-events-auto absolute right-4 bottom-4 flex w-64 flex-col items-center gap-3 rounded-2xl border border-border bg-card p-5 shadow-2xl">
                        <UserAvatar name={who} size="lg" />
                        <p className="text-sm font-medium">{who}</p>
                        <p className="text-xs text-muted-foreground">
                            {s.phase === "outgoing"
                                ? "等待对方接听..."
                                : fmt(s.seconds)}
                        </p>
                        {s.net ? (
                            <p
                                className={cn(
                                    "text-[11px]",
                                    s.weak
                                        ? "text-amber-600 dark:text-amber-400"
                                        : "text-muted-foreground",
                                )}
                            >
                                {s.net}
                            </p>
                        ) : null}
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                title={s.muted ? "取消静音" : "静音"}
                                disabled={s.phase !== "active"}
                                onClick={toggleMute}
                                className={cn(
                                    "flex size-10 items-center justify-center rounded-full border border-border",
                                    s.muted
                                        ? "bg-red-50 text-red-500"
                                        : "hover:bg-accent",
                                )}
                            >
                                {s.muted ? (
                                    <MicOffIcon className="size-5" />
                                ) : (
                                    <MicIcon className="size-5" />
                                )}
                            </button>
                            <button
                                type="button"
                                title="挂断"
                                onClick={() => void hangup()}
                                className="flex size-10 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600"
                            >
                                <PhoneOffIcon className="size-5" />
                            </button>
                        </div>
                    </div>
                ) : null}
                {showVideoPanel ? (
                    <div className="pointer-events-auto absolute right-3 bottom-3 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl md:right-4 md:bottom-4">
                        <div className="relative">
                            {s.net ? (
                                <div
                                    className={cn(
                                        "pointer-events-none absolute top-2 left-2 z-10 rounded-full px-2 py-0.5 text-[11px] font-medium",
                                        s.weak
                                            ? "bg-amber-500/90 text-white"
                                            : "bg-black/50 text-white/90",
                                    )}
                                >
                                    {s.net}
                                </div>
                            ) : null}
                            <video
                                ref={videoRef}
                                autoPlay
                                playsInline
                                className="aspect-video w-full bg-black object-cover"
                            >
                                <track kind="captions" src="" label="字幕" />
                            </video>
                            <video
                                ref={previewRef}
                                autoPlay
                                playsInline
                                muted
                                className="absolute right-2 bottom-2 aspect-video w-24 rounded-lg border border-white/30 bg-black/60 object-cover"
                            >
                                <track kind="captions" src="" label="字幕" />
                            </video>
                            <span className="absolute left-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-xs text-white">
                                {fmt(s.seconds)}
                            </span>
                        </div>
                        <div className="flex items-center gap-2 px-3 py-2">
                            <p className="min-w-0 flex-1 truncate text-sm font-medium">
                                {who}
                            </p>
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
                            <button
                                type="button"
                                title={s.camOff ? "开启摄像头" : "关闭摄像头"}
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
                            <button
                                type="button"
                                title="挂断"
                                onClick={() => void hangup()}
                                className="flex size-9 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600"
                            >
                                <PhoneOffIcon className="size-4" />
                            </button>
                        </div>
                    </div>
                ) : null}
                <audio ref={audioRef} autoPlay playsInline>
                    <track kind="captions" src="" label="字幕" />
                </audio>
            </>
        );
    };

    const unregisterHeader = ui.register("header", CallButtons, 9);
    const unregisterOverlay = ui.register("overlay", Overlay, 41);
    return () => {
        unregisterHeader();
        unregisterOverlay();
        disposeSignal();
        disposeOpen();
        disposeStatus();
        clearTimeout(errorTimer);
        clearInterval(tickTimer);
        teardown();
    };
};
