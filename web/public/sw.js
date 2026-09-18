// OpenClaw Web Control – Service Worker
// Handles offline caching and push notifications.
//
// 与旧版 `ui/public/sw.js` 保持一致，唯一的**有意偏离**是 fetch 的跳过名单里多了
// `__openclaw__` 命名空间（见下方注释）。
//
// ⚠️ `EMBEDDED_CACHE_VERSION` 的占位符必须原样保留（连引号一起）：
//   `web/vite.config.ts` 的 `controlUiServiceWorkerBuildIdPlugin` 在构建期把它替换成
//   真实 buildId，替换不到会直接抛错。改成模板字符串 / 去掉引号都会让缓存名退化成
//   `dev`，表现为「发版后用户永远拿到旧 chunk」—— 这类问题只在线上复现。

const CACHE_PREFIX = "openclaw-control-";
const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";
const URL_CACHE_VERSION = new URL(self.location.href).searchParams
  .get("v")
  ?.replace(/[^a-zA-Z0-9._-]/g, "-");
const CACHE_VERSION =
  (EMBEDDED_CACHE_VERSION !== "__OPENCLAW_CONTROL_UI_BUILD_ID__"
    ? EMBEDDED_CACHE_VERSION
    : URL_CACHE_VERSION) || "dev";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const CONTROL_CACHE_LIMIT = 3;

// Minimal app-shell files to precache.
const PRECACHE_URLS = ["./"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const [cacheKeys, windowClients] = await Promise.all([
        caches.keys(),
        self.clients.matchAll({ type: "window", includeUncontrolled: true }),
      ]);
      const controlKeys = cacheKeys.filter((key) => key.startsWith(CACHE_PREFIX));
      const priorCacheLimit = Math.max(0, CONTROL_CACHE_LIMIT - 1);
      // Keep a small prior-build window so open tabs can still load old hashed chunks after updates.
      const retained = new Set([
        ...controlKeys.filter((key) => key !== CACHE_NAME).slice(-priorCacheLimit),
        CACHE_NAME,
      ]);

      await Promise.all([
        self.clients.claim(),
        Promise.all(
          controlKeys.filter((key) => !retained.has(key)).map((key) => caches.delete(key)),
        ),
      ]);

      for (const client of windowClients) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Service Worker Client.postMessage does not take targetOrigin.
        client.postMessage({ type: "sw-updated", version: CACHE_VERSION });
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and cross-origin requests.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // Skip top-level navigations so the browser can handle HTTP auth
  // challenges natively — WWW-Authenticate dialogs are bypassed when the
  // response comes from a service worker, breaking reverse-proxy setups
  // with basic/digest auth in front of the gateway.
  if (event.request.mode === "navigate") {
    return;
  }

  // Skip non-UI routes — API, RPC, and plugin routes should never be cached.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/rpc") ||
    url.pathname.startsWith("/plugins/")
  ) {
    return;
  }

  // 额外跳过网关的 `__openclaw__` 命名空间（头像 / 助理媒体），这是 web 版相对 ui 版
  // **有意增加**的一条：族下所有 URL 都带「短时效签名或 ticket」
  //   - `/__openclaw__/avatar/<id>?token=<hmac>`
  //   - `/__openclaw__/assistant-media?ticket=<5min>`
  // 缓存键含 query ⇒ 每次签名变化都会新增一条永不命中的条目；而 assistant-media 直接
  // 回媒体字节，会把 Cache Storage 撑爆。两类响应都不该经过 SW。
  if (url.pathname.startsWith("/__openclaw__/")) {
    return;
  }

  // Cache-first for hashed assets; network-first for HTML/other.
  if (url.pathname.includes("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          }),
      ),
    );
  } else {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
  }
});

// --- Web Push ---

self.addEventListener("push", (event) => {
  if (!event.data) {
    return;
  }

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "OpenClaw", body: event.data.text() };
  }

  const title = data.title || "OpenClaw";
  const options = {
    body: data.body || "",
    icon: "./apple-touch-icon.png",
    // ⚠️ 这里**故意不设 `badge`**：`badge` 是 Android 通知栏那个单色小图标，旧版 ui 指的是
    // `./favicon-32.png`，但 web 没有发布这个文件（它是 ui 的吉祥物图标，web 的品牌图标是
    // JD Cloud 红标 `favicon.ico`），指向不存在的文件只会在推送落地后变成一条 404。
    // 将来把 `ui/src/app/web-push.ts` 搬到 web 时，一并加一个**单色** badge 资源再补上这行。
    tag: data.tag || "openclaw-notification",
    data: { url: data.url || "./" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "./";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing window if one is open.
      for (const client of clients) {
        if (new URL(client.url).pathname === new URL(targetUrl, self.location.origin).pathname) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
