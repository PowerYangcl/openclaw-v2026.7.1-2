<script setup lang="ts">
/**
 * Instances 视图 — 对应 ui/src/pages/instances/ 的最小 Vue 3 版本。
 * RPC: system-presence；订阅 gateway presence 事件。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import type { PresenceEntry } from "@/api/types";

const gateway = useGatewayStore();
const loading = ref(false);
const entries = ref<PresenceEntry[]>([]);
const hostsRevealed = ref(false);
let unsubscribe: (() => void) | null = null;

function toggleHosts(): void {
  hostsRevealed.value = !hostsRevealed.value;
}

function mask(value: string | undefined | null): string {
  if (!value || hostsRevealed.value) return value ?? "-";
  return value.slice(0, 4) + "***";
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await gateway.request<{ presence?: PresenceEntry[] }>("system-presence", {});
    entries.value = res?.presence ?? [];
  } catch {
    entries.value = [];
  }
  loading.value = false;
}

onMounted(async () => {
  await load();
  unsubscribe = gateway.onEvent((evt) => {
    if (evt.event !== "presence") return;
    const payload = evt.payload as { presence?: PresenceEntry[] };
    if (payload?.presence) entries.value = payload.presence;
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
});

function fmtAge(ms?: number | null): string {
  if (ms == null) return "-";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s 前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m 前`;
  return `${Math.round(diff / 3_600_000)}h 前`;
}
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">实例</h2>
      <div class="header-actions">
        <el-button text @click="toggleHosts">
          {{ hostsRevealed ? "隐藏" : "显示" }} 主机
        </el-button>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </header>

    <div v-if="!loading && entries.length === 0" class="empty-hint">
      暂无活跃实例。
    </div>

    <div v-else class="instance-grid">
      <div v-for="entry in entries" :key="entry.host ?? Math.random()" class="instance-card wb-card">
        <div class="instance-card-header">
          <span class="instance-host mono">{{ mask(entry.host) }}</span>
          <el-tag size="small" :type="entry.mode === 'operator' ? 'success' : 'info'">
            {{ entry.mode }}
          </el-tag>
        </div>
        <div class="instance-card-body">
          <div v-if="entry.ip" class="row"><span class="lbl">IP</span><span class="mono">{{ mask(entry.ip) }}</span></div>
          <div v-if="entry.roles?.length" class="row">
            <span class="lbl">角色</span>
            <span class="mono">{{ entry.roles.join(", ") }}</span>
          </div>
          <div v-if="entry.platform" class="row">
            <span class="lbl">平台</span>
            <span class="mono">{{ entry.platform }}</span>
          </div>
          <div v-if="entry.version" class="row">
            <span class="lbl">版本</span>
            <span class="mono">{{ entry.version }}</span>
          </div>
          <div class="row">
            <span class="lbl">最后心跳</span>
            <span>{{ fmtAge(entry.ts) }}</span>
          </div>
        </div>
      </div>
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
.header-actions {
  display: flex;
  gap: 8px;
}
.instance-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.instance-card {
  padding: 14px 16px;
}
.instance-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.instance-host {
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-primary);
}
.instance-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-text-secondary);
}
.row {
  display: flex;
  gap: 8px;
}
.lbl {
  min-width: 60px;
  color: var(--wb-text-tertiary);
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 32px;
  text-align: center;
}
</style>