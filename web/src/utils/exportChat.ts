/**
 * 对话导出 Markdown — 移植上游 `ui/src/pages/chat/export.ts` 的
 * `buildChatMarkdown` / `exportChatMarkdown` 到 web 层。
 *
 * 与「复制按钮」的关系（评估结论）：
 *   - 复制按钮复制的是**单条消息的正文**（`msg.text.trim()`，无角色/时间戳/会话标题）；
 *   - 导出需要的是**整段对话**的结构化 Markdown（会话标题 + 逐条角色 + 时间戳）。
 *   两者粒度、格式、输出通道都不同，**不能直接复用复制按钮**；
 *   但复制按钮的「正文提取」逻辑（`messageCopyText`）可作为导出的消息正文来源复用。
 */
import type { ChatMessage } from "@/types/chat";
import {
  buildAssistantMediaUrl,
  isGatewayHostedMediaUrl,
  withAssistantMediaDownload,
} from "@/utils/assistantMedia";

/** 角色名映射（对齐上游 export.ts）：user → 你 / assistant → 助手名 / 其余 → 工具。 */
function roleLabel(msg: ChatMessage, assistantName: string): string {
  if (msg.role === "user") return "你";
  if (msg.role === "assistant") return assistantName;
  return "工具";
}

/** 时间戳转 ISO 串（无 ts 则空）。 */
function isoOf(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  try {
    return new Date(ts).toISOString();
  } catch {
    return "";
  }
}

/** 附件下载 URL 的构造器（base/token 由调用方注入，导出出的 md 里链接才能下载）。 */
export type AttachmentDownloadResolver = (source: string) => string | null;

/**
 * 构造一个「附件 → 可下载链接」的解析器。
 *
 * 与 ChatPane 的 `downloadHrefOrNull` 同口径：只有网关托管媒体 / data / blob 才给
 * 链接（追加 `download=1`），远端第三方地址返回 null（导出里就退化成纯文件名）。
 */
export function makeAttachmentDownloadResolver(
  base: string | null | undefined,
  token: string | null | undefined,
): AttachmentDownloadResolver {
  return (source: string): string | null => {
    const resolved = buildAssistantMediaUrl({ source, base, token });
    if (!resolved) return null;
    const hosted = isGatewayHostedMediaUrl(resolved, base) || /^(?:data|blob):/i.test(resolved);
    if (!hosted) return null;
    return withAssistantMediaDownload(resolved, base);
  };
}

/**
 * 一条消息的附件 Markdown 片段（内嵌图片 / 内嵌附件 / 历史附件三路来源合并去重）。
 *
 * - 图片 → `![label](下载链接)`（可点击下载；拿不到链接则退化纯文件名）
 * - 文档/视频 → `[label](下载链接)`
 * - 音频 → `[label](下载链接)`（音频无在线播放，只做可下载链接）
 */
function attachmentMarkdown(msg: ChatMessage, resolve: AttachmentDownloadResolver): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  const pushFile = (label: string, source: string, kind: "image" | "file"): void => {
    const key = source.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const name = label?.trim() || "附件";
    const href = resolve(source);
    if (kind === "image" && href) {
      lines.push(`![${name}](${href})`);
    } else if (href) {
      lines.push(`[${name}](${href})`);
    } else {
      lines.push(`- 附件：${name}`);
    }
  };

  for (const img of msg.contentImages ?? []) pushFile(img.alt ?? "图片", img.url, "image");
  for (const att of msg.contentAttachments ?? []) pushFile(att.label, att.url, "file");
  for (const media of msg.historyMedia ?? []) {
    pushFile(media.label, media.source, media.kind === "image" ? "image" : "file");
  }
  return lines;
}

/**
 * 把整段对话序列化为 Markdown。
 *
 * 格式（对齐上游 buildChatMarkdown）：
 *   # Chat with {assistantName}
 *
 *   ## {角色} ({ISO 时间戳})
 *
 *   {正文}
 *
 * 每条消息的附件（图片 / 文档 / 音频）以 Markdown 链接形式追加在正文之后，
 * 点击可在浏览器中下载（链接由 `resolve` 生成，带 `download=1` 强制 attachment）。
 *
 * 返回 null 表示无内容可导出。
 */
export function buildChatMarkdown(
  messages: ChatMessage[],
  assistantName: string,
  resolve?: AttachmentDownloadResolver,
): string | null {
  const history = Array.isArray(messages) ? messages : [];
  if (history.length === 0) return null;
  const lines: string[] = [`# 与 ${assistantName || "助手"} 的对话`, ""];
  for (const msg of history) {
    const role = roleLabel(msg, assistantName);
    const content = (msg.text ?? "").trim();
    const ts = isoOf(msg.ts);
    lines.push(`## ${role}${ts ? ` (${ts})` : ""}`, "");
    if (content) lines.push(content, "");
    if (resolve) {
      const attachments = attachmentMarkdown(msg, resolve);
      if (attachments.length > 0) lines.push(...attachments, "");
    }
  }
  return lines.join("\n");
}

/**
 * 触发浏览器下载 Markdown 文件。
 *
 * 文件名 `chat-{assistantName}-{Date.now()}.md`（对齐上游）。
 * `base` / `token` 用于生成附件下载链接（详见 `makeAttachmentDownloadResolver`）。
 */
export function exportChatMarkdown(
  messages: ChatMessage[],
  assistantName: string,
  base?: string | null,
  token?: string | null,
): boolean {
  const resolve = makeAttachmentDownloadResolver(base, token);
  const markdown = buildChatMarkdown(messages, assistantName, resolve);
  if (!markdown) return false;
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chat-${assistantName || "assistant"}-${Date.now()}.md`;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}
