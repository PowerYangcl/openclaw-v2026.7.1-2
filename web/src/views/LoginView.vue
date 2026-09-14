<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import { useSettingsStore } from "@/stores/settings";
import { entryLandingPath } from "@/utils/urlOverrides";

const route = useRoute();
const router = useRouter();
const gateway = useGatewayStore();
const settings = useSettingsStore();

/**
 * 登录成功后的落地路径。
 *
 * 优先级：
 * 1. `?redirect=` 指定的**具体**站内路径（路由守卫拦下来的目标页，例如 `/logs`）；
 * 2. `entryLandingPath()` —— 带 `#token=` / `?session=` 的入口进「对话」，否则进「概览」。
 *
 * 根路径 `/` 不算「具体目标」：`/` 本身会被重定向成落地页，把它当成用户意图会
 * 绕回去导致永远停在概览。
 */
function resolveLandingPath(): string {
  const redirect = typeof route.query.redirect === "string" ? route.query.redirect.trim() : "";
  if (redirect && redirect !== "/" && redirect.startsWith("/")) return redirect;
  return entryLandingPath();
}

const form = ref({
  url: settings.gatewayUrl,
  token: settings.token,
  // url: 'ws://90331b842f7147c1b7d7-agent.gcs-sjz1a.jdcloud.com/',
  // token: 'd28c42c06026479a88a307259b5b8dbc',
  password: "",
});
const connecting = ref(false);

function submit(): void {
  const url = form.value.url.trim();
  if (!url) {
    ElMessage.warning("请填写网关地址");
    return;
  }
  if (!/^wss?:\/\//i.test(url)) {
    ElMessage.warning("网关地址需以 ws:// 或 wss:// 开头");
    return;
  }

  settings.gatewayUrl = url;
  settings.token = form.value.token;
  connecting.value = true;
  gateway.connect({
    url,
    token: form.value.token,
    password: form.value.password,
  });
}

watch(
  () => gateway.phase,
  (phase) => {
    if (phase === "connected") {
      connecting.value = false;
      sessionStorage.setItem("openclaw.gateway.ready", "1");
      void router.push(resolveLandingPath());
    } else if (phase === "failed") {
      connecting.value = false;
    }
  },
);

onMounted(() => {
  // 已连接时直接进入
  if (gateway.phase === "connected") {
    sessionStorage.setItem("openclaw.gateway.ready", "1");
    void router.push(resolveLandingPath());
    return;
  }
  // 若用户在本 tab 主动断开过（handleDisconnect 在 MainLayout 里设置该 flag），
  // 不要自动重连，让他可以重新输入凭据。
  if (sessionStorage.getItem("openclaw.gateway.intentional-disconnect") === "1") return;
  // 等待 App.vue 的 autoConnect 拍完；如果正在握手就什么都不做，避免双连。
  if (
    gateway.phase === "connecting" ||
    gateway.phase === "reconnecting"
  ) {
    return;
  }
  // 令牌已就绪（来自 ?/#token= 或本地持久化）时自动连接，对齐后端 dashboard URL 的免手输体验。
  // 仅在真的有 token 时才自动发请求；否则停在登录页等用户输入。
  const tokenCandidate = form.value.token.trim();
  if (!tokenCandidate && !settings.gatewayUrl.trim()) return;
  submit();
});
</script>

<template>
  <div class="login-page">
    <div class="login-bg" />

    <div class="login-card">
      <div class="login-header">
        <span class="brand-mark">OC</span>
        <div>
          <div class="login-title">AgentClaw</div>
          <div class="login-sub">连接到网关以继续</div>
        </div>
      </div>

      <el-form label-position="top" class="login-form" @submit.prevent="submit">
        <el-form-item label="网关地址">
          <el-input
            v-model="form.url"
            placeholder="ws://127.0.0.1:18789"
            class="mono"
            autocomplete="off"
          />
          <div class="form-hint">
            生产环境建议使用 <code>wss://</code>；同机开发用 <code>ws://127.0.0.1:18789</code>
          </div>
        </el-form-item>

        <el-form-item label="访问令牌（可选）">
          <el-input
            v-model="form.token"
            type="password"
            placeholder="留空则使用设备身份配对"
            show-password
            autocomplete="off"
          />
          <div class="form-hint">
            后端开启 token 认证时必填。令牌位于本机
            <code>~/.openclaw/openclaw.json</code> 的 <code>gateway.auth.token</code>，
            或运行 <code>openclaw dashboard</code> 得到的 URL 里的 <code>#token=</code>。
          </div>
        </el-form-item>

        <el-form-item label="密码（可选）">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="网关配置了密码时填写"
            show-password
            autocomplete="off"
          />
        </el-form-item>

        <el-button
          type="primary"
          class="login-submit"
          :loading="connecting || gateway.phase === 'connecting'"
          @click="submit"
        >
          连接
        </el-button>
      </el-form>

      <el-alert
        v-if="gateway.lastError"
        :title="gateway.lastError"
        type="error"
        :closable="false"
        show-icon
        class="login-error"
      />
      <div v-if="gateway.errorDetailCode" class="login-code mono">
        错误码：{{ gateway.errorDetailCode }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.login-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(800px 400px at 30% 10%, rgba(96, 165, 250, 0.18), transparent 60%),
    radial-gradient(600px 300px at 80% 90%, rgba(37, 99, 235, 0.12), transparent 60%),
    var(--wb-bg-content);
  z-index: 0;
}

html.dark .login-bg {
  background:
    radial-gradient(800px 400px at 30% 10%, rgba(96, 165, 250, 0.10), transparent 60%),
    radial-gradient(600px 300px at 80% 90%, rgba(37, 99, 235, 0.08), transparent 60%),
    var(--wb-bg-content);
}

.login-card {
  position: relative;
  z-index: 1;
  width: 440px;
  padding: 32px;
  background: var(--wb-bg-card);
  border-radius: var(--wb-radius-lg);
  box-shadow: var(--wb-shadow-lg);
  border: 1px solid var(--wb-border);
}

.login-header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 24px;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, #60a5fa, #2563eb);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  box-shadow: 0 4px 14px rgba(37, 99, 235, 0.30);
}

.login-title {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.login-sub {
  font-size: 12px;
  color: var(--wb-text-secondary);
  margin-top: 2px;
}

.login-form {
  margin-bottom: 0;
}

.login-form :deep(.el-form-item__label) {
  font-weight: 500;
  color: var(--wb-text-primary);
  padding-bottom: 6px;
  font-size: 13px;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 16px;
}

.form-hint {
  font-size: 11px;
  color: var(--wb-text-tertiary);
  line-height: 1.6;
  margin-top: 6px;
}

.form-hint code {
  background: var(--wb-bg-inset);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: "SFMono-Regular", "SF Mono", Consolas, Menlo, monospace;
  font-size: 11px;
}

.login-submit {
  width: 100%;
  height: 40px;
  font-weight: 500;
  margin-top: 8px;
  border-radius: var(--wb-radius) !important;
}

.login-error {
  margin-top: 16px;
}

.login-code {
  margin-top: 8px;
  font-size: 11px;
  color: var(--wb-text-tertiary);
}
</style>