const SHELL_CACHE = "plugim-shell-v1";
const SHELL_ASSETS = [
    "/",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(SHELL_CACHE)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== SHELL_CACHE)
                        .map((key) => caches.delete(key)),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

const isAsset = (url) =>
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest";

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith("/rpc") || url.pathname.startsWith("/ws"))
        return;

    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches
                        .open(SHELL_CACHE)
                        .then((cache) => cache.put("/", copy))
                        .catch(() => undefined);
                    return response;
                })
                .catch(() =>
                    caches
                        .match("/")
                        .then((cached) => cached ?? Response.error()),
                ),
        );
        return;
    }

    if (!isAsset(url)) return;
    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) return cached;
            return fetch(request).then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches
                        .open(SHELL_CACHE)
                        .then((cache) => cache.put(request, copy))
                        .catch(() => undefined);
                }
                return response;
            });
        }),
    );
});

self.addEventListener("push", (event) => {
    let data = { title: "plugim", body: "", session: "" };
    try {
        data = Object.assign(data, event.data.json());
    } catch {}
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: "/icons/icon-192.png",
            badge: "/icons/icon-192.png",
            tag: data.session || "plugim",
            data: { session: data.session },
        }),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const session = event.notification.data?.session || "";
    event.waitUntil(
        self.clients
            .matchAll({ type: "window", includeUncontrolled: true })
            .then((list) => {
                const target = list.find((client) =>
                    client.url.startsWith(self.location.origin),
                );
                if (target) {
                    target.postMessage({ type: "push:open", session });
                    return target.focus();
                }
                const url = new URL("/", self.location.origin);
                if (session) url.searchParams.set("open", session);
                return self.clients.openWindow(url.toString());
            }),
    );
});
