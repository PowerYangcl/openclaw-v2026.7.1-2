/**
 * 会话记录里的**媒体附件**（`MediaPath` / `MediaPaths`）解析。
 *
 * ## 为什么需要它
 * 页内自己发出去的附件走 `utils/chatAttachments.ts`（模块级 payload，刷新即丢）；
 * 而**刷新后 / 换会话后**的历史消息，附件信息只存在于网关 `chat.history` 返回的
 * user 消息**顶层**字段里：
 *
 * ```json
 * {"role":"user","content":"分析图中信息",
 *  "MediaPath":"/Users/x/.openclaw/media/inbound/xxx.png",
 *  "MediaPaths":["/Users/x/.openclaw/media/inbound/xxx.png"],
 *  "MediaType":"image/png","MediaTypes":["image/png"]}
 * ```
 *
 * ⚠️ **`content` 里确实只有 `{type:"text"}`，但顶层有上面这 4 个字段**。
 * 曾经把「content 里没有」错写成「网关没有 media 字段」（见 `ChatPane.vue` 的
 * `ChatMessage` 与 `utils/assistantMedia.ts` 文件头），导致历史附件一直不显示。
 * 结论改过一次就不该再改回去：**字段是有的，只是没读**。
 *
 * 取字节不在这里做 —— 交给 `utils/assistantMedia.ts` 的 `buildAssistantMediaUrl()`
 * （本地绝对路径 → `/__openclaw__/assistant-media?source=...&token=...`）。
 *
 * 逐条移植自旧版 Lit UI `ui/src/pages/chat/components/chat-message.ts`：
 * `getFileExtension`(378) / `isImageTranscriptMediaPath`(395) / `isAudioTranscriptMediaPath`(412) /
 * `isVideoTranscriptMediaPath`(423) / `labelForMediaPath`(431) / `extractTranscriptMediaEntries`(442)。
 * 判定规则逐字照搬；`kind` 多分 audio/video 两档只为对齐上游附件卡片的分类。
 */

/** 附件类别（决定气泡里渲染成缩略图 / 文件卡片 / 播放器）。 */
export type TranscriptMediaKind = "image" | "audio" | "video" | "document";

export type TranscriptMediaItem = {
  /**
   * 稳定 key（= `source`）。
   *
   * 同一条消息里重复引用同一个路径时**只留一条**，与旧版 `appendImageBlock`
   * 的「按 url 去重」一致 —— 用户传了两次同一个文件，气泡里也只该出现一个。
   */
  key: string;
  /** 原始引用：本地绝对路径 / `~` / `file://` / http(s) / `media://inbound/<id>`。 */
  source: string;
  /** 展示名（文件名）。 */
  label: string;
  kind: TranscriptMediaKind;
  /** 网关报的 MIME；缺失时由 `kind` 推断。 */
  mediaType?: string;
};

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "avif"];
const AUDIO_EXTENSIONS = ["aac", "flac", "m2a", "m4a", "mp3", "oga", "ogg", "opus", "wav"];
const VIDEO_EXTENSIONS = ["m4v", "mov", "mp4", "webm"];

/** 从路径 / URL 里取扩展名（小写，不含点）。 */
export function getMediaFileExtension(source: string): string | undefined {
  const trimmed = typeof source === "string" ? source.trim() : "";
  if (!trimmed) return undefined;
  const pathLike = (() => {
    try {
      if (/^https?:\/\//i.test(trimmed)) {
        return new URL(trimmed).pathname;
      }
    } catch {
      // URL 解析失败就按原串处理（旧版同）。
    }
    return trimmed;
  })();
  const fileName = pathLike.split(/[\\/]/).pop() ?? pathLike;
  const match = /\.([a-zA-Z0-9]+)$/.exec(fileName);
  return match?.[1]?.toLowerCase();
}

/**
 * 是不是图片附件。
 *
 * ⚠️ 中间那条 `application/octet-stream` 分支不能删：网关对无法识别的上传会统一
 * 报 octet-stream，此时**必须**回退到扩展名判断；而报了其它具体 MIME（如
 * `text/markdown`）就是明确「不是图片」，不看扩展名。旧版同款三分支。
 */
export function isImageTranscriptMediaPath(source: string, mediaType?: unknown): boolean {
  if (typeof mediaType === "string" && mediaType.trim()) {
    const normalized = mediaType.trim().toLowerCase();
    if (normalized.startsWith("image/")) return true;
    if (normalized !== "application/octet-stream") return false;
  }
  const extension = getMediaFileExtension(source);
  return extension !== undefined && IMAGE_EXTENSIONS.includes(extension);
}

export function isAudioTranscriptMediaPath(source: string, mediaType?: unknown): boolean {
  if (typeof mediaType === "string" && mediaType.trim().toLowerCase().startsWith("audio/")) {
    return true;
  }
  const extension = getMediaFileExtension(source);
  return extension !== undefined && AUDIO_EXTENSIONS.includes(extension);
}

export function isVideoTranscriptMediaPath(source: string, mediaType?: unknown): boolean {
  if (typeof mediaType === "string" && mediaType.trim().toLowerCase().startsWith("video/")) {
    return true;
  }
  const extension = getMediaFileExtension(source);
  return extension !== undefined && VIDEO_EXTENSIONS.includes(extension);
}

/** 图片 → audio → video → 其余一律 document。 */
export function transcriptMediaKind(source: string, mediaType?: unknown): TranscriptMediaKind {
  if (isImageTranscriptMediaPath(source, mediaType)) return "image";
  if (isAudioTranscriptMediaPath(source, mediaType)) return "audio";
  if (isVideoTranscriptMediaPath(source, mediaType)) return "video";
  return "document";
}

/** 展示用文件名：URL 取 `pathname` 末段，fs 路径取最后一段；都拿不到就回退原串。 */
export function labelForMediaPath(source: string): string {
  const trimmed = typeof source === "string" ? source.trim() : "";
  if (!trimmed) return "";
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      return parsed.pathname.split("/").pop()?.trim() || parsed.hostname || trimmed;
    }
  } catch {
    // 解析失败继续走 fs 路径分支（旧版同）。
  }
  return trimmed.split(/[\\/]/).pop()?.trim() || trimmed;
}

/** 读 `MediaPaths`（数组优先）/ `MediaPath`（单数兜底），过滤空值。 */
export function readTranscriptMediaPaths(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, unknown>;
  const paths = Array.isArray(record.MediaPaths)
    ? record.MediaPaths.filter((value): value is string => typeof value === "string")
    : typeof record.MediaPath === "string"
      ? [record.MediaPath]
      : [];
  return paths.map((value) => value.trim()).filter((value) => value.length > 0);
}

/** 读 `MediaTypes`（数组优先）/ `MediaType`（单数兜底），**下标与 paths 对齐**。 */
export function readTranscriptMediaTypes(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, unknown>;
  return Array.isArray(record.MediaTypes)
    ? record.MediaTypes
    : typeof record.MediaType === "string"
      ? [record.MediaType]
      : [];
}

/**
 * 把一条消息的 `MediaPath(s)` / `MediaType(s)` 解析成可直接渲染的条目列表。
 *
 * `MediaTypes` 比 `MediaPaths` 短（或整个缺失）时，多出来的路径 mediaType 为
 * `undefined` → 走扩展名判断，不会丢附件。
 */
export function extractTranscriptMediaItems(message: unknown): TranscriptMediaItem[] {
  const paths = readTranscriptMediaPaths(message);
  if (paths.length === 0) return [];
  const types = readTranscriptMediaTypes(message);

  const items: TranscriptMediaItem[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < paths.length; index += 1) {
    const source = paths[index]!;
    if (seen.has(source)) continue;
    seen.add(source);
    const mediaType = types[index];
    const normalizedType =
      typeof mediaType === "string" && mediaType.trim() ? mediaType.trim() : undefined;
    items.push({
      key: source,
      source,
      label: labelForMediaPath(source) || source,
      kind: transcriptMediaKind(source, normalizedType),
      mediaType: normalizedType,
    });
  }
  return items;
}
