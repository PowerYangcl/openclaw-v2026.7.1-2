<script setup lang="ts">
/**
 * DEV-ONLY: Markdown pipeline smoke page.
 * 直接用 MarkdownView 渲染一段混合 markdown，验证 markdown-it + DOMPurify + hljs 链路。
 * 仅 import.meta.env.DEV 时挂上路由（router 已根据 dev 标志注册）。
 */
import MarkdownView from "@/components/MarkdownView.vue";
import ChatAvatar from "@/components/ChatAvatar.vue";

const sample = [
  "**优点：**",
  "",
  "- 速度快",
  "- 体积小",
  "- 可扩展",
  "",
  "下面是一个 GFM 表格：",
  "",
  "| 列 A | 列 B |",
  "|----|----|",
  "| a1 | b1 |",
  "| a2 | b2 |",
  "",
  "一段 JS 代码：",
  "",
  "```js",
  "const x = 42;",
  "console.log(x);",
  "```",
  "",
  "一段 `||` 伪表格（Agent 自创格式）：",
  "",
  "|| 内容 || 说明 || 备注 ||",
  "|| --- || --- || --- ||",
  "|| A1 || B1 || C1 ||",
  "|| A2 || B2 || C2 ||",
  "|| A3 || B3 || C3 ||",
  "",
  "中文混合 RTL 测试：",
  "",
  "这是一段中文文字（应该 dir=ltr）。",
  "",
  "Another paragraph in English.",
].join("\n");

const streamingSample = [
  "# 流式渲染测试",
  "",
  "下面是一段**正在生成**的代码块：",
  "",
  "```js",
  "function greet(name",
].join("\n");

/**
 * 内联 SVG 头像（data URI），用来验证「图片头像在 20px subtle 下透明底」这条路径。
 * 不依赖网络，避免冒烟时受网关 / 鉴权影响。
 */
const IMAGE_AVATAR_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
     <rect width="32" height="32" fill="#f59e0b"/>
     <circle cx="16" cy="16" r="9" fill="#fff"/>
   </svg>`,
)}`;
</script>

<template>
  <div class="md-test">
    <header>
      <h2>完整渲染</h2>
      <div class="avatar-row">
        <ChatAvatar role="assistant" name="Assistant" avatar="🐾" :size="32" />
        <ChatAvatar role="assistant" name="Assistant" avatar="🐾" :size="24" />
        <ChatAvatar role="assistant" name="Assistant" avatar="🐾" :size="20" />
        <ChatAvatar role="user" name="User" :size="32" />
        <ChatAvatar
          class="t-image-avatar"
          role="assistant"
          name="ImageAvatar"
          :image-url="IMAGE_AVATAR_DATA_URI"
          :size="20"
        />
        <ChatAvatar class="t-text-avatar" role="assistant" name="英语" avatar="英" :size="20" />
      </div>
    </header>
    <MarkdownView :text="sample" />

    <header><h2>流式渲染</h2></header>
    <MarkdownView :text="streamingSample" :streaming="true" />
  </div>
</template>

<style scoped>
.md-test {
  max-width: 720px;
  margin: 24px auto;
  padding: 16px 24px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
}
.md-test h2 {
  font-size: 18px;
  margin: 24px 0 12px;
}
.md-test .avatar-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
</style>