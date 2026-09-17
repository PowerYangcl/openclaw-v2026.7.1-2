/**
 * 外部 URL 白名单（逐行移植 `ui/src/lib/open-external-url.ts`）。
 *
 * ## 为什么不能让 `<a href>` 直接用消息里的 URL
 * 消息内容与附件 URL 都可能来自**不受信来源**（工具体返回值、agent 生成的链接、
 * 网关历史里的旧数据）。直接塞进 `href` 就能被 `javascript:` / `file:` /
 * `data:text/html,<script>` 这类 scheme 利用 —— 点击即执行。
 * 旧版因此把所有「点开看大图 / 打开附件」的出口都收口到这一个函数。
 *
 * ## 判定规则（与旧版一致）
 * - 允许 `http:` / `https:` / `blob:`；
 * - `data:` 仅在 `allowDataImage` 时放行，且必须是 `image/*`；
 * - **`image/svg+xml` 一律拒绝** —— SVG 里可以内嵌脚本，等同 XSS；
 * - 其余（`javascript:` / `file:` / 空串 / 解析失败）→ `null`。
 *
 * ⚠️ 调用方要在**渲染期**就用它过滤（拿不到安全 URL 就不要渲染成链接），
 * 而不是渲染完再在 click 里判断：后者会让一个危险 href 先落到 DOM 上。
 */

const DATA_URL_PREFIX = "data:";
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "blob:"]);
/** 能内嵌脚本，等同 XSS 载体。 */
const BLOCKED_DATA_IMAGE_MIME_TYPES = new Set(["image/svg+xml"]);

/** 就地内联的 `normalizeLowercaseStringOrEmpty`（本项目不引上游 string-coerce 包）。 */
function normalizeLowercase(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isAllowedDataImageUrl(url: string): boolean {
  if (!normalizeLowercase(url).startsWith(DATA_URL_PREFIX)) {
    return false;
  }

  const commaIndex = url.indexOf(",");
  if (commaIndex < DATA_URL_PREFIX.length) {
    return false;
  }

  const metadata = url.slice(DATA_URL_PREFIX.length, commaIndex);
  const mimeType = normalizeLowercase(metadata.split(";")[0]);
  if (!mimeType.startsWith("image/")) {
    return false;
  }

  return !BLOCKED_DATA_IMAGE_MIME_TYPES.has(mimeType);
}

export type ResolveSafeExternalUrlOptions = {
  /** 是否放行 `data:image/*`（`image/svg+xml` 仍然拒绝）。 */
  allowDataImage?: boolean;
};

/**
 * 把候选 URL 解析成可安全放进 `href` / 交给 `window.open` 的绝对地址。
 * 不安全或为空 → `null`（调用方据此不渲染链接 / 不做任何事）。
 */
export function resolveSafeExternalUrl(
  rawUrl: string,
  baseHref: string,
  opts: ResolveSafeExternalUrlOptions = {},
): string | null {
  const candidate = rawUrl.trim();
  if (!candidate) {
    return null;
  }

  if (opts.allowDataImage === true && isAllowedDataImageUrl(candidate)) {
    return candidate;
  }

  if (normalizeLowercase(candidate).startsWith(DATA_URL_PREFIX)) {
    return null;
  }

  try {
    const parsed = new URL(candidate, baseHref);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(normalizeLowercase(parsed.protocol))
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export type OpenExternalUrlSafeOptions = ResolveSafeExternalUrlOptions & {
  baseHref?: string;
};

/**
 * 新标签打开一个已校验的 URL；返回被打开的窗口（被浏览器拦截时为 `null`）。
 *
 * 本项目主要用 `resolveSafeExternalUrl` 在渲染期决定 `href`；
 * 这个包装函数保留给「没有真实锚点、只能 JS 打开」的场景（与旧版同行为）。
 */
export function openExternalUrlSafe(
  rawUrl: string,
  opts: OpenExternalUrlSafeOptions = {},
): Window | null {
  const baseHref = opts.baseHref ?? window.location.href;
  const safeUrl = resolveSafeExternalUrl(rawUrl, baseHref, opts);
  if (!safeUrl) {
    return null;
  }

  const opened = window.open(safeUrl, "_self", "noopener,noreferrer");
  if (opened) {
    opened.opener = null;
  }
  return opened;
}
