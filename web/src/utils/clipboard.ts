/**
 * 剪贴板复制（移植自上游 `ui/src/lib/clipboard.ts`）。
 *
 * 异步 Clipboard API 只在安全上下文（HTTPS / localhost）暴露，纯 HTTP 部署（如内网 IP 访问）
 * 下 `navigator.clipboard` 为 undefined，直接调用会同步抛错而非 reject。
 * 因此先守卫安全上下文分支，失败再退回 `execCommand('copy')`，让复制按钮在 HTTP 下仍然可用。
 *
 * @returns 是否复制成功
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 安全上下文 API 存在但被拒（如权限拒绝）：继续走 execCommand 兜底。
    }
  }
  return copyWithExecCommand(text);
}

function copyWithExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  textarea.value = text;
  // 把临时节点放到屏幕外，避免选中时页面滚动或闪烁。
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    if (previouslyFocused?.isConnected) {
      window.setTimeout(() => {
        const activeElement = document.activeElement;
        if (previouslyFocused.isConnected && (!activeElement || activeElement === document.body)) {
          previouslyFocused.focus({ preventScroll: true });
        }
      }, 0);
    }
  }
}
