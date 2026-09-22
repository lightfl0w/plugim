import type { Plugin } from "@plugim/core";
import type { IceServerConfig, ScreenSignal } from "@plugim/protocol";
import {
    MonitorIcon,
    PhoneForwardedIcon,
    PhoneIcon,
    ScreenShareOffIcon,
} from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { RpcService } from "./connection";
import type { UiService } from "./ui";

type Phase =
    | "idle"
    | "outgoing"
    | "incoming"
    | "connecting"
    | "sharing"
    | "viewing";

interface ScreenState {
    phase: Phase;
    peer: string;
    incomingFrom: string;
    error: string;
    streamSeq: number;
}

export const uiScreenPlugin: Plugin = {
    name: "ui-screen-share",
    description: "1v1 屏幕共享(WebRTC，信令走 WS 网关)",
    inject: ["ui", "rpc"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");

        let state: ScreenState = {
            phase: "idle",
            peer: "",
            incomingFrom: "",
            error: "",
            streamSeq: 0,
        };
        const subs = new Set<() => void>();
        const set = (patch: Partial<ScreenState>) => {
            state = { ...state, ...patch };
            for (const cb of subs) cb();
        };
        const useScreen = () =>
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

        const flashError = (message: string) => {
            set({ error: message });
            clearTimeout(errorTimer);
            errorTimer = setTimeout(() => set({ error: "" }), 3000);
        };

        const screenLog: string[] = [];
        const trace = (line: string) => {
            screenLog.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
            if (screenLog.length > 200) screenLog.shift();
            console.debug("[screen]", line);
        };
        (window as unknown as { __screenLog: string[] }).__screenLog =
            screenLog;

        const sendSignal = async (params: Record<string, unknown>) => {
            trace(`send ${String(params.type)}`);
            try {
                await rpc.call("screen.signal", params);
            } catch (err) {
                trace(`send ${String(params.type)} rejected: ${String(err)}`);
                throw err;
            }
        };

        const loadIce = async () => {
            if (!iceConfig)
                iceConfig = (await rpc.call(
                    "screen.config",
                    {},
                )) as IceServerConfig[];
            return iceConfig;
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

        const teardown = () => {
            trace(`teardown from phase=${state.phase}`);
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
            set({ phase: "idle", incomingFrom: "" });
        };

        const flushCandidates = async () => {
            for (const candidate of pendingCandidates) {
                await pc?.addIceCandidate(candidate as RTCIceCandidateInit);
            }
            pendingCandidates = [];
        };

        const beginShare = async () => {
            trace("beginShare: requesting display media");
            try {
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true,
                });
                localStream = stream;
                pc = await createPeer();
                stream.getTracks().forEach((track) => {
                    pc?.addTrack(track, stream);
                });
                stream.getVideoTracks()[0].onended = () => void hangup();
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await sendSignal({
                    callId,
                    type: "offer",
                    sdp: offer.sdp,
                });
                trace(`offer sent, tracks=${stream.getTracks().length}`);
                set({ phase: "sharing" });
            } catch (err) {
                trace(`beginShare failed: ${String(err)}`);
                await rpc
                    .call("screen.hangup", { callId })
                    .catch(() => undefined);
                teardown();
                flashError("共享已取消");
            }
        };

        const hangup = async () => {
            if (callId)
                await rpc
                    .call("screen.hangup", { callId })
                    .catch(() => undefined);
            teardown();
        };

        const startOutgoing = async (peer: string) => {
            try {
                const result = (await rpc.call("screen.invite", {
                    to: peer,
                    kind: "screen",
                })) as { callId: string };
                callId = result.callId;
                isCaller = true;
                trace(`invite sent to ${peer}, callId=${callId.slice(0, 8)}`);
                set({ phase: "outgoing", peer });
            } catch (err) {
                trace(`invite failed: ${String(err)}`);
                flashError(String(err instanceof Error ? err.message : err));
            }
        };

        const acceptIncoming = async () => {
            try {
                isCaller = false;
                pc = await createPeer();
                pc.ontrack = (e) => {
                    trace(
                        `ontrack: ${e.streams[0]?.getTracks().length ?? 0} tracks`,
                    );
                    remoteStream = e.streams[0] ?? new MediaStream([e.track]);
                    set({
                        phase: "viewing",
                        streamSeq: state.streamSeq + 1,
                    });
                };
                await rpc.call("screen.accept", { callId });
                trace(`accepted, callId=${callId.slice(0, 8)}`);
                set({ phase: "connecting" });
            } catch (err) {
                trace(`accept failed: ${String(err)}`);
                teardown();
                flashError(String(err instanceof Error ? err.message : err));
            }
        };

        const handleSignal = async (signal: ScreenSignal) => {
            if (signal.kind === "voice") return;
            const guarded =
                signal.callId !== callId && signal.type !== "invite";
            trace(
                `recv ${signal.type} from ${signal.from}${guarded ? " (ignored, callId mismatch)" : ""}`,
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
                    if (isCaller) await beginShare();
                    break;
                }
                case "decline": {
                    if (state.phase === "outgoing") {
                        teardown();
                        flashError(`${signal.from} 拒绝了共享请求`);
                    } else teardown();
                    break;
                }
                case "hangup": {
                    teardown();
                    flashError("对方已结束共享");
                    break;
                }
                case "offer": {
                    if (!pc || !signal.sdp) return;
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
                    break;
                }
                case "answer": {
                    if (!pc || !signal.sdp) return;
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
            if (state.phase !== "idle") void hangup();
            set({ peer });
        });

        const HeaderButton = () => {
            const s = useScreen();
            if (!s.peer || s.phase === "incoming") return null;
            if (s.phase === "idle")
                return (
                    <Button
                        size="sm"
                        variant="ghost"
                        title={`向 ${s.peer} 发起屏幕共享`}
                        onClick={() => void startOutgoing(s.peer)}
                    >
                        <MonitorIcon />
                        共享屏幕
                    </Button>
                );
            if (s.phase === "outgoing")
                return (
                    <Button size="sm" variant="ghost" disabled>
                        等待 {s.peer} 接受...
                    </Button>
                );
            return (
                <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-500 hover:text-red-600"
                    onClick={() => void hangup()}
                >
                    <ScreenShareOffIcon />
                    {s.phase === "sharing" ? "停止共享" : "结束观看"}
                </Button>
            );
        };

        const Overlay = () => {
            const s = useScreen();
            const videoRef = useRef<HTMLVideoElement>(null);
            useEffect(() => {
                void s.phase;
                void s.streamSeq;
                const el = videoRef.current;
                if (el && remoteStream && el.srcObject !== remoteStream) {
                    el.srcObject = remoteStream;
                    void el.play().catch(() => {
                        el.muted = true;
                        void el.play().catch(() => undefined);
                    });
                }
            }, [s.phase, s.streamSeq]);

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
                                <span className="flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary">
                                    <MonitorIcon className="size-7" />
                                </span>
                                <p className="text-sm font-medium">
                                    {s.incomingFrom} 请求共享屏幕
                                </p>
                                <div className="flex gap-3">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                            void rpc
                                                .call("screen.decline", {
                                                    callId,
                                                })
                                                .catch(() => undefined);
                                            teardown();
                                        }}
                                    >
                                        拒绝
                                    </Button>
                                    <Button
                                        size="sm"
                                        onClick={() => void acceptIncoming()}
                                    >
                                        接受
                                    </Button>
                                </div>
                            </div>
                        </div>
                    ) : null}
                    {s.phase === "viewing" || s.phase === "connecting" ? (
                        <div className="pointer-events-auto absolute right-4 bottom-4 flex w-[26rem] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
                            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                                <PhoneForwardedIcon className="size-4 text-emerald-500" />
                                <p className="min-w-0 flex-1 truncate text-sm font-medium">
                                    {s.phase === "connecting"
                                        ? `已接受，等待 ${s.incomingFrom || s.peer} 的画面...`
                                        : `${s.incomingFrom || s.peer} 正在共享屏幕`}
                                </p>
                                <button
                                    type="button"
                                    title="结束观看"
                                    className="rounded-md p-1 text-red-500 hover:bg-accent"
                                    onClick={() => void hangup()}
                                >
                                    <ScreenShareOffIcon className="size-4" />
                                </button>
                            </div>
                            <video
                                ref={videoRef}
                                autoPlay
                                playsInline
                                className="aspect-video w-full bg-black object-contain"
                            >
                                <track kind="captions" src="" label="字幕" />
                            </video>
                        </div>
                    ) : null}
                    {s.phase === "sharing" ? (
                        <div
                            className={cn(
                                "pointer-events-auto absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-emerald-600 px-4 py-1.5 text-xs text-white shadow-lg",
                            )}
                        >
                            <PhoneIcon className="size-3.5" />
                            正在向 {s.peer} 共享屏幕
                            <button
                                type="button"
                                className="rounded-full bg-white/20 px-2 py-0.5 hover:bg-white/30"
                                onClick={() => void hangup()}
                            >
                                停止
                            </button>
                        </div>
                    ) : null}
                </>
            );
        };

        const unregisterHeader = ui.register("header", HeaderButton, 10);
        const unregisterOverlay = ui.register("overlay", Overlay, 40);
        return () => {
            unregisterHeader();
            unregisterOverlay();
            disposeSignal();
            disposeOpen();
            clearTimeout(errorTimer);
            teardown();
        };
    },
};
