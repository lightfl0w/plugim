import type { Plugin } from "@plugim/core";
import type { SettingsStore } from "../types";

const STATE_PREFIX = "task_state_";
const TICK_MS = 60_000;
const FIRST_TICK_MS = 5_000;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 43_200;

export interface TaskSpec {
    name: string;
    title: string;
    description?: string;
    intervalMinutes: number;
    run(): Promise<string>;
}

export interface TaskState {
    enabled: boolean;
    intervalMinutes: number;
    lastRun: string | null;
    lastStatus: "ok" | "error" | null;
    lastMessage: string;
    runs: number;
}

export interface TaskInfo extends TaskState {
    name: string;
    title: string;
    description: string;
}

export interface TasksService {
    register(spec: TaskSpec): void;
    list(): Promise<TaskInfo[]>;
    run(name: string): Promise<TaskInfo>;
    set(
        name: string,
        patch: { enabled?: boolean; intervalMinutes?: number },
    ): Promise<TaskInfo>;
}

const clampInterval = (value: number): number =>
    Math.min(
        Math.max(Number.isFinite(value) ? Math.floor(value) : 0, MIN_INTERVAL),
        MAX_INTERVAL,
    );

export const tasksPlugin: Plugin = {
    name: "tasks",
    description: "后台定时任务调度",
    provides: ["tasks"],
    inject: ["settings"],
    async apply(ctx) {
        const settings = ctx.get<SettingsStore>("settings");
        const specs = new Map<string, TaskSpec>();
        const running = new Set<string>();

        const stateOf = async (spec: TaskSpec): Promise<TaskState> => {
            const fallback: TaskState = {
                enabled: true,
                intervalMinutes: clampInterval(spec.intervalMinutes),
                lastRun: null,
                lastStatus: null,
                lastMessage: "",
                runs: 0,
            };
            const raw = await settings.get(STATE_PREFIX + spec.name);
            if (!raw) return fallback;
            try {
                const parsed = JSON.parse(raw) as Partial<TaskState>;
                return {
                    enabled: parsed.enabled !== false,
                    intervalMinutes: clampInterval(
                        Number(parsed.intervalMinutes) ||
                            fallback.intervalMinutes,
                    ),
                    lastRun:
                        typeof parsed.lastRun === "string"
                            ? parsed.lastRun
                            : null,
                    lastStatus:
                        parsed.lastStatus === "ok" ||
                        parsed.lastStatus === "error"
                            ? parsed.lastStatus
                            : null,
                    lastMessage:
                        typeof parsed.lastMessage === "string"
                            ? parsed.lastMessage.slice(0, 300)
                            : "",
                    runs: Math.max(0, Number(parsed.runs) || 0),
                };
            } catch {
                return fallback;
            }
        };

        const saveState = async (spec: TaskSpec, state: TaskState) => {
            await settings.set(STATE_PREFIX + spec.name, JSON.stringify(state));
        };

        const infoOf = async (spec: TaskSpec): Promise<TaskInfo> => ({
            name: spec.name,
            title: spec.title,
            description: spec.description ?? "",
            ...(await stateOf(spec)),
        });

        const runTask = async (
            spec: TaskSpec,
            trigger: "auto" | "manual",
        ): Promise<TaskInfo> => {
            if (running.has(spec.name)) {
                throw new Error("任务正在执行中");
            }
            running.add(spec.name);
            let status: "ok" | "error" = "ok";
            let message = "";
            try {
                message = await spec.run();
            } catch (err) {
                status = "error";
                message = String(err instanceof Error ? err.message : err);
            } finally {
                running.delete(spec.name);
            }
            const state = await stateOf(spec);
            const next: TaskState = {
                ...state,
                lastRun: new Date().toISOString(),
                lastStatus: status,
                lastMessage: message.slice(0, 300),
                runs: state.runs + 1,
            };
            await saveState(spec, next);
            if (status === "ok") {
                ctx.log.info(`task ${spec.name} (${trigger}): ${message}`);
            } else {
                ctx.log.warn(
                    `task ${spec.name} (${trigger}) failed: ${message}`,
                );
            }
            return {
                name: spec.name,
                title: spec.title,
                description: spec.description ?? "",
                ...next,
            };
        };

        ctx.provide<TasksService>("tasks", {
            register(spec) {
                specs.set(spec.name, spec);
            },
            async list() {
                return Promise.all([...specs.values()].map(infoOf));
            },
            async run(name) {
                const spec = specs.get(name);
                if (!spec) throw new Error("任务不存在");
                return runTask(spec, "manual");
            },
            async set(name, patch) {
                const spec = specs.get(name);
                if (!spec) throw new Error("任务不存在");
                const state = await stateOf(spec);
                const next: TaskState = { ...state };
                if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
                if (patch.intervalMinutes !== undefined) {
                    const minutes = Number(patch.intervalMinutes);
                    if (
                        !Number.isInteger(minutes) ||
                        minutes < MIN_INTERVAL ||
                        minutes > MAX_INTERVAL
                    )
                        throw new Error(
                            `执行周期需为 ${MIN_INTERVAL} 到 ${MAX_INTERVAL} 分钟之间的整数`,
                        );
                    next.intervalMinutes = minutes;
                }
                await saveState(spec, next);
                return {
                    name: spec.name,
                    title: spec.title,
                    description: spec.description ?? "",
                    ...next,
                };
            },
        });

        const tick = async () => {
            for (const spec of specs.values()) {
                const state = await stateOf(spec);
                if (!state.enabled) continue;
                const last = state.lastRun ? Date.parse(state.lastRun) : 0;
                if (Date.now() - last < state.intervalMinutes * 60_000) {
                    continue;
                }
                await runTask(spec, "auto").catch(() => undefined);
            }
        };

        const first = setTimeout(() => void tick(), FIRST_TICK_MS);
        first.unref?.();
        const timer = setInterval(() => void tick(), TICK_MS);
        timer.unref?.();
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    },
};
