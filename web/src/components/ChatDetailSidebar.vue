<script setup lang="ts">
/**
 * 右侧详情面板 — 移植上游 `ui/src/pages/chat/components/chat-sidebar.ts` 的
 * 「消息详情」能力到 Vue 3，用 Element Plus 的 `el-drawer`（右侧抽屉）承载。
 *
 * 职责：把单条消息的**完整内容**（完整 Markdown + 思考过程 + 媒体/附件）从
 * 气泡里「展开」到右侧抽屉，便于长消息阅读、复制、以及进一步查看
 * 会话工作区文件（文件预览弹窗）。
 *
 * 显隐由父级传入的 `message`（非空 = 展开）驱动：`el-drawer` 的 `model-value`
 * 绑定 `!!message`，关闭动画结束后回调 `close` 事件 → 父级把 message 置 null。
 * 这样不引入额外的「visible + message」双状态，单一数据源，不会出现
 * 「消息清了但抽屉还开着」或「抽屉关了但消息还挂着」的错位。
 *
 * 数据来源：web 层 `ChatMessage` 已含完整 `text`（消息从历史/流式落库时即完整，
 * 无上游「列表消息 truncated → 需 upgradeToFullMessage」的场景），故无需回源拉取。
 */
import { computed } from "vue";
import { ElMessage } from "element-plus";
import { Close, CopyDocument } from "@element-plus/icons-vue";
import type { ChatMessage } from "@/types/chat";
import type { TranscriptMediaItem } from "@/utils/transcriptMedia";
import type { ContentImageBlock, ContentAttachmentItem } from "@/utils/contentMedia";
import MarkdownView from "@/components/MarkdownView.vue";
import ChatAvatar from "@/components/ChatAvatar.vue";
import AudioPlayer from "@/components/AudioPlayer.vue";
import { copyToClipboard } from "@/utils/clipboard";
import { formatDateTimeMinute } from "@/utils/format";
import {
  buildAssistantMediaUrl,
  isGatewayHostedMediaUrl,
  withAssistantMediaDownload,
} from "@/utils/assistantMedia";
import { contentMediaSafeHref } from "@/utils/contentMedia";
import { useSettingsStore } from "@/stores/settings";

const props = withDefaults(
  defineProps<{
    /** 要展开的消息；为 null 时抽屉隐藏。 */
    message: ChatMessage | null;
    /** 该消息所属 agent 的展示名（头像/标题用）。 */
    agentName?: string;
    /** 该消息所属 agent 的头像。 */
    agentAvatar?: string;
    /** 用户展示名（user 消息用）。 */
    userName?: string;
  }>(),
  {
    agentName: "",
    agentAvatar: "",
    userName: "",
  },
);

const emit = defineEmits<{
  (e: "close"): void;
  /** 请求打开「会话工作区文件预览」弹窗（由布局层决定文件来源）。 */
  (e: "openFilePreview"): void;
}>();

const settings = useSettingsStore();

const title = computed<string>(() => {
  const msg = props.message;
  if (!msg) return "消息详情";
  if (msg.role === "user") return props.userName || "我";
  return props.agentName || "助手";
});

const timeText = computed<string>(() =>
  props.message?.ts ? formatDateTimeMinute(props.message.ts) : "",
);

const hasThinking = computed(() => Boolean(props.message?.thinking));

/** 是否可复制（有正文才可）。 */
const canCopy = computed(() => (props.message?.text ?? "").trim().length > 0);

/** 图片/附件的**可渲染** URL（原始 url 可能是 data:/本地路径/media://，需经网关媒体地址构建）。 */
function mediaSrc(source: string): string {
  return (
    buildAssistantMediaUrl({
      source,
      base: settings.gatewayHttpBase,
      token: settings.token,
    }) ?? source
  );
}

/**
 * 渲染期统一出口：把「已解析的绝对地址」变成**可下载的链接地址**。
 *
 * 与 ChatPane 的 `downloadHrefOrNull` 同口径（见该函数文件头注释）：
 * - 网关托管媒体 / data / blob → 追加 `download=1`（或原样）返回；
 * - 远端第三方地址 → 返回 null（改不了 disposition，给了 href 就会「打开」把抽屉顶掉）。
 */
function downloadHref(resolvedUrl: string | null | undefined): string | null {
  const safe = contentMediaSafeHref(resolvedUrl ?? "");
  if (!safe) return null;
  const hosted =
    isGatewayHostedMediaUrl(safe, settings.gatewayHttpBase) || /^(?:data|blob):/i.test(safe);
  if (!hosted) return null;
  return withAssistantMediaDownload(safe, settings.gatewayHttpBase);
}

/** 锚点 `download` 的落盘文件名（远端地址浏览器会忽略它，只作同源兜底）。 */
function downloadFileName(label: string | null | undefined, fallback = "附件"): string {
  const name = typeof label === "string" ? label.trim() : "";
  return name || fallback;
}

/** 内嵌图片的下载地址。 */
function imageHref(image: ContentImageBlock): string | null {
  return downloadHref(mediaSrc(image.url));
}

/** 内嵌附件（document/video）的下载地址；音频走 AudioPlayer。 */
function attachmentHref(att: ContentAttachmentItem): string | null {
  return downloadHref(mediaSrc(att.url));
}

/** 历史附件（historyMedia）的可渲染 URL。 */
function historyMediaUrlOf(item: TranscriptMediaItem): string {
  return mediaSrc(item.source);
}

/** 历史附件的下载地址。 */
function historyMediaHrefOf(item: TranscriptMediaItem): string | null {
  return downloadHref(historyMediaUrlOf(item));
}

async function copyFullMessage(): Promise<void> {
  const text = props.message?.text ?? "";
  const ok = await copyToClipboard(text.trim());
  ElMessage({
    message: ok ? "已复制完整消息" : "复制失败，请手动选择复制",
    type: ok ? "success" : "error",
    grouping: true,
  });
}
</script>

<template>
  <el-drawer
    :model-value="!!message"
    direction="rtl"
    size="640px"
    class="detail-drawer"
    :show-close="false"
    :close-on-click-modal="true"
    :close-on-press-escape="true"
    destroy-on-close
    @close="emit('close')"
  >
    <template #header>
      <header class="detail-drawer__head">
        <div class="detail-drawer__identity">
          <ChatAvatar
            :role="message?.role === 'user' ? 'user' : 'assistant'"
            :name="title"
            :avatar="message?.role === 'assistant' ? agentAvatar : undefined"
            :size="28"
          />
          <div class="detail-drawer__title-block">
            <span class="detail-drawer__title">{{ title }}</span>
            <span v-if="timeText" class="detail-drawer__time">{{ timeText }}</span>
          </div>
        </div>
        <div class="detail-drawer__tools">
          <el-button
            v-if="canCopy"
            text
            size="small"
            title="复制完整消息"
            aria-label="复制完整消息"
            @click="copyFullMessage"
          >
            <el-icon><CopyDocument /></el-icon>
          </el-button>
          <el-button
            text
            size="small"
            title="关闭"
            aria-label="关闭详情面板"
            @click="emit('close')"
          >
            <el-icon><Close /></el-icon>
          </el-button>
        </div>
      </header>
    </template>

    <div v-if="message" class="detail-drawer__body">
      <div v-if="hasThinking" class="detail-drawer__thinking">
        <div class="detail-drawer__thinking-label">思考过程</div>
        <div class="detail-drawer__thinking-body">{{ message.thinking }}</div>
      </div>

      <MarkdownView :text="message.text" />

      <!-- 内嵌图片（助手回复 / 工具结果里的 image 块）。包 <a download>：点击只下载，
           不把抽屉顶掉（`download=1` 让网关回 attachment）。 -->
      <div v-if="message.contentImages?.length" class="detail-drawer__images">
        <a
          v-for="(img, i) in message.contentImages"
          :key="`${message.id}-img-${i}`"
          class="detail-drawer__image-link"
          :href="imageHref(img) ?? undefined"
          :download="downloadFileName(img.alt, '附件图片')"
          :title="img.alt?.trim() || '点击下载图片'"
        >
          <img
            class="detail-drawer__image"
            :src="mediaSrc(img.url)"
            :alt="img.alt ?? ''"
          />
        </a>
      </div>

      <!-- 内嵌非图片附件：音频出播放器，文档/视频出可点击下载的文件卡片 -->
      <template v-for="(att, i) in message.contentAttachments ?? []" :key="`${message.id}-att-${i}`">
        <AudioPlayer v-if="att.kind === 'audio'" :source="att.url" :label="att.label" />
        <a
          v-else
          class="detail-drawer__file"
          :class="{ 'detail-drawer__file--previewable': !!attachmentHref(att) }"
          :href="attachmentHref(att) ?? undefined"
          :download="downloadFileName(att.label)"
          :title="attachmentHref(att) ? `点击下载 ${att.label}` : att.label"
        >
          <span class="detail-drawer__file-name">{{ att.label }}</span>
        </a>
      </template>

      <!-- 历史附件（historyMedia，刷新/换会话后 user 消息的 MediaPath(s) 还原）。
           图片出缩略图（可下载）、音频出播放器、视频/文档出可点击下载卡片。 -->
      <template v-for="(media, i) in message.historyMedia ?? []" :key="`${message.id}-hmedia-${i}`">
        <AudioPlayer v-if="media.kind === 'audio'" :source="media.source" :label="media.label" />
        <a
          v-else-if="media.kind === 'image' && historyMediaUrlOf(media)"
          class="detail-drawer__image-link"
          :href="historyMediaHrefOf(media) ?? undefined"
          :download="downloadFileName(media.label, '附件图片')"
          :title="historyMediaHrefOf(media) ? `点击下载 ${media.label}` : media.label"
        >
          <img
            class="detail-drawer__image"
            :src="historyMediaUrlOf(media)"
            :alt="media.label"
          />
        </a>
        <a
          v-else
          class="detail-drawer__file"
          :class="{ 'detail-drawer__file--previewable': !!historyMediaHrefOf(media) }"
          :href="historyMediaHrefOf(media) ?? undefined"
          :download="downloadFileName(media.label)"
          :title="historyMediaHrefOf(media) ? `点击下载 ${media.label}` : media.label"
        >
          <span class="detail-drawer__file-name">{{ media.label }}</span>
        </a>
      </template>
    </div>
    
  </el-drawer>
</template>

<style scoped>
/* el-drawer 默认 body 有 20px padding，这里去掉，由内容自行控制留白。 */
.detail-drawer :deep(.el-drawer__body) {
  padding: 0;
}
.detail-drawer :deep(.el-drawer__header) {
  margin-bottom: 0;
  padding: 12px 16px;
  border-bottom: 1px solid var(--wb-border);
}
.detail-drawer :deep(.el-drawer__footer) {
  padding: 10px 16px;
  border-top: 1px solid var(--wb-border);
}
.detail-drawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.detail-drawer__identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.detail-drawer__title-block {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.detail-drawer__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-drawer__time {
  font-size: 11px;
  color: var(--wb-text-tertiary);
}
.detail-drawer__tools {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  color: var(--wb-text-secondary);
}
.detail-drawer__body {
  height: 100%;
  overflow-y: auto;
  padding: 16px;
}
.detail-drawer__thinking {
  margin-bottom: 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-bg-inset);
  padding: 10px 12px;
}
.detail-drawer__thinking-label {
  font-size: 11px;
  color: var(--wb-text-tertiary);
  margin-bottom: 6px;
}
.detail-drawer__thinking-body {
  font-size: 13px;
  color: var(--wb-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.detail-drawer__images {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.detail-drawer__image-link {
  display: block;
  width: 100%;
  text-decoration: none;
}
.detail-drawer__image {
  max-width: 100%;
  border-radius: var(--wb-radius);
  border: 1px solid var(--wb-border);
  display: block;
}
.detail-drawer__file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-top: 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-bg-elevated);
  text-decoration: none;
  color: inherit;
}
.detail-drawer__file--previewable {
  cursor: pointer;
}
.detail-drawer__file--previewable:hover {
  border-color: var(--wb-brand, var(--el-color-primary));
}
.detail-drawer__file-name {
  font-size: 13px;
  color: var(--wb-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-drawer__foot {
  display: flex;
  justify-content: flex-end;
  width: 100%;
}
</style>
