<script setup lang="ts">
/**
 * Worktrees 视图 — 对应 ui/src/pages/worktrees/ 的最小 Vue 3 版本。
 * 工作树是 runtimeConfig 内嵌的 Worktree[] 配置。这里只展示当前快照,不做 patch。
 */
import { onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import type { ConfigSnapshot } from "@/api/types";

const gateway = useGatewayStore();
const loading = ref(false);
const snapshot = ref<ConfigSnapshot | null>(null);
const trees = ref<Array<Record<string, unknown>>>([]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const snap = await gateway.request<ConfigSnapshot>("config.get", {});
    snapshot.value = snap;
    const cfg = snap?.config as Record<string, unknown> | undefined;
    const list = (cfg?.worktrees ?? []) as Array<Record<string, unknown>>;
    trees.value = Array.isArray(list) ? list : [];
  } catch {
    trees.value = [];
  }
  loading.value = false;
}

onMounted(load);

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "-";
  return String(v);
}
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">工作树</h2>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>

    <div v-if="!loading && trees.length === 0" class="empty-hint">
      当前没有配置的工作树。可在 <code class="mono">config.worktrees</code> 下添加。
    </div>

    <ul v-else class="tree-list">
      <li v-for="(t, i) in trees" :key="i" class="tree-row wb-card">
        <div class="tree-row-head">
          <span class="tree-name">{{ asString(t.name ?? t.id ?? `tree-${i}`) }}</span>
          <el-tag v-if="t.branch" size="small" type="info">{{ asString(t.branch) }}</el-tag>
          <el-tag v-if="t.commit" size="small">{{ asString((t.commit as string)?.slice(0, 8)) }}</el-tag>
        </div>
        <div class="tree-row-body">
          <div v-if="t.path" class="kv"><span class="lbl">路径</span><span class="mono">{{ asString(t.path) }}</span></div>
          <div v-if="t.agentId" class="kv"><span class="lbl">绑定智能体</span><span>{{ asString(t.agentId) }}</span></div>
          <div v-if="t.description" class="kv"><span class="lbl">说明</span><span>{{ asString(t.description) }}</span></div>
        </div>
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
.tree-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tree-row {
  padding: 12px 16px;
}
.tree-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.tree-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--wb-text-primary);
}
.tree-row-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-text-secondary);
}
.kv {
  display: flex;
  gap: 12px;
}
.lbl {
  min-width: 80px;
  color: var(--wb-text-tertiary);
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 32px;
  text-align: center;
}
</style>