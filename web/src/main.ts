import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { createPinia } from "pinia";
import { createApp } from "vue";
import "element-plus/dist/index.css";

import App from "./App.vue";
import { router } from "./router";
import { watchKeyboardInset } from "./utils/keyboardInset";
import "./styles/main.css";
import "./styles/layout.mobile.css";

// `gateways/control-ui-assets.ts` resolves the Gateway static asset root to `web/dist/`.
// `index.html` reads `data-openclaw-control-ui-base-path` and `data-openclaw-terminal-enabled`
// from `<html>` attributes (injected by `serveResolvedIndexHtml` in `src/gateway/control-ui.ts`)
// and exposes them as `window.__OPENCLAW_BASE_PATH__` / `window.__OPENCLAW_TERMINAL_ENABLED__`
// before this script runs.

// ---------------------------------------------------------------------------
// PWA / Service Worker
//
// 逐条对齐旧版 `ui/src/main.ts:19-35` 的行为，只有 SW 地址的推导方式不同：
// 旧版用 `inferControlUiPublicAssetPath()` 从 `location.pathname` 反推 base path；
// web 直接信任构建期常量 `import.meta.env.BASE_URL`（与 `router/index.ts` 的
// `createWebHistory(import.meta.env.BASE_URL)` 同一口径），得到与当前路由无关的确定地址。
// ---------------------------------------------------------------------------

/** 构建期注入的真实版本号（见 web/vite.config.ts 的 define）。 */
declare const OPENCLAW_CONTROL_UI_BUILD_ID: string | undefined;

const controlUiBuildId = OPENCLAW_CONTROL_UI_BUILD_ID || "dev";

/**
 * 构建期 base → 原点相对的目录前缀。
 * `"./"` / `"/"` → `""`（部署在根）；`"/openclaw/"` → `"/openclaw"`（子路径部署）。
 */
function controlUiBasePrefix(): string {
  const raw = import.meta.env.BASE_URL || "/";
  if (raw === "./" || raw === "/") return "";
  return `/${raw.replace(/^\.?\//, "").replace(/\/+$/, "")}`;
}

function syncControlUiServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;

  if (!import.meta.env.PROD) {
    // dev 下反注册残留 SW：上一版构建留下的 SW 会拦截/缓存资源，
    // 表现为「本地改了代码不生效」，排查成本很高，所以开发态一律清掉。
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) {
        void registration.unregister();
      }
    });
    return;
  }

  const swUrl = new URL(`${controlUiBasePrefix()}/sw.js`, window.location.origin);
  // 版本号进 query：SW 脚本内容不变但构建号变了时，让浏览器把它当作新脚本处理，
  // 与 closeBundle 注入的缓存名一起完成「新版本 → 轮换缓存 → 通知页面刷新」的闭环。
  swUrl.searchParams.set("v", controlUiBuildId);

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: unknown; version?: unknown } | null;
    // 新 SW 激活并 claim 之后会广播 sw-updated；版本一致说明就是本页当前这一版，
    // 不需要刷新（否则会形成「刷新 → 又是自己 → 再刷新」的循环）。
    if (data?.type === "sw-updated" && data.version !== controlUiBuildId) {
      window.location.reload();
    }
  });

  void navigator.serviceWorker.register(swUrl, { updateViaCache: "none" });
}

const app = createApp(App);

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.mount("#app");

syncControlUiServiceWorker();

// 软键盘遮挡补偿：把「被键盘盖住的高度」持续写进 `--wb-keyboard-inset`，
// 由 composer 的 `padding-bottom` 消费（详见 utils/keyboardInset.ts）。
// 进程级常驻监听，不随路由卸载 —— 单页应用只有一个 `:root`。
watchKeyboardInset();
