/**
 * 助手媒体（音频/图片附件）引用解析。
 *
 * 网关把「本地文件」类媒体经 HTTP 路由暴露：
 *   `GET /__openclaw__/assistant-media?source=<路径>&meta=1`  → 可用性 + mediaTicket
 *   `GET /__openclaw__/assistant-media?source=<路径>&mediaTicket=<ticket>` → 字节流
 * （见 `src/gateway/control-ui.ts`；`mediaTicket` 是短期票据，避免把登录 token 写进
 *  `<audio src>` 里。）
 *
 * ## 实测约束（网关 2026.7.1，本机验证）
 * - 无鉴权 → **401**；`?token=<gatewayToken>` 或 `Authorization: Bearer` 均可（200）。
 * - 只允许 agent workspace 内的文件；其它路径返回 `{available:false, code:"outside-allowed-folders"}`。
 * - **响应不带 CORS 头、OPTIONS 直接 404**：跨源 `fetch` 必失败，所以
 *   ①可用性探测失败时要能「乐观继续」；②媒体本身必须靠 `<audio src>` 直出。
 *
 * ## 为什么音频从「消息文本」里找 mp3
 * 网关 `chat.history` 的 `content` 实测只有 `{type:"text"}`，音频是 agent **写在正文里的
 * 文件路径**，所以只能在文本层识别。
 *
 * ⚠️ 但**附件**不是这么回事：user 消息**顶层**带 `MediaPath`/`MediaPaths`/`MediaType`/
 * `MediaTypes`（实测确认）。曾经把「content 里没有」写成「没有 media 字段」，
 * 害得历史附件一直不显示 —— 附件解析见 `utils/transcriptMedia.ts`，别再把两者混为一谈。
 */

/** 网关托管的媒体路由前缀。 */
export const ASSISTANT_MEDIA_PATH = "/__openclaw__/assistant-media";

/** 可播放的音频扩展名（与上游 message-normalizer 的音频类型对齐）。 */
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|m4b|aac|ogg|oga|opus|flac|weba|mp4a|aiff?|caf|amr|wma)$/i;

/** 单个消息最多渲染几个播放器（防御异常长的正文）。 */
const MAX_AUDIO_REFS = 5;

/**
 * 切分「候选 token」：空白与中英文标点/引号/括号都不算路径的一部分。
 *
 * 冒号必须当分隔符（正文常写「文件路径：/root/x.mp3」，半角 `路径:/root/x.mp3`
 * 也要能切开），但这会让 `https://cdn.x.com/a.mp3` 在 `https` 后断掉、整条 URL
 * 识别不到。所以先给 `://` 打占位符、切完再还原，见 `tokenizeCandidates`。
 */
const TOKEN_SPLIT_RE = /[^\s"'`<>()[\]{}（）：:，。；、！？【】]+/g;

/** `://` 的临时占位符：不是分隔符，因此整条 URL 会留在同一个 token 里。 */
const SCHEME_SENTINEL = "\u0000";

/** 按候选切分文本，并还原被保护的 `://`。 */
function tokenizeCandidates(source: string): string[] {
  const guarded = source.split("://").join(SCHEME_SENTINEL);
  const tokens: string[] = [];
  for (const match of guarded.matchAll(TOKEN_SPLIT_RE)) {
    tokens.push(match[0].split(SCHEME_SENTINEL).join("://"));
  }
  return tokens;
}

/** 看起来像「路径或 URL」的前缀。 */
const PATH_LIKE_RE = /^(?:\/|~\/|\.{1,2}\/|[a-z]:[\\/]|[a-z][a-z0-9+.-]*:\/\/)/i;

/** 结尾的标点（token 常与句号/右括号粘连）。 */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>"'`，。；：！？、）】》」』]+$/;

/** 网关已经直接托管的站内路径 —— 只需绝对化 + 鉴权，不必再包一层 assistant-media。 */
const MANAGED_SITE_PATH_RE = /^\/(?:__openclaw__|media|api\/chat\/media\/outgoing)\//;

/**
 * 网关的「入站媒体」引用形态（`media://inbound/<id>`）。
 *
 * ⚠️ 它**不是**站内路径：不能拼在 base 后面当 URL 用，必须原样放进
 * `/__openclaw__/assistant-media?source=media://inbound/<id>` 的 query 里
 * （上游 `control-ui.http.test.ts` 就是这么断言的）。
 */
const MEDIA_INBOUND_RE = /^media:\/\/inbound\//i;

export type AudioReference = {
  /** 原始引用串（路径或 URL），用于做 key。 */
  raw: string;
  /** 展示用文件名。 */
  label: string;
  /** 是否需要经网关的 assistant-media 路由取（本地文件）。 */
  isLocal: boolean;
};

/** 从一段文本里提取音频引用（去重、限量、按出现顺序）。 */
export function extractAudioReferences(text: string): AudioReference[] {
  const source = typeof text === "string" ? text : "";
  if (!source) return [];

  const found: AudioReference[] = [];
  const seen = new Set<string>();

  for (const candidate of tokenizeCandidates(source)) {
    const token = candidate.replace(TRAILING_PUNCT_RE, "");
    if (!token || !AUDIO_EXT_RE.test(token)) continue;
    if (!PATH_LIKE_RE.test(token)) continue;

    const raw = token.trim();
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({ raw, label: audioReferenceLabel(raw), isLocal: isLocalMediaSource(raw) });
    if (found.length >= MAX_AUDIO_REFS) break;
  }
  return found;
}

/** 从路径里取文件名（URL 会去掉 query/hash）。 */
export function audioReferenceLabel(source: string): string {
  const raw = source.trim();
  if (!raw) return "";
  const withoutQuery = raw.split(/[?#]/)[0] ?? "";
  const segments = withoutQuery.replace(/\\/g, "/").split("/");
  const name = segments[segments.length - 1] ?? "";
  return decodeURIComponentSafe(name) || raw;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 是否必须经 `/__openclaw__/assistant-media?source=` 取字节。
 *
 * 覆盖：本地 fs 路径（绝对 / `~/` / `file://`）与 `media://inbound/<id>`。
 * 远端 http(s) / data: / blob: / 网关已托管的站内路径都返回 false（可直出）。
 *
 * 用途有二：①`AudioPlayer` 据此决定要不要先探测可用性；②失败时据此给出
 * 「可能已移动/过期」这类更具体的文案。
 */
export function isLocalMediaSource(source: string): boolean {
  const value = typeof source === "string" ? source.trim() : "";
  if (!value) return false;
  if (/^https?:\/\//i.test(value) || value.startsWith("data:") || value.startsWith("blob:")) {
    return false;
  }
  if (MANAGED_SITE_PATH_RE.test(value)) return false;
  return MEDIA_INBOUND_RE.test(value) || PATH_LIKE_RE.test(value);
}

/**
 * 站内托管路径 → 网关源绝对地址 + 补 `?token=`。
 *
 * ⚠️ **顺序陷阱**：不要写成「绝对化之后再判断 `startsWith("/")` 才补 token」——
 * 拼上 `base` 之后开头已经变成 `http`，守卫会直接跳过补 token，请求就以匿名身份
 * 打到网关 → 401。这个坑在 `utils/avatar.ts` 里踩过一次（见其注释），
 * 这里统一用「先判形态、再绝对化、最后无条件补」。
 */
function stripTokenForUrl(source: string, base: string, token?: string | null): string {
  const absolute = base
    ? source.startsWith("/")
      ? `${base}${source}`
      : `${base}/${source}`
    : source;
  const secret = typeof token === "string" ? token.trim() : "";
  if (!secret) return absolute;
  const sep = absolute.includes("?") ? "&" : "?";
  return `${absolute}${sep}token=${encodeURIComponent(secret)}`;
}

/** 构造 `?source=...` 查询形态的媒体地址（带票据时优先用票据）。 */
function buildQueryMediaUrl(params: {
  source: string;
  base: string;
  ticket?: string | null;
  token?: string | null;
}): string {
  const query = new URLSearchParams();
  query.set("source", params.source);
  const ticket = params.ticket?.trim();
  if (ticket) {
    query.set("mediaTicket", ticket);
  } else if (params.token) {
    query.set("token", params.token);
  }
  return `${params.base}${ASSISTANT_MEDIA_PATH}?${query.toString()}`;
}

/**
 * 构造媒体地址（可直接给 `<audio src>` / `<img src>`）。
 *
 * - 远端 / data: → 原样返回；
 * - 网关已托管的站内路径（`/__openclaw__/`、`/media/`）→ 拼上网关源 + token；
 * - 其它（fs 路径 / `~/` / `file://` / `media://inbound/<id>`）→ 统一走
 *   `/__openclaw__/assistant-media?source=...`，优先用 `mediaTicket`，
 *   没有票据时退回 `?token=`（实测两者都能取到字节）。
 */
export function buildAssistantMediaUrl(params: {
  source: string;
  base?: string | null;
  ticket?: string | null;
  token?: string | null;
}): string {
  const source = typeof params.source === "string" ? params.source.trim() : "";
  if (!source) return "";
  if (/^https?:\/\//i.test(source) || source.startsWith("data:") || source.startsWith("blob:")) {
    return source;
  }

  const base = (params.base ?? "").replace(/\/+$/, "");

  if (MANAGED_SITE_PATH_RE.test(source)) {
    return stripTokenForUrl(source, base, params.token);
  }

  return buildQueryMediaUrl({
    source: source.startsWith("file://") ? source.slice("file://".length) : source,
    base,
    ticket: params.ticket,
    token: params.token,
  });
}

/** `?download=1` 的查询键名（与 `src/gateway/control-ui.ts` 的解析保持一致）。 */
export const ASSISTANT_MEDIA_DOWNLOAD_QUERY = "download";

/**
 * 这个地址是不是「我们自己网关托管的媒体」。
 *
 * 只有托管的地址才谈得上换 disposition —— 远端第三方地址（agent 引用的公网图片等）
 * 的响应头我们改不了，`download` 属性在跨源下也会被浏览器忽略。
 */
export function isGatewayHostedMediaUrl(url: string, base?: string | null): boolean {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) return false;
  if (trimmed.includes(ASSISTANT_MEDIA_PATH)) return true;
  const absoluteBase = typeof base === "string" ? base.replace(/\/+$/, "") : "";
  return absoluteBase.length > 0 && trimmed.startsWith(`${absoluteBase}/`);
}

/**
 * 把「网关托管的媒体地址」改写成**强制下载**的地址（附件链接专用）。
 *
 * ## 为什么需要它
 * 网关的 `/__openclaw__/assistant-media` 默认按 MIME 给 disposition：
 * image / audio / video → `inline`，其余 → `attachment`
 * （`src/gateway/control-ui.ts: buildAssistantMediaContentDisposition`）。
 * 于是**点一下附件链接**时，浏览器对图片 / 音视频会**就地渲染** —— 整个 SPA 页面
 * 被顶掉换成那个文件，用户视角就是「附件自己打开了 / 聊天界面没了」。
 * 加上 `?download=1` 后网关改回 `attachment`，浏览器只下载、**不动当前页面、不弹窗**。
 *
 * 远端地址（改不了 disposition）原样返回；调用方用 `isGatewayHostedMediaUrl`
 * 判断能不能渲染成链接。
 */
export function withAssistantMediaDownload(url: string, base?: string | null): string {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) return "";
  if (!isGatewayHostedMediaUrl(trimmed, base)) return trimmed;
  const sep = trimmed.includes("?") ? "&" : "?";
  return `${trimmed}${sep}${ASSISTANT_MEDIA_DOWNLOAD_QUERY}=1`;
}

export type AssistantMediaAvailability =
  | { status: "ready"; ticket?: string }
  | { status: "unavailable"; reason: string }
  /** 探测不了（如跨源被 CORS 拦）—— 交给 `<audio>` 自己报错。 */
  | { status: "unknown" };

export type AssistantMediaProbeResult = {
  available?: boolean;
  mediaTicket?: string;
  reason?: string;
  code?: string;
};

/** 解析 `/__openclaw__/assistant-media?meta=1` 的响应体。 */
export function parseAssistantMediaProbe(
  payload: AssistantMediaProbeResult | null,
): AssistantMediaAvailability {
  if (!payload || payload.available !== true) {
    const reason =
      typeof payload?.reason === "string" && payload.reason.trim()
        ? payload.reason.trim()
        : "音频不可用";
    return { status: "unavailable", reason };
  }
  const ticket = typeof payload.mediaTicket === "string" ? payload.mediaTicket.trim() : "";
  return ticket ? { status: "ready", ticket } : { status: "ready" };
}

/**
 * 探测本地媒体可用性。
 *
 * 探测失败**不代表**媒体不可用：跨源时 `fetch` 会被 CORS 拦下（网关不发 CORS 头），
 * 而 `<audio src>` 仍能正常播放。所以网络异常一律返回 `unknown`，不要误报「不可用」。
 */
export async function probeAssistantMedia(params: {
  source: string;
  base?: string | null;
  token?: string | null;
  signal?: AbortSignal;
}): Promise<AssistantMediaAvailability> {
  if (!isLocalMediaSource(params.source)) return { status: "ready" };
  const base = (params.base ?? "").replace(/\/+$/, "");
  const raw = params.source.trim();
  const query = new URLSearchParams({
    source: raw.startsWith("file://") ? raw.slice("file://".length) : raw,
    meta: "1",
  });
  const url = `${base}${ASSISTANT_MEDIA_PATH}?${query.toString()}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      ...(params.token ? { headers: { Authorization: `Bearer ${params.token}` } } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!res.ok) return { status: "unknown" };
    const payload = (await res.json().catch(() => null)) as AssistantMediaProbeResult | null;
    return parseAssistantMediaProbe(payload);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return { status: "unknown" };
  }
}

/** 秒 → `m:ss`（时长未知/非法返回 `--:--`）。 */
export function formatAudioTime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
