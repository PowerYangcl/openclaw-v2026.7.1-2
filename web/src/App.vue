<script setup lang="ts">
/**
 * 根组件：每次新 tab / 整页刷新都会重新挂载。
 *
 * 三件事必须在 root 做，缺一不可：
 * 1. 主题应用；
 * 2. 触发一次自动连接（登录态来自 sessionStorage —— per-tab、刷新保留；
 *    首次进入时来自 URL `#token=`，见 `stores/settings.ts`）；
 * 3. 监听 `storage` 与 `pageshow`，让：
 *    - 其他 tab 改了 UI 偏好（主题/模型）后当前 tab 能跟上；
 *    - BFCache / 浏览器自带恢复后能重新握手（同一 WebSocket 连接在 BFCache 中可能被回收）。
 *
 * 注意：**不做跨 tab 的登录态同步**。每个 tab 是独立的登录会话（可能是不同上游 token），
 * 互相覆盖会导致「登录报错 + 会话串号」，这正是要避免的。
 */
import { onBeforeUnmount, onMounted } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useSettingsStore } from "@/stores/settings";

const gateway = useGatewayStore();
const settings = useSettingsStore();

/** 跨 tab 共享的 UI 偏好键（localStorage）。 */
const PREFS_KEY = "openclaw.web.prefs.v1";

/** 当前 tab 的 storage 监听器引用，方便 unmount 时清理。 */
let storageHandler: ((e: StorageEvent) => void) | null = null;
/** pageshow 监听器引用。 */
let pageShowHandler: ((e: PageTransitionEvent) => void) | null = null;

/**
 * 跨 tab：仅同步 UI 偏好（localStorage）。
 * `storage` 事件**只**在写入方以外的 tab 触发，写入方本 tab 不会收到。
 */
function onStorageChange(e: StorageEvent): void {
  if (e.key !== PREFS_KEY) return;
  settings.reloadSharedPrefs();
}

/**
 * BFCache（浏览器前进后退缓存）恢复后，WebSocket 可能已被回收，
 * 重新触发一次自动连接确保可用。
 */
function onPageShow(e: PageTransitionEvent): void {
  if (!e.persisted) return;
  void gateway.autoConnect();
}

onMounted(() => {
  settings.applyTheme();
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    settings.applyTheme();
  });
  // 1) 触发自动连接（覆盖 URL token 与 localStorage 两条入口）
  void gateway.autoConnect();
  // 2) 跨 tab 同步
  storageHandler = onStorageChange;
  window.addEventListener("storage", storageHandler);
  // 3) BFCache 恢复
  pageShowHandler = onPageShow;
  window.addEventListener("pageshow", pageShowHandler);
});

onBeforeUnmount(() => {
  if (storageHandler) {
    window.removeEventListener("storage", storageHandler);
    storageHandler = null;
  }
  if (pageShowHandler) {
    window.removeEventListener("pageshow", pageShowHandler);
    pageShowHandler = null;
  }
});
</script>

<template>
  <router-view />
</template>
