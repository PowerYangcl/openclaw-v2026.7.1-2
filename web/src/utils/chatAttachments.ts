/**
 * 会话附件（选择 / 读取 / 预览 / 发送）的唯一实现。
 *
 * 逐条移植自旧版 Lit UI：
 * - `ui/src/lib/chat/chat-types.ts` 的 `ChatAttachment`
 * - `ui/src/pages/chat/attachment-payload-store.ts`（payload store）
 * - `ui/src/pages/chat/components/chat-composer.ts`
 *   （`CHAT_ATTACHMENT_ACCEPT` / `isSupportedChatAttachmentFile` /
 *    `isImageAttachment` / `generateAttachmentId` / `chatAttachmentFromFile` /
 *    `dataImageClipboardFile` / `handleChatAttachmentFileSelect` / `handleChatAttachmentPaste`）
 * - `ui/src/pages/chat/chat-send.ts` 的 `dataUrlToBase64` / `buildApiAttachments`
 *
 * ## 为什么需要 payload store
 * `ChatAttachment` 的**元数据**（id/mimeType/fileName/sizeBytes）要能安全地放进
 * 会话队列、日志、持久化；而 `dataUrl`（整份 base64）体积大且只在「发送那一刻」有用。
 * 旧版把 payload 放在模块级 Map 里，`ChatAttachment` 只带 id：
 * - 预览用 `URL.createObjectURL(file)`（不进内存 base64，大图不卡）；
 * - 发送时用 `getChatAttachmentDataUrl()` 取回 base64 拼 `chat.send.attachments`；
 * - 移除 / 发送完成后 `release*` 掉，避免 objectURL 泄漏。
 *
 * ⚠️ 这是**进程内内存**：刷新页面即丢。附件只在「还没发出去」的这段时间存在，
 * 与旧版一致（旧版同样不持久化 composer 附件，见 `composer-persistence` 只存文本草稿）。
 */
import { resolveSafeExternalUrl } from "@/utils/openExternalUrl";

/** 附件元数据（与旧版 `ChatAttachment` 字段一一对应）。 */
export type ChatAttachment = {
  id: string;
  /** 完整 base64 data URL；只在 payload store 里，元数据副本上通常没有。 */
  dataUrl?: string;
  /** 预览地址（优先 objectURL，退化到 dataUrl）。 */
  previewUrl?: string;
  mimeType: string;
  fileName?: string;
  sizeBytes?: number;
};

/** 网关 `chat.send` 的 `attachments[]` 线格式（见 server-methods/attachment-normalize.ts）。 */
export type ApiChatAttachment = {
  type: "image" | "file";
  mimeType: string;
  fileName?: string;
  /** **纯 base64**，不带 `data:...;base64,` 前缀。 */
  content: string;
};

/** 文件选择框的 accept（与旧版逐字一致）。 */
export const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";

/**
 * 网关不支持视频附件（`chat-attachments.ts` 会拒绝）——旧版在**前端**就按
 * mime + 扩展名双重过滤掉，避免用户选了之后才报错。
 */
export function isSupportedChatAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("video/")) {
    return false;
  }
  return !/\.(?:avi|m4v|mov|mp4|mpeg|mpg|webm)$/i.test(file.name);
}

/** 图片附件走缩略图预览，其余走「文件名」卡片。 */
export function isImageAttachment(att: Pick<ChatAttachment, "mimeType">): boolean {
  return att.mimeType.startsWith("image/");
}

/** 人可读的体积文案（旧版未展示，本项目在文件名卡片上补一个）。 */
export function formatAttachmentSize(sizeBytes: number | undefined): string {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "";
  }
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// payload store
// ---------------------------------------------------------------------------

type AttachmentPayload = {
  dataUrl?: string;
  previewUrl?: string;
};

const payloads = new Map<string, AttachmentPayload>();

function createObjectUrl(file: File): string | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return undefined;
  }
  return URL.createObjectURL(file);
}

function revokeObjectUrl(url: string | undefined): void {
  if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  URL.revokeObjectURL(url);
}

/** 登记一份附件 payload，返回带 `previewUrl` 的元数据副本。 */
export function registerChatAttachmentPayload(params: {
  attachment: ChatAttachment;
  dataUrl: string;
  file: File;
}): ChatAttachment {
  const previous = payloads.get(params.attachment.id);
  revokeObjectUrl(previous?.previewUrl);
  const previewUrl = createObjectUrl(params.file) ?? params.attachment.previewUrl;
  payloads.set(params.attachment.id, {
    dataUrl: params.dataUrl,
    ...(previewUrl ? { previewUrl } : {}),
  });
  return {
    ...params.attachment,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

export function getChatAttachmentDataUrl(attachment: ChatAttachment): string | null {
  return attachment.dataUrl ?? payloads.get(attachment.id)?.dataUrl ?? null;
}

export function getChatAttachmentPreviewUrl(attachment: ChatAttachment): string | null {
  return (
    attachment.previewUrl ?? payloads.get(attachment.id)?.previewUrl ?? attachment.dataUrl ?? null
  );
}

/**
 * 「点开看附件」用的**安全地址**：通过白名单校验（见 `utils/openExternalUrl.ts`）。
 *
 * 三步缺一不可：
 * 1. 取预览地址（大图走 objectURL，退化到 dataUrl）；
 * 2. 过白名单 —— `data:application/pdf` / `javascript:` 这类一律不给；
 * 3. 拿不到就返回 `null`，调用方**不要渲染成链接**（渲染后再拦已经晚了）。
 *
 * `baseHref` 可注入是为了单测（Node 里没有 `window`）。
 */
export function chatAttachmentPreviewHref(
  attachment: ChatAttachment,
  baseHref: string = typeof window === "undefined" ? "http://localhost/" : window.location.href,
): string | null {
  const raw = getChatAttachmentPreviewUrl(attachment);
  if (!raw) {
    return null;
  }
  return resolveSafeExternalUrl(raw, baseHref, { allowDataImage: true });
}

/** 释放单个附件的 payload（移除附件 / 发送完成后调用）。 */
export function releaseChatAttachmentPayload(id: string): void {
  const payload = payloads.get(id);
  if (!payload) {
    return;
  }
  revokeObjectUrl(payload.previewUrl);
  payloads.delete(id);
}

export function releaseChatAttachmentPayloads(attachments: readonly ChatAttachment[] = []): void {
  for (const attachment of attachments) {
    releaseChatAttachmentPayload(attachment.id);
  }
}

/**
 * 发送成功后丢掉 base64，**保留 objectURL**。
 *
 * 为什么不能直接 `release`：消息已经渲染在对话里，缩略图还要靠 objectURL 显示。
 * 但整份 base64 留在内存里没有意义（已经发出去了），大附件会一直占着几十 MB。
 * 旧版 `discardChatAttachmentDataUrls` 就是这条界线。
 */
function discardChatAttachmentDataUrl(id: string): void {
  const payload = payloads.get(id);
  if (!payload) {
    return;
  }
  if (payload.previewUrl) {
    payloads.set(id, { previewUrl: payload.previewUrl });
    return;
  }
  payloads.delete(id);
}

export function discardChatAttachmentDataUrls(attachments: readonly ChatAttachment[] = []): void {
  for (const attachment of attachments) {
    discardChatAttachmentDataUrl(attachment.id);
  }
}

/** 只留元数据（去掉 dataUrl / previewUrl），供放进渲染列表或持久化。 */
export function cloneChatAttachmentMetadata(attachment: ChatAttachment): ChatAttachment {
  const { dataUrl: _dataUrl, previewUrl: _previewUrl, ...metadata } = attachment;
  return metadata;
}

export function cloneChatAttachmentsMetadata(
  attachments: readonly ChatAttachment[],
): ChatAttachment[] {
  return attachments.map(cloneChatAttachmentMetadata);
}

/** 清空 payload store（单测用；生产代码不应调用）。 */
export function resetChatAttachmentPayloadStoreForTest(): void {
  for (const payload of payloads.values()) {
    revokeObjectUrl(payload.previewUrl);
  }
  payloads.clear();
}

// ---------------------------------------------------------------------------
// File / clipboard → ChatAttachment
// ---------------------------------------------------------------------------

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function chatAttachmentFromFile(file: File, dataUrl: string): ChatAttachment {
  return registerChatAttachmentPayload({
    attachment: {
      id: generateAttachmentId(),
      mimeType: file.type || "application/octet-stream",
      fileName: file.name || undefined,
      sizeBytes: file.size,
    },
    dataUrl,
    file,
  });
}

/**
 * 读取 File 为 dataURL 并登记 payload。
 *
 * 旧版用 `FileReader.onload` 累加到一个数组、等 `pending === 0` 才一次性
 * `onAttachmentsChange`（避免多选时多次覆盖）。这里换成 Promise.all + 数组
 * **保序**（旧版 `additions.push` 是「谁先读完谁先进」，多选大图时顺序会乱）。
 */
export function readChatAttachment(file: File): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(chatAttachmentFromFile(file, String(reader.result ?? "")));
    });
    reader.addEventListener("error", () => {
      reject(new Error(`无法读取文件「${file.name || "未命名"}」`));
    });
    reader.readAsDataURL(file);
  });
}

/** 过滤掉不支持的文件；返回保序的附件数组。 */
export async function readChatAttachments(files: Iterable<File>): Promise<ChatAttachment[]> {
  const supported: File[] = [];
  for (const file of files) {
    if (isSupportedChatAttachmentFile(file)) {
      supported.push(file);
    }
  }
  return Promise.all(supported.map((file) => readChatAttachment(file)));
}

/**
 * 剪贴板里的「data:image/...;base64,xxx」纯文本 → File。
 *
 * 从截图工具直接 Ctrl+V 到输入框时，`clipboardData.items` 里可能没有 File，
 * 只有一个图片 dataURL 文本 —— 旧版 `dataImageClipboardFile` 就是为这条路径准备的。
 */
export function dataImageClipboardFile(dataUrl: string): { file: File; dataUrl: string } | null {
  const match = /^\s*data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\s*$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
    return {
      file: new File([bytes], `pasted-image.${extension}`, { type: mimeType }),
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

/** 收集剪贴板事件里的图片附件（保序返回 File 列表）。 */
export function chatAttachmentFilesFromClipboard(clipboardData: DataTransfer | null): File[] {
  const items = clipboardData?.items;
  if (items) {
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length > 0) {
      return files;
    }
  }
  // 没有 File 项时，回退到「图片 dataURL 文本」这条路径（截图工具常见行为）。
  const pasted = dataImageClipboardFile(clipboardData?.getData("text/plain") ?? "");
  return pasted ? [pasted.file] : [];
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

/**
 * 把 composer 附件转成 `chat.send` 的 `attachments[]`。
 *
 * - `type`: `image/*` → `"image"`，其余 → `"file"`（网关按类型决定内联/落盘）。
 * - `content`: **纯 base64**（网关的 `normalizeRpcAttachmentsToChatAttachments` 接受字符串）。
 * - 取不到 dataUrl 的（payload 已被释放）直接丢弃 —— 旧版同样 `.filter(Boolean)`。
 */
export function buildApiAttachments(
  attachments: readonly ChatAttachment[] | undefined,
): ApiChatAttachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  const out: ApiChatAttachment[] = [];
  for (const att of attachments) {
    const dataUrl = getChatAttachmentDataUrl(att);
    const parsed = dataUrl ? dataUrlToBase64(dataUrl) : null;
    if (!parsed) {
      continue;
    }
    out.push({
      type: parsed.mimeType.startsWith("image/") ? "image" : "file",
      mimeType: parsed.mimeType,
      ...(att.fileName ? { fileName: att.fileName } : {}),
      content: parsed.content,
    });
  }
  return out.length > 0 ? out : undefined;
}
