<script setup lang="ts">
/**
 * Nodes 视图 — 对应 ui/src/pages/nodes/ 的最小 Vue 3 版本。
 * RPC: node.list, device.pair.list。
 */
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";

interface NodeRow {
  nodeId?: string;
  id?: string;
  displayName?: string;
  name?: string;
  status?: string;
  platform?: string;
  version?: string;
  capabilities?: string[];
  lastSeenMs?: number;
  ip?: string;
}

interface DeviceRow {
  id: string;
  name?: string;
  status?: "pending" | "paired" | "revoked";
  roles?: string[];
  lastSeenMs?: number;
  platform?: string;
  ip?: string;
}

const gateway = useGatewayStore();
const loading = ref(false);
const nodes = ref<NodeRow[]>([]);
const devices = ref<{ pending: DeviceRow[]; paired: DeviceRow[] }>({ pending: [], paired: [] });

async function load(): Promise<void> {
  loading.value = true;
  const results = await Promise.allSettled([
    gateway.request<{ nodes?: NodeRow[] } | NodeRow[]>("node.list", {}),
    gateway.request<{ pending?: DeviceRow[]; paired?: DeviceRow[] }>("device.pair.list", {}),
  ]);
  if (results[0].status === "fulfilled") {
    const v = results[0].value;
    nodes.value = Array.isArray(v) ? v : ((v as { nodes?: NodeRow[] })?.nodes ?? []);
  }
  if (results[1].status === "fulfilled" && results[1].value) {
    devices.value = {
      pending: results[1].value.pending ?? [],
      paired: results[1].value.paired ?? [],
    };
  }
  loading.value = false;
}

async function approve(device: DeviceRow): Promise<void> {
  try {
    await gateway.request("device.pair.approve", { deviceId: device.id });
    ElMessage.success("已批准");
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function reject(device: DeviceRow): Promise<void> {
  try {
    await gateway.request("device.pair.reject", { deviceId: device.id });
    ElMessage.success("已驳回");
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

onMounted(load);

function fmtAge(ms?: number): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function nodeId(n: NodeRow): string {
  return n.nodeId ?? n.id ?? "(无)";
}
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">节点</h2>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>

    <section class="section">
      <h3 class="section-title">连接的节点 ({{ nodes.length }})</h3>
      <div v-if="!loading && nodes.length === 0" class="empty-hint">暂无节点连接。</div>
      <div v-else class="grid">
        <div v-for="n in nodes" :key="nodeId(n)" class="card wb-card">
          <div class="card-head">
            <span class="card-title">{{ n.displayName ?? n.name ?? nodeId(n) }}</span>
            <el-tag size="small" :type="n.status === 'online' ? 'success' : 'info'">
              {{ n.status ?? "unknown" }}
            </el-tag>
          </div>
          <div class="card-body">
            <div class="kv"><span class="lbl">ID</span><span class="mono">{{ nodeId(n) }}</span></div>
            <div v-if="n.platform" class="kv"><span class="lbl">平台</span><span>{{ n.platform }}</span></div>
            <div v-if="n.version" class="kv"><span class="lbl">版本</span><span class="mono">{{ n.version }}</span></div>
            <div v-if="n.capabilities?.length" class="kv">
              <span class="lbl">能力</span>
              <span>{{ n.capabilities.join(", ") }}</span>
            </div>
            <div class="kv"><span class="lbl">最后心跳</span><span>{{ fmtAge(n.lastSeenMs) }}</span></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <h3 class="section-title">待批准设备 ({{ devices.pending.length }})</h3>
      <div v-if="devices.pending.length === 0" class="empty-hint">无。</div>
      <ul v-else class="device-list">
        <li v-for="d in devices.pending" :key="d.id" class="device-row wb-card">
          <div class="device-meta">
            <span class="device-name">{{ d.name ?? d.id }}</span>
            <span class="mono device-id">{{ d.id }}</span>
            <span v-if="d.roles?.length" class="device-roles">{{ d.roles.join(", ") }}</span>
            <span class="device-platform">{{ d.platform ?? "-" }}</span>
          </div>
          <div class="device-actions">
            <el-button size="small" type="success" @click="approve(d)">批准</el-button>
            <el-button size="small" type="danger" plain @click="reject(d)">驳回</el-button>
          </div>
        </li>
      </ul>
    </section>

    <section class="section">
      <h3 class="section-title">已配对设备 ({{ devices.paired.length }})</h3>
      <ul v-if="devices.paired.length" class="device-list">
        <li v-for="d in devices.paired" :key="d.id" class="device-row wb-card">
          <div class="device-meta">
            <span class="device-name">{{ d.name ?? d.id }}</span>
            <span class="mono device-id">{{ d.id }}</span>
            <span v-if="d.roles?.length" class="device-roles">{{ d.roles.join(", ") }}</span>
            <span class="device-platform">{{ d.platform ?? "-" }}</span>
            <span class="device-time">{{ fmtAge(d.lastSeenMs) }}</span>
          </div>
        </li>
      </ul>
      <div v-else class="empty-hint">无。</div>
    </section>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.section {
  margin-bottom: 24px;
}
.section-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-secondary);
  margin-bottom: 10px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.card {
  padding: 12px 14px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-primary);
}
.card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-text-secondary);
}
.kv {
  display: flex;
  gap: 8px;
}
.lbl {
  min-width: 50px;
  color: var(--wb-text-tertiary);
}
.device-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.device-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
}
.device-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.device-name {
  font-weight: 500;
  color: var(--wb-text-primary);
}
.device-id {
  font-size: 12px;
  color: var(--wb-text-tertiary);
}
.device-roles {
  font-size: 12px;
  color: var(--wb-accent-strong);
}
.device-platform {
  font-size: 12px;
  color: var(--wb-text-secondary);
}
.device-time {
  font-size: 11px;
  color: var(--wb-text-tertiary);
}
.device-actions {
  display: flex;
  gap: 6px;
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 12px 0;
}
</style>