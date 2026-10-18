const base = "ws://127.0.0.1:3111";

const rpc = (ws, id, method, params) =>
    ws.send(JSON.stringify({ kind: "rpc", id, method, params }));

const open = (token) =>
    new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base}/ws?token=${encodeURIComponent(token)}`);
        const pending = new Map();
        const events = [];
        ws.onmessage = (evt) => {
            const frame = JSON.parse(evt.data);
            if (frame.kind === "rpc:ok" || frame.kind === "rpc:err") {
                const entry = pending.get(frame.id);
                pending.delete(frame.id);
                if (entry) entry(frame);
            } else if (frame.kind === "event") {
                events.push(frame);
            }
        };
        ws.onerror = reject;
        ws.onopen = () =>
            resolve({
                ws,
                events,
                call(method, params) {
                    const id = `r${Math.random().toString(36).slice(2)}`;
                    return new Promise((res, rej) => {
                        pending.set(id, (frame) =>
                            frame.kind === "rpc:ok"
                                ? res(frame.result)
                                : rej(new Error(frame.message)),
                        );
                        rpc(ws, id, method, params);
                    });
                },
                close: () => ws.close(),
            });
    });

const post = async (method, params, token) => {
    const res = await fetch(`http://127.0.0.1:3111/rpc/${method}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ params }),
    });
    return res.json();
};

const assert = (label, cond, extra) => {
    if (!cond) {
        console.error(`FAIL ${label}`, extra ?? "");
        process.exitCode = 1;
    } else console.log(`ok ${label}`);
};

const run = async () => {
    const suffix = Date.now().toString(36).slice(-4);
    const alice = await post("auth.register", {
        username: `ka${suffix}`,
        password: "Passw0rd!",
    });
    const bob = await post("auth.register", {
        username: `kb${suffix}`,
        password: "Passw0rd!",
    });
    assert("register both users", alice.ok && bob.ok, alice);
    const ta = alice.result.token;
    const tb = bob.result.token;

    const a = await open(ta);
    const b = await open(tb);
    await a.call("friend.request", { username: `kb${suffix}` });
    await b.call("friend.accept", { username: `ka${suffix}` });

    const m1 = await a.call("message.send", {
        session: `p2p:kb${suffix}`,
        content: "one",
    });
    const m2 = await a.call("message.send", {
        session: `p2p:kb${suffix}`,
        content: "two",
    });
    assert("seq increments", m1.seq === 1 && m2.seq === 2, { m1, m2 });

    const list = await b.call("history.list", {
        session: `p2p:ka${suffix}`,
        limit: 10,
    });
    assert("history ordered by seq", list.map((m) => m.seq).join(",") === "1,2");

    const summary = await b.call("chat.sessionList", {
        sessions: [`p2p:ka${suffix}`],
    });
    assert("unread counted server-side", summary[0].unread === 2, summary[0]);
    assert("summary exposes lastSeq", summary[0].lastSeq === 2);

    await b.call("chat.read", { session: `p2p:ka${suffix}`, seq: 2 });
    const cleared = await b.call("chat.sessionList", {
        sessions: [`p2p:ka${suffix}`],
    });
    assert("read clears unread", cleared[0].unread === 0, cleared[0]);

    const delta = await b.call("sync.delta", {
        cursors: [{ session: `p2p:ka${suffix}`, seq: 1 }],
    });
    assert(
        "delta returns only newer rows",
        delta.sessions[0].messages.map((m) => m.seq).join(",") === "2",
        delta.sessions[0],
    );

    const stale = await b.call("sync.delta", {
        cursors: [{ session: `p2p:ka${suffix}`, seq: 1 }],
    });
    assert("delta is idempotent for same cursor", stale.sessions[0].messages.length === 1);

    const readEvent = b.events.find((e) => e.name === "read:update");
    assert("read:update broadcast delivered", Boolean(readEvent), readEvent);

    await b.call("message.send", {
        session: `p2p:ka${suffix}`,
        content: "three",
    });
    const unreadAfter = await a.call("chat.sessionList", {
        sessions: [`p2p:kb${suffix}`],
    });
    assert("counterparty sees the new unread", unreadAfter[0].unread === 1, unreadAfter[0]);

    a.close();
    b.close();
};

await run();
