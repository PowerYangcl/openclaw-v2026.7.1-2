<script setup lang="ts">
/**
 * 主布局：左侧导航 + 顶部状态条 + 内容区。
 *
 * 视觉对齐 WorkBuddy：
 * - 侧边栏 220px，去掉 Element Plus 默认蓝底
 * - 顶部状态条只保留最小必要的连接状态指示
 */
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { navRoutes } from "@/router";
import { useGatewayStore } from "@/stores/gateway";
import { useSettingsStore } from "@/stores/settings";

const route = useRoute();
const router = useRouter();
const gateway = useGatewayStore();
const settings = useSettingsStore();

const activePath = computed(() => route.path);

const statusKind = computed(() => {
  switch (gateway.phase) {
    case "connected":
      return "ok";
    case "connecting":
    case "reconnecting":
      return "busy";
    case "failed":
      return "err";
    default:
      return "off";
  }
});

const statusText = computed(() => {
  switch (gateway.phase) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "reconnecting":
      return "重连中";
    case "failed":
      return "连接失败";
    default:
      return "未连接";
  }
});

function toggleTheme(): void {
  settings.themeMode = settings.isDark() ? "light" : "dark";
  settings.applyTheme();
}

async function handleDisconnect(): Promise<void> {
  try {
    await ElMessageBox.confirm("确定要断开当前网关连接吗？", "断开连接", {
      type: "warning",
      confirmButtonText: "断开",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  gateway.disconnect();
  sessionStorage.removeItem("openclaw.gateway.ready");
  // 标记本 tab 为「用户主动断开」，阻止 login 页 / App.vue 立刻自动重连；
  // 下次成功握手或下次 sessionStorage 重建（如新 tab）后自动失效。
  sessionStorage.setItem("openclaw.gateway.intentional-disconnect", "1");
  void router.push({ name: "login" });
}
</script>

<template>
  <el-container class="layout">
    <!-- 左侧导航 -->
    <el-aside width="220px" class="layout-aside">
      <div class="brand">
        <span class="brand-mark">AC</span>
        <div class="brand-info">
          <span class="brand-text">AgentClaw</span>
          <span class="brand-sub">控制台</span>
        </div>
      </div>

      <el-menu :default-active="activePath" router class="layout-menu">
        <el-menu-item v-for="item in navRoutes" :key="item.name" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>

      <div class="aside-footer">
        <span class="dot" :class="`dot-${statusKind}`" />
        <span class="aside-footer-text">{{ statusText }}</span>
      </div>
    </el-aside>

    <!-- 右侧主区 -->
    <el-container>
      <el-header height="52px" class="layout-header">
        <div class="header-left">
          <span class="status-dot" :class="`dot-${statusKind}`" />
          <span class="status-text">{{ statusText }}</span>
          <span class="status-divider" />
          <span class="gateway-url mono" :title="gateway.url">{{ gateway.url }}</span>
        </div>
        <div class="header-right">
          <el-tooltip :content="settings.isDark() ? '切换浅色' : '切换深色'" placement="bottom">
            <el-button text class="icon-btn" @click="toggleTheme">
              <el-icon><component :is="settings.isDark() ? 'Sunny' : 'Moon'" /></el-icon>
            </el-button>
          </el-tooltip>
          <el-button text type="danger" @click="handleDisconnect">断开</el-button>
        </div>
      </el-header>

      <el-main class="layout-main">
        <el-alert
          v-if="gateway.lastError && gateway.phase !== 'connected'"
          :title="gateway.lastError"
          type="error"
          :closable="false"
          show-icon
          class="page-container"
          style="margin-bottom: 12px"
        />
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100%;
}

/* ============== 侧边栏 ============== */

.layout-aside {
  border-right: 1px solid var(--wb-border);
  background: var(--wb-bg-card);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.brand {
  height: var(--wb-header-height);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  border-bottom: 1px solid var(--wb-border);
  flex-shrink: 0;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg, #60a5fa, #2563eb);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  box-shadow: 0 2px 6px rgba(37, 99, 235, 0.25);
  flex-shrink: 0;
}

.brand-info {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  min-width: 0;
}

.brand-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text-primary);
  letter-spacing: -0.01em;
}

.brand-sub {
  font-size: 11px;
  color: var(--wb-text-tertiary);
  margin-top: 1px;
}

.layout-menu {
  flex: 1;
  padding: 8px;
  overflow-y: auto;
  background: transparent !important;
}

.layout-menu :deep(.el-menu-item) {
  height: 36px;
  line-height: 36px;
  border-radius: var(--wb-radius-sm);
  margin-bottom: 2px;
  color: var(--wb-text-secondary);
  font-size: 13px;
  padding: 0 10px;
}

.layout-menu :deep(.el-menu-item .el-icon) {
  font-size: 16px;
  margin-right: 8px;
}

.layout-menu :deep(.el-menu-item:hover) {
  background: var(--wb-bg-hover);
  color: var(--wb-text-primary);
}

.layout-menu :deep(.el-menu-item.is-active) {
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  font-weight: 600;
}

.aside-footer {
  flex-shrink: 0;
  padding: 10px 16px;
  border-top: 1px solid var(--wb-border);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--wb-text-secondary);
}

.aside-footer-text {
  font-variant-numeric: tabular-nums;
}

/* ============== 顶栏 ============== */

.layout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-bg-card);
  flex-shrink: 0;
  padding: 0 20px;
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-primary);
}

.status-divider {
  width: 1px;
  height: 14px;
  background: var(--wb-border);
  margin: 0 2px;
}

.gateway-url {
  font-size: 12px;
  color: var(--wb-text-secondary);
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-btn {
  font-size: 16px;
}

/* ============== 状态点 ============== */

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--wb-text-tertiary);
  display: inline-block;
  position: relative;
  flex-shrink: 0;
}

.dot-ok {
  background: #16a34a;
  box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.16);
}

.dot-busy {
  background: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.16);
  animation: pulse 1.4s ease-in-out infinite;
}

.dot-err {
  background: #ef4444;
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.16);
}

.dot-off {
  background: rgba(15, 23, 42, 0.25);
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--wb-text-tertiary);
  display: inline-block;
  position: relative;
}

.status-dot.dot-ok {
  background: #16a34a;
}

.status-dot.dot-busy {
  background: #f59e0b;
  animation: pulse 1.4s ease-in-out infinite;
}

.status-dot.dot-err {
  background: #ef4444;
}

.status-dot.dot-off {
  background: rgba(15, 23, 42, 0.25);
}

/* ============== 主区 ============== */

.layout-main {
  padding: 0;
  background: var(--wb-bg-content);
  overflow-y: auto;
}
</style>