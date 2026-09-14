<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import type { SessionsUsageResult } from "@/api/types";
import { formatCost, formatCount } from "@/utils/format";

const gateway = useGatewayStore();

const loading = ref(false);
const usage = ref<SessionsUsageResult | null>(null);
const days = ref(30);

const summaryCards = computed(() => [
  { label: "总成本", value: formatCost(usage.value?.totals?.totalCost) },
  { label: "总 Tokens", value: formatCount(usage.value?.totals?.totalTokens) },
  { label: "输入 Tokens", value: formatCount(usage.value?.totals?.inputTokens) },
  { label: "输出 Tokens", value: formatCount(usage.value?.totals?.outputTokens) },
]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    usage.value = await gateway.request<SessionsUsageResult>("sessions.usage", {
      startDate: new Date(Date.now() - days.value * 86_400_000).toISOString().slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    ElMessage.error(`加载用量失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <div class="page-head">
      <h2 class="page-title">用量</h2>
      <div class="head-actions">
        <el-select v-model="days" style="width: 120px" @change="load">
          <el-option label="近 7 天" :value="7" />
          <el-option label="近 30 天" :value="30" />
          <el-option label="近 90 天" :value="90" />
        </el-select>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="stat-grid">
      <div v-for="card in summaryCards" :key="card.label" class="stat-card">
        <div class="stat-card-label">{{ card.label }}</div>
        <div class="stat-card-value">{{ card.value }}</div>
      </div>
    </div>

    <div class="wb-card">
      <div class="wb-card-header">
        <span class="wb-card-title">按模型</span>
      </div>
      <el-table v-loading="loading" :data="usage?.sessions ?? []" size="small">
        <el-table-column prop="provider" label="供应商" min-width="140" />
        <el-table-column prop="model" label="模型" min-width="180" show-overflow-tooltip />
        <el-table-column label="Tokens" width="130" align="right">
          <template #default="{ row }">
            <span class="mono">{{ formatCount(row.totalTokens) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="成本" width="130" align="right">
          <template #default="{ row }">
            <span class="mono">{{ formatCost(row.totalCost) }}</span>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无用量数据" /></template>
      </el-table>
    </div>

    <div v-if="usage?.daily?.length" class="wb-card" style="margin-top: 16px">
      <div class="wb-card-header">
        <span class="wb-card-title">按日</span>
      </div>
      <el-table :data="usage.daily" size="small" max-height="320">
        <el-table-column prop="date" label="日期" width="140" />
        <el-table-column label="Tokens" width="140" align="right">
          <template #default="{ row }">
            <span class="mono">{{ formatCount(row.totals?.totalTokens) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="成本" width="140" align="right">
          <template #default="{ row }">
            <span class="mono">{{ formatCost(row.totals?.totalCost) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.stat-card {
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  padding: 16px 18px;
  box-shadow: var(--wb-shadow-sm);
}

.stat-card-label {
  font-size: 12px;
  color: var(--wb-text-secondary);
  margin-bottom: 8px;
  letter-spacing: 0.02em;
}

.stat-card-value {
  font-size: 22px;
  font-weight: 600;
  color: var(--wb-text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  letter-spacing: -0.01em;
}
</style>