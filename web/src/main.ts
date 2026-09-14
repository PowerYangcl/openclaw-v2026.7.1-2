import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { createPinia } from "pinia";
import { createApp } from "vue";
import "element-plus/dist/index.css";

import App from "./App.vue";
import { router } from "./router";
import "./styles/main.css";

// `gateways/control-ui-assets.ts` resolves the Gateway static asset root to `web/dist/`.
// `index.html` reads `data-openclaw-control-ui-base-path` and `data-openclaw-terminal-enabled`
// from `<html>` attributes (injected by `serveResolvedIndexHtml` in `src/gateway/control-ui.ts`)
// and exposes them as `window.__OPENCLAW_BASE_PATH__` / `window.__OPENCLAW_TERMINAL_ENABLED__`
// before this script runs.

const app = createApp(App);

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.mount("#app");
