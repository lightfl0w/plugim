const STORAGE_KEY = "plugim_session_drafts";

const load = (): Record<string, string> => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed))
            if (typeof value === "string" && value.trim()) out[key] = value;
        return out;
    } catch {
        return {};
    }
};

let drafts = load();
const listeners = new Set<() => void>();

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
        } catch {}
    }, 400);
};

export const draftKey = (owner: string, session: string) =>
    `${owner}\n${session}`;

export const draftStore = {
    get(owner: string, session: string) {
        return drafts[draftKey(owner, session)] ?? "";
    },
    snapshot() {
        return drafts;
    },
    subscribe(cb: () => void) {
        listeners.add(cb);
        return () => {
            listeners.delete(cb);
        };
    },
    set(owner: string, session: string, text: string) {
        const key = draftKey(owner, session);
        if ((drafts[key] ?? "") === text) return;
        const next = { ...drafts };
        if (text.trim()) next[key] = text;
        else delete next[key];
        drafts = next;
        persist();
        for (const cb of listeners) cb();
    },
};
