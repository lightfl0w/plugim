import {
    createDecipheriv,
    createECDH,
    createHash,
    createHmac,
    createPublicKey,
    createVerify,
    hkdfSync,
    randomBytes,
} from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

const base = process.env.BASE ?? "http://127.0.0.1:3999";
const hookPort = Number(process.env.HOOK_PORT ?? 3998);
const hookHits = [];

const pushHits = [];
const s3Port = Number(process.env.S3_PORT ?? 3997);
const s3Objects = new Map();
const s3Calls = [];
const S3_ACCESS = "test-access-key";
const S3_SECRET = "test-secret-key";

const s3Hmac = (key, data) => createHmac("sha256", key).update(data).digest();

function s3SignatureCheck(req, rawBody) {
    const auth = req.headers.authorization ?? "";
    const match =
        /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d+)\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(
            auth,
        );
    if (!match) return { ok: false, reason: "bad authorization" };
    const [, accessKey, dateStamp, region, signedHeaders, signature] = match;
    const amzDate = req.headers["x-amz-date"] ?? "";
    const payloadHash = req.headers["x-amz-content-sha256"] ?? "";
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    if (bodyHash !== payloadHash)
        return { ok: false, reason: "payload hash mismatch" };
    const names = signedHeaders.split(";");
    const canonicalHeaders = names
        .map((name) => `${name}:${String(req.headers[name] ?? "").trim()}\n`)
        .join("");
    const canonicalRequest = [
        req.method,
        req.url,
        "",
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        scope,
        createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    let key = s3Hmac(`AWS4${S3_SECRET}`, dateStamp);
    key = s3Hmac(key, region);
    key = s3Hmac(key, "s3");
    key = s3Hmac(key, "aws4_request");
    const expected = createHmac("sha256", key)
        .update(stringToSign)
        .digest("hex");
    return {
        ok: accessKey === S3_ACCESS && expected === signature,
        reason:
            expected === signature
                ? "access key mismatch"
                : "signature mismatch",
        expected,
        actual: signature,
    };
}

function startS3Mock() {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            const check = s3SignatureCheck(req, raw);
            s3Calls.push({
                method: req.method,
                url: req.url,
                ok: check.ok,
                reason: check.reason,
            });
            if (!check.ok) {
                res.writeHead(403, { "content-type": "text/plain" });
                res.end(`denied: ${check.reason}`);
                return;
            }
            const key = decodeURIComponent(req.url.replace(/^\/test\//, ""));
            if (req.method === "PUT") {
                s3Objects.set(key, raw);
                res.writeHead(200);
                res.end();
                return;
            }
            if (req.method === "GET") {
                const found = s3Objects.get(key);
                if (!found) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    "content-type": "application/octet-stream",
                });
                res.end(found);
                return;
            }
            if (req.method === "DELETE") {
                s3Objects.delete(key);
                res.writeHead(204);
                res.end();
                return;
            }
            if (req.method === "HEAD") {
                res.writeHead(200);
                res.end();
                return;
            }
            res.writeHead(405);
            res.end();
        });
    });
    return new Promise((resolve) => {
        server.listen(s3Port, "127.0.0.1", () => resolve(server));
    });
}

const b64u = (buffer) => Buffer.from(buffer).toString("base64url");
const unb64u = (text) => Buffer.from(String(text), "base64url");
const VAPID_SPKI = Buffer.from(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200",
    "hex",
);

function decryptPush(body, uaPrivate, uaPublic, authSecret) {
    const salt = body.subarray(0, 16);
    const recordSize = body.readUInt32BE(16);
    const idLen = body[20];
    const keyId = body.subarray(21, 21 + idLen);
    const ciphertext = body.subarray(21 + idLen);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(uaPrivate);
    const shared = ecdh.computeSecret(keyId);
    const authInfo = Buffer.concat([
        Buffer.from("WebPush: info\0", "utf8"),
        uaPublic,
        keyId,
    ]);
    const ikm = Buffer.from(
        hkdfSync("sha256", shared, authSecret, authInfo, 32),
    );
    const cek = Buffer.from(
        hkdfSync(
            "sha256",
            ikm,
            salt,
            Buffer.from("Content-Encoding: aes128gcm\0"),
            16,
        ),
    );
    const nonce = Buffer.from(
        hkdfSync(
            "sha256",
            ikm,
            salt,
            Buffer.from("Content-Encoding: nonce\0"),
            12,
        ),
    );
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const sealed = ciphertext.subarray(0, ciphertext.length - 16);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(sealed), decipher.final()]);
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) end -= 1;
    const padded = plain.subarray(0, end);
    const delimiter = padded[padded.length - 1];
    return {
        body: padded.subarray(0, padded.length - 1),
        delimiter,
        recordSize,
        keyId,
        salt,
    };
}

function verifyVapid(headers, publicKeyText) {
    const raw = headers.authorization;
    if (typeof raw !== "string" || !raw.startsWith("vapid ")) return null;
    const parts = Object.fromEntries(
        raw
            .slice(6)
            .split(",")
            .map((item) => {
                const index = item.indexOf("=");
                return [
                    item.slice(0, index).trim(),
                    item.slice(index + 1).trim(),
                ];
            }),
    );
    const jwt = parts.t;
    if (!jwt) return null;
    const [head, payload, signature] = jwt.split(".");
    const key = createPublicKey({
        key: Buffer.concat([VAPID_SPKI, unb64u(publicKeyText)]),
        format: "der",
        type: "spki",
    });
    const verifier = createVerify("SHA256");
    verifier.update(`${head}.${payload}`);
    const verified = verifier.verify(
        { key, dsaEncoding: "ieee-p1363" },
        unb64u(signature),
    );
    const claims = JSON.parse(unb64u(payload).toString("utf8"));
    return {
        verified,
        claims,
        header: unb64u(head).toString("utf8"),
        key: parts.k,
    };
}

const OG_PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>标题标签 &amp; 兜底</title>
<meta property="og:title" content="格子聊天 &amp; 预览">
<meta property="og:description" content="这是一段摘要，含实体 &lt;tag&gt;">
<meta property="og:site_name" content="plugim 实验室">
<meta property="og:image" content="/cover.png">
</head><body>ok</body></html>`;

function startHookReceiver() {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            if (req.url === "/push") {
                pushHits.push({ headers: req.headers, body: raw });
                res.writeHead(201, { "content-type": "text/plain" });
                res.end("created");
                return;
            }
            if (req.url === "/og") {
                res.writeHead(200, {
                    "content-type": "text/html; charset=utf-8",
                });
                res.end(OG_PAGE);
                return;
            }
            if (req.url === "/og-redirect") {
                res.writeHead(302, { location: "/og" });
                res.end();
                return;
            }
            if (req.url === "/og-plain") {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end("not html");
                return;
            }
            if (req.url === "/slow") {
                setTimeout(() => {
                    res.writeHead(200, { "content-type": "text/html" });
                    res.end("<html><title>slow</title></html>");
                }, 3000);
                return;
            }
            hookHits.push({ headers: req.headers, body: raw.toString("utf8") });
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
        });
    });
    return new Promise((resolve) => {
        server.listen(hookPort, "127.0.0.1", () => resolve(server));
    });
}
const wsBase = base.replace(/^http/, "ws");

let passed = 0;
const RPC_BUDGET = 45;
const failures = [];

function check(name, condition, extra) {
    if (condition) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(name);
        console.log(
            `  FAIL ${name}${extra === undefined ? "" : ` -> ${JSON.stringify(extra).slice(0, 400)}`}`,
        );
    }
}

async function httpRpc(method, params, token) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${base}/rpc/${method}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ params }),
    });
    return response.json();
}

class Client {
    constructor(token) {
        this.token = token;
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        this.waiters = [];
        this.sentAt = [];
        this.closed = false;
    }

    async open() {
        const url = this.token
            ? `${wsBase}/ws?token=${encodeURIComponent(this.token)}`
            : `${wsBase}/ws`;
        this.ws = new WebSocket(url);
        this.ws.addEventListener("close", () => {
            this.closed = true;
            for (const resolver of this.pending.values())
                resolver({
                    kind: "rpc:err",
                    message: "连接已被服务端关闭（可能触发限流）",
                });
            this.pending.clear();
        });
        this.ws.addEventListener("message", (event) => {
            const frame = JSON.parse(String(event.data));
            if (frame.kind === "rpc:ok" || frame.kind === "rpc:err") {
                const resolver = this.pending.get(frame.id);
                if (resolver) {
                    this.pending.delete(frame.id);
                    resolver(frame);
                }
                return;
            }
            if (frame.kind === "event") {
                this.events.push(frame);
                this.waiters = this.waiters.filter((waiter) => {
                    if (
                        waiter.name === frame.name &&
                        (!waiter.pred || waiter.pred(frame.payload))
                    ) {
                        waiter.resolve(frame.payload);
                        return false;
                    }
                    return true;
                });
            }
        });
        await new Promise((resolve, reject) => {
            this.ws.addEventListener("open", resolve, { once: true });
            this.ws.addEventListener("error", reject, { once: true });
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        return this;
    }

    async pace() {
        const now = Date.now();
        this.sentAt = this.sentAt.filter((at) => now - at < 1000);
        if (this.sentAt.length >= RPC_BUDGET) {
            const wait = 1000 - (now - this.sentAt[0]) + 15;
            await new Promise((resolve) =>
                setTimeout(resolve, Math.max(wait, 15)),
            );
        }
        this.sentAt.push(Date.now());
    }

    async rpc(method, params = {}) {
        await this.pace();
        const id = `r${++this.id}`;
        if (this.closed)
            return Promise.reject(new Error(`连接已关闭: ${method}`));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`rpc timeout: ${method}`));
            }, 8000);
            this.pending.set(id, (frame) => {
                clearTimeout(timer);
                if (frame.kind === "rpc:ok") resolve(frame.result);
                else reject(new Error(frame.message));
            });
            this.ws.send(JSON.stringify({ kind: "rpc", id, method, params }));
        });
    }

    waitEvent(name, pred, timeoutMs = 4000) {
        const existing = this.events.find(
            (frame) => frame.name === name && (!pred || pred(frame.payload)),
        );
        if (existing) return Promise.resolve(existing.payload);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`event timeout: ${name}`)),
                timeoutMs,
            );
            this.waiters.push({
                name,
                pred,
                resolve: (payload) => {
                    clearTimeout(timer);
                    resolve(payload);
                },
            });
        });
    }

    clearEvents() {
        this.events = [];
        this.waiters = [];
    }

    close() {
        this.ws.close();
    }
}

async function main() {
    console.log("plugim server smoke\n");
    const hookReceiver = await startHookReceiver();
    const s3Mock = await startS3Mock();

    const health = await (await fetch(`${base}/health`)).json();
    check("health ok", health.ok === true, health);
    check("health reports runtime", health.runtime === "rust", health);

    const policy = await (await fetch(`${base}/auth/register-policy`)).json();
    check(
        "register-policy shape",
        typeof policy.open === "boolean" &&
            typeof policy.requireInvite === "boolean",
        policy,
    );

    const suffix = Date.now().toString().slice(-6);
    const alice = `alice${suffix}`;
    const bob = `bob${suffix}`;
    const carol = `carol${suffix}`;

    const anon = await new Client(null).open();
    const bad = await anon
        .rpc("auth.login", { username: "nobody", password: "whatever" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "login of unknown user rejected",
        bad instanceof Error && bad.message === "用户名或密码错误",
        String(bad),
    );

    const pgUrl = process.env.PLUGIM_SMOKE_PG_URL;
    if (!pgUrl) {
        check("install testdb postgres skipped", true);
    } else {
        const pgOk = await anon
            .rpc("install.testdb", { dbDriver: "postgres", databaseUrl: pgUrl })
            .then(
                () => null,
                (err) => err,
            );
        check("install testdb postgres ok", pgOk === null, String(pgOk));
        const pgBadHost = await anon
            .rpc("install.testdb", {
                dbDriver: "postgres",
                databaseUrl: "postgres://plugim@127.0.0.1:1/plugim",
            })
            .then(
                () => null,
                (err) => err,
            );
        check(
            "install testdb postgres rejects",
            pgBadHost instanceof Error &&
                pgBadHost.message.includes("连接失败"),
            String(pgBadHost),
        );
        const pgBadScheme = await anon
            .rpc("install.testdb", {
                dbDriver: "postgres",
                databaseUrl: "mysql://x",
            })
            .then(
                () => null,
                (err) => err,
            );
        check(
            "install testdb scheme validated",
            pgBadScheme instanceof Error &&
                pgBadScheme.message.includes("postgres://"),
            String(pgBadScheme),
        );
    }

    const registered = await anon.rpc("auth.register", {
        username: alice,
        password: "secret123",
    });
    check(
        "register returns token",
        typeof registered.token === "string" && registered.token.length > 20,
    );
    check(
        "register returns user",
        registered.user?.username === alice,
        registered.user,
    );
    anon.close();

    const bobReg = await httpRpc("auth.register", {
        username: bob,
        password: "secret123",
    });
    check(
        "http rpc register works",
        bobReg.ok === true && !!bobReg.result?.token,
        bobReg,
    );
    const carolReg = await httpRpc("auth.register", {
        username: carol,
        password: "secret123",
    });
    check("third register works", carolReg.ok === true, carolReg);

    const aliceClient = await new Client(registered.token).open();
    const me = await aliceClient.rpc("auth.me");
    check(
        "auth.me returns row",
        me.username === alice && me.id === registered.user.id,
        me,
    );

    const bobClient = await new Client(bobReg.result.token).open();
    const carolClient = await new Client(carolReg.result.token).open();

    await new Promise((resolve) => setTimeout(resolve, 200));
    const presence = await aliceClient.rpc("presence.list");
    check(
        "presence lists online peers",
        Array.isArray(presence.online) && presence.online.includes(bob),
        presence,
    );

    const unknown = await aliceClient.rpc("nope.method").then(
        () => null,
        (err) => err,
    );
    check(
        "unknown method rejected",
        unknown instanceof Error && unknown.message.startsWith("未知方法"),
        String(unknown),
    );

    const unauthed = await httpRpc("message.send", {
        session: "general",
        content: "hi",
    });
    check(
        "http rpc blocks anonymous",
        unauthed.ok === false && unauthed.message.includes("未登录"),
        unauthed,
    );

    const requested = await aliceClient.rpc("friend.request", {
        username: bob,
        message: "hello",
    });
    check(
        "friend.request lists outgoing",
        requested.outgoing.includes(bob),
        requested.outgoing,
    );
    const bobIncoming = await bobClient.rpc("friend.list");
    check(
        "friend.list shows incoming",
        bobIncoming.incoming.includes(alice),
        bobIncoming.incoming,
    );
    check(
        "friend request message kept",
        bobIncoming.incomingMessages?.[alice] === "hello",
        bobIncoming.incomingMessages,
    );

    const accepted = await bobClient.rpc("friend.accept", { username: alice });
    check(
        "friend.accept mutual",
        accepted.friends.includes(alice),
        accepted.friends,
    );
    const aliceFriends = await aliceClient.rpc("friend.list");
    check(
        "friend accepted visible to requester",
        aliceFriends.friends.includes(bob),
        aliceFriends.friends,
    );

    const remark = await aliceClient.rpc("friend.remark", {
        username: bob,
        remark: "同事",
    });
    check(
        "friend.remark stored",
        remark.remarks?.[bob] === "同事",
        remark.remarks,
    );
    const starred = await aliceClient.rpc("friend.star", {
        username: bob,
        on: true,
    });
    check("friend.star stored", starred.starred.includes(bob), starred.starred);
    const groupRow = await aliceClient.rpc("friend.group.create", {
        name: "工作",
    });
    check(
        "friend group created",
        groupRow.groups.some((item) => item.name === "工作"),
        groupRow.groups,
    );

    bobClient.clearEvents();
    const sent = await aliceClient.rpc("message.send", {
        session: `p2p:${bob}`,
        content: "晚上好",
    });
    check(
        "message.send p2p returns message",
        sent.content === "晚上好" && sent.session === `p2p:${bob}`,
        sent,
    );
    check("p2p message has seq", sent.seq >= 1, sent.seq);
    const delivered = await bobClient
        .waitEvent("message:new")
        .catch(() => null);
    check(
        "peer receives message:new",
        delivered?.message?.content === "晚上好",
        delivered,
    );
    check(
        "peer sees own session alias",
        delivered?.message?.session === `p2p:${alice}`,
        delivered?.message?.session,
    );

    const history = await bobClient.rpc("history.list", {
        session: `p2p:${alice}`,
        limit: 20,
    });
    check(
        "history round trip",
        Array.isArray(history) &&
            history.length === 1 &&
            history[0].content === "晚上好",
        history,
    );

    const sessions = await bobClient.rpc("chat.sessionList");
    const p2pRow = sessions.find((row) => row.session === `p2p:${alice}`);
    check(
        "sessionList contains p2p",
        !!p2pRow,
        sessions.map((row) => row.session),
    );
    check("sessionList unread counts", p2pRow?.unread === 1, p2pRow);

    aliceClient.clearEvents();
    const read = await bobClient.rpc("chat.read", { session: `p2p:${alice}` });
    check("chat.read returns seq", read.seq === 1, read);
    const readEvent = await aliceClient
        .waitEvent("read:update")
        .catch(() => null);
    check(
        "peer receives read:update",
        readEvent?.username === bob && readEvent?.seq === 1,
        readEvent,
    );

    const afterRead = await bobClient.rpc("chat.sessionList", {
        sessions: [`p2p:${alice}`],
    });
    check("unread cleared after read", afterRead[0]?.unread === 0, afterRead);

    const pinned = await bobClient.rpc("chat.session.meta", {
        session: `p2p:${alice}`,
        pinned: true,
    });
    check("session pinned", pinned.pinned === true, pinned);
    const pinnedList = await bobClient.rpc("chat.sessionList", {
        sessions: [`p2p:${alice}`],
    });
    check("pinned persisted", pinnedList[0]?.pinned === true, pinnedList[0]);

    const reacted = await aliceClient.rpc("message.react", {
        id: sent.id,
        emoji: "👍",
    });
    check(
        "reaction added",
        reacted.message.reactions?.["👍"]?.includes(alice),
        reacted.message.reactions,
    );
    const unreacted = await aliceClient.rpc("message.react", {
        id: sent.id,
        emoji: "👍",
    });
    check(
        "reaction toggled off",
        !unreacted.message.reactions?.["👍"],
        unreacted.message.reactions,
    );

    const edited = await aliceClient.rpc("message.edit", {
        id: sent.id,
        content: "晚上好呀",
    });
    check(
        "message edited",
        edited.message.content === "晚上好呀" && edited.editCount === 1,
        edited,
    );

    const editedByPeer = await bobClient.rpc("history.list", {
        session: `p2p:${alice}`,
    });
    check(
        "edit persisted",
        editedByPeer[0]?.content === "晚上好呀",
        editedByPeer[0]?.content,
    );

    const searched = await bobClient.rpc("message.search", {
        keyword: "晚上好",
    });
    check(
        "search finds message",
        searched.total === 1 && searched.hits.length === 1,
        searched,
    );

    const recalled = await aliceClient.rpc("message.recall", { id: sent.id });
    check(
        "recall sets timestamp",
        typeof recalled.recalledAt === "string",
        recalled,
    );
    const afterRecall = await bobClient.rpc("history.list", {
        session: `p2p:${alice}`,
    });
    check(
        "recall persisted",
        typeof afterRecall[0]?.recalledAt === "string",
        afterRecall[0]?.recalledAt,
    );
    const searchAfterRecall = await bobClient.rpc("message.search", {
        keyword: "晚上好",
    });
    check(
        "recall hides from search",
        searchAfterRecall.total === 0,
        searchAfterRecall,
    );

    carolClient.clearEvents();
    const group = await aliceClient.rpc("group.create", {
        name: "测试群",
        members: [bob],
    });
    check(
        "group.create returns info",
        group.name === "测试群" &&
            group.memberCount === 2 &&
            group.myRole === "owner",
        group,
    );
    const groupId = group.id;
    const invited = await aliceClient.rpc("group.invite.set", {
        groupId,
        expiresIn: "7d",
    });
    check(
        "invite code generated",
        typeof invited.inviteCode === "string" &&
            invited.inviteCode.length === 8,
        invited.inviteCode,
    );

    const joined = await carolClient.rpc("group.join", {
        code: invited.inviteCode,
        message: "带上我",
    });
    check(
        "join requests approval by default",
        joined.status === "pending",
        joined,
    );
    const pending = await aliceClient.rpc("group.requests", { groupId });
    check(
        "pending request listed",
        pending.some((row) => row.username === carol),
        pending,
    );
    await aliceClient.rpc("group.request.approve", {
        groupId,
        username: carol,
        on: true,
    });
    const members = await aliceClient.rpc("group.members", { groupId });
    check(
        "approved member joined",
        members.members.length === 3,
        members.members.map((row) => row.username),
    );
    check(
        "owner sorted first",
        members.members[0]?.role === "owner",
        members.members[0],
    );

    bobClient.clearEvents();
    const groupMessage = await aliceClient.rpc("message.send", {
        session: `g:${groupId}`,
        content: "群里好",
    });
    check(
        "group message sent",
        groupMessage.session === `g:${groupId}`,
        groupMessage.session,
    );
    const groupDelivered = await bobClient
        .waitEvent("message:new")
        .catch(() => null);
    check(
        "group member receives message",
        groupDelivered?.message?.content === "群里好",
        groupDelivered,
    );

    await aliceClient.rpc("group.member.mute", {
        groupId,
        username: bob,
        muted: true,
    });
    const mutedError = await bobClient
        .rpc("message.send", { session: `g:${groupId}`, content: "我能说话吗" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "muted member blocked",
        mutedError instanceof Error && mutedError.message === "你已被禁言",
        String(mutedError),
    );
    await aliceClient.rpc("group.member.mute", {
        groupId,
        username: bob,
        muted: false,
    });

    const nonMember = await carolClient
        .rpc("group.rename", { groupId, name: "改名" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "non manager cannot rename",
        nonMember instanceof Error &&
            nonMember.message.includes("需要群主或管理员权限"),
        String(nonMember),
    );

    const info = await aliceClient.rpc("group.info", { groupId });
    check(
        "group.info matches",
        info.id === groupId && info.memberCount === 3,
        info,
    );

    const uploadName = encodeURIComponent("测试 图.png");
    const upload = await fetch(`${base}/upload`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${registered.token}`,
            "content-type": "image/png",
            "x-file-name": uploadName,
        },
        body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    const uploadBody = await upload.json();
    check(
        "upload returns key",
        uploadBody.ok === true &&
            /^[a-f0-9]{32}$/.test(uploadBody.result?.key ?? ""),
        uploadBody,
    );
    check(
        "upload keeps utf8 name",
        uploadBody.result?.name === "测试 图.png",
        uploadBody.result?.name,
    );

    const download = await fetch(`${base}${uploadBody.result.url}`, {
        headers: { authorization: `Bearer ${registered.token}` },
    });
    check("download authorized", download.status === 200, download.status);
    const downloadBody = new Uint8Array(await download.arrayBuffer());
    check(
        "download bytes intact",
        downloadBody.length === 8 && downloadBody[0] === 137,
        downloadBody.length,
    );
    const downloadAnon = await fetch(`${base}${uploadBody.result.url}`);
    check(
        "download requires token",
        downloadAnon.status === 401,
        downloadAnon.status,
    );

    const mediaMessage = await aliceClient.rpc("message.send", {
        session: `g:${groupId}`,
        content: uploadBody.result.url,
        kind: "image",
        file: { name: "测试 图.png", size: 8, mime: "image/png" },
    });
    check(
        "image message accepted",
        mediaMessage.kind === "image" &&
            mediaMessage.file?.mime === "image/png",
        mediaMessage,
    );
    const fakeMedia = await aliceClient
        .rpc("message.send", {
            session: `g:${groupId}`,
            content: "/files/not-a-real-key",
            kind: "image",
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "media requires uploaded url",
        fakeMedia instanceof Error &&
            fakeMedia.message === "媒体消息必须引用已上传的文件",
        String(fakeMedia),
    );

    const delta = await bobClient.rpc("sync.delta", {
        cursors: [{ session: `g:${groupId}`, seq: 0 }],
        limit: 10,
    });
    check(
        "sync.delta returns messages",
        delta.sessions[0]?.messages?.length >= 2,
        delta.sessions?.[0]?.messages?.length,
    );
    check(
        "sync.delta exposes lastSeq",
        delta.sessions[0]?.lastSeq >= 2,
        delta.sessions?.[0]?.lastSeq,
    );

    const aliceSessions = await aliceClient.rpc("auth.sessions");
    check(
        "auth.sessions lists device",
        aliceSessions.devices?.length >= 1 &&
            aliceSessions.totpEnabled === false,
        aliceSessions,
    );

    const renamed = await aliceClient.rpc("auth.session.rename", {
        id: aliceSessions.devices[0].id,
        label: "测试机",
    });
    check("session rename ok", renamed.ok === true, renamed);

    const totpSetup = await aliceClient.rpc("auth.totp.setup");
    check(
        "totp setup returns secret",
        typeof totpSetup.secret === "string" &&
            totpSetup.otpauth.includes("otpauth://"),
        totpSetup.otpauth,
    );
    const totpBad = await aliceClient
        .rpc("auth.totp.enable", { code: "000000" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "totp wrong code rejected",
        totpBad instanceof Error,
        String(totpBad),
    );

    const p2pOnlyForFriends = await aliceClient
        .rpc("message.send", { session: `p2p:${carol}`, content: "非好友" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "cannot dm non friend",
        p2pOnlyForFriends instanceof Error &&
            p2pOnlyForFriends.message === "只能和好友私聊",
        String(p2pOnlyForFriends),
    );

    const emptyMessage = await aliceClient
        .rpc("message.send", { session: "general", content: "   " })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "empty message rejected",
        emptyMessage instanceof Error &&
            emptyMessage.message === "消息内容不能为空",
        String(emptyMessage),
    );

    const general = await aliceClient.rpc("message.send", {
        session: "general",
        content: "大厅消息",
    });
    check(
        "default session works",
        general.session === "general",
        general.session,
    );
    const generalHistory = await carolClient.rpc("history.list", {
        session: "general",
    });
    check(
        "default session history shared",
        generalHistory.some((row) => row.content === "大厅消息"),
        generalHistory.length,
    );

    const info2 = await aliceClient.rpc("user.info", { username: bob });
    check("user.info works", info2.username === bob, info2);

    const searched2 = await carolClient.rpc("user.search", {
        keyword: "alice",
    });
    check(
        "user.search finds alice",
        searched2.users.some((row) => row.name === alice),
        searched2,
    );

    const stickerAdd = await aliceClient.rpc("stickers.add", {
        url: uploadBody.result.url,
        name: "图",
        mime: "image/png",
        size: 8,
    });
    check("sticker added", stickerAdd.stickers.length === 1, stickerAdd);
    const stickerList = await aliceClient.rpc("stickers.list");
    check(
        "sticker list persists",
        stickerList.stickers[0]?.url === uploadBody.result.url,
        stickerList,
    );
    const stickerBad = await aliceClient
        .rpc("stickers.add", {
            url: "http://example.com/a.png",
            name: "坏",
            mime: "image/png",
            size: 1,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "invalid sticker rejected",
        stickerBad instanceof Error && stickerBad.message === "无效的表情数据",
        String(stickerBad),
    );
    const stickerRemove = await aliceClient.rpc("stickers.remove", {
        url: uploadBody.result.url,
    });
    check(
        "sticker removed",
        stickerRemove.stickers.length === 0,
        stickerRemove,
    );

    const dnd = await aliceClient.rpc("dnd.get");
    check(
        "dnd defaults",
        dnd.settings.enabled === false && dnd.settings.start === "22:00",
        dnd,
    );
    const dndSet = await aliceClient.rpc("dnd.set", {
        enabled: true,
        start: "23:00",
        end: "07:30",
    });
    check(
        "dnd set",
        dndSet.settings.enabled === true && dndSet.settings.start === "23:00",
        dndSet,
    );
    const dndMute = await aliceClient.rpc("dnd.mute", {
        session: `p2p:${bob}`,
        on: true,
    });
    check(
        "dnd mute",
        dndMute.settings.mutedSessions.includes(`p2p:${bob}`),
        dndMute,
    );
    const dndUnmute = await aliceClient.rpc("dnd.mute", {
        session: `p2p:${bob}`,
        on: false,
    });
    check(
        "dnd unmute",
        !dndUnmute.settings.mutedSessions.includes(`p2p:${bob}`),
        dndUnmute,
    );

    const nonAdmin = await carolClient.rpc("admin.users").then(
        () => null,
        (err) => err,
    );
    check(
        "admin gated",
        nonAdmin instanceof Error && nonAdmin.message === "需要管理员权限",
        String(nonAdmin),
    );

    const adminUsers = await aliceClient.rpc("admin.users");
    check(
        "admin.users lists all",
        Array.isArray(adminUsers) && adminUsers.length >= 3,
        adminUsers.length,
    );
    check(
        "admin.users online flag",
        adminUsers.find((row) => row.username === bob)?.online === true,
        adminUsers,
    );
    const stats = await aliceClient.rpc("admin.stats");
    check(
        "admin.stats numbers",
        stats.users >= 3 && stats.messages >= 1,
        stats,
    );
    const trend = await aliceClient.rpc("admin.trend", { days: 7 });
    check("admin.trend points", trend.points.length === 7, trend);
    const site = await aliceClient.rpc("admin.site.set", {
        name: "测试站点",
        icon: "",
    });
    check("site name saved", site.name === "测试站点", site);
    const siteMeta = await (await fetch(`${base}/site/meta`)).json();
    check("site meta reflected", siteMeta.name === "测试站点", siteMeta);

    const mode = await aliceClient.rpc("admin.mode.set", { mode: "chat" });
    check("mode chat", mode === "chat", mode);
    const orgBlocked = await aliceClient.rpc("org.tree").then(
        () => null,
        (err) => err,
    );
    check(
        "org blocked in chat mode",
        orgBlocked instanceof Error && orgBlocked.message.includes("聊天模式"),
        String(orgBlocked),
    );
    await aliceClient.rpc("admin.mode.set", { mode: "enterprise" });
    const tree = await aliceClient.rpc("org.tree");
    check(
        "org tree empty initially",
        Array.isArray(tree) && tree.length === 0,
        tree,
    );
    const dept = await aliceClient.rpc("admin.department.create", {
        name: "研发部",
    });
    check("department created", dept.name === "研发部", dept);
    const assign = await aliceClient.rpc("admin.user.assign", {
        userId: registered.user.id,
        deptId: dept.id,
        title: "工程师",
    });
    check("user assigned", assign === true, assign);
    const directory = await aliceClient.rpc("org.directory");
    check(
        "directory shows dept member",
        directory.departments.length === 1 &&
            directory.departments[0].memberCount === 1,
        directory.departments,
    );
    const deptGroup = await aliceClient.rpc("admin.department.group", {
        id: dept.id,
    });
    check(
        "department group created",
        deptGroup.created === true && typeof deptGroup.groupId === "string",
        deptGroup,
    );
    const retention = await aliceClient.rpc("admin.retention.set", {
        days: 30,
    });
    check("retention set", retention.days === 30, retention);
    const audit = await aliceClient.rpc("admin.audit.list", { limit: 5 });
    check(
        "audit entries recorded",
        audit.total > 0 && audit.rows.length > 0,
        audit.total,
    );
    const tasks = await aliceClient.rpc("admin.tasks");
    check("admin.tasks lists three jobs", tasks.length === 3, tasks.length);
    const backupTask = tasks.find((task) => task.name === "db-backup");
    check(
        "admin.tasks includes backup",
        Boolean(backupTask) && backupTask.intervalMinutes === 1440,
        backupTask,
    );
    const cleanupTask = tasks.find((task) => task.name === "message-cleanup");
    check(
        "task state shape",
        typeof cleanupTask.lastMessage === "string" &&
            typeof cleanupTask.runs === "number",
        cleanupTask,
    );
    const taskPatch = await aliceClient.rpc("admin.task.set", {
        name: "media-sweep",
        intervalMinutes: 720,
    });
    check("task set interval", taskPatch.intervalMinutes === 720, taskPatch);
    const taskBadInterval = await aliceClient
        .rpc("admin.task.set", { name: "media-sweep", intervalMinutes: 0 })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "task rejects bad interval",
        taskBadInterval instanceof Error &&
            taskBadInterval.message.includes("执行周期"),
        String(taskBadInterval),
    );
    await aliceClient.rpc("admin.task.set", {
        name: "media-sweep",
        intervalMinutes: 1440,
    });
    const backupRun = await aliceClient.rpc("admin.task.run", {
        name: "db-backup",
    });
    check(
        "backup task runs",
        typeof backupRun.result === "string" &&
            backupRun.result.includes("备份"),
        backupRun,
    );
    const runTask = await aliceClient.rpc("admin.task.run", {
        name: "media-sweep",
    });
    check(
        "task run returns result",
        typeof runTask.result === "string",
        runTask,
    );
    const registerPolicy2 = await aliceClient.rpc("admin.register.get");
    check(
        "register policy readable",
        typeof registerPolicy2.allowRegister === "boolean",
        registerPolicy2,
    );

    const screenConfig = await aliceClient.rpc("screen.config");
    check(
        "screen.config arrays",
        Array.isArray(screenConfig) && screenConfig.length > 0,
        screenConfig,
    );

    aliceClient.clearEvents();
    bobClient.clearEvents();
    const invite = await aliceClient.rpc("screen.invite", {
        to: bob,
        kind: "video",
    });
    check(
        "screen.invite returns call",
        typeof invite.callId === "string" && invite.kind === "video",
        invite,
    );
    const inviteEvent = await bobClient.waitEvent(
        "screen:signal",
        (payload) => payload.type === "invite",
    );
    check(
        "peer receives invite signal",
        inviteEvent.callId === invite.callId && inviteEvent.from === alice,
        inviteEvent,
    );
    const bobState = await bobClient.rpc("screen.state");
    check(
        "incoming call state",
        bobState.incoming === true &&
            bobState.peer === alice &&
            bobState.active === false,
        bobState,
    );
    const aliceState = await aliceClient.rpc("screen.state");
    check(
        "outgoing call state",
        aliceState.incoming === false && aliceState.peer === bob,
        aliceState,
    );
    const busyInvite = await bobClient
        .rpc("screen.invite", { to: alice, kind: "voice" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "busy user cannot invite",
        busyInvite instanceof Error && busyInvite.message === "你正在进行通话",
        String(busyInvite),
    );
    const earlySignal = await aliceClient
        .rpc("screen.signal", {
            callId: invite.callId,
            type: "offer",
            sdp: "v=0",
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "signal before accept rejected",
        earlySignal instanceof Error && earlySignal.message === "通话尚未接通",
        String(earlySignal),
    );

    aliceClient.clearEvents();
    const acceptResult = await bobClient.rpc("screen.accept", {
        callId: invite.callId,
    });
    check("accept returns true", acceptResult === true, acceptResult);
    const acceptEvent = await aliceClient.waitEvent(
        "screen:signal",
        (payload) => payload.type === "accept",
    );
    check(
        "caller receives accept",
        acceptEvent.callId === invite.callId,
        acceptEvent,
    );

    const badType = await aliceClient
        .rpc("screen.signal", {
            callId: invite.callId,
            type: "sdp",
            sdp: "v=0",
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "illegal signal type rejected",
        badType instanceof Error && badType.message === "非法信令类型",
        String(badType),
    );
    const noSdp = await aliceClient
        .rpc("screen.signal", { callId: invite.callId, type: "offer" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "missing sdp rejected",
        noSdp instanceof Error && noSdp.message === "缺少 SDP",
        String(noSdp),
    );
    const badIce = await aliceClient
        .rpc("screen.signal", {
            callId: invite.callId,
            type: "ice",
            candidate: "x",
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "illegal ice candidate rejected",
        badIce instanceof Error && badIce.message === "非法 ICE 候选",
        String(badIce),
    );

    aliceClient.clearEvents();
    bobClient.clearEvents();
    await aliceClient.rpc("screen.signal", {
        callId: invite.callId,
        type: "offer",
        sdp: "v=0 offer",
    });
    const offerEvent = await bobClient.waitEvent(
        "screen:signal",
        (payload) => payload.type === "offer",
    );
    check(
        "offer relayed to peer",
        offerEvent.sdp === "v=0 offer" && offerEvent.from === alice,
        offerEvent,
    );
    await bobClient.rpc("screen.signal", {
        callId: invite.callId,
        type: "ice",
        candidate: { candidate: "candidate:1" },
    });
    const iceEvent = await aliceClient.waitEvent(
        "screen:signal",
        (payload) => payload.type === "ice",
    );
    check(
        "ice relayed back",
        iceEvent.candidate?.candidate === "candidate:1",
        iceEvent,
    );

    aliceClient.clearEvents();
    const hangup = await aliceClient.rpc("screen.hangup", {
        callId: invite.callId,
    });
    check("hangup returns true", hangup === true, hangup);
    const hangupEvent = await bobClient.waitEvent(
        "screen:signal",
        (payload) => payload.type === "hangup",
    );
    check(
        "peer notified of hangup",
        hangupEvent.callId === invite.callId,
        hangupEvent,
    );
    const clearedState = await bobClient.rpc("screen.state");
    check("call state cleared", clearedState === null, clearedState);

    const callHistory = await bobClient.rpc("history.list", {
        session: `p2p:${alice}`,
        limit: 20,
    });
    check(
        "call summary recorded",
        callHistory.some(
            (row) => row.kind === "system" && row.content.includes("视频"),
        ),
        callHistory.map((row) => row.content),
    );
    const inviteAgain = await aliceClient.rpc("screen.invite", {
        to: bob,
        kind: "voice",
    });
    check(
        "reinvite after hangup",
        typeof inviteAgain.callId === "string" &&
            inviteAgain.callId !== invite.callId,
        inviteAgain,
    );
    await aliceClient.rpc("screen.hangup", { callId: inviteAgain.callId });

    const strangerCall = await carolClient
        .rpc("screen.invite", { to: alice, kind: "voice" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "call requires friendship",
        strangerCall instanceof Error &&
            strangerCall.message === "只能向好友发起通话",
        String(strangerCall),
    );
    const noCall = await carolClient.rpc("screen.state");
    check("no call state for stranger", noCall === null, noCall);

    const groupInfo = await aliceClient.rpc("call.group.info", {
        groupId: group.id,
    });
    check(
        "group call info empty",
        groupInfo === null || groupInfo.roomId === undefined,
        groupInfo,
    );
    bobClient.clearEvents();
    const startedRoom = await aliceClient.rpc("call.group.start", {
        groupId: group.id,
        kind: "video",
    });
    check(
        "group call started",
        startedRoom.kind === "video" &&
            startedRoom.host === alice &&
            startedRoom.members.length === 1,
        startedRoom,
    );
    const roomInvite = await bobClient.waitEvent(
        "group:call",
        (payload) => payload.type === "invite",
    );
    check(
        "members receive group invite",
        roomInvite.roomId === startedRoom.roomId,
        roomInvite,
    );
    const dupStart = await bobClient
        .rpc("call.group.start", { groupId: group.id, kind: "voice" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "duplicate group call blocked",
        dupStart instanceof Error && dupStart.message === "该群已有通话进行中",
        String(dupStart),
    );
    const joinResult = await bobClient.rpc("call.group.join", {
        roomId: startedRoom.roomId,
    });
    check(
        "member joins group call",
        joinResult.room.members.length === 2 &&
            joinResult.others.includes(alice),
        joinResult,
    );
    const roomAfterJoin = await aliceClient.rpc("call.group.info", {
        groupId: group.id,
    });
    check(
        "group info reflects members",
        roomAfterJoin.members.length === 2,
        roomAfterJoin,
    );
    const missingTarget = await bobClient
        .rpc("call.group.signal", {
            roomId: startedRoom.roomId,
            type: "offer",
            sdp: "v=0",
            to: "ghost",
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "unknown signal target rejected",
        missingTarget instanceof Error &&
            missingTarget.message === "对方不在该通话中",
        String(missingTarget),
    );
    aliceClient.clearEvents();
    await bobClient.rpc("call.group.signal", {
        roomId: startedRoom.roomId,
        type: "offer",
        sdp: "v=0 room",
        to: alice,
    });
    const roomSignal = await aliceClient.waitEvent(
        "group:call:signal",
        (payload) => payload.type === "offer",
    );
    check(
        "group signal relayed",
        roomSignal.roomId === startedRoom.roomId && roomSignal.from === bob,
        roomSignal,
    );
    const hostOnly = await bobClient
        .rpc("call.group.end", { roomId: startedRoom.roomId })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "only host can end group call",
        hostOnly instanceof Error &&
            hostOnly.message === "只有发起人可以结束通话",
        String(hostOnly),
    );
    const ended = await aliceClient.rpc("call.group.end", {
        roomId: startedRoom.roomId,
    });
    check("host ends group call", ended === true, ended);
    const roomGone = await aliceClient.rpc("call.group.info", {
        groupId: group.id,
    });
    check(
        "group call cleared",
        roomGone === null || roomGone.roomId === undefined,
        roomGone,
    );
    const roomHistory = await aliceClient.rpc("history.list", {
        session: `g:${group.id}`,
        limit: 30,
    });
    check(
        "group call announcements recorded",
        roomHistory.some((row) => row.content.includes("发起了群视频")),
        roomHistory.map((row) => row.content),
    );

    const emptyFiles = await aliceClient.rpc("group.file.list", {
        groupId: group.id,
    });
    check(
        "group file list empty",
        emptyFiles.total === 0 && emptyFiles.files.length === 0,
        emptyFiles,
    );
    const foreignFile = await bobClient
        .rpc("group.file.add", {
            groupId: group.id,
            key: uploadBody.result.key,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "cannot add foreign upload",
        foreignFile instanceof Error &&
            foreignFile.message === "只能添加自己上传的文件",
        String(foreignFile),
    );
    const badKeyFile = await aliceClient
        .rpc("group.file.add", { groupId: group.id, key: "not-a-key" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "bad file key rejected",
        badKeyFile instanceof Error && badKeyFile.message === "文件不存在",
        String(badKeyFile),
    );
    const addedFile = await aliceClient.rpc("group.file.add", {
        groupId: group.id,
        key: uploadBody.result.key,
    });
    check(
        "group file added",
        addedFile.key === uploadBody.result.key,
        addedFile,
    );
    const listedFiles = await aliceClient.rpc("group.file.list", {
        groupId: group.id,
    });
    check(
        "group file list one",
        listedFiles.total === 1 && listedFiles.files[0]?.uploader === alice,
        listedFiles,
    );
    const outsider = `dave${suffix}`;
    const outsiderReg = await httpRpc("auth.register", {
        username: outsider,
        password: "secret123",
    });
    const outsiderFiles = await httpRpc(
        "group.file.list",
        { groupId: group.id },
        outsiderReg.result.token,
    );
    check(
        "outsider cannot list group files",
        outsiderFiles.ok === false && outsiderFiles.message === "你不在该群中",
        outsiderFiles,
    );
    const memberDelete = await bobClient
        .rpc("group.file.delete", {
            groupId: group.id,
            key: uploadBody.result.key,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "member cannot delete file",
        memberDelete instanceof Error &&
            memberDelete.message === "只有上传者或群管理可以删除",
        String(memberDelete),
    );
    const groupFileHistory = await bobClient.rpc("history.list", {
        session: `g:${group.id}`,
        limit: 20,
    });
    check(
        "group file message sent",
        groupFileHistory.some(
            (row) =>
                row.kind === "file" &&
                row.content.includes(`/files/${uploadBody.result.key}`),
        ),
        groupFileHistory.map((row) => row.kind),
    );
    const deletedFile = await aliceClient.rpc("group.file.delete", {
        groupId: group.id,
        key: uploadBody.result.key,
    });
    check("uploader deletes file", deletedFile === true, deletedFile);
    const afterDelete = await aliceClient.rpc("group.file.list", {
        groupId: group.id,
    });
    check(
        "group file list cleared",
        afterDelete.total === 0,
        afterDelete.total,
    );
    const missingFile = await aliceClient
        .rpc("group.file.delete", {
            groupId: group.id,
            key: uploadBody.result.key,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "delete missing file rejected",
        missingFile instanceof Error && missingFile.message === "文件不存在",
        String(missingFile),
    );

    const emptyMoment = await aliceClient
        .rpc("moment.publish", { content: "   " })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "empty moment rejected",
        emptyMoment instanceof Error &&
            emptyMoment.message === "动态内容不能为空",
        String(emptyMoment),
    );
    const bothMedia = await aliceClient
        .rpc("moment.publish", {
            content: "x",
            images: [uploadBody.result.key],
            video: uploadBody.result.key,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "moment video with images rejected",
        bothMedia instanceof Error &&
            bothMedia.message === "视频动态不能同时包含图片",
        String(bothMedia),
    );
    const missingMedia = await aliceClient
        .rpc("moment.publish", { content: "x", images: ["a".repeat(32)] })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "moment media must exist",
        missingMedia instanceof Error &&
            missingMedia.message === "图片或视频不存在或已被删除",
        String(missingMedia),
    );
    const ogUrl = `http://127.0.0.1:${hookPort}/og`;
    const linkPreview = await aliceClient.rpc("moment.link", { url: ogUrl });
    check(
        "moment.link fetches og:title",
        linkPreview.title === "格子聊天 & 预览",
        linkPreview,
    );
    check(
        "moment.link decodes entities",
        linkPreview.description === "这是一段摘要，含实体 <tag>",
        linkPreview.description,
    );
    check(
        "moment.link site name",
        linkPreview.site === "plugim 实验室",
        linkPreview.site,
    );
    check(
        "moment.link resolves image",
        linkPreview.image === `http://127.0.0.1:${hookPort}/cover.png`,
        linkPreview.image,
    );
    const redirectPreview = await aliceClient.rpc("moment.link", {
        url: `http://127.0.0.1:${hookPort}/og-redirect`,
    });
    check(
        "moment.link follows redirect",
        redirectPreview.url === ogUrl &&
            redirectPreview.title === "格子聊天 & 预览",
        redirectPreview,
    );
    const nonHtml = await aliceClient
        .rpc("moment.link", { url: `http://127.0.0.1:${hookPort}/og-plain` })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "moment.link rejects non html",
        nonHtml instanceof Error && nonHtml.message === "链接不是网页",
        String(nonHtml),
    );
    const badScheme = await aliceClient
        .rpc("moment.link", { url: "ftp://example.com/a" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "moment.link rejects scheme",
        badScheme instanceof Error &&
            badScheme.message === "仅支持 http/https 链接",
        String(badScheme),
    );
    const badUrl = await aliceClient
        .rpc("moment.link", { url: "http://" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "moment.link rejects bad url",
        badUrl instanceof Error,
        String(badUrl),
    );
    const published = await aliceClient.rpc("moment.publish", {
        content: "第一條動態",
    });
    check(
        "moment.publish returns post",
        published.author === alice &&
            published.content === "第一條動態" &&
            published.visibility === "public",
        published,
    );
    const aliceTimeline = await aliceClient.rpc("moment.timeline", {
        limit: 5,
    });
    check(
        "timeline lists own post",
        aliceTimeline.posts.some((post) => post.id === published.id),
        aliceTimeline.posts.length,
    );
    check(
        "timeline has no more",
        aliceTimeline.hasMore === false,
        aliceTimeline.hasMore,
    );
    const bobTimeline = await bobClient.rpc("moment.timeline", { limit: 10 });
    check(
        "friend sees public post",
        bobTimeline.posts.some((post) => post.id === published.id),
        bobTimeline.posts.length,
    );
    const carolTimeline = await carolClient.rpc("moment.timeline", {
        limit: 10,
    });
    check(
        "stranger timeline hides post",
        !carolTimeline.posts.some((post) => post.id === published.id),
        carolTimeline.posts.length,
    );

    const space = await aliceClient.rpc("moment.space.link");
    check(
        "space link returns key",
        space.username === alice && space.key.length >= 16,
        space,
    );
    const spaceView = await carolClient.rpc("moment.space.view", {
        username: alice,
        key: space.key,
    });
    check(
        "space view shows public posts",
        spaceView.posts.some((post) => post.id === published.id),
        spaceView.posts.length,
    );
    const spaceBad = await carolClient
        .rpc("moment.space.view", { username: alice, key: "0123456789abcdef" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "space view rejects bad key",
        spaceBad instanceof Error &&
            spaceBad.message === "空间链接无效或已失效",
        String(spaceBad),
    );

    aliceClient.clearEvents();
    const liked = await bobClient.rpc("moment.like", { postId: published.id });
    check(
        "like recorded",
        liked.likes.some((row) => row.username === bob),
        liked.likes,
    );
    const likeEvent = await aliceClient.waitEvent(
        "moment:update",
        (payload) => payload.action === "like",
    );
    check(
        "author notified of like",
        likeEvent.postId === published.id && likeEvent.author === bob,
        likeEvent,
    );
    const unlike = await bobClient.rpc("moment.like", {
        postId: published.id,
        liked: false,
    });
    check("unlike clears", unlike.likes.length === 0, unlike.likes);
    const comment = await bobClient.rpc("moment.comment", {
        postId: published.id,
        content: "不錯",
    });
    check(
        "comment added",
        comment.comments.length === 1 && comment.comments[0].content === "不錯",
        comment.comments,
    );
    const emptyComment = await bobClient
        .rpc("moment.comment", { postId: published.id, content: "  " })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "empty comment rejected",
        emptyComment instanceof Error &&
            emptyComment.message === "评论内容不能为空",
        String(emptyComment),
    );
    const commentId = comment.comments[0].id;
    const foreignCommentDelete = await carolClient
        .rpc("moment.comment.delete", { postId: published.id, commentId })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "outsider cannot delete comment",
        foreignCommentDelete instanceof Error,
        String(foreignCommentDelete),
    );
    const commentDeleted = await aliceClient.rpc("moment.comment.delete", {
        postId: published.id,
        commentId,
    });
    check(
        "post author deletes comment",
        commentDeleted.comments.length === 0,
        commentDeleted.comments,
    );

    const partialNoFriend = await aliceClient
        .rpc("moment.publish", {
            content: "限定",
            visibility: "partial",
            audience: [carol],
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "partial audience must be friend",
        partialNoFriend instanceof Error &&
            partialNoFriend.message.includes("不是你的好友"),
        String(partialNoFriend),
    );
    const partialBad = await aliceClient
        .rpc("moment.publish", {
            content: "限定",
            visibility: "partial",
            audience: [],
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "partial audience required",
        partialBad instanceof Error &&
            partialBad.message === "请选择可见的好友",
        String(partialBad),
    );
    const partialPost = await aliceClient.rpc("moment.publish", {
        content: "只给某人看",
        visibility: "partial",
        audience: [bob],
    });
    check(
        "partial post stores audience names",
        partialPost.audience.includes(bob),
        partialPost.audience,
    );
    const bobPartial = await bobClient.rpc("moment.timeline", { limit: 10 });
    check(
        "audience member sees partial post",
        bobPartial.posts.some((post) => post.id === partialPost.id),
        bobPartial.posts.length,
    );
    const carolPartial = await carolClient
        .rpc("moment.get", { postId: partialPost.id })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "moment.get hides non public",
        carolPartial instanceof Error &&
            carolPartial.message === "动态不存在或仅好友可见",
        String(carolPartial),
    );
    const excludePost = await aliceClient.rpc("moment.publish", {
        content: "屏蔽某人",
        visibility: "exclude",
        audience: [bob],
    });
    const bobExclude = await bobClient.rpc("moment.timeline", { limit: 10 });
    check(
        "excluded member cannot see post",
        !bobExclude.posts.some((post) => post.id === excludePost.id),
        bobExclude.posts.length,
    );

    await bobClient.rpc("moment.like", { postId: published.id });
    const unread = await aliceClient.rpc("moment.unread");
    check("unread counts interactions", unread.interactions >= 1, unread);
    const seen = await aliceClient.rpc("moment.seen");
    check("seen clears counters", seen.total === 0, seen);
    const unreadAfter = await aliceClient.rpc("moment.unread");
    check("unread zero after seen", unreadAfter.total === 0, unreadAfter);

    const forwarded = await bobClient.rpc("moment.forward", {
        postId: published.id,
        sessions: [`p2p:${alice}`],
    });
    check(
        "forward returns message",
        Array.isArray(forwarded) && forwarded[0]?.kind === "moment",
        forwarded,
    );
    const nonPublicForward = await aliceClient
        .rpc("moment.forward", {
            postId: partialPost.id,
            sessions: [`p2p:${bob}`],
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "only public moments forwardable",
        nonPublicForward instanceof Error &&
            nonPublicForward.message === "仅公开动态可以分享",
        String(nonPublicForward),
    );
    const foreignDelete = await bobClient
        .rpc("moment.delete", { postId: published.id })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "only author deletes moment",
        foreignDelete instanceof Error &&
            foreignDelete.message === "只能删除自己的动态",
        String(foreignDelete),
    );
    const deletedMoment = await aliceClient.rpc("moment.delete", {
        postId: published.id,
    });
    check("author deletes moment", deletedMoment === true, deletedMoment);
    const goneMoment = await aliceClient
        .rpc("moment.get", { postId: published.id })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "deleted moment gone",
        goneMoment instanceof Error,
        String(goneMoment),
    );

    const bobId = adminUsers.find((row) => row.username === bob)?.id;
    check(
        "admin users expose id",
        typeof bobId === "string" && bobId.length > 10,
        bobId,
    );
    const walletStart = await aliceClient.rpc("wallet.balance");
    check("wallet starts empty", walletStart.balance === 0, walletStart);
    const topup = await aliceClient.rpc("wallet.topup", { amount: 10000 });
    check("topup credits balance", topup.balance === 10000, topup);
    const topupFloat = await aliceClient
        .rpc("wallet.topup", { amount: 3.5 })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "topup rejects non integer",
        topupFloat instanceof Error &&
            topupFloat.message === "充值金额必须是整数（单位：分）",
        String(topupFloat),
    );
    const topupZero = await aliceClient.rpc("wallet.topup", { amount: 0 }).then(
        () => null,
        (err) => err,
    );
    check(
        "topup rejects zero",
        topupZero instanceof Error &&
            topupZero.message === "充值金额必须大于 0",
        String(topupZero),
    );

    aliceClient.clearEvents();
    const transfer = await aliceClient.rpc("transfer.send", {
        sessionId: `p2p:${bob}`,
        toUsername: bob,
        amount: 3000,
        message: "饭钱",
    });
    check(
        "transfer pending",
        transfer.transfer.state === "pending" &&
            transfer.transfer.amount === 3000,
        transfer.transfer,
    );
    check(
        "transfer message kind",
        transfer.message.kind === "transfer" &&
            transfer.message.transfer?.amount === 3000,
        transfer.message.kind,
    );
    const afterTransfer = await aliceClient.rpc("wallet.balance");
    check(
        "transfer debits sender",
        afterTransfer.balance === 7000,
        afterTransfer,
    );
    const bobList = await bobClient.rpc("transfer.list");
    check(
        "receiver sees incoming",
        bobList.transfers[0]?.action === "received" &&
            bobList.transfers[0]?.fromName === alice,
        bobList.transfers[0],
    );
    const selfTransfer = await aliceClient
        .rpc("transfer.send", {
            sessionId: `p2p:${alice}`,
            toUsername: alice,
            amount: 1,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "cannot transfer to self",
        selfTransfer instanceof Error &&
            selfTransfer.message === "不能给自己转账",
        String(selfTransfer),
    );
    const strangerTransfer = await aliceClient
        .rpc("transfer.send", {
            sessionId: `p2p:${carol}`,
            toUsername: carol,
            amount: 1,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "transfer requires friendship",
        strangerTransfer instanceof Error &&
            strangerTransfer.message === "你们还不是好友，无法转账",
        String(strangerTransfer),
    );
    const groupTransfer = await aliceClient
        .rpc("transfer.send", {
            sessionId: `g:${group.id}`,
            toUsername: bob,
            amount: 1,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "transfer p2p only",
        groupTransfer instanceof Error &&
            groupTransfer.message === "转账只能在私聊中进行",
        String(groupTransfer),
    );
    const brokeTransfer = await aliceClient
        .rpc("transfer.send", {
            sessionId: `p2p:${bob}`,
            toUsername: bob,
            amount: 999999,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "insufficient balance rejected",
        brokeTransfer instanceof Error &&
            brokeTransfer.message.startsWith("余额不足"),
        String(brokeTransfer),
    );

    aliceClient.clearEvents();
    const acceptedTransfer = await bobClient.rpc("transfer.accept", {
        transferId: transfer.transfer.id,
    });
    check(
        "transfer accepted",
        acceptedTransfer.transfer.state === "accepted" &&
            acceptedTransfer.myBalance === 3000,
        acceptedTransfer,
    );
    const acceptNotice = await aliceClient.waitEvent(
        "transfer:update",
        (payload) => payload.id === transfer.transfer.id,
    );
    check(
        "sender notified of accept",
        acceptNotice.state === "accepted",
        acceptNotice,
    );
    const doubleAccept = await bobClient
        .rpc("transfer.accept", { transferId: transfer.transfer.id })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "double accept rejected",
        doubleAccept instanceof Error &&
            doubleAccept.message === "该转账已处理过了",
        String(doubleAccept),
    );

    const rejectMe = await aliceClient.rpc("transfer.send", {
        sessionId: `p2p:${bob}`,
        toUsername: bob,
        amount: 500,
    });
    const rejected = await bobClient.rpc("transfer.reject", {
        transferId: rejectMe.transfer.id,
    });
    check(
        "transfer rejected",
        rejected.transfer.state === "rejected",
        rejected.transfer.state,
    );
    const refundedBalance = await aliceClient.rpc("wallet.balance");
    check(
        "reject refunds sender",
        refundedBalance.balance === 7000,
        refundedBalance,
    );
    const expireCount = await aliceClient.rpc("transfer.expire");
    check("transfer.expire idempotent", expireCount === 0, expireCount);
    const detail = await aliceClient.rpc("transfer.detail", {
        transferId: transfer.transfer.id,
    });
    check(
        "transfer detail readable",
        detail.transfer.state === "accepted" &&
            detail.transfer.action === "sent",
        detail.transfer,
    );

    const packet = await aliceClient.rpc("redpacket.create", {
        sessionId: `p2p:${bob}`,
        type: "normal",
        totalAmount: 1000,
        totalCount: 2,
    });
    check(
        "redpacket created",
        packet.packet.totalAmount === 1000 && packet.packet.remainCount === 2,
        packet.packet,
    );
    check(
        "redpacket message kind",
        packet.message.kind === "redpacket" &&
            packet.message.redPacket?.totalCount === 2,
        packet.message.kind,
    );
    const ownClaim = await aliceClient
        .rpc("redpacket.claim", { redPacketId: packet.packet.id })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "cannot claim own packet",
        ownClaim instanceof Error &&
            ownClaim.message === "不能领取自己发的红包",
        String(ownClaim),
    );
    bobClient.clearEvents();
    const claimOne = await bobClient.rpc("redpacket.claim", {
        redPacketId: packet.packet.id,
    });
    check(
        "even split claim",
        claimOne.amount === 500 && claimOne.packet.claimCount === undefined,
        claimOne.amount,
    );
    const claimNotice = await bobClient.waitEvent(
        "redpacket:update",
        (payload) => payload.id === packet.packet.id,
    );
    check(
        "packet update broadcast",
        claimNotice.remainCount === 1,
        claimNotice,
    );
    const claimAgain = await bobClient
        .rpc("redpacket.claim", { redPacketId: packet.packet.id })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "double claim rejected",
        claimAgain instanceof Error &&
            claimAgain.message === "你已经领过这个红包了",
        String(claimAgain),
    );
    const packetDetail = await bobClient.rpc("redpacket.detail", {
        redPacketId: packet.packet.id,
    });
    check(
        "packet detail records",
        packetDetail.records.length === 1 &&
            packetDetail.records[0].isMe === true,
        packetDetail.records,
    );
    check(
        "packet myAmount",
        packetDetail.packet.myAmount === 500,
        packetDetail.packet.myAmount,
    );
    const packetRecords = await aliceClient.rpc("redpacket.records", {
        redPacketId: packet.packet.id,
    });
    check(
        "packet records listed",
        packetRecords[0]?.username === bob,
        packetRecords,
    );
    const strangerClaim = await carolClient
        .rpc("redpacket.claim", { redPacketId: packet.packet.id })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "outsider cannot claim",
        strangerClaim instanceof Error &&
            strangerClaim.message === "你不在该会话中",
        String(strangerClaim),
    );
    const packetExpire = await aliceClient.rpc("redpacket.expire");
    check("packet.expire idempotent", packetExpire === 0, packetExpire);
    const badPacket = await aliceClient
        .rpc("redpacket.create", {
            sessionId: `p2p:${bob}`,
            totalAmount: 1,
            totalCount: 5,
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "packet split validated",
        badPacket instanceof Error &&
            badPacket.message === "金额不足以拆分成这么多个红包",
        String(badPacket),
    );

    const aaCandidates = await aliceClient.rpc("aa.candidates", {
        sessionId: `p2p:${bob}`,
    });
    check(
        "aa candidates p2p",
        aaCandidates.candidates.length === 1 &&
            aaCandidates.candidates[0].username === bob,
        aaCandidates.candidates,
    );
    const aaNoMembers = await aliceClient
        .rpc("aa.create", {
            sessionId: `p2p:${bob}`,
            totalAmount: 1000,
            description: "聚餐",
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "aa needs participants",
        aaNoMembers instanceof Error &&
            aaNoMembers.message === "AA 账单至少要有 1 位参与者",
        String(aaNoMembers),
    );
    const bill = await aliceClient.rpc("aa.create", {
        sessionId: `p2p:${bob}`,
        totalAmount: 1000,
        description: "聚餐",
        participantIds: [bobId],
    });
    check(
        "aa bill created",
        bill.bill.totalAmount === 1000 && bill.bill.participantIds.length === 1,
        bill.bill,
    );
    check(
        "aa message kind",
        bill.message.kind === "aabill" &&
            bill.message.aaBill?.id === bill.bill.id,
        bill.message.kind,
    );
    check(
        "aa detail members",
        bill.detail.members.length === 1 &&
            bill.detail.members[0].share === 1000,
        bill.detail.members,
    );
    check(
        "aa creator has no share",
        bill.detail.share === 0,
        bill.detail.share,
    );
    const badSplit = await aliceClient
        .rpc("aa.create", {
            sessionId: `p2p:${bob}`,
            totalAmount: 1000,
            splitType: "custom",
            participantIds: [bobId],
            customSplits: { [bobId]: 500 },
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "aa custom split sum validated",
        badSplit instanceof Error &&
            badSplit.message === "自定义分摊金额之和必须等于账单总额",
        String(badSplit),
    );
    const cancelByPeer = await bobClient
        .rpc("aa.cancel", { billId: bill.bill.id })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "only creator cancels",
        cancelByPeer instanceof Error &&
            cancelByPeer.message === "只有发起人可以取消账单",
        String(cancelByPeer),
    );
    const pay = await bobClient.rpc("aa.pay", { billId: bill.bill.id });
    check(
        "aa payment settles",
        pay.detail.bill.status === "settled" && pay.myBalance === 2000,
        pay.detail.bill.status,
    );
    const payAgain = await bobClient
        .rpc("aa.pay", { billId: bill.bill.id })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "aa closed bill rejects pay",
        payAgain instanceof Error &&
            payAgain.message === "该账单已结束，无法付款",
        String(payAgain),
    );
    const creatorBalance = await aliceClient.rpc("wallet.balance");
    check(
        "aa credits creator",
        creatorBalance.balance === 8000,
        creatorBalance,
    );
    const aaList = await aliceClient.rpc("aa.list", {
        sessionId: `p2p:${bob}`,
    });
    check(
        "aa list session",
        aaList.length === 1 && aaList[0].id === bill.bill.id,
        aaList.length,
    );
    const aaOverdue = await aliceClient.rpc("aa.overdue");
    check("aa overdue count", aaOverdue === 0, aaOverdue);

    const emptyApps = await aliceClient.rpc("bots.apps");
    check(
        "bots apps empty",
        Array.isArray(emptyApps) && emptyApps.length === 0,
        emptyApps,
    );
    const botNameErr = await aliceClient
        .rpc("bots.app.create", { name: "   " })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "bot name required",
        botNameErr instanceof Error && botNameErr.message === "请填写应用名称",
        String(botNameErr),
    );
    const botApp = await aliceClient.rpc("bots.app.create", {
        name: "构建机器人",
        scopes: ["messages:read", "messages:write", "nope"],
    });
    check(
        "bot app created",
        /^pgm_[A-Za-z0-9_-]{32}$/.test(botApp.token) &&
            botApp.scopes.length === 2,
        botApp,
    );
    check(
        "bot token preview",
        typeof botApp.tokenPreview === "string" &&
            botApp.tokenPreview.endsWith("…"),
        botApp.tokenPreview,
    );
    const appList = await aliceClient.rpc("bots.apps");
    check(
        "bot app listed",
        appList.length === 1 && appList[0].id === botApp.id,
        appList,
    );
    const hookBadUrl = await aliceClient
        .rpc("bots.hook.create", { url: "ftp://x", events: ["message.new"] })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "bot hook rejects url",
        hookBadUrl instanceof Error &&
            hookBadUrl.message === "回调地址必须是 http(s) URL",
        String(hookBadUrl),
    );
    const hookNoEvents = await aliceClient
        .rpc("bots.hook.create", {
            url: "https://example.com/hook",
            events: [],
        })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "bot hook requires events",
        hookNoEvents instanceof Error &&
            hookNoEvents.message === "请至少选择一个事件",
        String(hookNoEvents),
    );
    const hookUrl = `http://127.0.0.1:${hookPort}/hook`;
    const hook = await aliceClient.rpc("bots.hook.create", {
        url: hookUrl,
        events: ["message.new", "bogus"],
    });
    check(
        "bot hook created",
        hook.enabled === true &&
            hook.events.length === 1 &&
            typeof hook.secret === "string",
        hook,
    );
    const hooks = await aliceClient.rpc("bots.hooks");
    check(
        "bot hooks listed",
        hooks.length === 1 && hooks[0].botName === "构建机器人",
        hooks,
    );
    const hookToggle = await aliceClient.rpc("bots.hook.toggle", {
        id: hook.id,
        enabled: false,
    });
    check("bot hook toggled", hookToggle.ok === true, hookToggle);
    const hooksAfter = await aliceClient.rpc("bots.hooks");
    check("bot hook disabled", hooksAfter[0].enabled === false, hooksAfter[0]);
    const whoami = await (
        await fetch(
            `${base}/open/whoami?token=${encodeURIComponent(botApp.token)}`,
        )
    ).json();
    check(
        "open whoami",
        whoami.ok === true && whoami.result.id === botApp.id,
        whoami,
    );
    const whoamiBad = await fetch(`${base}/open/whoami?token=pgm_bogus`);
    check("open whoami rejects", whoamiBad.status === 401, whoamiBad.status);
    const openSend = await (
        await fetch(`${base}/open/message`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${botApp.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                session: `p2p:${bob}`,
                content: "机器人消息",
                kind: "notice",
                title: "构建",
            }),
        })
    ).json();
    check(
        "open message sends",
        openSend.ok === true && typeof openSend.result.id === "string",
        openSend,
    );
    const botRead = await (
        await fetch(
            `${base}/open/messages?session=${encodeURIComponent(`p2p:${bob}`)}&limit=5&token=${encodeURIComponent(botApp.token)}`,
        )
    ).json();
    check(
        "open messages lists",
        botRead.ok === true &&
            botRead.result.messages.some((row) =>
                row.content.includes("机器人消息"),
            ),
        botRead,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    check(
        "disabled hook not delivered",
        hookHits.length === 0,
        hookHits.length,
    );
    await aliceClient.rpc("bots.hook.toggle", { id: hook.id, enabled: true });
    const openSend2 = await (
        await fetch(`${base}/open/message`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${botApp.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                session: `p2p:${bob}`,
                content: "钩子投递",
            }),
        })
    ).json();
    check("open message second send", openSend2.ok === true, openSend2);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const hit = hookHits[0];
    check(
        "hook delivered event",
        Boolean(hit) && hit.headers["x-plugim-event"] === "message.new",
        hookHits.length,
    );
    if (hit) {
        const expected = createHash("sha256")
            .update(`${hook.secret}.${hit.body}`)
            .digest("hex");
        check(
            "hook signature matches",
            hit.headers["x-plugim-signature"] === expected,
            hit.headers["x-plugim-signature"],
        );
        const parsed = JSON.parse(hit.body);
        check(
            "hook payload shape",
            parsed.event === "message.new" &&
                parsed.bot === "构建机器人" &&
                typeof parsed.at === "string",
            parsed.event,
        );
        check(
            "hook payload carries message",
            parsed.data?.message?.content === "钩子投递",
            parsed.data?.message?.content,
        );
    }
    const readOnlyApp = await aliceClient.rpc("bots.app.create", {
        name: "只读机器人",
        scopes: ["messages:read"],
    });
    const sendForbidden = await fetch(`${base}/open/message`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${readOnlyApp.token}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({ session: `p2p:${bob}`, content: "越权" }),
    });
    check(
        "open message scope enforced",
        sendForbidden.status === 403,
        sendForbidden.status,
    );
    const revokeReadonly = await aliceClient.rpc("bots.app.revoke", {
        id: readOnlyApp.id,
    });
    check("bot app revoked", revokeReadonly.ok === true, revokeReadonly);
    const appsAfter = await aliceClient.rpc("bots.apps");
    check("revoked app hidden", appsAfter.length === 1, appsAfter.length);
    const revokedWhoami = await fetch(
        `${base}/open/whoami?token=${encodeURIComponent(readOnlyApp.token)}`,
    );
    check(
        "revoked token rejected",
        revokedWhoami.status === 401,
        revokedWhoami.status,
    );
    const hookRemoved = await aliceClient.rpc("bots.hook.remove", {
        id: hook.id,
    });
    check("bot hook removed", hookRemoved.ok === true, hookRemoved);
    const hooksEmpty = await aliceClient.rpc("bots.hooks");
    check("bot hooks empty", hooksEmpty.length === 0, hooksEmpty);

    const installStatus = await aliceClient.rpc("install.status");
    check(
        "install status locked",
        installStatus.installed === true && installStatus.hasUsers === true,
        installStatus,
    );
    check(
        "install status omits db",
        installStatus.dbFile === undefined,
        Object.keys(installStatus),
    );
    const finishFirst = await aliceClient.rpc("install.finish", {
        allowRegister: true,
        mode: "enterprise",
    });
    check("install finish by first user", finishFirst === true, finishFirst);
    const finishAgain = await aliceClient.rpc("install.finish", {}).then(
        () => null,
        (err) => err,
    );
    check(
        "install finish locked",
        finishAgain instanceof Error &&
            finishAgain.message === "系统已完成初始化",
        String(finishAgain),
    );
    const testdbLocked = await aliceClient
        .rpc("install.testdb", { dbDriver: "sqlite", dbFile: "data/other.db" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "install testdb locked",
        testdbLocked instanceof Error &&
            testdbLocked.message === "系统已完成初始化",
        String(testdbLocked),
    );
    const savedbLocked = await aliceClient
        .rpc("install.savedb", { dbDriver: "sqlite", dbFile: "data/other.db" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "install savedb locked",
        savedbLocked instanceof Error &&
            savedbLocked.message === "系统已完成初始化",
        String(savedbLocked),
    );

    const updateCheck = await aliceClient.rpc("admin.update.check");
    check(
        "update check unsupported repo",
        updateCheck.supported === false,
        updateCheck,
    );
    const updateStatus = await aliceClient.rpc("admin.update.status");
    check("update status null", updateStatus === null, updateStatus);
    const applyDenied = await carolClient.rpc("admin.update.apply").then(
        () => null,
        (err) => err,
    );
    check(
        "update apply admin only",
        applyDenied instanceof Error &&
            applyDenied.message === "需要管理员权限",
        String(applyDenied),
    );

    const fileCfg = await aliceClient.rpc("files.config.get");
    check(
        "files config local",
        fileCfg.driver === "local" && fileCfg.uploadLimitMb === 20,
        fileCfg,
    );
    const cfgTest = await aliceClient.rpc("files.config.test");
    check(
        "files config test writable",
        cfgTest.ok === true && cfgTest.message.includes("可写"),
        cfgTest,
    );
    const badLimit = await aliceClient
        .rpc("files.config.set", { uploadLimitMb: 0 })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "files limit validated",
        badLimit instanceof Error &&
            badLimit.message === "上传上限需为 1 到 1024 之间的整数",
        String(badLimit),
    );
    const badDriver = await aliceClient
        .rpc("files.config.set", { driver: "ftp" })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "files driver validated",
        badDriver instanceof Error &&
            badDriver.message === "存储驱动仅支持 local 或 s3",
        String(badDriver),
    );
    const setLimit = await aliceClient.rpc("files.config.set", {
        uploadLimitMb: 30,
    });
    check("files limit applied", setLimit.uploadLimitMb === 30, setLimit);
    const infoAfter = await aliceClient.rpc("files.info");
    check(
        "files info reflects limit",
        infoAfter.uploadLimitMb === 30,
        infoAfter,
    );
    const nonAdminCfg = await carolClient.rpc("files.config.get").then(
        () => null,
        (err) => err,
    );
    check(
        "files config admin only",
        nonAdminCfg instanceof Error &&
            nonAdminCfg.message === "需要管理员权限",
        String(nonAdminCfg),
    );

    const metricsText = await (await fetch(`${base}/metrics`)).text();
    check(
        "metrics exposes rpc counter",
        metricsText.includes('plugim_rpc_calls_total{method="auth.login"}'),
        metricsText.slice(0, 80),
    );
    check(
        "metrics exposes websocket gauge",
        /plugim_websocket_connections \d+/.test(metricsText),
        "gauge missing",
    );
    check(
        "metrics exposes histogram",
        metricsText.includes("plugim_rpc_duration_ms_bucket"),
        "histogram missing",
    );
    check(
        "metrics content type",
        (await fetch(`${base}/metrics`)).headers
            .get("content-type")
            ?.includes("text/plain"),
        "bad type",
    );
    const metricsJson = await (await fetch(`${base}/metrics.json`)).json();
    check(
        "metrics json uptime",
        metricsJson.uptimeSec >= 0 && metricsJson.rpc.length > 0,
        metricsJson.uptimeSec,
    );
    check(
        "metrics json memory",
        metricsJson.memoryRssBytes > 0 && metricsJson.memoryHeapUsedBytes > 0,
        metricsJson.memoryHeapUsedBytes,
    );

    const tmpDir = process.env.TMP_DIR ?? "";
    if (tmpDir) {
        const logDir = join(tmpDir, "logs");
        const logFiles = readdirSync(logDir).filter((name) =>
            name.startsWith("server-"),
        );
        check("log file written", logFiles.length >= 1, logFiles.length);
        const logText = readFileSync(join(logDir, logFiles[0]), "utf8");
        check(
            "log file has bootstrap line",
            logText.includes("rpc methods"),
            logText.slice(0, 40),
        );
        const backupDir = join(tmpDir, "backups");
        const backups = readdirSync(backupDir).filter((name) =>
            name.startsWith("plugim-"),
        );
        check("backup file written", backups.length >= 1, backups.length);
    }

    const pushInfo = await aliceClient.rpc("push.info");
    check(
        "push info returns vapid key",
        /^[A-Za-z0-9_-]{87}$/.test(pushInfo.publicKey),
        pushInfo.publicKey?.length,
    );
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const uaPublic = ua.getPublicKey();
    const uaPrivate = ua.getPrivateKey();
    const authSecret = randomBytes(16);
    const subscribed = await aliceClient.rpc("push.subscribe", {
        subscription: {
            endpoint: `http://127.0.0.1:${hookPort}/push`,
            keys: { p256dh: b64u(uaPublic), auth: b64u(authSecret) },
        },
    });
    check("push subscribe counts", subscribed.subscriptions === 1, subscribed);
    const pushBad = await aliceClient
        .rpc("push.subscribe", { subscription: { endpoint: "" } })
        .then(
            () => null,
            (err) => err,
        );
    check(
        "push subscribe validates",
        pushBad instanceof Error && pushBad.message === "订阅信息不完整",
        String(pushBad),
    );
    const pushOk = await aliceClient.rpc("push.test");
    check("push test delivered", pushOk.ok === true, pushOk);
    check("push hit received", pushHits.length === 1, pushHits.length);
    const pushHit = pushHits[0];
    check(
        "push content encoding",
        pushHit.headers["content-encoding"] === "aes128gcm",
        pushHit.headers["content-encoding"],
    );
    check(
        "push ttl header",
        pushHit.headers.ttl === "86400",
        pushHit.headers.ttl,
    );
    const decrypted = decryptPush(
        pushHit.body,
        uaPrivate,
        uaPublic,
        authSecret,
    );
    check(
        "push ciphertext decrypts",
        decrypted.delimiter === 2,
        decrypted.delimiter,
    );
    check(
        "push record size",
        decrypted.recordSize === 4096,
        decrypted.recordSize,
    );
    check(
        "push key id is as public",
        decrypted.keyId.length === 65 && decrypted.keyId[0] === 4,
        decrypted.keyId.length,
    );
    const payloadJson = JSON.parse(decrypted.body.toString("utf8"));
    check(
        "push payload content",
        payloadJson.title === "plugim" && payloadJson.body === "推送测试成功",
        payloadJson,
    );
    const vapid = verifyVapid(pushHit.headers, pushInfo.publicKey);
    check(
        "push vapid signature",
        Boolean(vapid?.verified),
        vapid && vapid.verified,
    );
    check(
        "push vapid claims",
        Boolean(vapid) &&
            typeof vapid.claims.aud === "string" &&
            vapid.claims.exp > Math.floor(Date.now() / 1000),
        vapid?.claims,
    );
    check(
        "push vapid key header",
        Boolean(vapid) && vapid.key === pushInfo.publicKey,
        vapid?.key?.length,
    );

    const linkMessage = await aliceClient.rpc("message.send", {
        session: `p2p:${bob}`,
        content: `看看这个 http://127.0.0.1:${hookPort}/og 页面`,
    });
    check(
        "message link attached",
        linkMessage.link?.title === "格子聊天 & 预览",
        linkMessage.link,
    );
    const plainMessage = await aliceClient.rpc("message.send", {
        session: `p2p:${bob}`,
        content: "没有链接的消息",
    });
    check(
        "message link omitted",
        plainMessage.link === null || plainMessage.link === undefined,
        plainMessage.link,
    );

    const localDir = await aliceClient.rpc("files.config.get");
    const s3Set = await aliceClient.rpc("files.config.set", {
        driver: "s3",
        endpoint: `http://127.0.0.1:${s3Port}`,
        region: "us-east-1",
        bucket: "test",
        accessKey: S3_ACCESS,
        secretKey: S3_SECRET,
        pathStyle: true,
    });
    check(
        "s3 config saved",
        s3Set.driver === "s3" && s3Set.secretKeySet === true,
        s3Set,
    );
    const s3Probe = await aliceClient.rpc("files.config.test");
    check("s3 head bucket", s3Probe.ok === true, s3Probe);
    check(
        "s3 hash signed",
        s3Calls.some((call) => call.method === "HEAD" && call.ok),
        s3Calls.slice(-2),
    );
    const s3UploadResponse = await fetch(`${base}/upload`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${registered.token}`,
            "content-type": "text/plain",
            "x-file-name": encodeURIComponent("s3 测试.txt"),
        },
        body: Buffer.from("s3 payload 内容"),
    });
    const s3Upload = await s3UploadResponse.json();
    check("s3 upload ok", s3Upload.ok === true, s3Upload);
    check(
        "s3 put signature ok",
        s3Calls.some((call) => call.method === "PUT" && call.ok),
        s3Calls.slice(-3),
    );
    check(
        "s3 object stored",
        s3Objects.get(s3Upload.result.key)?.toString("utf8") ===
            "s3 payload 内容",
        s3Objects.size,
    );
    const s3Download = await fetch(
        `${base}/files/${s3Upload.result.key}?token=${encodeURIComponent(registered.token)}`,
    );
    check("s3 download status", s3Download.status === 200, s3Download.status);
    check(
        "s3 download bytes",
        (await s3Download.text()) === "s3 payload 内容",
        "body mismatch",
    );
    check(
        "s3 get signature ok",
        s3Calls.some((call) => call.method === "GET" && call.ok),
        s3Calls.slice(-3),
    );
    const badSecret = await aliceClient.rpc("files.config.set", {
        secretKey: "wrong-secret",
    });
    check("s3 wrong secret saved", badSecret.secretKeySet === true, badSecret);
    const badProbe = await aliceClient.rpc("files.config.test").then(
        () => null,
        (err) => err,
    );
    check(
        "s3 rejects bad signature",
        badProbe instanceof Error && /无权访问|403/.test(badProbe.message),
        String(badProbe),
    );
    const restore = await aliceClient.rpc("files.config.set", {
        driver: "local",
        dir: localDir.dir,
        secretKey: S3_SECRET,
    });
    check("storage restored to local", restore.driver === "local", restore);
    const localProbe = await aliceClient.rpc("files.config.test");
    check("local dir writable", localProbe.ok === true, localProbe);
    s3Mock.close();

    pushHits.length = 0;
    const unsubscribed = await aliceClient.rpc("push.unsubscribe", {
        endpoint: `http://127.0.0.1:${hookPort}/push`,
    });
    check(
        "push unsubscribe counts",
        unsubscribed.subscriptions === 0,
        unsubscribed,
    );
    const pushTestEmpty = await aliceClient.rpc("push.test").then(
        () => null,
        (err) => err,
    );
    check(
        "push test requires subscription",
        pushTestEmpty instanceof Error &&
            pushTestEmpty.message === "当前设备未开启推送",
        String(pushTestEmpty),
    );

    hookReceiver.close();
    aliceClient.close();
    bobClient.close();
    carolClient.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
        console.log(`failed: ${failures.join(", ")}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("smoke crashed:", err);
    process.exit(2);
});
