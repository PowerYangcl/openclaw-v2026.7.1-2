<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { formatTime } from "@/utils/format";

type LogRow = {
  id: number;
  ts: number;
  event: string;
  payload: string;
};

const gateway = useGatewayStore();

const rows = ref<LogRow[]>([]);
const paused = ref(false);
const keyword = ref("");
const maxRows = 300;
let seq = 0;

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return rows.value;
  return rows.value.filter(
    (row) =>
      row.event.toLowerCase().includes(kw) || row.payload.toLowerCase().includes(kw),
  );
});

let unsubscribe: (() => void) | null = null;

function serialize(payload: unknown): string {
  try {
    const text = JSON.stringify(payload);
    return text && text.length > 600 ? `${text.slice(0, 600)}…` : (text ?? "");
  } catch {
    return String(payload);
  }
}

function clear(): void {
  rows.value = [];
}

onMounted(() => {
  unsubscribe = gateway.onEvent((evt) => {
    if (paused.value) return;
    seq += 1;
    rows.value.unshift({
      id: seq,
      ts: Date.now(),
      event: evt.event,
      payload: serialize(evt.payload),
    });
    if (rows.value.length > maxRows) {
      rows.value.length = maxRows;
    }
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
});
</script>

<template>
  <div class="page-container">
    <div class="page-head">
      <h2 class="page-title">事件日志</h2>
      <div class="head-actions">
        <el-input v-model="keyword" placeholder="过滤事件名 / 内容" clearable style="width: 240px" />
        <el-button @click="paused = !paused">{{ paused ? "继续" : "暂停" }}</el-button>
        <el-button @click="clear">清空</el-button>
      </div>
    </div>

    <el-alert type="info" :closable="false" show-icon class="hint">
      实时监听网关推送事件（最多保留最近 {{ maxRows }} 条）。聊天、会话变更、工具调用等都会出现在此。
    </el-alert>

    <div class="wb-card">
      <el-table :data="filtered" size="small" max-height="calc(100vh - 240px)">
        <el-table-column label="时间" width="180">
          <template #default="{ row }"><span class="mono">{{ formatTime(row.ts) }}</span></template>
        </el-table-column>
        <el-table-column label="事件" width="220">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.event }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="内容" min-width="320" show-overflow-tooltip>
          <template #default="{ row }"><span class="mono payload">{{ row.payload }}</span></template>
        </el-table-column>
        <template #empty><el-empty description="暂无事件" /></template>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.hint {
  margin-bottom: 12px;
}

.payload {
  font-size: 12px;
  color: var(--el-text-color-regular);
}
</style>