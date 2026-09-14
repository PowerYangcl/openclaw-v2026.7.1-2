<script setup lang="ts">
/**
 * Activity 视图 — 对应 ui/src/pages/activity/ 的最小 Vue 3 版本。
 * 监听 gateway 的 agent / session.tool 事件,叠加历史 eventLog。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";

interface ActivityEntry {
  id: string;
  ts: number;
  type: string;
  text: string;
}

const gateway = useGatewayStore();
const entries = ref<ActivityEntry[]>([]);
const filter = ref<string>("");
let unsubscribe: (() => void) | null = null;

function push(entry: ActivityEntry): void {
  entries.value.unshift(entry);
  if (entries.value.length > 200) entries.value.length = 200;
}

function extractText(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    return (p.text ?? p.message ?? p.action ?? JSON.stringify(payload).slice(0, 80)) as string;
  }
  return String(payload);
}

onMounted(async () => {
  await gateway.waitForConnection(5000).catch(() => {});
  unsubscribe = gateway.onEvent((evt) => {
    if (evt.event !== "agent" && evt.event !== "session.tool") return;
    push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      type: evt.event,
      text: extractText(evt.payload),
    });
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
});

const filtered = (): ActivityEntry[] => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return entries.value;
  return entries.value.filter((e) => e.text.toLowerCase().includes(q) || e.type.includes(q));
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">活动</h2>
      <el-input v-model="filter" placeholder="过滤关键字" class="filter-input" clearable />
    </header>

    <div v-if="filtered().length === 0" class="empty-hint">
      暂无活动事件。开启会话或工具调用后会实时显示。
    </div>

    <ul v-else class="activity-stream">
      <li v-for="e in filtered()" :key="e.id" class="activity-row">
        <span class="ts mono">{{ fmtTime(e.ts) }}</span>
        <el-tag size="small" :type="e.type === 'agent' ? 'success' : 'info'">{{ e.type }}</el-tag>
        <span class="text">{{ e.text }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 12px;
}
.filter-input {
  max-width: 280px;
}
.activity-stream {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: calc(100vh - 200px);
  overflow: auto;
}
.activity-row {
  display: grid;
  grid-template-columns: 80px 110px 1fr;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  font-size: 13px;
}
.ts {
  font-size: 11px;
  color: var(--wb-text-tertiary);
}
.text {
  color: var(--wb-text-primary);
  word-break: break-word;
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 32px;
  text-align: center;
}
</style>