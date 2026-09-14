<script setup lang="ts">
/**
 * Config 视图 — 同时承担 `/config` 和 6 个 `/settings/*` 子路由的渲染。
 *
 * 渲染策略：
 *   - 加载 `config.schema` RPC；拿到 schema 后用 SchemaForm 渲染（推荐路径）
 *   - 若 schema 不可用，回退到 JSON 编辑器作为兜底（保证配置始终可编辑）
 *   - 「查看 JSON」按钮：随时切换两种视图
 *
 * RPC: config.get / config.schema / config.set
 */
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import type { ConfigSnapshot, ConfigSchemaResponse } from "@/api/types";
import SchemaForm from "@/components/SchemaForm.vue";

type ConfigPageId =
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "mcp"
  | "infrastructure"
  | "ai-agents";

const props = withDefaults(
  defineProps<{ pageId?: ConfigPageId }>(),
  { pageId: "config" },
);

const gateway = useGatewayStore();

const pageMeta: Record<ConfigPageId, { title: string; group: string; description: string }> = {
  config: { title: "通用设置", group: "基础", description: "整体配置 / 默认值" },
  communications: { title: "通信", group: "集成", description: "通道（IM / Webhook / 邮件）相关参数" },
  appearance: { title: "外观", group: "个性化", description: "主题 / 配色 / 字体" },
  automation: { title: "自动化", group: "扩展", description: "Cron / Hook / 计划任务" },
  mcp: { title: "MCP", group: "扩展", description: "Model Context Protocol 服务" },
  infrastructure: { title: "基础设施", group: "运维", description: "端口 / TLS / 资源限制" },
  "ai-agents": { title: "AI 智能体", group: "基础", description: "默认模型 / fallback / 速率限制" },
};

const loading = ref(false);
const saving = ref(false);
const schemaLoading = ref(false);
const snapshot = ref<ConfigSnapshot | null>(null);
const issues = ref<Array<{ path: string; message: string }>>([]);
const rawJson = ref("");
const formValue = ref<Record<string, unknown>>({});
const schema = ref<Record<string, unknown> | null>(null);
const uiHints = ref<Record<string, unknown>>({});
const schemaVersion = ref<string | null>(null);
const showRaw = ref(false);

const meta = computed(() => pageMeta[props.pageId] ?? pageMeta.config);
const navItems: Array<{ pageId: ConfigPageId; path: string }> = [
  { pageId: "config", path: "/settings/general" },
  { pageId: "communications", path: "/settings/communications" },
  { pageId: "appearance", path: "/settings/appearance" },
  { pageId: "automation", path: "/settings/automation" },
  { pageId: "mcp", path: "/settings/mcp" },
  { pageId: "infrastructure", path: "/settings/infrastructure" },
  { pageId: "ai-agents", path: "/settings/ai-agents" },
];

async function load(): Promise<void> {
  loading.value = true;
  schemaLoading.value = schema.value == null;
  try {
    const [snap, sch] = await Promise.allSettled([
      gateway.request<ConfigSnapshot>("config.get", {}),
      gateway.request<ConfigSchemaResponse>("config.schema", {}),
    ]);
    if (snap.status === "fulfilled" && snap.value) {
      snapshot.value = snap.value;
      issues.value = snap.value.issues ?? [];
      const cfg = (snap.value.config ?? snap.value.parsed ?? {}) as Record<string, unknown>;
      rawJson.value = JSON.stringify(cfg, null, 2);
      formValue.value = JSON.parse(JSON.stringify(cfg));
    } else if (snap.status === "rejected") {
      ElMessage.error(`加载配置失败：${(snap.reason as Error).message}`);
    }
    if (sch.status === "fulfilled" && sch.value) {
      schema.value = (sch.value.schema as Record<string, unknown>) ?? null;
      uiHints.value = (sch.value.uiHints as Record<string, unknown>) ?? {};
      schemaVersion.value = sch.value.version ?? null;
    }
  } finally {
    loading.value = false;
    schemaLoading.value = false;
  }
}

async function saveForm(): Promise<void> {
  saving.value = true;
  try {
    await gateway.request("config.set", { raw: JSON.stringify(formValue.value, null, 2) });
    ElMessage.success("配置已保存");
    await load();
  } catch (err) {
    ElMessage.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    saving.value = false;
  }
}

async function saveJson(): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson.value);
  } catch (err) {
    ElMessage.error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  saving.value = true;
  try {
    await gateway.request("config.set", { raw: JSON.stringify(parsed, null, 2) });
    ElMessage.success("配置已保存");
    await load();
  } catch (err) {
    ElMessage.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    saving.value = false;
  }
}

const hasSchema = computed(() => schema.value && typeof schema.value === "object" && "properties" in (schema.value as object));

watch(() => props.pageId, () => {
  formValue.value = {};
  rawJson.value = "";
  schema.value = null;
  uiHints.value = {};
  void load();
});

onMounted(load);
</script>

<template>
  <div class="config-page">
    <aside class="config-side">
      <h3 class="side-title">配置</h3>
      <nav class="side-nav">
        <router-link
          v-for="item in navItems"
          :key="item.pageId"
          :to="item.path"
          class="side-link"
          :class="{ active: item.pageId === props.pageId }"
        >
          <span class="link-title">{{ pageMeta[item.pageId].title }}</span>
          <span class="link-group">{{ pageMeta[item.pageId].group }}</span>
        </router-link>
      </nav>
    </aside>

    <main class="config-main">
      <header class="page-head">
        <div>
          <h2 class="page-title">{{ meta.title }}</h2>
          <p class="page-desc">{{ meta.description }}</p>
        </div>
        <div class="head-actions">
          <el-button @click="showRaw = !showRaw" :disabled="!hasSchema">
            {{ showRaw ? "表单视图" : "查看 JSON" }}
          </el-button>
          <el-button :loading="loading" @click="load">刷新</el-button>
          <el-button type="primary" :loading="saving" @click="showRaw ? saveJson() : saveForm()">
            保存
          </el-button>
        </div>
      </header>

      <el-descriptions v-if="snapshot" :column="3" size="small" class="meta">
        <el-descriptions-item label="配置文件">{{ snapshot.path ?? "-" }}</el-descriptions-item>
        <el-descriptions-item label="哈希">{{ snapshot.hash ?? "-" }}</el-descriptions-item>
        <el-descriptions-item v-if="schemaVersion" label="Schema 版本">{{ schemaVersion }}</el-descriptions-item>
      </el-descriptions>

      <el-alert v-if="issues.length" type="warning" :closable="false" show-icon class="issues">
        <template #default>
          <div v-for="(issue, index) in issues" :key="index" class="mono">
            {{ issue.path }}：{{ issue.message }}
          </div>
        </template>
      </el-alert>

      <div v-if="!showRaw && hasSchema" class="wb-card">
        <SchemaForm
          :schema="(schema as any)"
          :model-value="formValue"
          :ui-hints="(uiHints as any)"
          @update:model-value="(v: Record<string, unknown>) => (formValue = v)"
        />
      </div>

      <div v-else-if="schemaLoading && !hasSchema" class="wb-card">
        <div class="empty-hint">正在加载 schema…</div>
      </div>

      <div v-else-if="!hasSchema" class="wb-card">
        <div class="empty-hint">
          当前面板没有可用的 schema；只能使用 JSON 编辑器。
        </div>
      </div>

      <div v-if="showRaw || !hasSchema" class="wb-card">
        <el-input
          v-model="rawJson"
          type="textarea"
          :rows="24"
          class="mono editor"
          spellcheck="false"
          placeholder="配置 JSON"
        />
      </div>
    </main>
  </div>
</template>

<style scoped>
.config-page {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 16px;
  min-height: 100%;
}
.config-side {
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  padding: 14px;
  height: fit-content;
}
.side-title {
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--wb-text-tertiary);
  margin: 0 0 10px;
}
.side-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.side-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--wb-radius);
  color: var(--wb-text-primary);
  text-decoration: none;
  font-size: 13px;
}
.side-link:hover {
  background: var(--wb-bg-inset);
}
.side-link.active {
  background: var(--wb-accent-soft);
}
.link-group {
  font-size: 11px;
  color: var(--wb-text-tertiary);
}
.config-main {
  min-width: 0;
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 12px;
}
.page-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}
.page-desc {
  margin: 0;
  font-size: 12px;
  color: var(--wb-text-tertiary);
}
.meta {
  margin-bottom: 12px;
}
.issues {
  margin-bottom: 12px;
}
.editor {
  font-size: 12px;
  line-height: 1.6;
}
.editor :deep(.el-textarea__inner) {
  background: var(--wb-bg-inset);
  border: none !important;
  box-shadow: none !important;
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 32px;
  text-align: center;
}
</style>