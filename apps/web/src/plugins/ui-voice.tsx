import type { Plugin } from "@plugim/core";
import type { IceServerConfig, ScreenSignal } from "@plugim/protocol";
import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { RpcService } from "./connection";
import type { UiService } from "./ui";

type Phase = "idle" | "outgoing" | "incoming" | "active";

interface VoiceState {
    phase: Phase;
    peer: string;
    incomingFrom: string;
    error: string;
    seconds: number;
    muted: boolean;
}

export const uiVoicePlugin: Plugin = {
    name: "ui-voice-call",
    description: "1v1 语音通话(WebRTC 双向音频，复用通话信令)",
    inject: ["ui", "rpc"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");

        let state: VoiceState = {
            phase: "idle",
            peer: "",
            incomingFrom: "",
            error: "",
            seconds: 0,
            muted: false,
        };
        const subs = new Set<() => void>();
        const set = (patch: Partial<VoiceState>) => {
            state = { ...state, ...patch };
            for (const cb of subs) cb();
        };
        const useVoice = () =>
            useSyncExternalStore(
                (cb) => {
                    subs.add(cb);
                    return () => subs.delete(cb);
                },
                () => state,
            );

        let pc: RTCPeerConnection | null = null;
        let micStream: MediaStream | null = null;
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

        const voiceLog: string[] = [];
        const trace = (line: string) => {
            voiceLog.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
            if (voiceLog.length > 200) voiceLog.shift();
            console.debug("[voice]", line);
        };
        (window as unknown as { __voiceLog: string[] }).__voiceLog = voiceLog;

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
                attachRemote();
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

        let attachRemote: () => void = () => undefined;
        const setAttach = (fn: () => void) => {
            attachRemote = fn;
        };

        const openMic = async (peer: RTCPeerConnection) => {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
            });
            micStream = stream;
            stream.getAudioTracks().forEach((track) => {
                track.enabled = !state.muted;
                peer.addTrack(track, stream);
            });
        };

        const teardown = () => {
            trace(`teardown from phase=${state.phase}`);
            clearInterval(tickTimer);
            tickTimer = undefined;
            pc?.close();
            pc = null;
            micStream?.getTracks().forEach((t) => {
                t.stop();
            });
            micStream = null;
            remoteStream = null;
            callId = "";
            isCaller = false;
            pendingCandidates = [];
            remoteDescSet = false;
            set({
                phase: "idle",
                incomingFrom: "",
                seconds: 0,
                muted: false,
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
                await rpc
                    .call("screen.hangup", { callId })
                    .catch(() => undefined);
            teardown();
        };

        const beginCall = async () => {
            try {
                pc = await createPeer();
                await openMic(pc);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await sendSignal({
                    callId,
                    type: "offer",
                    sdp: offer.sdp,
                });
                startTick();
                set({ phase: "active" });
            } catch (err) {
                trace(`beginCall failed: ${String(err)}`);
                await rpc
                    .call("screen.hangup", { callId })
                    .catch(() => undefined);
                teardown();
                flashError("无法接通麦克风");
            }
        };

        const startOutgoing = async (peer: string) => {
            try {
                const result = (await rpc.call("screen.invite", {
                    to: peer,
                    kind: "voice",
                })) as { callId: string };
                callId = result.callId;
                isCaller = true;
                trace(`invite sent to ${peer}`);
                set({ phase: "outgoing", peer });
            } catch (err) {
                flashError(String(err instanceof Error ? err.message : err));
            }
        };

        const acceptIncoming = async () => {
            try {
                isCaller = false;
                pc = await createPeer();
                await openMic(pc);
                await rpc.call("screen.accept", { callId });
                trace(`accepted, callId=${callId.slice(0, 8)}`);
                set({ phase: "active" });
            } catch (err) {
                trace(`accept failed: ${String(err)}`);
                teardown();
                flashError("无法接通麦克风");
            }
        };

        const declineIncoming = async () => {
            if (callId)
                await rpc
                    .call("screen.decline", { callId })
                    .catch(() => undefined);
            teardown();
        };

        const toggleMute = () => {
            const next = !state.muted;
            micStream?.getAudioTracks().forEach((t) => {
                t.enabled = !next;
            });
            set({ muted: next });
        };

        const handleSignal = async (signal: ScreenSignal) => {
            if (signal.kind !== "voice") return;
            const guarded =
                signal.callId !== callId && signal.type !== "invite";
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
                    set({ phase: "incoming", incomingFrom: signal.from });
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
                        .addIceCandidate(
                            signal.candidate as RTCIceCandidateInit,
                        )
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

        const CallButton = () => {
            const s = useVoice();
            if (!s.peer || s.phase !== "idle") return null;
            return (
                <Button
                    size="sm"
                    variant="ghost"
                    title={`与 ${s.peer} 语音通话`}
                    onClick={() => void startOutgoing(s.peer)}
                >
                    <PhoneIcon />
                    语音通话
                </Button>
            );
        };

        const Overlay = () => {
            const s = useVoice();
            const audioRef = useRef<HTMLAudioElement>(null);
            useEffect(() => {
                setAttach(() => {
                    const el = audioRef.current;
                    if (el && remoteStream && el.srcObject !== remoteStream) {
                        el.srcObject = remoteStream;
                        void el.play().catch(() => undefined);
                    }
                });
            }, []);
            useEffect(() => {
                void s.phase;
                const el = audioRef.current;
                if (el && remoteStream && el.srcObject !== remoteStream) {
                    el.srcObject = remoteStream;
                    void el.play().catch(() => undefined);
                }
            }, [s.phase]);

            const showCall = s.phase === "outgoing" || s.phase === "active";
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
                                    <PhoneIcon className="size-7" />
                                </span>
                                <p className="text-sm font-medium">
                                    {s.incomingFrom} 邀请你语音通话
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
                    {showCall ? (
                        <div className="pointer-events-auto absolute right-4 bottom-4 flex w-64 flex-col items-center gap-3 rounded-2xl border border-border bg-card p-5 shadow-2xl">
                            <UserAvatar
                                name={s.incomingFrom || s.peer}
                                size="lg"
                            />
                            <p className="text-sm font-medium">
                                {s.incomingFrom || s.peer}
                            </p>
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
                    <audio ref={audioRef} autoPlay playsInline>
                        <track kind="captions" src="" label="字幕" />
                    </audio>
                </>
            );
        };

        const unregisterHeader = ui.register("header", CallButton, 9);
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
    },
};
