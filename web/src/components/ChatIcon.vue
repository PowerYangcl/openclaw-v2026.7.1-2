<script setup lang="ts">
/**
 * 旧版 Lit UI 图标（`ui/src/components/icons.ts`）的渲染壳。
 *
 * 只负责「24×24 viewBox + stroke 归一」，图形数据在 `@/utils/chatIcons`。
 * 尺寸由外层 CSS 决定（与旧版一致：`width/height` 写在使用处）。
 */
import { computed } from "vue";
import { CHAT_ICONS, type ChatIconName } from "@/utils/chatIcons";

const props = defineProps<{ name: ChatIconName }>();

const markup = computed(() => CHAT_ICONS[props.name] ?? "");
</script>

<template>
  <!-- 内容来自本仓库内的静态常量（chatIcons.ts），不含任何外部输入 -->
  <svg
    class="chat-icon"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    v-html="markup"
  />
</template>

<style scoped>
/**
 * ⚠️ 必须显式给宽高：`<svg>` 只有 viewBox、没有 width/height 属性时，
 * 浏览器按 replaced element 的默认尺寸（300×150）排版，会把按钮撑爆。
 * 默认 16px，对齐旧版 `.btn svg { width:16px; height:16px }`。
 * 调用方要改尺寸时，用**双类选择器**覆盖（单类会比不过这里的 `.chat-icon`）。
 */
.chat-icon {
  display: block;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5px;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
