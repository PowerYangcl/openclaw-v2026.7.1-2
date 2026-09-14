<script setup lang="ts">
/**
 * Dreams 视图 — 对应 ui/src/pages/dreams/ 的最小 Vue 3 版本。
 * RPC: doctor.memory.status, doctor.memory.dreamDiary, wiki.importInsights, wiki.palace。
 */
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";

interface DreamingStatus {
  enabled?: boolean;
  timezone?: string;
  shortTermCount?: number;
  groundedSignalCount?: number;
  totalSignalCount?: number;
  promotedToday?: number;
  phases?: Record<string, unknown>;
}

const gateway = useGatewayStore();
const loading = ref(false);
const saving = ref(false);
const status = ref<DreamingStatus | null>(null);
const diary = ref<string>("");
const insights = ref<string>("");
const palace = ref<string>("");
const agentId = ref<string>("");

async function load(): Promise<void> {
  loading.value = true;
  const params = agentId.value ? { agentId: agentId.value } : {};
  const results = await Promise.allSettled([
    gateway.request<DreamingStatus>("doctor.memory.status", params),
    gateway.request<{ content?: string } | string>("doctor.memory.dreamDiary", params),
    gateway.request<{ insights?: string } | string>("wiki.importInsights", {}),
    gateway.request<{ palace?: string } | string>("wiki.palace", {}),
  ]);
  if (results[0].status === "fulfilled") status.value = results[0].value ?? null;
  if (results[1].status === "fulfilled") {
    const v = results[1].value;
    diary.value = typeof v === "string" ? v : ((v as { content?: string })?.content ?? "");
  }
  if (results[2].status === "fulfilled") {
    const v = results[2].value;
    insights.value = typeof v === "string" ? v : ((v as { insights?: string })?.insights ?? "");
  }
  if (results[3].status === "fulfilled") {
    const v = results[3].value;
    palace.value = typeof v === "string" ? v : ((v as { palace?: string })?.palace ?? "");
  }
  loading.value = false;
}

async function toggle(): Promise<void> {
  if (!status.value) return;
  const next = !status.value.enabled;
  await ElMessageBox.confirm(`${next ? "启用" : "停用"}梦境引擎？`, "提示", {
    confirmButtonText: next ? "启用" : "停用",
    cancelButtonText: "取消",
  }).catch(() => null);
  if (status.value.enabled === next) return;
  saving.value = true;
  try {
    await gateway.request("config.patch", {
      path: "plugins.entries.openclaw-doctor.config.dreaming.enabled",
      value: next,
      baseHash: (await gateway.request<{ hash?: string }>("config.get", {})).hash,
    });
    ElMessage.success("已切换");
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    saving.value = false;
  }
}

async function backfill(): Promise<void> {
  try {
    await gateway.request("doctor.memory.backfillDreamDiary", agentId.value ? { agentId: agentId.value } : {});
    ElMessage.success("已触发回填");
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">梦境</h2>
      <div class="actions">
        <el-input v-model="agentId" placeholder="智能体 ID（可选）" class="agent-input" />
        <el-button :loading="loading" @click="load">刷新</el-button>
        <el-button
          v-if="status"
          :type="status.enabled ? 'warning' : 'success'"
          :loading="saving"
          @click="toggle"
        >
          {{ status.enabled ? "停用" : "启用" }}
        </el-button>
        <el-button @click="backfill">回填</el-button>
      </div>
    </header>

    <div v-if="status" class="status-card wb-card">
      <div class="status-grid">
        <div class="kv"><span class="lbl">启用</span><span>{{ status.enabled ? "是" : "否" }}</span></div>
        <div class="kv"><span class="lbl">时区</span><span class="mono">{{ status.timezone ?? "-" }}</span></div>
        <div class="kv"><span class="lbl">短期记忆</span><span>{{ status.shortTermCount ?? 0 }}</span></div>
        <div class="kv"><span class="lbl">已落地信号</span><span>{{ status.groundedSignalCount ?? 0 }}</span></div>
        <div class="kv"><span class="lbl">信号总数</span><span>{{ status.totalSignalCount ?? 0 }}</span></div>
        <div class="kv"><span class="lbl">今日晋升</span><span>{{ status.promotedToday ?? 0 }}</span></div>
      </div>
    </div>

    <div class="card-grid">
      <div class="wb-card">
        <div class="card-title">梦境日记</div>
        <pre class="json">{{ diary || "(空)" }}</pre>
      </div>
      <div class="wb-card">
        <div class="card-title">导入洞察</div>
        <pre class="json">{{ insights || "(空)" }}</pre>
      </div>
      <div class="wb-card">
        <div class="card-title">记忆宫殿</div>
        <pre class="json">{{ palace || "(空)" }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.agent-input {
  width: 200px;
}
.status-card {
  padding: 14px 16px;
  margin-bottom: 16px;
}
.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px 16px;
  font-size: 13px;
}
.kv {
  display: flex;
  gap: 8px;
}
.lbl {
  color: var(--wb-text-tertiary);
  min-width: 80px;
}
.card-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
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
  padding: 12px 14px;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
}
</style>