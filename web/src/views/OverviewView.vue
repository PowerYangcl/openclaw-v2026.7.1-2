<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import type {
  ChannelsStatusSnapshot,
  CronStatus,
  SessionsListResult,
  SkillStatusReport,
} from "@/api/types";

const gateway = useGatewayStore();

const loading = ref(false);
const stats = ref({
  sessions: 0,
  channels: 0,
  channelsConnected: 0,
  cronJobs: 0,
  skills: 0,
  skillsEligible: 0,
});
const health = ref<Record<string, unknown> | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  const results = await Promise.allSettled([
    gateway.request<SessionsListResult>("sessions.list", { limit: 1 }),
    gateway.request<ChannelsStatusSnapshot>("channels.status", {}),
    gateway.request<CronStatus>("cron.status", {}),
    gateway.request<SkillStatusReport>("skills.status", {}),
    gateway.request<Record<string, unknown>>("health", {}),
  ]);

  const [sessions, channels, cron, skills, healthRes] = results;

  if (sessions.status === "fulfilled") {
    stats.value.sessions = sessions.value?.totalCount ?? sessions.value?.sessions?.length ?? 0;
  }
  if (channels.status === "fulfilled" && channels.value) {
    const snap = channels.value;
    stats.value.channels = snap.channelOrder?.length ?? 0;
    stats.value.channelsConnected = Object.values(snap.channels ?? {}).filter(
      (entry) => (entry as { connected?: boolean } | null)?.connected === true,
    ).length;
  }
  if (cron.status === "fulfilled" && cron.value) {
    stats.value.cronJobs = cron.value.jobs ?? 0;
  }
  if (skills.status === "fulfilled" && skills.value) {
    stats.value.skills = skills.value.skills?.length ?? 0;
    stats.value.skillsEligible = skills.value.skills?.filter((s) => s.eligible).length ?? 0;
  }
  if (healthRes.status === "fulfilled") {
    health.value = healthRes.value ?? null;
  }
  loading.value = false;
}

onMounted(load);

const statsView = [
  { key: "sessions", label: "会话总数", sub: null },
  { key: "channels", label: "通道", sub: (v: typeof stats.value) => `已连接 ${v.channelsConnected}` },
  { key: "cronJobs", label: "定时任务", sub: null },
  { key: "skills", label: "技能", sub: (v: typeof stats.value) => `可用 ${v.skillsEligible}` },
];
</script>

<template>
  <div class="page-container">
    <h2 class="page-title">概览</h2>

    <div class="stat-grid">
      <div v-for="item in statsView" :key="item.key" class="stat-card">
        <div class="stat-card-label">{{ item.label }}</div>
        <div class="stat-card-value">{{ stats[item.key as keyof typeof stats] }}</div>
        <div v-if="item.sub" class="stat-card-sub">{{ item.sub(stats) }}</div>
      </div>
    </div>

    <div class="wb-card info-card">
      <div class="wb-card-header">
        <span class="wb-card-title">连接信息</span>
        <el-button text size="small" @click="load">刷新</el-button>
      </div>
      <div class="wb-card-body">
        <el-descriptions v-if="gateway.hello" :column="2" size="default">
          <el-descriptions-item label="网关地址">{{ gateway.url }}</el-descriptions-item>
          <el-descriptions-item label="协议版本">{{ gateway.hello?.protocol ?? "-" }}</el-descriptions-item>
          <el-descriptions-item label="服务端版本">{{ gateway.hello?.server?.version ?? "-" }}</el-descriptions-item>
          <el-descriptions-item label="连接 ID">{{ gateway.hello?.server?.connId ?? "-" }}</el-descriptions-item>
          <el-descriptions-item label="角色">{{ gateway.hello?.auth?.role ?? "-" }}</el-descriptions-item>
          <el-descriptions-item label="作用域">
            {{ gateway.hello?.auth?.scopes?.join(", ") || "-" }}
          </el-descriptions-item>
        </el-descriptions>
        <div v-else class="empty-hint">等待网关握手…</div>
      </div>
    </div>

    <div v-if="health" class="wb-card info-card">
      <div class="wb-card-header">
        <span class="wb-card-title">健康快照</span>
      </div>
      <div class="wb-card-body">
        <pre class="health-json mono">{{ JSON.stringify(health, null, 2) }}</pre>
      </div>
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
  transition: border-color 0.15s var(--wb-ease), box-shadow 0.15s var(--wb-ease);
}

.stat-card:hover {
  border-color: var(--wb-accent-soft);
}

.stat-card-label {
  font-size: 12px;
  color: var(--wb-text-secondary);
  margin-bottom: 8px;
  letter-spacing: 0.02em;
}

.stat-card-value {
  font-size: 26px;
  font-weight: 600;
  color: var(--wb-text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  letter-spacing: -0.01em;
}

.stat-card-sub {
  font-size: 12px;
  color: var(--wb-text-tertiary);
  margin-top: 4px;
}

.info-card {
  margin-top: 12px;
}

.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 12px 0;
}

.health-json {
  margin: 0;
  max-height: 280px;
  overflow: auto;
  font-size: 12px;
  background: var(--wb-bg-inset);
  padding: 14px 16px;
  border-radius: var(--wb-radius);
  border: 1px solid var(--wb-border);
}
</style>