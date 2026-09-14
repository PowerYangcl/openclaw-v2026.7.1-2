<script setup lang="ts">
/**
 * Markdown 视图 — 移植上游 `ui/src/pages/chat/components/chat-message.ts`
 * 的 `<div class="chat-text" dir="${detectTextDirection(markdown)}">
 *   ${unsafeHTML(toStreamingMarkdownHtml(markdown, markdownRenderOptions))}
 * </div>` 模式到 Vue 3。
 *
 * 关键点：
 *  - dir 属性：detectTextDirection() 检测 RTL / LTR
 *  - 流式渲染：streaming=true 时用 toStreamingMarkdownHtml()，
 *    找稳定边界分段渲染（避免边流式输入边重排导致闪烁）
 *  - 完整渲染：streaming=false 时直接 toSanitizedMarkdownHtml()
 *  - 渲染管线：markdown-it (GFM + linkify + strikethrough + task lists)
 *              → highlight.js (代码高亮)
 *              → DOMPurify (XSS / 危险 URL 清洗)
 *
 * 副作用：旧的「自写 parseBlocks + 极简高亮」实现已整体替换。
 * 之前为适配 Agent 的 `||` 伪表格加的 fallback 已下沉到 `utils/markdown.ts`
 * 的 `convertPseudoTableToGfm()` 预处理中（送进 markdown-it 之前转换成
 * 标准 GFM 表格语法），行为等价但走的是真正的 markdown-it 管线。
 */
import { computed } from "vue";
import {
  detectTextDirection,
  toSanitizedMarkdownHtml,
  toStreamingMarkdownHtml,
  type MarkdownRenderOptions,
} from "@/utils/markdown";

const props = withDefaults(
  defineProps<{
    /** 原始 Markdown 文本 */
    text: string;
    /**
     * 是否处于流式生成中。
     * true → 走 `toStreamingMarkdownHtml`，稳定段 sanitize、未稳定尾部按纯文本转义追加；
     * false → 整体走 `toSanitizedMarkdownHtml`。
     */
    streaming?: boolean;
    /** 自定义渲染选项（默认 copy 按钮 + 不开 file link 转换） */
    options?: MarkdownRenderOptions;
  }>(),
  {
    streaming: false,
    options: () => ({}),
  },
);

const dir = computed(() => detectTextDirection(props.text));
const html = computed(() =>
  props.streaming
    ? toStreamingMarkdownHtml(props.text, props.options)
    : toSanitizedMarkdownHtml(props.text, props.options),
);
</script>

<template>
  <div class="chat-text md" :dir="dir" v-html="html" />
</template>

<style>
/*
 * Markdown 渲染样式 — WorkBuddy 风。
 * 与 src/styles/main.css 的 token 对齐。
 */
.md {
  font-size: 14px;
  line-height: 1.72;
  color: var(--wb-text-primary);
  word-break: break-word;
}

.md > *:first-child {
  margin-top: 0;
}
.md > *:last-child {
  margin-bottom: 0;
}

.md p {
  margin: 0 0 10px;
}
.md p:last-child {
  margin-bottom: 0;
}

.md h1,
.md h2,
.md h3,
.md h4 {
  margin: 18px 0 10px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.01em;
  color: var(--wb-text-primary);
}
.md h1:first-child,
.md h2:first-child,
.md h3:first-child,
.md h4:first-child {
  margin-top: 0;
}
.md h1 {
  font-size: 20px;
}
.md h2 {
  font-size: 17px;
}
.md h3 {
  font-size: 15px;
}
.md h4 {
  font-size: 14px;
}

.md ul,
.md ol {
  margin: 0 0 10px;
  padding-left: 22px;
}
.md ul li,
.md ol li {
  margin: 4px 0;
}
.md ul li::marker,
.md ol li::marker {
  color: var(--wb-text-tertiary);
}

.md blockquote {
  margin: 0 0 12px;
  padding: 8px 14px;
  border-left: 3px solid var(--wb-accent);
  background: var(--wb-accent-softer);
  border-radius: 0 var(--wb-radius) var(--wb-radius) 0;
  color: var(--wb-text-secondary);
}

.md hr {
  border: none;
  border-top: 1px solid var(--wb-border);
  margin: 18px 0;
}

.md code {
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--wb-code-bg);
  color: var(--wb-text-primary);
  font-family: "SFMono-Regular", "SF Mono", "JetBrains Mono", Consolas, Menlo, monospace;
  font-size: 0.88em;
}

.md a {
  color: var(--wb-accent-link);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.15s var(--wb-ease);
}
.md a:hover {
  text-decoration: none;
  border-bottom-color: var(--wb-accent-link);
}

.md pre {
  margin: 0 0 14px;
  padding: 12px 14px;
  overflow-x: auto;
  background: var(--wb-code-bg);
  font-size: 13px;
  line-height: 1.6;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
}
.md pre code {
  background: transparent;
  padding: 0;
  font-family: "SFMono-Regular", "SF Mono", "JetBrains Mono", Consolas, Menlo, monospace;
  color: var(--wb-text-primary);
}

/* highlight.js 主题色 — 直接走 WorkBuddy token，避免再 import hljs css */
.md .hljs-keyword,
.md .hljs-selector-tag,
.md .hljs-built_in,
.md .hljs-name,
.md .hljs-tag {
  color: #c084fc;
}
.md .hljs-string,
.md .hljs-attr,
.md .hljs-symbol,
.md .hljs-bullet,
.md .hljs-addition {
  color: #86efac;
}
.md .hljs-comment,
.md .hljs-quote,
.md .hljs-deletion,
.md .hljs-meta {
  color: var(--wb-text-tertiary);
  font-style: italic;
}
.md .hljs-number,
.md .hljs-literal,
.md .hljs-variable,
.md .hljs-template-variable,
.md .hljs-link {
  color: #fbbf24;
}
.md .hljs-title,
.md .hljs-section,
.md .hljs-function .hljs-title {
  color: #60a5fa;
}
.md .hljs-type,
.md .hljs-class .hljs-title {
  color: #38bdf8;
}

.md table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
  margin: 0 0 14px;
}
.md table th,
.md table td {
  border: none;
  border-bottom: 1px solid var(--wb-border);
  padding: 8px 14px;
  text-align: left;
}
.md table tr:last-child td {
  border-bottom: none;
}
.md table th {
  background: var(--wb-bg-card-strong);
  font-weight: 600;
  color: var(--wb-text-secondary);
  font-size: 12px;
  letter-spacing: 0.02em;
}
.md table tbody tr:hover {
  background: var(--wb-bg-hover);
}

/* 段落中的强调 */
.md strong {
  font-weight: 600;
  color: var(--wb-text-primary);
}
.md em {
  color: var(--wb-text-primary);
}
.md del {
  color: var(--wb-text-tertiary);
}

/* 流式渲染时未稳定尾部的纯文本兜底样式 */
.md .markdown-plain-text-fallback {
  white-space: pre-wrap;
  font-family: inherit;
}

/* 行内图片 */
.md .markdown-inline-image {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
</style>