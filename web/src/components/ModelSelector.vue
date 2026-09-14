<script setup lang="ts">
/**
 * 模型选择器（仿 WorkBuddy 风格）。
 *
 * 接收 `models`（已聚合的可用模型列表），点击触发器展开下拉面板，
 * 点击外部或 Esc 关闭。`v-model` 双向绑定当前选中的模型 key（格式 "provider/modelId"），
 * 空串代表「使用默认」。
 *
 * 设计参考 WorkBuddy 模型选择器：
 * - 紧凑胶囊触发器（与 composer-box 圆角一致）
 * - 弹出面板带阴影 + 圆角 + 分组
 * - 选中项左侧蓝色圆点标识
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

export type ModelOption = {
  /** 完整 key，格式 "provider/modelId"，作为 v-model 值 */
  key: string;
  /** 展示名称（一般是 modelId，去前缀） */
  label: string;
  /** 供应商（用于分组与二级文本） */
  provider: string;
  /** 上下文窗口（tokens），可选 */
  contextWindow?: number;
  /** 是否支持推理（thinking），用于打标 */
  reasoning?: boolean;
  /** 数据来源：来自后端目录 / 历史用量 */
  source: "catalog" | "history";
};

const props = defineProps<{
  modelValue: string;
  models: ModelOption[];
  /**
   * 网关侧生效的默认模型 key（`"provider/modelId"`）。
   * 仅在 `modelValue` 为空（= 使用默认模型）时用于把标签渲染成真实模型名，
   * 而不是干巴巴的「默认模型」。
   */
  defaultKey?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const open = ref(false);
/** el-button 的 ref 拿到的是组件实例而非 DOM 元素，所以外层包一个 span 拿 trigger 的真实位置。 */
const triggerWrapRef = ref<HTMLSpanElement | null>(null);
const panelRef = ref<HTMLDivElement | null>(null);
const search = ref("");
const searchInputRef = ref<HTMLInputElement | null>(null);
const panelStyle = ref<{ left: string; top: string }>({ left: "0px", top: "0px" });

const grouped = computed(() => {
  const filter = search.value.trim().toLowerCase();
  const buckets = new Map<string, ModelOption[]>();
  for (const m of props.models) {
    if (filter) {
      const hay = `${m.label} ${m.provider} ${m.key}`.toLowerCase();
      if (!hay.includes(filter)) continue;
    }
    if (!buckets.has(m.provider)) buckets.set(m.provider, []);
    buckets.get(m.provider)!.push(m);
  }
  return Array.from(buckets.entries()).map(([provider, items]) => ({ provider, items }));
});

/** 从 key 里取出 `modelId` / `provider` 两段（key 形如 "provider/modelId"）。 */
function splitKey(key: string): { provider: string; model: string } {
  const idx = key.indexOf("/");
  if (idx <= 0 || idx === key.length - 1) return { provider: "", model: key };
  return { provider: key.slice(0, idx), model: key.slice(idx + 1) };
}

/** 默认模型在列表里的展示名（没查到就退化成 key 的 modelId 段）。 */
const defaultLabel = computed<string>(() => {
  const key = props.defaultKey?.trim() ?? "";
  if (!key) return "";
  const found = props.models.find((x) => x.key === key);
  return found?.label ?? splitKey(key).model;
});

const currentLabel = computed(() => {
  const m = props.models.find((x) => x.key === props.modelValue);
  if (m) return m.label;
  if (props.modelValue) return props.modelValue;
  // 未显式选择 → 展示网关实际生效的默认模型名，而非空泛的「默认模型」
  return defaultLabel.value || "默认模型";
});

const currentProvider = computed(() => {
  const m = props.models.find((x) => x.key === props.modelValue);
  if (m?.provider) return m.provider;
  if (props.modelValue) return splitKey(props.modelValue).provider;
  const key = props.defaultKey?.trim() ?? "";
  return key ? splitKey(key).provider : "";
});

function toggle(): void {
  if (props.disabled) return;
  open.value = !open.value;
}

function close(): void {
  open.value = false;
  search.value = "";
}

function pick(key: string): void {
  emit("update:modelValue", key);
  close();
}

function pickDefault(): void {
  emit("update:modelValue", "");
  close();
}

function positionPanel(): void {
  const el = triggerWrapRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const panelWidth = 320;
  const margin = 12;
  // 默认贴左对齐，按视口右边界做翻转
  let left = rect.left;
  if (left + panelWidth + margin > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - panelWidth - margin);
  }
  // 面板高度不再固定（底部脚注已移除）：优先量实际高度，量不到时按 340 估算
  const measured = panelRef.value?.getBoundingClientRect().height ?? 0;
  const panelHeight = measured > 0 ? measured : 340;
  // 优先贴触发器上方；上方不够贴下方；上下都不够则顶到上边距，由列表区自行滚动
  let top = rect.top - panelHeight - 8;
  if (top < margin) {
    top = rect.bottom + 8;
  }
  const maxTop = window.innerHeight - margin - panelHeight;
  if (top > maxTop) {
    top = Math.max(margin, maxTop);
  }
  panelStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
  };
}

watch(open, async (next) => {
  if (next) {
    await nextTick();
    positionPanel();
    searchInputRef.value?.focus();
  }
});

function onDocClick(e: MouseEvent): void {
  if (!open.value) return;
  const target = e.target as Node;
  if (triggerWrapRef.value?.contains(target)) return;
  if (panelRef.value?.contains(target)) return;
  close();
}

function onDocKeydown(e: KeyboardEvent): void {
  if (!open.value) return;
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function onWindowChange(): void {
  if (open.value) positionPanel();
}

onMounted(() => {
  document.addEventListener("mousedown", onDocClick);
  document.addEventListener("keydown", onDocKeydown);
  window.addEventListener("resize", onWindowChange);
  window.addEventListener("scroll", onWindowChange, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocClick);
  document.removeEventListener("keydown", onDocKeydown);
  window.removeEventListener("resize", onWindowChange);
  window.removeEventListener("scroll", onWindowChange, true);
});

function formatContext(tokens?: number): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}
</script>

<template>
  <div class="model-selector">
    <span ref="triggerWrapRef" class="model-trigger-wrap">
      <el-button
        class="model-trigger"
        :class="{ open, disabled }"
        :disabled="disabled"
        round
        @click="toggle"
      >
      <span class="trigger-glyph" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4" />
          <circle cx="8" cy="8" r="1.2" fill="currentColor" />
        </svg>
      </span>
      <span class="trigger-text">
        <span class="trigger-label">{{ currentLabel }}</span>
        <span v-if="currentProvider" class="trigger-provider">{{ currentProvider }}</span>
      </span>
      <span class="trigger-caret" :class="{ rotated: open }" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="10" height="10">
          <path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </el-button>
    </span>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="model-panel"
        role="listbox"
        :style="panelStyle"
      >
        <div class="model-panel-head">
          <span class="panel-title">选择模型</span>
          <el-button
            class="panel-close"
            text
            circle
            aria-label="关闭"
            @click="close"
          >
            <svg viewBox="0 0 12 12" width="10" height="10">
              <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </el-button>
        </div>

        <div class="model-panel-search">
          <span class="search-icon" aria-hidden="true">
            <svg viewBox="0 0 14 14" width="12" height="12">
              <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.4" />
              <path d="M9 9 L12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </span>
          <input
            ref="searchInputRef"
            v-model="search"
            class="search-input"
            type="text"
            placeholder="搜索模型名或供应商"
            spellcheck="false"
          />
        </div>

        <div class="model-panel-body">
          <el-button
            class="model-item model-item-default"
            :class="{ active: modelValue === '' }"
            text
            @click="pickDefault"
          >
            <span class="item-dot" />
            <span class="item-main">
              <span class="item-label-row">
                <span class="item-label">使用默认模型</span>
                <span v-if="modelValue === '' && defaultLabel" class="item-tag">
                  {{ defaultLabel }}
                </span>
              </span>
              <span class="item-meta">
                <span v-if="defaultKey">{{ defaultKey }}</span>
                <span v-else>由网关自动选择</span>
              </span>
            </span>
            <span v-if="modelValue === ''" class="item-check" aria-hidden="true">
              <svg viewBox="0 0 12 12" width="12" height="12">
                <path d="M2.5 6.5 L5 9 L9.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
          </el-button>

          <div v-if="!grouped.length" class="model-empty">
            暂无可用模型，可继续发送，网关会按默认模型回复。
          </div>

          <div v-for="group in grouped" :key="group.provider" class="model-group">
            <div class="group-title">{{ group.provider }}</div>
            <el-button
              v-for="m in group.items"
              :key="m.key"
              class="model-item"
              :class="{ active: modelValue === m.key }"
              text
              @click="pick(m.key)"
            >
              <span class="item-dot" />
              <span class="item-main">
                <span class="item-label-row">
                  <span class="item-label">{{ m.label }}</span>
                  <span v-if="m.reasoning" class="item-tag">推理</span>
                </span>
                <span class="item-meta">
                  <span>{{ m.key }}</span>
                  <span v-if="m.contextWindow" class="item-meta-ctx">{{ formatContext(m.contextWindow) }} ctx</span>
                </span>
              </span>
              <span v-if="modelValue === m.key" class="item-check" aria-hidden="true">
                <svg viewBox="0 0 12 12" width="12" height="12">
                  <path d="M2.5 6.5 L5 9 L9.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
            </el-button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
  display: inline-flex;
}

/* 包裹 span：用 el-button 时拿 ref 拿到的是组件实例，
   在外层包一个 span 拿真实 DOM 位置给弹窗定位用。 */
.model-trigger-wrap {
  display: inline-flex;
  align-items: center;
}

.model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--wb-border);
  background: var(--wb-bg-card-strong);
  color: var(--wb-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s var(--wb-ease);
  max-width: 220px;
  user-select: none;
  height: auto;
}
/* el-button 默认 padding/font 会把触发器撑高，强制压回与发送按钮一致的尺寸 = 34px。
   注意：el-button 内部的 slot 包裹 span 由组件自身渲染，**不带 scoped 属性**，
   直接写 `.model-trigger.el-button > span` 永远命中不了，必须走 :deep()。 */
.model-trigger.el-button {
  padding: 6px 8px 6px 10px;
  font-size: 12px;
  height: 34px;
}
.model-selector :deep(.model-trigger.el-button > span) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.model-trigger:hover:not(.disabled) {
  border-color: var(--wb-accent);
  color: var(--wb-text-primary);
  background: var(--wb-bg-card);
}

.model-trigger.open {
  border-color: var(--wb-accent);
  background: var(--wb-accent-softer);
  color: var(--wb-accent-strong);
}

.model-trigger.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.trigger-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 6px;
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  flex-shrink: 0;
}

.trigger-text {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.15;
  min-width: 0;
}

.trigger-label {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

.trigger-provider {
  font-size: 10px;
  color: var(--wb-text-tertiary);
  font-family: "SFMono-Regular", "SF Mono", Consolas, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

.trigger-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--wb-text-tertiary);
  transition: transform 0.18s var(--wb-ease);
}

.trigger-caret.rotated {
  transform: rotate(180deg);
  color: var(--wb-accent-strong);
}

.model-panel {
  position: fixed;
  z-index: 3000;
  width: 320px;
  /* 弹窗上下左右内边距统一 16px */
  padding: 16px;
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  box-shadow: var(--wb-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: modelPanelIn 0.16s var(--wb-ease);
}

@keyframes modelPanelIn {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.model-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* 外层已统一 16px 内边距，这里只负责标题与下方内容的间距 */
  padding: 0 0 12px;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text-primary);
}

.panel-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  color: var(--wb-text-tertiary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s var(--wb-ease);
}
.panel-close.el-button {
  border: none;
  padding: 0;
}
/* 同 .model-item：面板被 teleport 到 body，不能带 .model-selector 前缀 */
:deep(.panel-close.el-button > span) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.panel-close:hover {
  background: var(--wb-bg-hover);
  color: var(--wb-text-primary);
}

.model-panel-search {
  position: relative;
  margin: 0 0 12px;
  display: flex;
  align-items: center;
  background: var(--wb-bg-card-strong);
  border: 1px solid var(--wb-border);
  border-radius: 8px;
  padding: 0 10px;
  height: 30px;
  transition: border-color 0.15s var(--wb-ease), box-shadow 0.15s var(--wb-ease);
}

.model-panel-search:focus-within {
  border-color: var(--wb-accent);
  box-shadow: 0 0 0 3px var(--wb-accent-soft);
}

.search-icon {
  display: inline-flex;
  color: var(--wb-text-tertiary);
  flex-shrink: 0;
  margin-right: 6px;
}

.search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--wb-text-primary);
  font-size: 12px;
  height: 28px;
}

.search-input::placeholder {
  color: var(--wb-text-tertiary);
}

/* 列表区：外层已统一 16px 内边距，这里只保留滚动与行距（16px）。 */
.model-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  display: flex;
  flex-direction: column;
  /* 行距 16px */
  gap: 16px;
  max-height: min(320px, calc(100vh - 180px));
  overscroll-behavior: contain;
}

.model-empty {
  padding: 20px 12px;
  font-size: 12px;
  color: var(--wb-text-tertiary);
  text-align: center;
  line-height: 1.6;
}

/* 分组内也是行距 16px（组与组之间的间距由 model-panel-body 的 gap 提供） */
.model-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.group-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--wb-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 10px;
}

.model-item {
  width: 100%;
  display: flex;
  align-items: center;
  /* 圆点 ↔ 右侧内容（item-main / item-check）间距 10px */
  gap: 10px;
  padding: 6px 10px;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--wb-text-primary);
  transition: background 0.12s var(--wb-ease);
  justify-content: flex-start;
  margin: 0;
}
/* el-button 默认会插入 span 包内容并居中、占满宽。需要重置为 flex-row 排版。
   注意与 .model-trigger 同一个坑：el-button 内层 slot span 由组件渲染、**不带 scoped 属性**，
   裸写 `.model-item.el-button > span` 命中不了，必须走 :deep()。
   `display: contents` 让 dot / main / check 直接成为 .model-item 的 flex 子项，
   这样容器上的 gap 与 .item-check 的 margin-left:auto 才生效。

   ⚠️ 这里**不能**加 `.model-selector` 祖先前缀：面板是通过 <Teleport to="body"> 挂到 body 上的，
   DOM 里并不在 `.model-selector` 内部，带前缀的选择器永远匹配不到。
   `:deep(X)` 编译成 `[data-v-x] X`，`[data-v-x]` 由面板根节点 `.model-panel` 承担即可。 */
.model-item.el-button {
  border: none;
  font-size: 13px;
  padding: 6px 10px;
  /* el-button 默认写死 height:32px，会压扁两行内容（标题+描述） */
  height: auto;
}
:deep(.model-item.el-button > span) {
  display: contents;
}

.model-item:hover {
  background: var(--wb-bg-hover);
}

.model-item.active {
  background: var(--wb-accent-soft);
}

.item-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wb-border-strong);
  flex-shrink: 0;
  transition: background 0.15s var(--wb-ease), box-shadow 0.15s var(--wb-ease);
}

.model-item.active .item-dot {
  background: var(--wb-accent-strong);
  box-shadow: 0 0 0 3px var(--wb-accent-softer);
}

.item-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  /* 标题（item-label-row）↔ 描述（item-meta）间距 10px */
  gap: 10px;
}

.item-label-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.item-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-tag {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
  letter-spacing: 0.02em;
}

.item-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--wb-text-tertiary);
  font-family: "SFMono-Regular", "SF Mono", Consolas, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-meta-ctx {
  background: var(--wb-bg-card-strong);
  padding: 1px 6px;
  border-radius: 999px;
  font-family: inherit;
}

.item-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--wb-accent-strong);
  flex-shrink: 0;
  /* 选中的对勾推到行尾右侧 */
  margin-left: auto;
}
</style>