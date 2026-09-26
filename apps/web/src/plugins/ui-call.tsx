import type { Context } from "@plugim/core";
import type { IceServerConfig, ScreenSignal } from "@plugim/protocol";
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
            if (e.candidate)
                void sendSignal({
                    callId,
                    type: "ice",
                    candidate: e.candidate.toJSON(),
                }).catch(() => undefined);
        };
        peer.ontrack = (e) => {
            trace(`ontrack kind=${e.track.kind}`);
            remoteStream = e.streams[0] ?? new MediaStream([e.track]);
            bindMedia();
        };
        peer.onconnectionstatechange = () => {
            trace(`connectionState=${peer.connectionState}`);
            if (
                peer.connectionState === "failed" ||
                peer.connectionState === "closed"
            )
                teardown();
        };
        return peer;
    };

    const VIDEO_MAX_BITRATE = 900_000;
    const AUDIO_MAX_BITRATE = 48_000;

    const applyEncodings = () => {
        for (const sender of pc?.getSenders() ?? []) {
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
                    await rpc
                        .call("screen.decline", {
                            callId: signal.callId,
                        })
                        .catch(() => undefined);
                    return;
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
            case "hangup": {
                if (state.phase === "active") flashError("对方已挂断");
                teardown();
                break;
            }
            case "offer": {
                if (isCaller || !pc || !signal.sdp) return;
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
                    <div className="pointer-events-auto absolute right-4 bottom-4 flex w-[22rem] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
                        <div className="relative">
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
        clearTimeout(errorTimer);
        clearInterval(tickTimer);
        teardown();
    };
};
