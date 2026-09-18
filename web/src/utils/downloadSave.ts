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
 */

/** 内存中转的上限：超过就放弃兜底，回落原生下载。 */
export const BLOB_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

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
