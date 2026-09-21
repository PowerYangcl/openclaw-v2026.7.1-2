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
  extractAudioReferences,
  isGatewayHostedMediaUrl,
  withAssistantMediaDownload,
} from "@/utils/assistantMedia";

/**
 * 角色名映射（对齐上游 export.ts：user → 你 / assistant → 助手名 / 其余 → 工具）。
 *
 * `system` 单独映射成「系统」：会话里确实存在系统记录（系统提示词回写、
 * 上下文压缩提示、通道管理记录），视图也照常渲染它们。此前它们落到 `else`
 * 分支被标成「工具」，导出成存档后是**事实错误**（读起来像工具调用）。
 */
function roleLabel(msg: ChatMessage, assistantName: string): string {
  if (msg.role === "user") return "你";
  if (msg.role === "assistant") return assistantName;
  if (msg.role === "system") return "系统";
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

/** 浏览器里的页面 origin（SSR / 非浏览器环境返回空串）。 */
function pageOrigin(): string {
  if (typeof window === "undefined") return "";
  const origin = window.location?.origin;
  return typeof origin === "string" ? origin : "";
}

/**
 * 构造一个「附件 → 可下载链接」的解析器。
 *
 * 分四种形态处理（顺序即优先级）：
 * 1. `blob:` —— 页面会话内的临时地址，写进文件必然失效，返回 null（退化成纯名字）；
 * 2. `data:` —— 直接导航过去会**执行脚本**（`data:image/svg+xml` 是已知的 XSS 载体，
 *    见 `utils/contentMedia.ts: contentMediaSafeHref` 的同一告诫）。存档文件可能被分享，
 *    不给它可点链接；
 * 3. 远端 `http(s)://` —— 原样返回。第三方地址我们改不了 disposition，
 *    但它本身可点可开，比退化成纯名字有用（此前一律退化，等于把远端附件写成了死文本）；
 * 4. 其余（本地绝对路径 / `~/` / `file://` / `media://inbound/<id>` / 网关站内路径）
 *    —— 过 `buildAssistantMediaUrl` 换成网关媒体地址，只有确认是**本网关托管**的
 *    才追加 `download=1`，让点击变成下载而不是把当前页面顶掉。
 *
 * ## `origin` 参数为什么存在（别删）
 * 导出的 md 是在**另一个进程**里打开的（Typora / VS Code / 浏览器直接开本地文件），
 * 相对地址在那里会被解析成**本地文件路径** —— 一个都点不开。
 * 而 `resolveGatewayHttpBase` 在 `gatewayUrl` 为空时返回**空串**（同源部署很常见），
 * 此时 `buildAssistantMediaUrl` 只能产出 `/__openclaw__/assistant-media?…` 这样的相对地址。
 * 所以这里兜一层页面 origin（同源部署时它本来就是网关地址）。
 *
 * `origin` 显式传入是为了可测：默认取 `window.location.origin`，Node 单测里没有 window。
 */
export function makeAttachmentDownloadResolver(
  base: string | null | undefined,
  token: string | null | undefined,
  origin?: string | null,
): AttachmentDownloadResolver {
  const explicitBase = typeof base === "string" ? base.trim().replace(/\/+$/, "") : "";
  const fallbackOrigin = (origin ?? pageOrigin()).replace(/\/+$/, "");
  const effectiveBase = explicitBase || fallbackOrigin;
  return (source: string): string | null => {
    const raw = typeof source === "string" ? source.trim() : "";
    if (!raw) return null;
    if (/^blob:/i.test(raw) || /^data:/i.test(raw)) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    const resolved = buildAssistantMediaUrl({ source: raw, base: effectiveBase, token });
    if (!resolved) return null;
    if (!isGatewayHostedMediaUrl(resolved, effectiveBase)) return null;
    return withAssistantMediaDownload(resolved, effectiveBase);
  };
}

/** 附件分类（写进链接标签，读者不用点开就知道是什么）。 */
type ExportAttachmentKind = "image" | "audio" | "video" | "file";

/** 一条消息里收集到的附件引用。 */
export type ExportAttachment = {
  /** 展示名（原始文件名）。 */
  label: string;
  /** 原始引用（本地路径 / `media://` / URL），既做去重 key 也用来解析下载地址。 */
  source: string;
  kind: ExportAttachmentKind;
};

/** 分类 → 中文标签。 */
function attachmentKindLabel(kind: ExportAttachmentKind): string {
  if (kind === "image") return "图片";
  if (kind === "audio") return "音频";
  if (kind === "video") return "视频";
  return "文档";
}

/**
 * 把上游的媒体分类归一到导出用的四档。
 *
 * 上游两处 kind 的取值范围不同（`ContentAttachmentItem` 只有
 * `audio|video|document`，`TranscriptMediaItem` 还有 `image`），
 * 所以不能直接透传 —— 尤其是 `historyMedia` 里的音频，若笼统归成 `file`，
 * 导出的标签会把「音频」写成「文档」。
 */
function toExportKind(kind: string | undefined): ExportAttachmentKind {
  if (kind === "image") return "image";
  if (kind === "audio") return "audio";
  if (kind === "video") return "video";
  return "file";
}

/** 缺名时的兜底展示名。 */
function attachmentDefaultLabel(kind: ExportAttachmentKind): string {
  return kind === "image" ? "图片" : "附件";
}

/**
 * 去掉 URL 里的 `download=1`（图片**预览**地址专用）。
 *
 * 为什么预览要单独去这个参数：带上它时网关按 `attachment` 回 disposition，
 * 部分 markdown 查看器（尤其会走原生网络栈转存图片的）就不再渲染内嵌图。
 * 预览要的是「能看见」、下载链接要的是「点了就存」——两者不共用同一个地址。
 *
 * 三种位置都要能处理（不能只 `replace("&download=1")`，末尾那种会留下悬空分隔符）：
 * `?a=1&download=1` → `?a=1`；`?download=1` → ``（无参数）；`?download=1&a=1` → `?a=1`。
 */
function withoutDownloadFlag(url: string): string {
  if (!/[?&]download=1(?:&|$)/.test(url)) return url;
  const mid = url.replace(/([?&])download=1&/, "$1");
  if (mid !== url) return mid;
  return url.replace(/[?&]download=1$/, "");
}

/**
 * 收集一条消息的**全部**附件引用（四个来源，按原始引用去重）。
 *
 * 四条来源与视图渲染附件的口径一一对应（`ChatPane.vue`），少任何一条都会让导出
 * 比界面**少东西** —— 而少掉的部分用户无法察觉：
 * 1. `contentImages` —— content 块里的图片（助手插图）；
 * 2. `contentAttachments` —— content 块里的音频/视频/文档（含 `MEDIA:` 行被 `normalizeMessage` 剥出来的）；
 * 3. `historyMedia` —— transcript 顶层的 `MediaPaths`（刷新后还原文件卡片靠它）；
 * 4. **正文里的音频路径** —— `extractAudioReferences(msg.text)`。
 *
 * ⚠️ 第 4 条是最容易漏的一路：网关 `chat.history` 的 `content` 实测**只有 `{type:"text"}`**，
 * agent 常把音频（TTS 产物）作为**裸路径写在正文里**（不是 `MEDIA:` 行），
 * 于是它不在 1/2/3 里；可视图的 `audioRefsFor` 会给它渲染一个播放器。
 *
 * 去重按**原始引用**（转小写）做，与视图 `audioRefsFor` 的 `covered` 集合同一口径：
 * 同一条音频既被剥成 `contentAttachments` 又留在正文里时，只出一份。
 */
export function collectMessageAttachments(msg: ChatMessage): ExportAttachment[] {
  const out: ExportAttachment[] = [];
  const seen = new Set<string>();
  const push = (label: string, source: string, kind: ExportAttachmentKind): void => {
    const raw = typeof source === "string" ? source.trim() : "";
    if (!raw) return;
    const key = raw.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: label?.trim() || attachmentDefaultLabel(kind), source: raw, kind });
  };

  for (const img of msg.contentImages ?? []) push(img.alt ?? "", img.url, "image");
  for (const att of msg.contentAttachments ?? []) {
    push(att.label, att.url, toExportKind(att.kind));
  }
  for (const media of msg.historyMedia ?? []) {
    push(media.label, media.source, toExportKind(media.kind));
  }
  for (const ref of extractAudioReferences(msg.text ?? "")) {
    push(ref.label, ref.raw, "audio");
  }
  return out;
}

/**
 * 一条消息的附件 Markdown 段落（无附件返回空数组）。
 *
 * ## 输出形态为什么是这样
 * 整段以 `**附件**` 起头：附件与正文之间需要一个**显式边界**，否则导出的裸链接
 * 会和正文里本来就有 markdown 链接的内容混在一起，读者分不清哪些是附件。
 *
 * ⚠️ **图片必须同时给「内嵌预览」和「可下载链接」**：markdown 的 `![](...)` 是
 * **内嵌图，不是链接** —— 在查看器里它只是一个 `<img>`，点它什么也不会发生。
 * 所以历史上只写 `![]()` 的版本表现是「图片看得到、但点不动、下不下来」。
 * 现在图片出 `![名](预览地址) · [下载](下载地址)`（预览地址不带 `download=1`，
 * 保证查看器能渲染；链接带 `download=1`，点击即下载）。
 *
 * 非图片一律是**可点击的下载链接** `[类型 · 名](地址)`；拿不到地址时退化成
 * `- 类型 · 名（无可用下载链接）`——形态上明确说明「这条附件导出不出来」，
 * 而不是静默丢掉。
 */
function attachmentMarkdown(msg: ChatMessage, resolve: AttachmentDownloadResolver): string[] {
  const items = collectMessageAttachments(msg);
  if (items.length === 0) return [];
  const lines: string[] = ["**附件**", ""];
  for (const item of items) {
    const text = `${attachmentKindLabel(item.kind)} · ${item.label}`;
    const href = resolve(item.source);
    if (!href) {
      lines.push(`- ${text}（无可用下载链接）`);
      continue;
    }
    if (item.kind === "image") {
      lines.push(
        `- ![${item.label}](${withoutDownloadFlag(href)}) · [下载 ${item.label}](${href})`,
      );
    } else {
      lines.push(`- [${text}](${href})`);
    }
  }
  return lines;
}

/**
 * 导出头部的可选元信息。
 *
 * ⚠️ 刻意做成**可选**：头部格式是与上游 `ui/src/pages/chat/export.ts` 对齐的契约，
 * 不传时输出与改动前逐字节相同（旧调用方零影响）。
 */
export type ChatMarkdownMeta = {
  /**
   * 本次导出的消息条数。
   *
   * 只在**全量导出**时传：分页可能因为游标异常提前停下（见
   * `utils/fullChatExport.ts` 的 `FullExportStopReason`），此时把实际条数写进文件，
   * 用户下次打开这份存档才能判断它是否完整。
   */
  messageCount?: number;
};

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
  meta?: ChatMarkdownMeta,
): string | null {
  const history = Array.isArray(messages) ? messages : [];
  if (history.length === 0) return null;
  const lines: string[] = [`# 与 ${assistantName || "助手"} 的对话`, ""];
  const count = meta?.messageCount;
  if (typeof count === "number" && Number.isFinite(count) && count > 0) {
    lines.push(`> 共 ${Math.floor(count)} 条消息`, "");
  }
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
 *
 * `options.filename` 由调用方预先生成（走 `fullChatExport.fullExportFilename`，
 * 助手名过了文件名安全化）；不传时退回本地拼装，保持旧行为。
 * `options.messageCount` 会写进头部（见 `ChatMarkdownMeta`）。
 */
export type ExportChatOptions = {
  filename?: string;
  messageCount?: number;
};

export function exportChatMarkdown(
  messages: ChatMessage[],
  assistantName: string,
  base?: string | null,
  token?: string | null,
  options?: ExportChatOptions,
): boolean {
  const resolve = makeAttachmentDownloadResolver(base, token);
  const markdown = buildChatMarkdown(messages, assistantName, resolve, {
    messageCount: options?.messageCount,
  });
  if (!markdown) return false;
  // ⚠️ 必须带 charset：只有 `text/markdown` 时部分编辑器（含 Windows 记事本）
  // 会按本地代码页猜编码，中文正文直接变乱码 —— 导出是存档，不能赌。
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = options?.filename || `chat-${assistantName || "assistant"}-${Date.now()}.md`;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}
