<script setup lang="ts">
/**
 * Tasks 视图 — 对应 ui/src/pages/tasks/ 的最小可用 Vue 3 版本。
 * RPC: tasks.list (queued+running / 最近完成), tasks.cancel。
 */
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";

interface TaskSummary {
  id: string;
  sessionKey?: string | null;
  title?: string | null;
  status?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  agentId?: string | null;
}

const gateway = useGatewayStore();
const loading = ref(false);
const tasks = ref<TaskSummary[]>([]);
const cancelling = ref<Set<string>>(new Set());

async function load(): Promise<void> {
  loading.value = true;
  const results = await Promise.allSettled([
    gateway.request<{ tasks?: TaskSummary[] }>("tasks.list", { status: ["queued", "running"], limit: 200 }),
    gateway.request<{ tasks?: TaskSummary[] }>("tasks.list", { limit: 100 }),
  ]);
  const seen = new Set<string>();
  const merged: TaskSummary[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const t of r.value?.tasks ?? []) {
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      merged.push(t);
    }
  }
  tasks.value = merged;
  loading.value = false;
}

async function cancel(id: string): Promise<void> {
  cancelling.value.add(id);
  try {
    await gateway.request("tasks.cancel", { taskId: id });
    ElMessage.success("已取消任务");
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    cancelling.value.delete(id);
  }
}

onMounted(load);

function fmtTime(ms?: number): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">任务</h2>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>

    <div v-if="!loading && tasks.length === 0" class="empty-hint">
      暂无任务。可在「会话」中发起会话来产生任务。
    </div>

    <ul v-else class="task-list">
      <li v-for="t in tasks" :key="t.id" class="task-row wb-card">
        <div class="task-row-main">
          <div class="task-title">{{ t.title || t.id }}</div>
          <div class="task-meta">
            <el-tag size="small" :type="t.status === 'running' ? 'warning' : 'info'">
              {{ t.status ?? "queued" }}
            </el-tag>
            <span class="task-time">{{ fmtTime(t.updatedAtMs ?? t.createdAtMs) }}</span>
            <span v-if="t.agentId" class="task-agent">{{ t.agentId }}</span>
            <span v-if="t.sessionKey" class="task-session mono">{{ t.sessionKey }}</span>
          </div>
        </div>
        <el-button
          v-if="t.status === 'queued' || t.status === 'running'"
          size="small"
          type="danger"
          plain
          :loading="cancelling.has(t.id)"
          @click="cancel(t.id)"
        >
          取消
        </el-button>
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
}
.task-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.task-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
}
.task-row-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.task-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--wb-text-primary);
  word-break: break-word;
}
.task-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--wb-text-secondary);
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 32px;
  text-align: center;
}
</style>