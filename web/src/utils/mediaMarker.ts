/**
 * 助手/工具输出正文里的 **`MEDIA:<引用>` 文本约定**解析。
 *
 * ## 为什么需要它（这是一个真 bug 的根因）
 * 助手让文件「出现」在对话里的方式，是在**回复正文**里写一行：
 * ```
 * PDF 已重新生成，无警告了 ✅
 *
 * MEDIA:/Users/x/.openclaw/workspace/cet4_vocab_batch3.pdf
 * ```
 * 实测（CDP 读真实 `chat.history`）这条消息的字段是
 * `role,content,api,provider,model,usage,stopReason,timestamp,responseId,__openclaw`
 * —— **没有 `MediaPaths`**。所以「附件从哪来」的三条既有线（模块级 `chatAttachments`、
 * 顶层 `MediaPath(s)`、`content` 内嵌块）**一条都覆盖不到**，结果是：
 * ①正文里那行 `MEDIA:/...` 赤裸裸地显示出来；②没有任何可点/可下载的按钮。
 *
 * 旧版把这一步放在 `ui/src/lib/chat/message-normalizer.ts` 的 `expandTextContent` 里，
 * 底层是 `src/media/parse.ts` 的 `splitMediaFromOutput`。本文件是它的**客户端精简移植**
 * （只做 `MEDIA:` 这一条语法，不移植 `extractMarkdownImages` 与 `[[audio_as_voice]]`，
 * 因为本项目调用时那两项都是关闭的）。
 *
 * ## 逐行移植，保留三条容易改错的语义
 * 1. **围栏（``` / ~~~）内的 `MEDIA:` 不提取** —— 它是文档示例，提取会篡改正文；
 * 2. **整行只有 `MEDIA:` 时，该行整行消失**（不留空行）——「文本保真 + 媒体提到卡片位」；
 * 3. **非法但明显是本地路径的 `MEDIA:` 行整行丢弃**，绝不当可见文本泄漏
 *    （上游注释：internal tools like TTS 的绝对路径不该出现在气泡里）。
 * 4. **整行被一对反引号包住的 `MEDIA:` 行仍按投递处理**（`codeSpanWrappedMediaLine`）——
 *    模型经常把指令整行写进「行内代码」：`` `MEDIA:/root/x.docx` ``。上游与「行内 code span
 *    里的 `MEDIA:` 是讲解举例」那条规则会把这种行当示例放过 ⇒ **附件卡片消失、正文里还留着
 *    一行 `MEDIA:` 脏文本**（预发实测正是这样）。判据收紧到「整行只有这一对反引号 +
 *    去壳后能解析出至少一条可渲染引用」，正文中段出现的 `` `MEDIA:/x.mp3` `` 举例不受影响。
 *
 * ## 与上游的取舍（都是「让客户端实现更薄」，不是行为差异）
 * 1. **不做 `meta=1` 可用性探测 + blocked 卡片**：上游会先探测本地文件是否在允许目录内，
 *    不可用就渲染一张「不可用 + 原因」的卡。本项目取字节统一走
 *    `/__openclaw__/assistant-media?source=&token=`（网关侧本来就只放行 agent workspace），
 *    与既有的历史附件条同一套做法 —— 保持一致优于单点收紧；
 * 2. **不做 `localMediaPreviewRoots` 白名单**：本项目设置里没有这个配置项；
 * 3. **IP 字面量分类自带一份精简实现**（`isBlockedIpv4Literal` / `isBlockedIpv6Literal`），
 *    不引 `ipaddr.js`。覆盖 loopback / 私网 / CGNAT / link-local / 组播 / 保留段 /
 *    ULA / v4-mapped，以及 `2130706433`、`0x7f.0.0.1` 这类**非规范数字形式**；
 *    **未覆盖** rfc6145 / rfc6052 过渡前缀（上游用 `extractEmbeddedIpv4FromIpv6` 处理）。
 *    客户端红线其实由 `utils/openExternalUrl.ts` 兜底（http/https/blob，`data:` 仅图片），
 *    这里只是不放过上游明确拒绝的形态。
 */
import { labelForMediaPath, transcriptMediaKind, type TranscriptMediaKind } from "@/utils/transcriptMedia";

/** 旧版 `src/media/parse.ts` 的同名正则：捕获 `MEDIA:` 后面的整段（可含反引号包裹）。 */
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;

export type MediaMarkerAttachment = {
  /** 原始引用（本地绝对路径 / `~` / `file://` / http(s) / `media://inbound/<id>`）。 */
  url: string;
  kind: TranscriptMediaKind;
  label: string;
  mimeType?: string;
};

export type MediaMarkerSplit = {
  /** 已剥离可渲染 `MEDIA:` 行的可见正文。 */
  text: string;
  /** 可渲染的引用（按出现顺序去重）。 */
  media: string[];
};

// ---------------------------------------------------------------------------
// 常量（与上游逐条对齐）
// ---------------------------------------------------------------------------

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT = /\.\w{1,10}$/;
const HTTP_URL_PREFIX_RE = /^https?:\/\//i;
/** `..` 作为独立路径段出现（首/中/尾）。 */
const TRAVERSAL_SEGMENT_RE = /(?:^|[/\\])\.\.(?:[/\\]|$)/;
/** 序列化 JSON 尾巴：`.png\"` 后面跟 `]},:` 或行尾 —— 先切掉再判定。 */
const TRAILING_SERIALIZED_JSON_AFTER_EXT_RE = /^(.*\.\w{1,10})\\?"(?=[\]},:]|$).*/s;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/opus",
  m4a: "audio/mp4",
  m2a: "audio/mpeg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  html: "text/html",
  htm: "text/html",
  // Office 产物。⚠️ 以前这张表没有它们，直接后果是**卡片上的 mimeType 为空**
  // （`inferMediaAttachment` 取不到 → 下游只能靠扩展名兜底），而且
  // `RELATIVE_ARTIFACT_EXT_RE` 同步缺失 ⇒ 助手按相对路径交付
  // `MEDIA:备考计划.docx` 时既不产卡片、正文里还留一行 `MEDIA:`。
  // 预发截图里丢按钮的正是 docx / xlsx 这两类。
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
};

/**
 * 扩展名明确属于「产物」的**相对引用**（`./lobster-invaders.html`、`report.docx`）。
 *
 * ⚠️ 与上游的刻意差异：上游把相对引用原样留在正文里（`isRenderableMediaReference`
 * 返回 false）。但 HTML / 小游戏 / 办公文档这类产物，助手是按 prompt 给的**相对路径**
 * 交付的（`MEDIA:./x.html`、`MEDIA:备考计划.docx`），而 `chat.history` 里网关往往已把
 * 它规范成 workspace 绝对路径 ⇒ 首次返回判为「不可渲染」⇒ 没有卡片、正文还多一行
 * `MEDIA:./x.html`；刷新后却变成绝对路径、卡片出现了 —— 正是「下载入口要刷新才出现」。
 * 因此：扩展名明确属于产物时放行成卡片，其余相对引用仍按上游保留原文。
 *
 * ⚠️ 这份清单必须与 `MIME_BY_EXT` 的键**同步扩展**：两边缺一个，对应格式的
 * 相对交付就退化成「没有卡片 + 正文残留 `MEDIA:`」（docx / xlsx 曾经就是这样）。
 */
const RELATIVE_ARTIFACT_EXT_RE =
  /\.(?:html?|pdf|md|csv|json|zip|txt|png|jpe?g|gif|webp|svg|avif|heic|heif|bmp|mp3|wav|m4a|m2a|aac|ogg|oga|opus|flac|mp4|webm|mov|m4v|docx?|xlsx?|pptx?|od[stp]|rtf)$/i;

// ---------------------------------------------------------------------------
// 引用形态判定
// ---------------------------------------------------------------------------

/** `file://` → 纯本地路径（下游统一按路径处理）。 */
export function normalizeMediaSource(source: string): string {
  return source.startsWith("file://") ? source.replace("file://", "") : source;
}

/** 去掉包裹的引号/括号与结尾的 `\"` 序列化残渣（上游 `cleanCandidate`）。 */
function cleanCandidate(raw: string): string {
  const stripped = raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
  const jsonSuffix = TRAILING_SERIALIZED_JSON_AFTER_EXT_RE.exec(stripped);
  return jsonSuffix?.[1] ?? stripped;
}

/** 整段被同一对引号包住时返回内部内容（上游 `unwrapQuoted`）。 */
function unwrapQuoted(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) return undefined;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last) return undefined;
  if (first !== `"` && first !== `'` && first !== "`") return undefined;
  return trimmed.slice(1, -1).trim();
}

function cleanLineText(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

function isSupportedHomeRelativePath(candidate: string): boolean {
  return candidate.startsWith("~/") || candidate.startsWith("~\\");
}

/** 目录穿越 / 不支持的 `~` 形式（`~foo`）。 */
function hasTraversalOrUnsupportedHomeDirPrefix(candidate: string): boolean {
  return (
    candidate.startsWith("../") ||
    candidate === ".." ||
    (candidate.startsWith("~") && !isSupportedHomeRelativePath(candidate)) ||
    TRAVERSAL_SEGMENT_RE.test(candidate)
  );
}

/**
 * 结构上像不像本地路径 —— **只用于「要不要把这一行从正文里删掉」**，
 * 绝不用于「要不要渲染」（上游注释同此）。
 */
function looksLikeLocalFilePath(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(candidate) ||
    candidate.startsWith("\\\\") ||
    (!SCHEME_RE.test(candidate) && (candidate.includes("/") || candidate.includes("\\")))
  );
}

/** 允许放行的本地路径形态（挡掉穿越与不支持的 `~`）。 */
function isLikelyLocalPath(candidate: string): boolean {
  if (hasTraversalOrUnsupportedHomeDirPrefix(candidate)) return false;
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    isSupportedHomeRelativePath(candidate) ||
    WINDOWS_DRIVE_RE.test(candidate) ||
    candidate.startsWith("\\\\") ||
    (!SCHEME_RE.test(candidate) && (candidate.includes("/") || candidate.includes("\\")))
  );
}

function normalizeRemoteMediaHostname(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (normalized.split(".").some((label) => label.length === 0)) return "";
  return normalized;
}

/** 私网 / 保留 / 组播 / 环回等特殊用途 IPv4（对齐上游 blocked special-use ranges）。 */
function isBlockedIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    if (value > 255) return false;
    nums.push(value);
  }
  const a = nums[0]!;
  const b = nums[1]!;
  const c = nums[2]!;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24 + TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 组播 + 保留 + 广播
  return false;
}

/** IPv6 字面量的环回 / 未指定 / ULA / link-local / v4-mapped（递归校验内嵌 v4）。 */
function isBlockedIpv6Literal(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true; // fe80::/10 link-local
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted) return isBlockedIpv4Literal(dotted[1]!);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    return isBlockedIpv4Literal([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join("."));
  }
  return false;
}

/**
 * 非规范的 IPv4 数字形式（`2130706433`、`0x7f.0.0.1`、`127.1`）。
 *
 * 上游靠 `!isCanonicalDottedDecimalIPv4 && isLegacyIpv4Literal` 判定；这里用
 * 「每个 label 都是十进制或 0x 十六进制，且整体不是规范 dotted-decimal」等价表达。
 */
function isLegacyIpv4LiteralHost(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // 规范形式另行分类
  return /^(?:\d+|0x[0-9a-f]+)(?:\.(?:\d+|0x[0-9a-f]+))*$/i.test(host);
}

function isBlockedRemoteMediaHostname(hostname: string): boolean {
  const normalized = normalizeRemoteMediaHostname(hostname);
  if (!normalized) return true;
  if (!normalized.includes(".")) return true; // 裸主机名（含 localhost）
  if (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }
  if (normalized.includes(":")) return isBlockedIpv6Literal(normalized);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) return isBlockedIpv4Literal(normalized);
  return isLegacyIpv4LiteralHost(normalized);
}

/** 远端媒体只放行**公开 https**（上游 `isAllowedRemoteMediaUrl`）。 */
function isAllowedRemoteMediaUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !isBlockedRemoteMediaHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isValidMedia(
  candidate: string,
  opts?: { allowSpaces?: boolean; allowBareFilename?: boolean; allowArtifactFilename?: boolean },
): boolean {
  if (!candidate) return false;
  if (candidate.length > 4096) return false;
  if (!opts?.allowSpaces && /\s/.test(candidate)) return false;
  if (HTTP_URL_PREFIX_RE.test(candidate)) return isAllowedRemoteMediaUrl(candidate);
  if (isLikelyLocalPath(candidate)) return true;
  if (hasTraversalOrUnsupportedHomeDirPrefix(candidate)) return false;
  // 产物扩展名的裸文件名（`report.html`）：助手交付产物时常只写文件名，而网关是按
  // agent workspace 解析 `source` 的，取得到字节。
  // ⚠️ 只在「不会拆成碎片」时放行（见 splitMediaMarkers 的 mediaOpts）：含空格的
  // 本地路径要靠「回退 1」把碎片合成整条，提前放行片段会把 `test image.png` 拆成两个文件。
  if (opts?.allowArtifactFilename && !SCHEME_RE.test(candidate) && RELATIVE_ARTIFACT_EXT_RE.test(candidate)) {
    return true;
  }
  if (opts?.allowBareFilename && !SCHEME_RE.test(candidate) && HAS_FILE_EXT.test(candidate)) {
    return true;
  }
  return false;
}

/**
 * 是否**可渲染**成附件（上游 `isRenderableAssistantAttachment`）。
 *
 * 补集就是「相对引用」（`chart.png`、`sub/x.png`）—— 那种上游会**保留原文**而不是吃掉。
 */
export function isRenderableMediaReference(url: string): boolean {
  const trimmed = url.trim();
  return (
    HTTP_URL_PREFIX_RE.test(trimmed) ||
    /^data:(?:image|audio|video)\//i.test(trimmed) ||
    /^\/(?:__openclaw__|media)\//.test(trimmed) ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("/") ||
    WINDOWS_DRIVE_RE.test(trimmed) ||
    RELATIVE_ARTIFACT_EXT_RE.test(trimmed)
  );
}

/** 扩展名 → MIME（上游 `mimeTypeFromUrl` 的同一张表）。 */
export function mimeTypeForMediaPath(url: string): string | undefined {
  const withoutQuery = url.trim().split(/[?#]/)[0] ?? "";
  const fileName = withoutQuery.split(/[\\/]/).pop() ?? "";
  const match = /\.([a-zA-Z0-9]+)$/.exec(fileName);
  const ext = match?.[1]?.toLowerCase();
  return ext ? MIME_BY_EXT[ext] : undefined;
}

/** 引用 → 附件卡片所需的 `{kind, label, mimeType}`（上游 `inferAttachmentKind`）。 */
export function inferMediaAttachment(url: string): MediaMarkerAttachment {
  const mimeType = mimeTypeForMediaPath(url);
  return {
    url,
    kind: transcriptMediaKind(url, mimeType),
    label: labelForMediaPath(url) || url,
    ...(mimeType ? { mimeType } : {}),
  };
}

// ---------------------------------------------------------------------------
// 围栏（fenced code）保护
// ---------------------------------------------------------------------------

type FenceSpan = { start: number; end: number };

/**
 * 扫描 ``` / ~~~ 围栏的字符区间（上游 `packages/markdown-core` 的 `parseFenceSpans` 精简版）。
 *
 * 语义与上游一致：开栏行必须缩进 ≤3 空格 + 3 个以上同类字符；闭栏要求同类且**长度不少于**
 * 开栏。未闭合则延伸到文本结尾。
 */
function scanFenceSpans(buffer: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  let open: { char: string; length: number; start: number } | null = null;
  let offset = 0;
  for (const line of buffer.split("\n")) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      const char = match[1]![0]!;
      const length = match[1]!.length;
      if (!open) {
        open = { char, length, start: offset };
      } else if (char === open.char && length >= open.length) {
        spans.push({ start: open.start, end: offset + line.length });
        open = null;
      }
    }
    offset += line.length + 1;
  }
  if (open) spans.push({ start: open.start, end: buffer.length });
  return spans;
}

/** 与上游 `findFenceSpanAt` 同口径：`offset <= start` / `offset >= end` 都算「不在栏内」。 */
function isOffsetInsideFence(spans: readonly FenceSpan[], offset: number): boolean {
  for (const span of spans) {
    if (offset > span.start && offset < span.end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 行内 `MEDIA:<引用>` 的识别（`- **PDF 版**：MEDIA:/root/x.pdf`）。
 *
 * ## 为什么需要这一档
 * `src/media/parse.ts:544` 与上游一致，只认**行首独占行**的 `MEDIA:` —— 那是**投递语义**
 * （避免正文里提一句 `MEDIA:` 就触发投递）。但模型经常把引用内联在列表项 / 加粗标题后面：
 * ```
 * - **PDF 版**：MEDIA:/root/openclaw/media/outbound/x.pdf
 * ```
 * 这时服务端不投递、客户端也解不出来 ⇒ 用户既没有卡片，正文里还留着一行 `MEDIA:` 脏文本。
 *
 * ## 保守策略：只认「整段就是一条引用」，绝不猜路径边界
 * 行内形态没法像行首那样用「整行」界定路径终点。取舍是**宁可不出卡片**，
 * 也不能生成指向错误路径的卡片，所以要求：
 * 1. 该行**只有一个** `MEDIA:`（多引用不动，不猜切割点）；
 * 2. `MEDIA:` 之后（去掉尾部中文句读 / markdown 强调闭合符）**整段**就是一条合法引用；
 * 3. 该引用**必须带已知扩展名或是 http(s) 地址** —— 否则 `MEDIA:/some/path 这样写`
 *    这类正文说明会被误判（`isLikelyLocalPath` 只看是否以 `/` 开头，太宽）；
 * 4. 位置**不在行内 code span 里** —— `` `MEDIA:/x.mp3` `` 是讲解举例，不是投递。
 *
 * 不满足则返回 `null`，调用方原样保留该行（与修复前行为一致，不会更差）。
 */
/**
 * 引用末尾是否像一个**文件**（`…​.pdf`、`…​.docx`）。
 *
 * ⚠️ 不能复用 `mimeTypeForMediaPath` 来做这个判断：`MIME_BY_EXT` 是「能给出 mimeType 的
 * 扩展名」表，天生覆盖不全（docx / doc / xlsx 都不在表里），拿它判「是不是文件」会把
 * Word / Excel 产物漏掉。
 */
function hasFileExtensionTail(candidate: string): boolean {
  const withoutQuery = candidate.split(/[?#]/)[0] ?? "";
  const fileName = withoutQuery.split(/[\\/]/).pop() ?? "";
  return /\.[A-Za-z0-9]{1,8}$/.test(fileName);
}

/**
 * 整行恰好被**一对**反引号包住时返回内部文本（否则 `null`）。
 *
 * 只认单反引号（`` `` `` 是双反引号代码，保守不动），且内部不允许再出现反引号 ——
 * 出现即说明这一行不是一个完整的 code span（如 `` `a` 和 `b` ``），不参与判定。
 */
function unwrapWholeLineCodeSpan(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 3) return null;
  if (!trimmed.startsWith("`") || !trimmed.endsWith("`")) return null;
  if (trimmed.startsWith("``") || trimmed.endsWith("``")) return null;
  const inner = trimmed.slice(1, -1);
  if (inner.includes("`")) return null;
  return inner;
}

/**
 * 整行 code span 里的 `MEDIA:` 是否属于**投递**（而非正文里的讲解举例）。
 *
 * 判据（两道，缺一不可）：
 * 1. 去掉包裹反引号后，该行以 `MEDIA:` 开头；
 * 2. 去壳后的整行能被 `splitMediaMarkers` 解析出**至少一条可渲染引用**。
 *
 * 第 2 条是递归调用（去壳后的行不含反引号，必然终止）—— 它把「路径是否合法、是否可渲染」
 * 这套既有规则原样复用，避免在这里再写一份判定。命中则返回去壳文本，调用方按行首
 * `MEDIA:` 常规路径解析；未命中返回 `null`，该行**原样保留**（举例文本不受任何影响）。
 */
function codeSpanWrappedMediaLine(line: string): string | null {
  const inner = unwrapWholeLineCodeSpan(line);
  if (!inner) return null;
  if (!inner.trimStart().toUpperCase().startsWith("MEDIA:")) return null;
  return splitMediaMarkers(inner).media.length > 0 ? inner : null;
}

function splitInlineMediaReference(line: string): { prefix: string; reference: string } | null {
  const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const start = match.index ?? 0;
  if (start <= 0) return null; // 行首形态走主路径
  const prefix = line.slice(0, start);
  if (!prefix.trim()) return null; // 前缀只有空白 = 行首形态
  // 行内 code span 排除：模型讲解这套约定时，正文里会写 `` `MEDIA:/x.mp3` `` —— 反引号是
  // **行内代码**（围栏 ``` 在主循环更前面就拦掉了，这里只剩单个反引号对），里面的路径是
  // 举例、不是投递，解成卡片会凭空多一个指向不存在文件的幽灵卡片。判据：`MEDIA:` 之前
  // 出现**奇数个**反引号 ⇒ 当前位置在 code span 内部。
  if (((prefix.match(/`/g)?.length ?? 0) % 2) === 1) return null;

  const payload = match[1] ?? "";
  const unwrapped = unwrapQuoted(payload);
  const trimmed = (unwrapped ?? payload).trim();
  if (!trimmed) return null;

  // 尾部容忍中文句读与 markdown 强调 / 代码闭合符（`MEDIA:/x.pdf**`、`MEDIA:/x.pdf。`）
  const tail = trimmed.replace(/[。．，、；;:,：*_`]+$/, "");
  if (!tail) return null;
  const candidate = normalizeMediaSource(cleanCandidate(tail));
  if (!isValidMedia(candidate, { allowSpaces: true })) return null;
  if (!isRenderableMediaReference(candidate)) return null;
  // 上游 `MEDIA_TOKEN_RE` 的 payload 正则 `[^\n]+` 是**贪婪**的：同一行出现两处 `MEDIA:` 时，第一个
  // match 会把第二个 `MEDIA:` 连同后缀一起吞进 payload（`/root/a.pdf 和 MEDIA:/root/b.pdf`），
  // 此时 matches.length 仍然等于 1 —— 上面那道检查拦不住。补一道：候选里不允许再出现 `MEDIA:`。
  if (/media:/i.test(candidate)) return null;
  // 必须能看出「这是个文件」：末段带扩展名，或是远端 http(s) 地址
  if (!hasFileExtensionTail(candidate) && !HTTP_URL_PREFIX_RE.test(candidate)) return null;

  return { prefix: cleanLineText(prefix), reference: candidate };
}

/**
 * 从正文里抽出 `MEDIA:<引用>` 行。
 *
 * 返回 `text`（已剥离可渲染行）与 `media`（可渲染引用，已去重）。不可渲染的**相对引用**
 * （如 `MEDIA:chart.png`）会**原样留在 `text` 里** —— 与上游把
 * `shouldPreserveRelativeAssistantAttachment` 的引用回写成文本一致，位置也保持原地。
 */
export function splitMediaMarkers(text: unknown): MediaMarkerSplit {
  const raw = typeof text === "string" ? text : "";
  const trimmedRaw = raw.trimEnd();
  if (!trimmedRaw.trim()) return { text: "", media: [] };
  // 只有出现 `media:` 才进入逐行解析（上游同款快路径）
  if (!/media:/i.test(trimmedRaw)) return { text: trimmedRaw, media: [] };

  const media: string[] = [];
  const seen = new Set<string>();
  const keptLines: string[] = [];
  const hasFenceMarkers = trimmedRaw.includes("```") || trimmedRaw.includes("~~~");
  const fenceSpans = hasFenceMarkers ? scanFenceSpans(trimmedRaw) : [];
  let lineOffset = 0;

  for (const line of trimmedRaw.split("\n")) {
    const currentOffset = lineOffset;
    lineOffset += line.length + 1; // +1 = 换行符

    // ① 围栏内的 `MEDIA:` 是文档示例，保持原样
    if (hasFenceMarkers && isOffsetInsideFence(fenceSpans, currentOffset)) {
      keptLines.push(line);
      continue;
    }
    // ①.5 整行被一对反引号包住的 `MEDIA:` 行（`` `MEDIA:/x.docx` ``）—— 当投递处理，
    // 见 codeSpanWrappedMediaLine。命中去壳文本，后面完全按行首 `MEDIA:` 走。
    const effectiveLine = codeSpanWrappedMediaLine(line) ?? line;
    // ② 行内 `MEDIA:`（`- **PDF 版**：MEDIA:/x.pdf`）—— 上游只认行首，客户端放宽一档。
    // 见 splitInlineMediaReference：只在「整段就是一条引用」时才吃，不猜边界。
    if (!effectiveLine.trimStart().toUpperCase().startsWith("MEDIA:")) {
      const inline = splitInlineMediaReference(effectiveLine);
      if (!inline) {
        keptLines.push(line);
        continue;
      }
      if (inline.prefix) keptLines.push(inline.prefix);
      if (!seen.has(inline.reference)) {
        seen.add(inline.reference);
        media.push(inline.reference);
      }
      continue;
    }

    const matches = Array.from(effectiveLine.matchAll(MEDIA_TOKEN_RE));
    if (matches.length === 0) {
      keptLines.push(effectiveLine);
      continue;
    }

    const pieces: string[] = [];
    let cursor = 0;
    for (const match of matches) {
      const start = match.index ?? 0;
      pieces.push(effectiveLine.slice(cursor, start));

      const payload = match[1] ?? "";
      const unwrapped = unwrapQuoted(payload);
      const payloadValue = unwrapped ?? payload;
      const spaced = /\s/.test(payloadValue);
      const trimmedPayload = payloadValue.trim();
      const looksLocal =
        looksLikeLocalFilePath(trimmedPayload) || trimmedPayload.startsWith("file://");

      const parts = unwrapped ? [unwrapped] : payloadValue.split(/\s+/).filter(Boolean);
      // 只有「整包（反引号包裹）」或「不含空格 ⇒ 不会被拆成碎片」时才放行裸文件名产物；
      // 含空格的本地路径留给下面「回退 1」把碎片合成整条。
      const mediaOpts = unwrapped
        ? { allowSpaces: true }
        : spaced
          ? undefined
          : { allowArtifactFilename: true };
      let accepted: string[] = [];
      const rejected: string[] = [];
      for (const part of parts) {
        const candidate = normalizeMediaSource(cleanCandidate(part));
        if (!isValidMedia(candidate, mediaOpts)) {
          rejected.push(part);
          continue;
        }
        // 可渲染才吃掉；相对引用（`chart.png`）按上游口径**原样保留**，绝不静默吞掉
        if (isRenderableMediaReference(candidate)) accepted.push(candidate);
        else rejected.push(`MEDIA:${candidate}`);
      }

      // 回退 1：单个有效片段 + 空格碎片 ⇒ 整段其实是一个**含空格的本地路径**
      //（上游同款；`MEDIA:/tmp/openclaw/test image.png` 就是这条救回来的）
      if (!unwrapped && accepted.length === 1 && rejected.length > 0 && spaced && looksLocal) {
        const fallback = normalizeMediaSource(cleanCandidate(trimmedPayload));
        if (isValidMedia(fallback, { allowSpaces: true }) && isRenderableMediaReference(fallback)) {
          accepted = [fallback];
          rejected.length = 0;
        }
      }

      // 回退 2：一个都没成立且含空格 ⇒ 再按「整段 + 允许裸文件名」判一次
      let preserveWholeToken = false;
      if (!unwrapped && accepted.length === 0 && spaced) {
        const fallback = normalizeMediaSource(cleanCandidate(trimmedPayload));
        if (isValidMedia(fallback, { allowSpaces: true, allowBareFilename: true })) {
          if (isRenderableMediaReference(fallback)) {
            accepted = [fallback];
            rejected.length = 0;
          } else {
            // 相对引用 ⇒ 上面已按上游口径把 `MEDIA:<url>` 放回文本，无需再补整段
            preserveWholeToken = rejected.length === 0;
          }
        }
      }

      if (accepted.length > 0) {
        // `pieces` 里已经是要保留的可见文本（各 match 之前的部分），留着不动；
        // 被拒/被保留的片段按上游口径追加到行尾。
        for (const url of accepted) {
          if (seen.has(url)) continue;
          seen.add(url);
          media.push(url);
        }
        if (rejected.length > 0) pieces.push(rejected.join(" "));
      } else if (preserveWholeToken) {
        pieces.push(match[0]);
      } else if (looksLocal) {
        // ③ 非法但明显是本地路径 ⇒ 整行丢弃，绝不当文本泄漏（上游同款）
      } else {
        pieces.push(match[0]);
      }
      cursor = start + match[0].length;
    }

    pieces.push(effectiveLine.slice(cursor));
    const cleanedLine = cleanLineText(pieces.join(""));
    // ② 整行只剩 `MEDIA:` ⇒ 该行整行消失
    if (cleanedLine) keptLines.push(cleanedLine);
  }

  const cleaned = keptLines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    // 多个连续 MEDIA: 行被整行吞掉后，它们之间若有空行会残留成 2+ 个空行；
    // 压到「一个空行」（\n\n）即可 —— ⚠️ 绝不能压成单个 \n：那会把正常的
    // 段落空行（正文里 agent 写的 \n\n）也一并压平，段间距消失。
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: cleaned, media };
}
