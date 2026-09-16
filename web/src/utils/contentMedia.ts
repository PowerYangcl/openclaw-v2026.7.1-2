import { resolveSafeExternalUrl } from "@/utils/openExternalUrl";
/**
 * 消息 `content` 数组里的**内嵌媒体块**解析（图片 / 音频附件）。
 *
 * 与 `utils/transcriptMedia.ts` 的分工：
 * - `transcriptMedia.ts` 读的是**消息顶层**的 `MediaPath`/`MediaPaths`（用户上传的附件）；
 * - 本文件读的是 `content` 数组里**逐个 block** 的多模态内容（助手回复、工具结果、配对二维码…）。
 *
 * 逐条移植自旧版 Lit UI `ui/src/pages/chat/components/chat-message.ts`：
 * `buildBase64ImageUrl`(372) / `appendImageBlock`(366) / `extractImages`(463) /
 * `readPairingQrExpiresAtMs`(556) / `isExpiredPairingQrBlock`(561)。
 * `attachment` 块的形状来自 `ui/src/lib/chat/message-normalizer.ts`
 * （把 `{type:"audio",source:{type:"base64"|"url"}}` 归一成
 * `{type:"attachment",attachment:{url,kind,label,mimeType}}`，**仅 assistant**）。
 *
 * ## ⚠️ 本部署下最要紧的一条事实：`omitted`
 * 网关在把工具结果发给 Control UI **之前**会**主动删掉图片的 base64**，只留一个占位：
 * `src/agents/embedded-agent-subscribe.tools.ts:257-262`
 * ```js
 * if (readStringValue(entry.type) === "image") {
 *   const bytes = data ? data.length : undefined;
 *   delete cleaned.data;
 *   return Object.assign({}, cleaned, { bytes, omitted: true });
 * }
 * ```
 * 所以 toolResult 里的 `{type:"image",mimeType,omitted:true,bytes}` **没有任何客户端能渲染**
 * （旧版 `extractImages` 的三个分支分别要 `source.base64.data` / `b.data` / `b.url`，
 * 这里三个都没有 ⇒ 旧版同样渲染不出）。本文件对这种情况**明确跳过**，
 * 而不是渲染一个破图 —— 用单测把这条钉住（否则将来会有人「修」成一张裂图）。
 *
 * 因此真正能渲染的是这几种形态：`image` + `source.base64.data` / `image` + `data` /
 * `image` + `url` / `image_url`（OpenAI 风格）/ `input_image`（Responses 风格）/
 * 未过期的 `openclaw_pairing_qr`，以及助手 `audio` 块（TTS）。
 *
 * ## 刻意偏离上游的四处（都是「让本项目的实现更薄」，不是行为差异）
 * 1. **不做 `mediaTicket` 探测/刷新**：取字节统一走 `/__openclaw__/assistant-media?source=&token=`
 *    （`utils/assistantMedia.ts` 已实测可用，`AudioPlayer` 也走这条路）。上游那套
 *    `resolveAssistantAttachmentAvailability` + 票据过期重取是为了不把 token 写进 `<audio src>`；
 * 2. **不做 `localMediaPreviewRoots` 白名单**：本项目设置里没有这个配置，且音频那条线
 *    （`extractAudioReferences`）本来就不做，保持一致优于单点收紧；
 * 3. **不做配对二维码的「已过期」提示卡与刷新定时器**：本项目没有配对流程，
 *    只在解析期按 `expiresAtMs` 过滤掉过期块（副作用：加载后刚好过期的二维码会留到下次刷新）；
 * 4. **不做 `/api/chat/media/outgoing/` 的 fetch→blob 转换**：该路径由
 *    `buildAssistantMediaUrl` 当「站内托管路径」直接拼网关源 + token 给 `<img src>` 用。
 */
import { extractTranscriptMediaItems, labelForMediaPath } from "@/utils/transcriptMedia";

/** 一张可渲染的图片块（`url` 是**原始**引用，渲染前要过 `buildAssistantMediaUrl`）。 */
export type ContentImageBlock = {
  url: string;
  alt?: string;
  openUrl?: string;
  width?: number;
  height?: number;
};

/** 一个可渲染的附件块（非图片：音频 / 视频 / 文档）。 */
export type ContentAttachmentItem = {
  kind: "audio" | "video" | "document";
  /** 原始引用（`data:` / http(s) / 本地路径 / `media://inbound/<id>`）。 */
  url: string;
  label: string;
  mimeType?: string;
};

const DEFAULT_BASE64_IMAGE_MIME = "image/png";
const DEFAULT_BASE64_AUDIO_MIME = "audio/mpeg";

/** 与旧版 `buildBase64ImageUrl` 逐字一致：已经是 `data:` 就原样用，否则按 MIME 包一层。 */
export function buildBase64DataUrl(data: string, mediaType?: string): string {
  return data.startsWith("data:")
    ? data
    : `data:${mediaType ?? DEFAULT_BASE64_IMAGE_MIME};base64,${data}`;
}

/** 读 `openclaw_pairing_qr` 块的过期时间（ms）；缺失/非法返回 undefined。 */
export function readPairingQrExpiresAtMs(block: Record<string, unknown>): number | undefined {
  const value = block.expiresAtMs;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 配对二维码是否已过期（无过期时间视为永不过期）。 */
export function isExpiredPairingQrBlock(
  block: Record<string, unknown>,
  nowMs: number = Date.now(),
): boolean {
  const expiresAtMs = readPairingQrExpiresAtMs(block);
  return expiresAtMs !== undefined && expiresAtMs <= nowMs;
}

/** 按「url + alt」去重追加（与旧版 `appendImageBlock` 同口径）。 */
function appendImageBlock(images: ContentImageBlock[], block: ContentImageBlock): void {
  if (!images.some((entry) => entry.url === block.url && entry.alt === block.alt)) {
    images.push(block);
  }
}

function readImageMeta(block: Record<string, unknown>): Omit<ContentImageBlock, "url"> {
  return {
    ...(typeof block.alt === "string" ? { alt: block.alt } : {}),
    ...(typeof block.openUrl === "string" ? { openUrl: block.openUrl } : {}),
    ...(typeof block.width === "number" ? { width: block.width } : {}),
    ...(typeof block.height === "number" ? { height: block.height } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 从一条消息里取出所有可渲染的图片块。
 *
 * 末尾会把**消息顶层** `MediaPaths` 里的图片也并进来（旧版行为：图片与附件走同一个列表），
 * 这样 `image` 块与用户上传的附件不会因为来源不同而漏掉任何一个。
 */
export function extractContentImages(
  message: unknown,
  nowMs: number = Date.now(),
): ContentImageBlock[] {
  const images: ContentImageBlock[] = [];
  if (!isRecord(message)) return images;

  const content = message.content;
  if (Array.isArray(content)) {
    for (const raw of content) {
      if (!isRecord(raw)) continue;
      const type = typeof raw.type === "string" ? raw.type : "";

      if (type === "image") {
        const meta = readImageMeta(raw);
        const source = isRecord(raw.source) ? raw.source : undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          appendImageBlock(images, {
            url: buildBase64DataUrl(
              source.data,
              typeof source.media_type === "string" ? source.media_type : undefined,
            ),
            ...meta,
          });
        } else if (typeof raw.data === "string") {
          // 未过 `omitted` 清洗的直接 image 块（旧版注释：imageResult() / read 工具）
          appendImageBlock(images, {
            url: buildBase64DataUrl(
              raw.data,
              typeof raw.mimeType === "string" ? raw.mimeType : undefined,
            ),
            ...meta,
          });
        } else if (typeof raw.url === "string") {
          appendImageBlock(images, { url: raw.url, ...meta });
        }
        // 其余情况（含 `omitted:true`）刻意不产出任何块 —— 见文件头说明。
        continue;
      }

      if (type === "image_url") {
        // OpenAI 风格：{type:"image_url", image_url:{url}}
        const imageUrl = isRecord(raw.image_url) ? raw.image_url : undefined;
        if (typeof imageUrl?.url === "string") {
          appendImageBlock(images, { url: imageUrl.url });
        }
        continue;
      }

      if (type === "input_image") {
        // Responses 风格：image_url 可能是字符串或对象；另有 source.url / source.data 两条兜底
        const rawImageUrl = raw.image_url;
        if (typeof rawImageUrl === "string") {
          appendImageBlock(images, { url: rawImageUrl });
        } else if (isRecord(rawImageUrl) && typeof rawImageUrl.url === "string") {
          appendImageBlock(images, { url: rawImageUrl.url });
        }
        const source = isRecord(raw.source) ? raw.source : undefined;
        if (typeof source?.url === "string") {
          appendImageBlock(images, { url: source.url });
        } else if (typeof source?.data === "string") {
          appendImageBlock(images, {
            url: buildBase64DataUrl(
              source.data,
              typeof source.media_type === "string" ? source.media_type : undefined,
            ),
          });
        }
        continue;
      }

      if (type === "openclaw_pairing_qr") {
        // 过期的二维码不再展示（旧版还会渲染一张「已过期」提示卡 + 定时器，
        // 本项目没有配对流程，只做解析期过滤 —— 见文件头「刻意偏离上游」第 3 条）。
        if (isExpiredPairingQrBlock(raw, nowMs)) continue;
        if (typeof raw.image_url === "string") {
          appendImageBlock(images, {
            url: raw.image_url,
            ...(typeof raw.alt === "string" ? { alt: raw.alt } : {}),
          });
        }
      }
    }
  }

  // 顶层 MediaPaths 里的图片一并并入（旧版 `extractImages` 尾部就是这么做的）
  for (const media of extractTranscriptMediaItems(message)) {
    if (media.kind !== "image") continue;
    appendImageBlock(images, { url: media.source });
  }

  return images;
}

function normalizeAttachmentKind(
  value: unknown,
  url: string,
  mimeType?: string,
): ContentAttachmentItem["kind"] {
  if (value === "audio" || value === "video" || value === "document") {
    return value;
  }
  const lower = (mimeType ?? "").toLowerCase();
  if (lower.startsWith("audio/")) return "audio";
  if (lower.startsWith("video/")) return "video";
  if (/\.(?:mp3|wav|m4a|ogg|opus|flac)$/i.test(url)) return "audio";
  if (/\.(?:mp4|mov|webm|m4v)$/i.test(url)) return "video";
  return "document";
}

/**
 * 从一条消息里取出所有可渲染的**非图片**附件。
 *
 * 三个来源（与旧版一致）：
 * 1. `content` 里已经是 `{type:"attachment", attachment:{url,kind,label,mimeType}}` 的块；
 * 2. `content` 里的助手 `{type:"audio", label, source}` 块（TTS）—— 旧版 `message-normalizer`
 *    在做归一化时就把它变成了 attachment，我们在这里等价地补上，**仅 assistant**
 *    （旧版单测 `message-normalizer.test.ts:186` 明确要求 user 的 audio 块不转附件）；
 * 3. 消息顶层 `MediaPaths` 里的非图片（文档 / 音频 / 视频）。
 *
 * ⚠️ 第 3 条**只对非 user 生效**：user 的 `MediaPaths` 已经由
 * `utils/transcriptMedia.ts` + `ChatPane.vue` 的气泡附件条渲染过，这里再产出一次会**重复显示**。
 */
export function extractContentAttachments(message: unknown): ContentAttachmentItem[] {
  const out: ContentAttachmentItem[] = [];
  if (!isRecord(message)) return out;
  const role = typeof message.role === "string" ? message.role : "";

  const append = (item: ContentAttachmentItem): void => {
    if (!item.url) return;
    if (out.some((entry) => entry.url === item.url && entry.kind === item.kind)) return;
    out.push(item);
  };

  const content = message.content;
  if (Array.isArray(content)) {
    for (const raw of content) {
      if (!isRecord(raw)) continue;
      const type = typeof raw.type === "string" ? raw.type : "";

      if (type === "attachment") {
        const attachment = isRecord(raw.attachment) ? raw.attachment : undefined;
        const url = typeof attachment?.url === "string" ? attachment.url : "";
        if (!url) continue;
        const mimeType = typeof attachment?.mimeType === "string" ? attachment.mimeType : undefined;
        append({
          kind: normalizeAttachmentKind(attachment?.kind, url, mimeType),
          url,
          label:
            typeof attachment?.label === "string" && attachment.label.trim()
              ? attachment.label
              : labelForMediaPath(url) || url,
          ...(mimeType ? { mimeType } : {}),
        });
        continue;
      }

      if (type === "audio" && role === "assistant") {
        const source = isRecord(raw.source) ? raw.source : undefined;
        const mediaType =
          typeof source?.media_type === "string" ? source.media_type : DEFAULT_BASE64_AUDIO_MIME;
        let url = "";
        if (source?.type === "base64" && typeof source.data === "string") {
          url = buildBase64DataUrl(source.data, mediaType);
        } else if (typeof source?.url === "string") {
          url = source.url;
        }
        if (!url) continue;
        append({
          kind: "audio",
          url,
          label:
            typeof raw.label === "string" && raw.label.trim()
              ? raw.label
              : labelForMediaPath(url) || url,
          mimeType: mediaType,
        });
      }
    }
  }

  if (role !== "user") {
    for (const media of extractTranscriptMediaItems(message)) {
      if (media.kind === "image") continue;
      append({
        kind: media.kind === "audio" ? "audio" : media.kind === "video" ? "video" : "document",
        url: media.source,
        label: media.label,
        ...(media.mediaType ? { mimeType: media.mediaType } : {}),
      });
    }
  }

  return out;
}

/** 图片块是否来自「用户上传的附件」（顶层 MediaPaths），用于避免与气泡附件条重复渲染。 */
export function contentImageIsTranscriptMedia(image: ContentImageBlock, message: unknown): boolean {
  return extractTranscriptMediaItems(message).some(
    (item) => item.kind === "image" && item.source === image.url,
  );
}

/** 滤掉已由气泡附件条渲染过的那些（用户消息用，避免同一张图出现两次）。 */
export function contentImagesExcludingTranscriptMedia(
  message: unknown,
  images: readonly ContentImageBlock[],
): ContentImageBlock[] {
  return images.filter((image) => !contentImageIsTranscriptMedia(image, message));
}

/**
 * 附件卡片 `<a href>` 用的**渲染期**白名单结果。
 *
 * 与 `chatAttachmentPreviewHref` 同一个规矩（见 `utils/openExternalUrl.ts`）：
 * **拿不到安全地址就不渲染 href**，节点退化成纯展示 —— 而不是先写进 DOM 再在点击时拦。
 * 这里尤其重要：图片块/音频块可能是 `data:` 形态，其中 `data:image/svg+xml` 直接导航过去
 * 是会执行脚本的。
 */
export function contentMediaSafeHref(
  resolvedUrl: string,
  baseHref: string = typeof window === "undefined" ? "http://localhost/" : window.location.href,
): string | null {
  if (!resolvedUrl) return null;
  return resolveSafeExternalUrl(resolvedUrl, baseHref, { allowDataImage: true });
}
