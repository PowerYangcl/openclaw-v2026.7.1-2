<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import type { AgentsListResult } from "@/api/types";

const gateway = useGatewayStore();

const loading = ref(false);
const result = ref<AgentsListResult | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    result.value = await gateway.request<AgentsListResult>("agents.list", {});
  } catch (err) {
    ElMessage.error(`加载智能体失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <div class="page-head">
      <h2 class="page-title">智能体</h2>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-descriptions v-if="result" :column="3" size="small" class="meta">
      <el-descriptions-item label="默认">{{ result.defaultId }}</el-descriptions-item>
      <el-descriptions-item label="主 Key">{{ result.mainKey }}</el-descriptions-item>
      <el-descriptions-item label="作用域">{{ result.scope }}</el-descriptions-item>
    </el-descriptions>

    <div class="wb-card">
      <el-table v-loading="loading" :data="result?.agents ?? []" size="small">
        <el-table-column prop="id" label="ID" min-width="180">
          <template #default="{ row }"><span class="mono">{{ row.id }}</span></template>
        </el-table-column>
        <el-table-column label="名称" min-width="160">
          <template #default="{ row }">
            <span>{{ row.emoji ? `${row.emoji} ` : "" }}{{ row.name || row.id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="默认" width="80" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.isDefault" type="success" size="small" effect="light">默认</el-tag>
            <span v-else class="text-tertiary">-</span>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无智能体" /></template>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.meta {
  margin-bottom: 12px;
}
</style>