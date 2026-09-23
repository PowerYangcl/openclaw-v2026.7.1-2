/**
 * 附件下载的「HTTP 站点兜底保存」。
 *
 * ## 为什么要这个
 * 预发环境是**明文 HTTP** 站点（`http://<域名>/`，网关地址是 `ws://`）。用户点附件时：
 *   - 控制台：`The file at 'http://…/__openclaw__/assistant-media?…&download=1' was loaded
 *     over an insecure connection. This file should be served over HTTPS.`
 *   - 下载气泡：「无法从网站上提取文件」（下载被浏览器拦掉，不是网关 4xx）
 * 这是 Chrome 的**不安全下载拦截**：下载目标走明文 HTTP 时，浏览器会阻止写盘，
 * 只留一个「保留」按钮。前端改不了这个策略，但可以换一条**不经过明文网络**的落盘路径：
 * 先用同源 `fetch` 把字节取回内存，再转成 `blob:` 地址交给 `<a download>` ——
 * `blob:` 指向的是浏览器本地数据，没有明文传输环节，不会被拦
 * （`data:` / `blob:` 一直是跨源 download 属性的官方豁免路径）。
 *
 * ## 边界（`shouldSaveViaBlob` 就是这些边界的唯一判据）
 * - **HTTPS 站点不拦**：`window.isSecureContext === true` 时保持原生 `<a href download>`
 *   （既省内存也少一次请求）——`http://localhost` 也算安全上下文，本地开发不受影响。
 * - **只处理 http(s) 地址**：`blob:` / `data:`（本地待发送附件、内联图片）本来就能直接存，
 *   再包一层没有意义。
 * - **只处理同源**：网关媒体路由**不带 CORS 头**（见 `utils/assistantMedia.ts` 文件头实测），
 *   跨源 `fetch` 必失败，拦下来只会让本来能用的下载变不能用。
 * - **超大文件不接管**：字节要在内存里过一道，超过 `BLOB_DOWNLOAD_MAX_BYTES` 时
 *   回落到原生下载（HTTP 站点仍会被浏览器拦，但至少不制造 OOM）。
 *
 * ## 兜底失败必须**回落原生下载**（2026-09-21 修复）
 * 预发实测：接管了点击（`preventDefault`）之后 fetch 失败 —— 最常见的成因是**站点前面
 * 的 CDN / 反代把 http 请求 301 到 https**，于是 fetch 变成「跨源重定向」，而媒体路由
 * 不带 CORS 头 ⇒ `TypeError: Failed to fetch`；同样情况下**原生 `<a>` 导航却能跟随
 * 重定向把文件下下来**（导航不受 CORS 约束）。
 *
 * 旧实现失败后只弹提示，等于「既没下到，也把原本能用的原生下载堵死了」，而提示还让
 * 用户去点一个永远不会出现的下载气泡 —— 这就是用户报的「不能下载」。现在：
 *   ① 失败 → `saveUrlViaNativeAnchor` 立刻回落到原生下载（气泡出现，用户可点「保留」）；
 *   ② 同时 `probeMediaAvailability` 尽力问一次 `?meta=1`，把**真实原因**（网关报告
 *      不可用 / 网络层失败）写进提示，而不是一律甩锅给「浏览器拦截」。
 */

/** 内存中转的上限：超过就放弃兜底，回落原生下载。 */
export const BLOB_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

/**
 * 强制下载的查询键名。与 `utils/assistantMedia.ts`、网关 `control-ui.ts` 对齐
 * （这里刻意不 import，避免多一层依赖）。
 */
const DOWNLOAD_QUERY_KEY = "download";

export type BlobDownloadDecision = {
  /** 目标地址。 */
  url: string;
  /** `window.isSecureContext`（HTTPS / localhost 为 true）。 */
  secureContext: boolean;
  /** `window.location.origin`。 */
  pageOrigin: string;
};

/**
 * 这次点击是否该走「fetch → blob」兜底保存。
 *
 * 纯函数（不碰 DOM），判据见文件头；`web/tests/downloadSave.test.ts` 钉住每一条边界。
 */
export function shouldSaveViaBlob(params: BlobDownloadDecision): boolean {
  const url = typeof params.url === "string" ? params.url.trim() : "";
  if (!url) return false;
  // 安全上下文（HTTPS / localhost）：浏览器不拦，原生下载即可
  if (params.secureContext) return false;
  // 只接管 http(s)：blob:/data: 不需要中转
  if (!/^https?:\/\//i.test(url)) return false;

  const pageOrigin = typeof params.pageOrigin === "string" ? params.pageOrigin.trim() : "";
  if (!pageOrigin) return false;
  try {
    return new URL(url).origin === pageOrigin;
  } catch {
    return false;
  }
}

/**
 * 同源取字节 → `blob:` → `<a download>` 落盘。
 *
 * 失败时抛异常（调用方据此给出「当前站点是 HTTP，浏览器可能拦截下载」的提示，
 * 并回落到原生链接）。成功时返回字节数，便于测试断言。
 */
export async function saveUrlViaBlob(url: string, fileName: string): Promise<number> {
  const target = typeof url === "string" ? url.trim() : "";
  if (!target) throw new Error("empty-url");

  const res = await fetch(target, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`http-${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > BLOB_DOWNLOAD_MAX_BYTES) {
    throw new Error("too-large");
  }

  const blob = await res.blob();
  if (blob.size > BLOB_DOWNLOAD_MAX_BYTES) throw new Error("too-large");

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = typeof fileName === "string" && fileName.trim() ? fileName.trim() : "附件";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器的下载中断，留一点缓冲
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  return blob.size;
}

/** 回落锚点打的标记：带它的锚点不再被窗格捕获委托接管（否则会无限递归）。 */
export const NATIVE_DOWNLOAD_ATTR = "data-openclaw-native-download";

/** 这个元素是不是「已回落」的原生下载锚点。 */
export function isNativeDownloadAnchor(el: Element | null | undefined): boolean {
  return el?.getAttribute?.(NATIVE_DOWNLOAD_ATTR) === "1";
}

/**
 * 回落：用浏览器**原生** `<a download>` 触发一次下载。
 *
 * 为什么必须留着这条路：`blob:` 兜底要求同源 fetch 成功；一旦站点前面有 CDN / 反代
 * 把 http 301 到 https（跨源重定向）或直接拒绝非导航请求，`fetch` 必失败，而原生
 * 导航能跟随重定向拿到文件。失败时只弹提示 = 用户彻底下不到东西。
 *
 * 挂到 `document.body` **并**打标记：双保险，确保它不会被窗格上的捕获委托再次接管。
 * 返回是否真的触发了点击（地址为空时返回 false）。
 */
export function saveUrlViaNativeAnchor(url: string, fileName: string): boolean {
  const target = typeof url === "string" ? url.trim() : "";
  if (!target) return false;
  const anchor = document.createElement("a");
  anchor.setAttribute(NATIVE_DOWNLOAD_ATTR, "1");
  anchor.href = target;
  anchor.download = typeof fileName === "string" && fileName.trim() ? fileName.trim() : "附件";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}

/** `?meta=1` 探测的结果。 */
export type MediaAvailabilityProbe =
  | { status: "available" }
  | { status: "unavailable"; reason: string }
  /** 探测本身没结论（网络失败 / 该路由不认识 `meta`）—— 不要据此误报「文件不可用」。 */
  | { status: "unknown"; detail: string };

/**
 * 把「下载地址」改写成「可用性探测地址」（`?download=1` → `?meta=1`）。
 *
 * 解析不出来（相对地址 + 没有 base）时返回 `null`。
 */
export function buildMediaMetaUrl(url: string, baseHref?: string): string | null {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return null;
  const base = typeof baseHref === "string" && baseHref.trim() ? baseHref.trim() : undefined;
  try {
    const parsed = new URL(raw, base);
    parsed.searchParams.delete(DOWNLOAD_QUERY_KEY);
    parsed.searchParams.set("meta", "1");
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * 尽力问一次网关「这个附件到底可不可用」。
 *
 * 只在**兜底已经失败**之后才调用，因此不必省这一次请求；结论用于把提示写准：
 * 是「网关说文件不在允许目录 / 已删除」，还是「网络层取不到字节」。
 */
export async function probeMediaAvailability(url: string): Promise<MediaAvailabilityProbe> {
  const metaUrl = buildMediaMetaUrl(
    url,
    typeof window === "undefined" ? undefined : window.location.href,
  );
  if (!metaUrl) return { status: "unknown", detail: "地址无法解析" };
  try {
    const res = await fetch(metaUrl, { credentials: "same-origin" });
    if (!res.ok) return { status: "unknown", detail: `探测返回 HTTP ${res.status}` };
    const payload = (await res.json().catch(() => null)) as {
      available?: boolean;
      reason?: string;
    } | null;
    if (payload?.available === true) return { status: "available" };
    if (payload?.available === false) {
      const reason =
        typeof payload.reason === "string" && payload.reason.trim()
          ? payload.reason.trim()
          : "网关未说明原因";
      return { status: "unavailable", reason };
    }
    return { status: "unknown", detail: "该路由没有返回可用性信息" };
  } catch {
    return { status: "unknown", detail: "探测请求也失败了（网络层）" };
  }
}

/**
 * 兜底失败后给用户的**第二行**提示（主文案由调用方拼）。
 *
 * 一律不抛：探测失败也只是少一句解释。
 */
export async function describeDownloadFailure(url: string, error: unknown): Promise<string> {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  const probe = await probeMediaAvailability(url);
  if (probe.status === "unavailable") {
    return `网关报告该附件不可用：${probe.reason}。`;
  }
  if (probe.status === "unknown") {
    return `直读失败：${detail || "未知错误"}；探测无结论：${probe.detail}`;
  }
  return "若浏览器提示「不安全下载 / 无法从网站上提取文件」，请在下载气泡里点「保留」。";
}
