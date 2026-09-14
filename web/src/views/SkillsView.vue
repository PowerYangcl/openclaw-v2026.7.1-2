<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import type { SkillStatusEntry, SkillStatusReport } from "@/api/types";

const gateway = useGatewayStore();

const loading = ref(false);
const report = ref<SkillStatusReport | null>(null);
const keyword = ref("");

const filtered = computed(() => {
  const list = report.value?.skills ?? [];
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return list;
  return list.filter((item) =>
    [item.name, item.description, item.source].some(
      (field) => typeof field === "string" && field.toLowerCase().includes(kw),
    ),
  );
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    report.value = await gateway.request<SkillStatusReport>("skills.status", {});
  } catch (err) {
    ElMessage.error(`加载技能失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loading.value = false;
  }
}

function missingSummary(item: SkillStatusEntry): string {
  const parts: string[] = [];
  if (item.missing.bins?.length) parts.push(`bins: ${item.missing.bins.join(", ")}`);
  if (item.missing.env?.length) parts.push(`env: ${item.missing.env.join(", ")}`);
  if (item.missing.config?.length) parts.push(`config: ${item.missing.config.join(", ")}`);
  if (item.missing.os?.length) parts.push(`os: ${item.missing.os.join(", ")}`);
  return parts.join(" | ") || "-";
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <div class="page-head">
      <h2 class="page-title">技能</h2>
      <div class="head-actions">
        <el-input v-model="keyword" placeholder="搜索技能" clearable style="width: 220px" />
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <el-descriptions v-if="report" :column="2" size="small" class="meta">
      <el-descriptions-item label="工作区">{{ report.workspaceDir }}</el-descriptions-item>
      <el-descriptions-item label="托管目录">{{ report.managedSkillsDir }}</el-descriptions-item>
    </el-descriptions>

    <div class="wb-card">
      <el-table v-loading="loading" :data="filtered" size="small">
        <el-table-column label="技能" min-width="180">
          <template #default="{ row }">
            <span>{{ row.emoji ? `${row.emoji} ` : "" }}{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="240" show-overflow-tooltip />
        <el-table-column prop="source" label="来源" width="110" />
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag v-if="row.disabled" type="info" size="small" effect="light">已禁用</el-tag>
            <el-tag v-else-if="row.blockedByAllowlist" type="warning" size="small" effect="light">被白名单阻断</el-tag>
            <el-tag v-else-if="row.eligible" type="success" size="small" effect="light">可用</el-tag>
            <el-tag v-else type="danger" size="small" effect="light">不满足依赖</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="缺失依赖" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="mono">{{ missingSummary(row) }}</span>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无技能" /></template>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.meta {
  margin-bottom: 12px;
}
</style>