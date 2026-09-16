<script setup lang="ts">
/**
 * Debug 视图 — 对应 ui/src/pages/debug/ 的最小 Vue 3 版本。
 * 提供 status / health / models / heartbeat 实时视图 + 自由 RPC 调用器。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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

// ---------------------------------------------------------------------------
// 网关诊断：连接 / 请求耗时采样 + 最近一次错误的结构化信息
// ---------------------------------------------------------------------------
const timingRows = computed(() => gateway.timings.slice(0, 20));

const timingSummary = computed(() => {
  const list = gateway.timings;
  if (!list.length) return null;
  const ok = list.filter((t) => t.ok).map((t) => t.ms);
  return {
    total: list.length,
    failed: list.length - ok.length,
    avg: ok.length ? `${Math.round(ok.reduce((a, b) => a + b, 0) / ok.length)} ms` : "—",
    min: ok.length ? `${Math.min(...ok)} ms` : "—",
    max: ok.length ? `${Math.max(...ok)} ms` : "—",
  };
});

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

function clearTimings(): void {
  gateway.timings.splice(0, gateway.timings.length);
}
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

    <div class="wb-card diag-card">
      <div class="diag-head">
        <div class="card-title">网关诊断</div>
        <div class="diag-meta">
          <span>阶段：<b>{{ gateway.phase }}</b></span>
          <span v-if="timingSummary">
            样本 {{ timingSummary.total }} · 失败 {{ timingSummary.failed }} ·
            均值 {{ timingSummary.avg }} · {{ timingSummary.min }} ~ {{ timingSummary.max }}
          </span>
          <el-button v-if="timingRows.length" link type="primary" @click="clearTimings">
            清空
          </el-button>
        </div>
      </div>

      <div v-if="gateway.lastErrorInfo" class="diag-error">
        <div>
          <b>{{ gateway.lastErrorInfo.code }}</b> — {{ gateway.lastErrorInfo.message }}
        </div>
        <div v-if="gateway.lastErrorInfo.retryAfterMs" class="diag-retry">
          服务端建议 {{ Math.round(gateway.lastErrorInfo.retryAfterMs / 1000) }}s 后重试
        </div>
      </div>

      <el-table
        v-if="timingRows.length"
        :data="timingRows"
        size="small"
        max-height="260"
        class="diag-table"
      >
        <el-table-column label="时间" width="96">
          <template #default="{ row }">{{ formatTime(row.at) }}</template>
        </el-table-column>
        <el-table-column prop="label" label="方法" min-width="160" />
        <el-table-column label="耗时" width="92" align="right">
          <template #default="{ row }">{{ row.ms }} ms</template>
        </el-table-column>
        <el-table-column label="结果" width="72" align="center">
          <template #default="{ row }">
            <span :class="row.ok ? 'diag-ok' : 'diag-bad'">{{ row.ok ? "成功" : "失败" }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div v-else class="diag-empty">暂无采样：发起一次连接或任意 RPC 后，这里会记录耗时。</div>
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
.diag-card {
  margin-bottom: 16px;
}
.diag-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.diag-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: var(--wb-text-tertiary);
}
.diag-error {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: var(--wb-radius);
  background: var(--el-color-error-light-9);
  color: var(--el-color-error);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}
.diag-retry {
  margin-top: 2px;
  opacity: 0.8;
}
.diag-table {
  margin-top: 4px;
  width: 100%;
}
.diag-ok {
  color: var(--el-color-success);
}
.diag-bad {
  color: var(--el-color-error);
}
.diag-empty {
  font-size: 12px;
  color: var(--wb-text-tertiary);
  padding: 6px 0;
}
</style>