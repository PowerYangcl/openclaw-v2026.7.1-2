<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import type { ChannelsStatusSnapshot } from "@/api/types";
import { formatRelative } from "@/utils/format";

const gateway = useGatewayStore();

const loading = ref(false);
const snapshot = ref<ChannelsStatusSnapshot | null>(null);

const channelRows = computed(() => {
  const snap = snapshot.value;
  if (!snap) return [];
  const order = snap.channelOrder?.length ? snap.channelOrder : Object.keys(snap.channels ?? {});
  return order.map((id) => {
    const state = (snap.channels?.[id] ?? {}) as {
      configured?: boolean;
      running?: boolean;
      connected?: boolean;
      lastError?: string | null;
      lastStartAt?: number | null;
      lastInboundAt?: number | null;
      lastOutboundAt?: number | null;
    };
    return {
      id,
      label: snap.channelLabels?.[id] ?? id,
      detailLabel: snap.channelDetailLabels?.[id] ?? "",
      configured: state.configured === true,
      running: state.running === true,
      connected: state.connected === true,
      lastError: state.lastError ?? null,
      lastStartAt: state.lastStartAt ?? null,
      lastInboundAt: state.lastInboundAt ?? null,
      lastOutboundAt: state.lastOutboundAt ?? null,
    };
  });
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    snapshot.value = await gateway.request<ChannelsStatusSnapshot>("channels.status", {});
  } catch (err) {
    ElMessage.error(`加载通道状态失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <div class="page-head">
      <h2 class="page-title">通道</h2>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-alert
      v-if="snapshot?.warnings?.length"
      type="warning"
      :closable="false"
      show-icon
      class="warnings"
    >
      <template #default>
        <div v-for="(warning, index) in snapshot.warnings" :key="index">{{ warning }}</div>
      </template>
    </el-alert>

    <div class="wb-card">
      <el-table v-loading="loading" :data="channelRows" size="small">
        <el-table-column prop="label" label="通道" width="140" />
        <el-table-column prop="id" label="ID" width="140">
          <template #default="{ row }"><span class="mono">{{ row.id }}</span></template>
        </el-table-column>
        <el-table-column label="已配置" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.configured ? 'success' : 'info'" size="small" effect="light">
              {{ row.configured ? "是" : "否" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="运行中" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.running ? 'success' : 'info'" size="small" effect="light">
              {{ row.running ? "是" : "否" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="已连接" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.connected ? 'success' : 'danger'" size="small" effect="light">
              {{ row.connected ? "是" : "否" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近入站" width="130">
          <template #default="{ row }">{{ formatRelative(row.lastInboundAt) }}</template>
        </el-table-column>
        <el-table-column label="最近出站" width="130">
          <template #default="{ row }">{{ formatRelative(row.lastOutboundAt) }}</template>
        </el-table-column>
        <el-table-column label="错误" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.lastError" class="error-text">{{ row.lastError }}</span>
            <span v-else class="text-tertiary">-</span>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无通道数据" /></template>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.warnings {
  margin-bottom: 12px;
}

.error-text {
  color: var(--el-color-danger);
}
</style>