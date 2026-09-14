<script setup lang="ts">
/**
 * SkillWorkshop 视图 — 对应 ui/src/pages/skill-workshop/ 的最小 Vue 3 版本。
 * RPC: skills.proposals.list / inspect / apply / reject。
 */
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";

interface SkillProposal {
  id?: string;
  proposalId?: string;
  agentId?: string;
  title?: string;
  summary?: string;
  status?: string;
  createdAtMs?: number;
  filesChanged?: string[];
}

const gateway = useGatewayStore();
const loading = ref(false);
const busyKey = ref<string | null>(null);
const agentId = ref<string>("");
const proposals = ref<SkillProposal[]>([]);
const detail = ref<Record<string, unknown> | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await gateway.request<{ proposals?: SkillProposal[] }>("skills.proposals.list", agentId.value ? { agentId: agentId.value } : {});
    proposals.value = res?.proposals ?? [];
  } catch {
    proposals.value = [];
  }
  loading.value = false;
}

async function inspect(p: SkillProposal): Promise<void> {
  const id = p.proposalId ?? p.id;
  if (!id) return;
  busyKey.value = `inspect-${id}`;
  try {
    const res = await gateway.request<Record<string, unknown>>("skills.proposals.inspect", {
      agentId: p.agentId,
      proposalId: id,
    });
    detail.value = res ?? null;
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    busyKey.value = null;
  }
}

async function apply(p: SkillProposal, accept: boolean): Promise<void> {
  const id = p.proposalId ?? p.id;
  if (!id) return;
  busyKey.value = `${accept ? "apply" : "reject"}-${id}`;
  try {
    await gateway.request(accept ? "skills.proposals.apply" : "skills.proposals.reject", {
      agentId: p.agentId,
      proposalId: id,
    });
    ElMessage.success(accept ? "已应用" : "已驳回");
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    busyKey.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">技能工坊</h2>
      <div class="actions">
        <el-input v-model="agentId" placeholder="智能体 ID（可选）" class="agent-input" />
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </header>

    <div v-if="!loading && proposals.length === 0" class="empty-hint">
      当前没有待处理的技能提案。
    </div>

    <div v-else class="proposal-layout">
      <ul class="proposal-list">
        <li v-for="p in proposals" :key="(p.proposalId ?? p.id) ?? Math.random()" class="proposal-item wb-card">
          <div class="proposal-head">
            <span class="proposal-title">{{ p.title ?? p.proposalId ?? p.id }}</span>
            <el-tag size="small" :type="p.status === 'applied' ? 'success' : 'info'">
              {{ p.status ?? "pending" }}
            </el-tag>
          </div>
          <div class="proposal-body">
            <div v-if="p.summary" class="summary">{{ p.summary }}</div>
            <div v-if="p.filesChanged?.length" class="files">
              涉及 {{ p.filesChanged.length }} 个文件
            </div>
          </div>
          <div class="proposal-actions">
            <el-button size="small" :loading="busyKey === `inspect-${p.proposalId ?? p.id}`" @click="inspect(p)">查看</el-button>
            <el-button size="small" type="success" :loading="busyKey === `apply-${p.proposalId ?? p.id}`" @click="apply(p, true)">应用</el-button>
            <el-button size="small" type="danger" plain :loading="busyKey === `reject-${p.proposalId ?? p.id}`" @click="apply(p, false)">驳回</el-button>
          </div>
        </li>
      </ul>

      <div v-if="detail" class="proposal-detail wb-card">
        <div class="card-title">提案详情</div>
        <pre class="json">{{ JSON.stringify(detail, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.agent-input {
  width: 200px;
}
.proposal-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.proposal-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.proposal-item {
  padding: 12px 14px;
}
.proposal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.proposal-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-primary);
}
.proposal-body {
  font-size: 12px;
  color: var(--wb-text-secondary);
  margin-bottom: 8px;
}
.summary {
  margin-bottom: 4px;
}
.proposal-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-secondary);
  margin-bottom: 8px;
}
.json {
  margin: 0;
  font-size: 12px;
  background: var(--wb-bg-inset);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  padding: 10px 12px;
  max-height: 480px;
  overflow: auto;
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 32px;
  text-align: center;
}
</style>