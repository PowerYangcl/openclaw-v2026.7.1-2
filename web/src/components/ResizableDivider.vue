<script setup lang="ts">
/**
 * 可拖拽分隔条（移植自 `ui/src/components/resizable-divider.ts`）。
 *
 * 语义与旧版保持一致：
 * - `orientation="vertical"`（默认）= **竖直的条**，左右拖动，`cursor: col-resize`；
 * - `orientation="horizontal"` = **水平的条**，上下拖动，`cursor: row-resize`。
 *
 * 比例是**相对相邻两个兄弟节点**算的（`previousElementSibling` / `nextElementSibling`），
 * 不是相对整个容器 —— 一列里可能有 N 个窗格，拖动第 i 条只应重新分配第 i/i+1 两个窗格，
 * 用容器尺寸会因为「容器大、被拖的一对小」而手感迟钝（旧版注释里写明这点）。
 *
 * 键盘可达：方向键 ±0.02（Shift ±0.05），Home/End 到 min/max。
 */
import { computed, onBeforeUnmount, ref } from "vue";

const props = withDefaults(
  defineProps<{
    /** `vertical` = 竖直分隔条（左右拖）；`horizontal` = 水平分隔条（上下拖）。 */
    orientation?: "vertical" | "horizontal";
    splitRatio?: number;
    minRatio?: number;
    maxRatio?: number;
    label?: string;
  }>(),
  {
    orientation: "vertical",
    splitRatio: 0.5,
    minRatio: 0.15,
    maxRatio: 0.85,
    label: "调整拆分比例",
  },
);

const emit = defineEmits<{
  (e: "resize", payload: { splitRatio: number }): void;
}>();

const elRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
let startPosition = 0;
let startRatio = 0;

const isHorizontal = computed(() => props.orientation === "horizontal");

function clampRatio(value: number): number {
  return Math.max(props.minRatio, Math.min(props.maxRatio, value));
}

function toAriaValue(value: number): number {
  return Math.round(value * 100);
}

function emitResize(nextRatio: number): void {
  emit("resize", { splitRatio: clampRatio(nextRatio) });
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const el = elRef.value;
  if (!el) return;

  dragging.value = true;
  startPosition = isHorizontal.value ? event.clientY : event.clientX;
  startRatio = props.splitRatio;
  el.focus();
  try {
    el.setPointerCapture(event.pointerId);
  } catch {
    // 部分环境不支持 pointer capture，退化为 document 级监听（下面已加）
  }
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", stopDragging);
  document.addEventListener("pointercancel", stopDragging);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return;
  const el = elRef.value;
  const container = el?.parentElement;
  if (!el || !container) return;

  const previousBounds = (el.previousElementSibling as HTMLElement | null)?.getBoundingClientRect();
  const nextBounds = (el.nextElementSibling as HTMLElement | null)?.getBoundingClientRect();
  const containerBounds = container.getBoundingClientRect();
  const containerSize = isHorizontal.value
    ? (previousBounds?.height ?? 0) + (nextBounds?.height ?? 0) || containerBounds.height
    : (previousBounds?.width ?? 0) + (nextBounds?.width ?? 0) || containerBounds.width;
  if (!containerSize) return;

  const position = isHorizontal.value ? event.clientY : event.clientX;
  emitResize(startRatio + (position - startPosition) / containerSize);
}

function stopDragging(): void {
  if (!dragging.value) return;
  dragging.value = false;
  document.removeEventListener("pointermove", onPointerMove);
  document.removeEventListener("pointerup", stopDragging);
  document.removeEventListener("pointercancel", stopDragging);
}

function onKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 0.05 : 0.02;
  let nextRatio: number | null = null;
  const decreaseKey = isHorizontal.value ? "ArrowUp" : "ArrowLeft";
  const increaseKey = isHorizontal.value ? "ArrowDown" : "ArrowRight";

  if (event.key === decreaseKey) {
    nextRatio = props.splitRatio - step;
  } else if (event.key === increaseKey) {
    nextRatio = props.splitRatio + step;
  } else if (event.key === "Home") {
    nextRatio = props.minRatio;
  } else if (event.key === "End") {
    nextRatio = props.maxRatio;
  }

  if (nextRatio === null) return;
  event.preventDefault();
  emitResize(nextRatio);
}

onBeforeUnmount(stopDragging);
</script>

<template>
  <div
    ref="elRef"
    class="resizable-divider"
    :class="[`resizable-divider--${orientation}`, { 'is-dragging': dragging }]"
    role="separator"
    tabindex="0"
    :aria-orientation="orientation"
    :aria-label="label"
    :aria-valuemin="toAriaValue(minRatio)"
    :aria-valuemax="toAriaValue(maxRatio)"
    :aria-valuenow="toAriaValue(splitRatio)"
    @pointerdown="onPointerDown"
    @keydown="onKeydown"
  />
</template>

<style scoped>
.resizable-divider {
  flex-shrink: 0;
  position: relative;
  background: var(--wb-border);
  transition: background 150ms ease-out;
  touch-action: none;
  user-select: none;
}

/* 命中区比视觉区宽 8px：4px 的条太细，直接拖会「抓不住」。 */
.resizable-divider::before {
  content: "";
  position: absolute;
}

.resizable-divider:hover,
.resizable-divider.is-dragging,
.resizable-divider:focus-visible {
  background: var(--wb-accent);
}

.resizable-divider:focus-visible {
  outline: 2px solid var(--wb-accent);
  outline-offset: 2px;
}

.resizable-divider--vertical {
  width: 4px;
  cursor: col-resize;
}

.resizable-divider--vertical::before {
  top: 0;
  bottom: 0;
  left: -4px;
  right: -4px;
}

.resizable-divider--horizontal {
  height: 4px;
  cursor: row-resize;
}

.resizable-divider--horizontal::before {
  left: 0;
  right: 0;
  top: -4px;
  bottom: -4px;
}
</style>
