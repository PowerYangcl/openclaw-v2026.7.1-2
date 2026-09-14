<script setup lang="ts">
/**
 * Debug 视图 — 对应 ui/src/pages/debug/ 的最小 Vue 3 版本。
 * 提供 status / health / models / heartbeat 实时视图 + 自由 RPC 调用器。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";

const gateway = useGatewayStore();
const loading = ref(false);
const status = ref<Record<string, unknown> | null>(null);
const health = ref<Record<string, unknown> | null>(null);
const models = ref<unknown[]>([]);
const heartbeat = ref<Record<string, unknown> | null>(null);

const callMethod = ref<string>("");
const callParams = ref<string>("{}");
const callResult = ref<string | null>(null);
const callError = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  const results = await Promise.allSettled([
    gateway.request<Record<string, unknown>>("status", {}),
    gateway.request<Record<string, unknown>>("health", {}),
    gateway.request<{ models?: unknown[] } | unknown[]>("models.list", {}),
    gateway.request<Record<string, unknown>>("last-heartbeat", {}),
  ]);
  if (results[0].status === "fulfilled") status.value = results[0].value;
  if (results[1].status === "fulfilled") health.value = results[1].value;
  if (results[2].status === "fulfilled") {
    const v = results[2].value;
    models.value = Array.isArray(v) ? v : ((v as { models?: unknown[] })?.models ?? []);
  }
  if (results[3].status === "fulfilled") heartbeat.value = results[3].value;
  loading.value = false;
}

async function runCall(): Promise<void> {
  callResult.value = null;
  callError.value = null;
  let parsed: unknown = {};
  if (callParams.value.trim()) {
    try {
      parsed = JSON.parse(callParams.value);
    } catch (e) {
      callError.value = "JSON parse error: " + (e as Error).message;
      return;
    }
  }
  try {
    const res = await gateway.request(callMethod.value.trim() || "status", parsed);
    callResult.value = JSON.stringify(res, null, 2);
  } catch (e) {
    callError.value = (e as Error).message;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  load();
  timer = setInterval(load, 3000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const helloMethods = (gateway.hello as { features?: { methods?: string[] } } | null)?.features?.methods ?? [];
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">调试</h2>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>

    <div class="debug-grid">
      <div class="wb-card"><div class="card-title">Status</div><pre class="json">{{ JSON.stringify(status, null, 2) }}</pre></div>
      <div class="wb-card"><div class="card-title">Health</div><pre class="json">{{ JSON.stringify(health, null, 2) }}</pre></div>
      <div class="wb-card"><div class="card-title">Models</div><pre class="json">{{ JSON.stringify(models, null, 2) }}</pre></div>
      <div class="wb-card"><div class="card-title">Heartbeat</div><pre class="json">{{ JSON.stringify(heartbeat, null, 2) }}</pre></div>
    </div>

    <div class="wb-card rpc-card">
      <div class="card-title">自由 RPC</div>
      <div class="rpc-form">
        <el-input v-model="callMethod" placeholder="方法名" class="rpc-method" />
        <el-input v-model="callParams" type="textarea" :rows="3" placeholder='{"key":"value"}' class="rpc-params" />
        <el-button type="primary" @click="runCall">调用</el-button>
      </div>
      <pre v-if="callResult" class="json rpc-result">{{ callResult }}</pre>
      <div v-if="callError" class="rpc-error">{{ callError }}</div>
      <details v-if="helloMethods.length" class="method-hint">
        <summary>可用方法 ({{ helloMethods.length }})</summary>
        <pre class="json">{{ helloMethods.join("\n") }}</pre>
      </details>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.debug-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-secondary);
  margin-bottom: 8px;
}
.json {
  margin: 0;
  font-size: 12px;
  background: var(--wb-bg-inset);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  padding: 10px 12px;
  max-height: 260px;
  overflow: auto;
}
.rpc-card {
  margin-top: 8px;
}
.rpc-form {
  display: grid;
  grid-template-columns: 1fr 2fr auto;
  gap: 10px;
  align-items: start;
}
.rpc-method {
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.rpc-params {
  font-family: ui-monospace, SFMono-Regular, monospace;
}
.rpc-result {
  margin-top: 10px;
  border-color: var(--wb-accent-soft);
}
.rpc-error {
  color: #dc2626;
  margin-top: 8px;
  font-size: 13px;
}
.method-hint {
  margin-top: 12px;
  font-size: 12px;
  color: var(--wb-text-secondary);
}
</style>