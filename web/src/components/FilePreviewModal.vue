<script setup lang="ts">
/**
 * 文件预览弹窗 — 移植上游 `ui/src/components/file-preview-modal.ts`
 * （OpenClawFilePreviewModal）到 Vue 3 + Element Plus。
 *
 * 职责：会话工作区「文件浏览」场景的全屏预览 —— 左侧文件列表（可搜索），
 * 右侧展示选中文件的完整内容（纯文本代码，按 64 行分块渲染避免大文件卡顿）。
 *
 * 与「右侧详情面板」（ChatDetailSidebar）的区别：这里是**文件**维度（工作区文件树），
 * 那边是**消息**维度（单条 assistant 消息的完整 Markdown / 媒体）。两者通过
 * 「详情面板 → 文件 → 打开预览」衔接。
 *
 * 交互对齐上游：
 *  - 顶栏搜索：按「路径 + 内容」模糊过滤
 *  - ↑↓ 键在文件列表里导航，Esc / 点背景 / 底部 Close 关闭
 *  - 选中文件标题右侧有「复制文件内容」按钮
 */
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { Search, CopyDocument } from "@element-plus/icons-vue";
import { copyToClipboard } from "@/utils/clipboard";

export type PreviewFile = {
  /** 文件相对路径（列表项展示 + 唯一键）。 */
  path: string;
  /** 已格式化的体积（如 "2.4 KB"）。 */
  size: string;
  /** 文件纯文本内容；空串表示不可预览。 */
  contents: string;
};

const props = withDefaults(
  defineProps<{
    /** 会话工作区文件列表。 */
    files: PreviewFile[];
    /** 初始选中的文件路径。 */
    activePath?: string;
    /** 弹窗标题（如 "Support files"）。 */
    label?: string;
    /** 文件列表分区标题。 */
    listLabel?: string;
    /** 搜索框占位文案。 */
    searchPlaceholder?: string;
    /** 复制按钮文案。 */
    copyLabel?: string;
  }>(),
  {
    activePath: "",
    label: "会话工作区文件",
    listLabel: "文件",
    searchPlaceholder: "搜索文件名或内容…",
    copyLabel: "复制文件",
  },
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "select", path: string): void;
}>();

const query = ref("");
const searchInput = ref<HTMLInputElement | null>(null);
const listBody = ref<HTMLElement | null>(null);

/** 按「路径 + 内容」模糊过滤后的文件列表。 */
const filteredFiles = computed<PreviewFile[]>(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return props.files;
  return props.files.filter((file) =>
    `${file.path}\n${file.contents}`.toLowerCase().includes(needle),
  );
});

/** 当前选中的文件（优先 activePath，否则第一个）。 */
const activeFile = computed<PreviewFile | null>(() => {
  const list = filteredFiles.value;
  return list.find((f) => f.path === props.activePath) ?? list[0] ?? null;
});

const fileCount = computed<string>(() => {
  const list = filteredFiles.value;
  return list.length === props.files.length
    ? `${props.files.length} 个文件`
    : `${list.length}/${props.files.length} 个文件`;
});

/** 按 64 行分块（对齐上游 FILE_PREVIEW_CHUNK_LINES）。 */
const codeChunks = computed<string[]>(() => {
  const contents = activeFile.value?.contents;
  if (contents === undefined) return [];
  const lines = contents.split("\n");
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += 64) {
    chunks.push(lines.slice(i, i + 64).join("\n"));
  }
  return chunks;
});

function fileKind(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "Markdown",
    txt: "Text",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    sh: "Shell",
    bash: "Shell",
    go: "Go",
    rs: "Rust",
    html: "HTML",
    css: "CSS",
    sql: "SQL",
  };
  return map[ext] ?? (ext ? ext.toUpperCase() : "File");
}

async function copyActiveFile(): Promise<void> {
  const contents = activeFile.value?.contents;
  if (contents === undefined) return;
  const ok = await copyToClipboard(contents);
  ElMessage({
    message: ok ? "已复制文件内容" : "复制失败，请手动选择复制",
    type: ok ? "success" : "error",
    grouping: true,
  });
}

function onKeydown(event: KeyboardEvent): void {
  const list = filteredFiles.value;
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (list.length === 0) return;
  event.preventDefault();
  const current = activeFile.value;
  const index = current ? list.findIndex((f) => f.path === current.path) : -1;
  const delta = event.key === "ArrowDown" ? 1 : -1;
  const next = Math.max(0, Math.min(list.length - 1, index + delta));
  const nextFile = list[next];
  if (nextFile && nextFile.path !== current?.path) {
    emit("select", nextFile.path);
  }
}

watch(
  () => activeFile.value?.path,
  () => {
    listBody.value
      ?.querySelector<HTMLElement>(".file-preview__item.is-active")
      ?.scrollIntoView({ block: "nearest" });
  },
);

onMounted(() => searchInput.value?.focus({ preventScroll: true }));
</script>

<template>
  <Teleport to="body">
    <div class="file-preview" @keydown="onKeydown" tabindex="-1">
      <div class="file-preview__backdrop" @click="emit('close')" />
      <div
        class="file-preview__modal"
        role="dialog"
        :aria-label="label"
        aria-modal="true"
      >
        <header class="file-preview__head">
          <el-icon class="file-preview__search-icon"><Search /></el-icon>
          <input
            ref="searchInput"
            v-model="query"
            class="file-preview__search"
            :placeholder="searchPlaceholder"
          />
          <span class="file-preview__state">{{ fileCount }}</span>
        </header>

        <div class="file-preview__body">
          <aside class="file-preview__list" ref="listBody">
            <div class="file-preview__list-section">
              {{ listLabel }} · {{ filteredFiles.length }}
            </div>
            <div v-if="filteredFiles.length === 0" class="file-preview__empty-list">
              没有匹配的文件
            </div>
            <button
              v-for="file in filteredFiles"
              :key="file.path"
              type="button"
              class="file-preview__item"
              :class="{ 'is-active': file.path === activeFile?.path }"
              @click="emit('select', file.path)"
            >
              <span class="file-preview__item-name">{{ file.path }}</span>
              <span class="file-preview__item-meta">{{ file.size }}</span>
            </button>
          </aside>

          <section v-if="activeFile" class="file-preview__detail">
            <div class="file-preview__detail-head">
              <div class="file-preview__title-row">
                <h2 class="file-preview__title">{{ activeFile.path }}</h2>
                <el-button
                  v-if="activeFile.contents"
                  class="file-preview__copy-btn"
                  text
                  size="small"
                  :title="copyLabel"
                  @click="copyActiveFile"
                >
                  <el-icon><CopyDocument /></el-icon>
                </el-button>
              </div>
              <div class="file-preview__chips">
                <span class="file-preview__chip is-accent">{{ fileKind(activeFile.path) }}</span>
                <span class="file-preview__chip">{{ activeFile.size }}</span>
                <span class="file-preview__chip">只读</span>
              </div>
            </div>
            <div class="file-preview__detail-body">
              <pre
                v-for="(chunk, i) in codeChunks"
                :key="i"
                class="file-preview__code"
              >{{ chunk }}</pre>
            </div>
          </section>

          <section v-else class="file-preview__detail is-empty">
            <p class="file-preview__empty-title">没有匹配的文件</p>
            <p class="file-preview__empty-subtitle">换个文件名或内容关键词试试。</p>
          </section>
        </div>

        <footer class="file-preview__foot">
          <span class="file-preview__foot-group">↑↓ 导航</span>
          <span class="file-preview__spacer" />
          <el-button text size="small" @click="emit('close')">
            关闭 <span class="file-preview__kbd">esc</span>
          </el-button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.file-preview {
  position: fixed;
  inset: 0;
  z-index: 3000;
}
.file-preview__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
}
.file-preview__modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(1100px, 92vw);
  height: min(780px, 86vh);
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-lg);
  box-shadow: var(--wb-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.file-preview__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--wb-border);
}
.file-preview__search-icon {
  color: var(--wb-text-tertiary);
  font-size: 18px;
}
.file-preview__search {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--wb-text-primary);
  font: inherit;
  font-size: 18px;
  padding: 4px 0;
}
.file-preview__search::placeholder {
  color: var(--wb-text-tertiary);
}
.file-preview__state {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  color: var(--wb-text-tertiary);
  padding: 5px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-bg-elevated);
}
.file-preview__body {
  flex: 1;
  display: grid;
  grid-template-columns: 360px 1fr;
  min-height: 0;
}
.file-preview__list {
  border-right: 1px solid var(--wb-border);
  padding: 14px 10px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.file-preview__list-section {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--wb-text-tertiary);
  padding: 4px 12px 8px;
}
.file-preview__empty-list {
  color: var(--wb-text-tertiary);
  font-size: 13px;
  padding: 12px;
}
.file-preview__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--wb-radius);
  border: none;
  background: transparent;
  color: var(--wb-text-primary);
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.file-preview__item:hover {
  background: var(--wb-bg-hover);
}
.file-preview__item.is-active {
  background: var(--wb-accent-soft);
}
.file-preview__item.is-active .file-preview__item-name {
  color: var(--wb-text-primary);
}
.file-preview__item-name {
  flex: 1;
  min-width: 0;
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-preview__item-meta {
  color: var(--wb-text-tertiary);
  font-size: 12px;
  flex: 0 0 auto;
}
.file-preview__detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.file-preview__detail.is-empty {
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
}
.file-preview__detail-head {
  padding: 20px 24px 14px;
  border-bottom: 1px solid var(--wb-border);
}
.file-preview__title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.file-preview__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  font-size: 22px;
  color: var(--wb-text-primary);
  font-weight: 700;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-preview__copy-btn {
  flex: 0 0 auto;
  color: var(--wb-text-secondary);
}
.file-preview__chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.file-preview__chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11.5px;
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  color: var(--wb-text-tertiary);
}
.file-preview__chip.is-accent {
  background: var(--wb-accent-soft);
  color: var(--wb-accent-strong);
}
.file-preview__detail-body {
  flex: 1;
  overflow: auto;
  padding: 20px 24px 24px;
}
.file-preview__code {
  margin: 0;
  min-width: 0;
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  font-size: 13px;
  line-height: 1.7;
  color: var(--wb-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.file-preview__empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--wb-text-primary);
  margin: 0 0 8px;
}
.file-preview__empty-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--wb-text-tertiary);
  max-width: 380px;
}
.file-preview__foot {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px 20px;
  border-top: 1px solid var(--wb-border);
  font-size: 12px;
  color: var(--wb-text-tertiary);
}
.file-preview__foot-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.file-preview__spacer {
  flex: 1;
}
.file-preview__kbd {
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--wb-bg-elevated);
  color: var(--wb-text-primary);
}
</style>
