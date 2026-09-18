/**
 * 软键盘遮挡补偿。
 *
 * ## 问题
 *
 * 手机竖屏对话页里，输入区永远贴底。软键盘弹出时：
 *   - **Android / Chrome**：`viewport` meta 里写了 `interactive-widget=resizes-content`，
 *     布局视口会跟着变矮 ⇒ 输入区自然上移，不需要额外处理；
 *   - **iOS Safari**：没有 `interactive-widget`，**布局视口不变**，键盘只是盖在上面
 *     ⇒ 输入框被键盘挡住，用户打字时看不到自己输入的内容。
 *
 * ## 做法
 *
 * 不去改整页高度（那会把已经调好的窗格/抽屉布局一起搅动），只算出「被键盘盖住的高度」
 * 写进 CSS 变量 `--wb-keyboard-inset`，由 `ChatPane.vue` 里 composer 的
 * `padding-bottom` 消费 —— 补偿量只作用于输入区，其余布局完全不动。
 *
 * 两种情况必须同时成立才不会重复补偿：
 *   1. 布局视口已经缩了（Android）⇒ `innerHeight - vv.height - vv.offsetTop ≈ 0`，补偿为 0；
 *   2. iOS 键盘弹起时视觉视口同时**上移**（`offsetTop > 0`，因为浏览器要把输入框滚进视野）
 *      ⇒ 不减 `offsetTop` 会把「已经露出来」的部分也算成遮挡，输入区被顶高一大截。
 */

/** 纯计算部分（抽出来是为了可单测，不依赖任何浏览器 API）。 */
export function computeKeyboardInset(params: {
  innerHeight: number;
  viewportHeight: number;
  viewportOffsetTop?: number;
}): number {
  const { innerHeight, viewportHeight } = params;
  const offsetTop = params.viewportOffsetTop ?? 0;
  if (!Number.isFinite(innerHeight) || !Number.isFinite(viewportHeight)) return 0;
  if (!Number.isFinite(offsetTop)) return 0;
  // 视觉视口比布局视口还高（或相等）时不可能有遮挡；负值一律夹到 0。
  return Math.max(0, Math.round(innerHeight - viewportHeight - offsetTop));
}

const KEYBOARD_INSET_VAR = "--wb-keyboard-inset";

/** 把当前遮挡高度写进 `:root`。返回清理函数（供 `onBeforeUnmount` / HMR 使用）。 */
export function watchKeyboardInset(target: Document = document): () => void {
  const viewport = window.visualViewport;
  if (!viewport) {
    // 不支持 visualViewport 的环境（老浏览器）：保持 0，退化成「不加补偿」，
    // 与改造前行为一致，不会更糟。
    target.documentElement.style.setProperty(KEYBOARD_INSET_VAR, "0px");
    return () => {};
  }

  let pending = false;
  const apply = (): void => {
    pending = false;
    const inset = computeKeyboardInset({
      innerHeight: window.innerHeight,
      viewportHeight: viewport.height,
      viewportOffsetTop: viewport.offsetTop,
    });
    target.documentElement.style.setProperty(KEYBOARD_INSET_VAR, `${inset}px`);
  };
  const schedule = (): void => {
    // visualViewport 的 resize/scroll 在键盘动画期间会高频触发；
    // 用 rAF 合并到每帧一次，避免每个事件都写一次样式（会强制样式重算）。
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(apply);
  };

  apply();
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("orientationchange", schedule);

  return () => {
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    window.removeEventListener("orientationchange", schedule);
  };
}
