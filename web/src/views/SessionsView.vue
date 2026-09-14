<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import type { GatewaySessionRow, SessionsListResult } from "@/api/types";
import { formatCost, formatCount, formatRelative } from "@/utils/format";

const gateway = useGatewayStore();
const router = useRouter();

const loading = ref(false);
const rows = ref<GatewaySessionRow[]>([]);
const search = ref("");
const showArchived = ref(false);
const total = ref(0);

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  if (!keyword) return rows.value;
  return rows.value.filter((row) =>
    [row.key, row.displayName, row.label, row.model].some(
      (field) => typeof field === "string" && field.toLowerCase().includes(keyword),
    ),
  );
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await gateway.request<SessionsListResult>("sessions.list", {
      limit: 100,
      includeGlobal: true,
      includeUnknown: true,
      ...(showArchived.value ? { archived: true } : {}),
    });
    rows.value = result?.sessions ?? [];
    total.value = result?.totalCount ?? rows.value.length;
  } catch (err) {
    ElMessage.error(`加载会话失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loading.value = false;
  }
}

async function handleDelete(row: GatewaySessionRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除会话「${row.displayName || row.key}」？`, "删除会话", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  try {
    await gateway.request("sessions.delete", { key: row.key, deleteTranscript: true });
    ElMessage.success("已删除");
    await load();
  } catch (err) {
    ElMessage.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleArchive(row: GatewaySessionRow): Promise<void> {
  try {
    await gateway.request("sessions.patch", { key: row.key, archived: true });
    ElMessage.success("已归档");
    await load();
  } catch (err) {
    ElMessage.error(`归档失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
// 「归档」按钮目前在模板里被注释掉了（见下方 el-table-column），函数暂时无引用。
// 保留实现以免恢复按钮时又要重写；这里显式引用一次让 vue-tsc 的 TS6133（未使用）闭嘴。
void handleArchive;

function openChat(row: GatewaySessionRow): void {
  gateway.sessionKey = row.key;
  void router.push({ name: "chat", query: { session: row.key } });
}

function statusType(status?: string): "success" | "danger" | "warning" | "info" {
  switch (status) {
    case "done":
      return "success";
    case "failed":
    case "killed":
    case "timeout":
      return "danger";
    case "running":
      return "warning";
    default:
      return "info";
  }
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <div class="page-head">
      <h2 class="page-title">会话</h2>
      <span class="total mono">共 {{ total }} 条</span>
    </div>

    <div class="toolbar">
      <el-input v-model="search" placeholder="搜索 key / 名称 / 模型" clearable style="width: 260px" />
      <el-checkbox v-model="showArchived" label="显示已归档" @change="load" />
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <div class="wb-card">
      <el-table v-loading="loading" :data="filtered" size="small">
        <el-table-column prop="displayName" label="名称" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <span>{{ row.displayName || row.label || row.key }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="key" label="Key" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="mono">{{ row.key }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="model" label="模型" width="160" show-overflow-tooltip />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small" effect="light">
              {{ row.status ?? (row.hasActiveRun ? "running" : "-") }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Tokens" width="120" align="right">
          <template #default="{ row }">
            <span class="mono">{{ formatCount(row.totalTokens) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="成本" width="110" align="right">
          <template #default="{ row }">
            <span class="mono">{{ formatCost(row.estimatedCostUsd) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="更新" width="130">
          <template #default="{ row }">
            <span>{{ formatRelative(row.updatedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openChat(row)">打开</el-button>
            <!-- <el-button link type="info" size="small" @click="handleArchive(row)">归档</el-button> -->
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无会话" />
        </template>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.total {
  font-size: 12px;
  color: var(--wb-text-secondary);
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
}
</style>