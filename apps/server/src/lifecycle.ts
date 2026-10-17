import type { Logger } from "@plugim/core";

export interface LifecycleOptions {
    log: Logger;
    stop: () => Promise<void>;
    dispose?: () => void | Promise<void>;
    timeoutMs?: number;
    exit?: (code: number) => void;
}

export interface Lifecycle {
    shutdown(code: number, reason: string): Promise<void>;
    uninstall(): void;
    closing(): boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export const installLifecycle = (options: LifecycleOptions): Lifecycle => {
    const timeoutMs = Math.max(50, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const exit = options.exit ?? ((code: number) => process.exit(code));

    let closing = false;
    let requested = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const shutdown = async (code: number, reason: string): Promise<void> => {
        if (closing) {
            requested = Math.max(requested, code);
            options.log.warn(`shutdown already in progress (${reason})`);
            return;
        }
        closing = true;
        requested = code;
        options.log.info(`shutting down: ${reason}`);
        let guard: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((done) => {
            guard = setTimeout(() => {
                options.log.warn(`shutdown timed out after ${timeoutMs}ms`);
                done();
            }, timeoutMs);
            guard.unref?.();
            timers.add(guard);
        });
        try {
            await Promise.race([Promise.resolve().then(options.stop), timeout]);
            options.log.info("shutdown complete");
        } catch (err) {
            options.log.error("shutdown failed:", err);
        } finally {
            if (guard) {
                clearTimeout(guard);
                timers.delete(guard);
            }
        }
        try {
            await options.dispose?.();
        } catch (err) {
            process.stderr.write(`dispose failed: ${String(err)}\n`);
        }
        exit(requested);
    };

    const onSignal = (signal: NodeJS.Signals) => () => {
        void shutdown(0, signal);
    };
    const onRejection = (reason: unknown) => {
        options.log.error("unhandled rejection:", reason);
        void shutdown(1, "unhandledRejection");
    };
    const onException = (err: Error) => {
        options.log.error("uncaught exception:", err);
        void shutdown(1, "uncaughtException");
    };

    const signals: Array<NodeJS.Signals> = ["SIGINT", "SIGTERM"];
    const handlers: Array<[NodeJS.Signals, () => void]> = signals.map(
        (signal) => [signal, onSignal(signal)],
    );
    for (const [signal, handler] of handlers) process.on(signal, handler);
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onException);

    return {
        shutdown,
        closing: () => closing,
        uninstall() {
            for (const [signal, handler] of handlers) {
                process.off(signal, handler);
            }
            process.off("unhandledRejection", onRejection);
            process.off("uncaughtException", onException);
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
        },
    };
};
