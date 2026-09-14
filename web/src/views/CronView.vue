<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import type { CronJob, CronJobsListResult, CronStatus } from "@/api/types";
import { formatDuration, formatRelative, formatTime } from "@/utils/format";

const gateway = useGatewayStore();

const loading = ref(false);
const jobs = ref<CronJob[]>([]);
const status = ref<CronStatus | null>(null);

function describeSchedule(job: CronJob): string {
  const schedule = job.schedule;
  if (!schedule) return "-";
  switch (schedule.kind) {
    case "at":
      return `一次性 ${formatTime(new Date(schedule.at).getTime())}`;
    case "every":
      return `每 ${formatDuration(schedule.everyMs)}`;
    case "cron":
      return `cron ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    case "on-exit":
      return `退出时 ${schedule.command}`;
    default:
      return "-";
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [listRes, statusRes] = await Promise.all([
      gateway.request<CronJobsListResult>("cron.list", {}),
      gateway.request<CronStatus>("cron.status", {}),
    ]);
    jobs.value = listRes?.jobs ?? [];
    status.value = statusRes ?? null;
  } catch (err) {
    ElMessage.error(`加载定时任务失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loading.value = false;
  }
}

async function runNow(job: CronJob): Promise<void> {
  try {
    await gateway.request("cron.run", { id: job.id });
    ElMessage.success("已触发执行");
    await load();
  } catch (err) {
    ElMessage.error(`执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function toggle(job: CronJob): Promise<void> {
  try {
    await gateway.request("cron.update", { id: job.id, enabled: !job.enabled });
    ElMessage.success(job.enabled ? "已禁用" : "已启用");
    await load();
  } catch (err) {
    ElMessage.error(`操作失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function remove(job: CronJob): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除任务「${job.name}」？`, "删除定时任务", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  try {
    await gateway.request("cron.remove", { id: job.id });
    ElMessage.success("已删除");
    await load();
  } catch (err) {
    ElMessage.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <div class="page-head">
      <h2 class="page-title">定时任务</h2>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-descriptions v-if="status" :column="3" size="small" class="meta">
      <el-descriptions-item label="调度器">
        <el-tag :type="status.enabled ? 'success' : 'info'" size="small" effect="light">
          {{ status.enabled ? "已启用" : "已停用" }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="任务数">{{ status.jobs }}</el-descriptions-item>
      <el-descriptions-item label="下次唤醒">
        {{ status.nextWakeAtMs ? formatTime(status.nextWakeAtMs) : "-" }}
      </el-descriptions-item>
    </el-descriptions>

    <div class="wb-card">
      <el-table v-loading="loading" :data="jobs" size="small">
        <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
        <el-table-column label="调度" min-width="180">
          <template #default="{ row }">{{ describeSchedule(row) }}</template>
        </el-table-column>
        <el-table-column label="启用" width="80" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" size="small" @change="toggle(row)" />
          </template>
        </el-table-column>
        <el-table-column label="上次运行" width="130">
          <template #default="{ row }">{{ formatRelative(row.state?.lastRunAtMs) }}</template>
        </el-table-column>
        <el-table-column label="下次运行" width="170">
          <template #default="{ row }">{{ formatTime(row.state?.nextRunAtMs) }}</template>
        </el-table-column>
        <el-table-column label="上次状态" width="110">
          <template #default="{ row }">
            <el-tag
              v-if="row.state?.lastStatus"
              :type="row.state.lastStatus === 'ok' ? 'success' : 'danger'"
              size="small"
              effect="light"
            >
              {{ row.state.lastStatus }}
            </el-tag>
            <span v-else class="text-tertiary">-</span>
          </template>
        </el-table-column>
        <el-table-column label="错误" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.state?.lastError" class="error-text">{{ row.state.lastError }}</span>
            <span v-else class="text-tertiary">-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="runNow(row)">执行</el-button>
            <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无定时任务" /></template>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.meta {
  margin-bottom: 12px;
}

.error-text {
  color: var(--el-color-danger);
}
</style>