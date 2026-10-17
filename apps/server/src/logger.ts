import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    unlinkSync,
    type WriteStream,
} from "node:fs";
import { resolve } from "node:path";

export interface FileLoggerOptions {
    dir: string;
    maxBytes?: number;
    keepDays?: number;
    keepFiles?: number;
    now?: () => Date;
}

export interface FileLogger {
    close(): Promise<void>;
    flush(): Promise<void>;
    write(line: string): void;
    current(): string;
}

const LEVELS = ["log", "info", "warn", "error"] as const;
const DAY_MS = 86_400_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_KEEP_FILES = 200;
const FILE_RE = /^server-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

export const logDay = (date: Date): string => date.toISOString().slice(0, 10);

const logName = (day: string, index: number): string =>
    index === 0 ? `server-${day}.log` : `server-${day}.${index}.log`;

const readSize = (file: string): number => {
    try {
        return existsSync(file) ? statSync(file).size : 0;
    } catch {
        return 0;
    }
};

const nextIndex = (dir: string, day: string, maxBytes: number): number => {
    for (let index = 0; index < 1000; index += 1) {
        const size = readSize(resolve(dir, logName(day, index)));
        if (size < maxBytes) return index;
    }
    return 999;
};

export const pruneLogs = (
    dir: string,
    keepDays: number,
    keepFiles: number,
    now: () => Date = () => new Date(),
): string[] => {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const cutoff = now().getTime() - keepDays * DAY_MS;
    const removed: string[] = [];
    const kept: Array<{ file: string; at: number }> = [];
    for (const name of names) {
        const match = FILE_RE.exec(name);
        if (!match) continue;
        const file = resolve(dir, name);
        const day = Date.parse(`${match[1]}T00:00:00.000Z`);
        if (Number.isFinite(day) && day < cutoff) {
            try {
                unlinkSync(file);
                removed.push(file);
            } catch {
                continue;
            }
            continue;
        }
        kept.push({ file, at: day + Number(match[2] ?? 0) });
    }
    if (kept.length > keepFiles) {
        kept.sort((a, b) => a.at - b.at);
        for (const item of kept.slice(0, kept.length - keepFiles)) {
            try {
                unlinkSync(item.file);
                removed.push(item.file);
            } catch {}
        }
    }
    return removed;
};

export const installFileLogger = (
    options: FileLoggerOptions,
): FileLogger | null => {
    if (!options.dir.trim()) return null;
    const dir = resolve(process.cwd(), options.dir);
    mkdirSync(dir, { recursive: true });

    const maxBytes = Math.max(64 * 1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const keepDays = Math.max(1, options.keepDays ?? DEFAULT_KEEP_DAYS);
    const keepFiles = Math.max(1, options.keepFiles ?? DEFAULT_KEEP_FILES);
    const now = options.now ?? (() => new Date());

    let stream: WriteStream | null = null;
    let day = "";
    let index = 0;
    let size = 0;
    let closed = false;

    const open = (target: string) => {
        const next = createWriteStream(target, { flags: "a" });
        next.on("error", (err) => {
            process.stderr.write(`file logger write failed: ${String(err)}\n`);
        });
        stream = next;
        size = readSize(target);
    };

    const rotate = (target: string) => {
        const previous = stream;
        stream = null;
        if (previous) previous.end();
        open(target);
    };

    const ensure = (): WriteStream | null => {
        if (closed) return null;
        const today = logDay(now());
        if (!stream) {
            day = today;
            index = nextIndex(dir, today, maxBytes);
            open(resolve(dir, logName(day, index)));
            if (size >= maxBytes) {
                index += 1;
                rotate(resolve(dir, logName(day, index)));
            }
            return stream;
        }
        if (today !== day) {
            day = today;
            index = nextIndex(dir, today, maxBytes);
            rotate(resolve(dir, logName(day, index)));
            return stream;
        }
        if (size >= maxBytes) {
            index += 1;
            rotate(resolve(dir, logName(day, index)));
            pruneLogs(dir, keepDays, keepFiles, now);
            return stream;
        }
        return stream;
    };

    const write = (line: string) => {
        const target = ensure();
        if (!target) return;
        target.write(line);
        size += Buffer.byteLength(line);
    };

    for (const level of LEVELS) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            original(...args);
            write(
                `${new Date().toISOString()} [${level}] ${args.map(String).join(" ")}\n`,
            );
        };
    }

    pruneLogs(dir, keepDays, keepFiles, now);

    const flush = async (): Promise<void> => {
        const target = stream;
        if (!target) return;
        await new Promise<void>((done) => {
            target.write("", () => done());
        });
    };

    return {
        async close() {
            if (closed) return;
            closed = true;
            const target = stream;
            stream = null;
            if (!target) return;
            await new Promise<void>((done) => {
                target.end(() => done());
            });
        },
        flush,
        write,
        current: () => resolve(dir, logName(day, index)),
    };
};
