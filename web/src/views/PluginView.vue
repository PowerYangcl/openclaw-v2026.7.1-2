<script setup lang="ts">
/**
 * Plugin 视图 — 对应 ui/src/pages/plugin/ 的最小 Vue 3 版本。
 * 列出 hello.controlUiTabs 提供的 tabs；详细渲染交给对应 bundled tab 组件。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";

interface ControlUiTab {
  id: string;
  pluginId?: string;
  label?: string;
  path?: string;
  scope?: "user" | "operator" | "admin";
}

const gateway = useGatewayStore();
const route = useRoute();
const tabs = computed<ControlUiTab[]>(() => {
  const t = (gateway.hello as { controlUiTabs?: ControlUiTab[] } | null)?.controlUiTabs ?? [];
  return Array.isArray(t) ? t : [];
});

const activeTab = computed<ControlUiTab | null>(() => {
  const id = String(route.query.id ?? route.query.tab ?? "");
  if (!id) return null;
  return tabs.value.find((t) => t.id === id) ?? null;
});

const iframeSrc = computed<string | null>(() => activeTab.value?.path ?? null);
const loading = ref(false);

onMounted(async () => {
  if (!gateway.hello) {
    loading.value = true;
    await gateway.waitForConnection(8000).catch(() => {});
    loading.value = false;
  }
});
</script>

<template>
  <div class="page-container">
    <header class="page-header">
      <h2 class="page-title">插件</h2>
    </header>

    <div v-if="tabs.length === 0" class="empty-hint">
      当前没有由插件注册的 Control UI 标签。
    </div>

    <template v-else>
      <div class="tab-bar">
        <el-tag
          v-for="tab in tabs"
          :key="tab.id"
          :type="activeTab?.id === tab.id ? 'primary' : 'info'"
          effect="plain"
        >
          {{ tab.label ?? tab.id }}
        </el-tag>
      </div>

      <div v-if="iframeSrc" class="iframe-wrap">
        <iframe
          :src="iframeSrc"
          class="plugin-iframe"
          sandbox="allow-scripts allow-forms allow-same-origin"
        ></iframe>
      </div>
      <div v-else class="empty-hint">
        选择一个 tab 查看（query: <code class="mono">?id=&lt;tabId&gt;</code>）。
      </div>
    </template>
  </div>
</template>

<style scoped>
.page-header {
  margin-bottom: 16px;
}
.tab-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.iframe-wrap {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  overflow: hidden;
  background: var(--wb-bg-card);
  height: calc(100vh - 220px);
}
.plugin-iframe {
  width: 100%;
  height: 100%;
  border: 0;
}
.empty-hint {
  font-size: 13px;
  color: var(--wb-text-tertiary);
  padding: 32px;
  text-align: center;
}
</style>