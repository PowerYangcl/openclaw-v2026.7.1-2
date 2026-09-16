/**
 * 上下文占用计算（纯函数，便于单测；不依赖 Vue / store）。
 *
 * ## 「已用」口径 = `input + cacheRead + cacheWrite`
 *
 * 这是**提示词侧**规模，也是上游 `normalizeUsage` 的口径。**刻意不含 `output`** ——
 * 与旧版 UI 的实际显示严格对齐，可拿实测数据反推验证：
 *
 *   窗口 1,048,576 · input 917 · cacheRead 26,624 · cacheWrite 0 · output 92
 *   已用   = 917 + 26,624 + 0            = 27,541        ← 与旧 UI「已用」一致
 *   剩余   = 1,048,576 − 27,541          = 1,021,035     ← 与旧 UI「剩余」一致
 *   百分比 = round(27,541 / 1,048,576 *100) = round(2.63) = 3%   ← 与旧 UI「3% ctx」一致
 *
 * ⚠️ 若把 `output` 也算进去（917+26,624+0+92 = 27,633），「已用」就对不上旧 UI 了。
 * 想改成含 output 的口径时，请先确认这是产品决定，别当成 bug 顺手改。
 *
 * 三个字段都拆不出来时退回 `totalTokens`（部分代理只报总数）。
 *
 * ## 百分比
 * `round(已用 / 上下文窗口 * 100)`，上限截断到 100。
 * 拿不到窗口、或压根没有用量数据时返回 `null` ——
 * 宁可不显示（UI 走「— ctx」），也不给用户看一个假的 `0%`。
 *
 * ## 弹层里的数字格式
 * 标题行 = `已用 / 上限`，两个数都用 **紧凑格式**（`27.5k / 1M`），
 * 与旧版 `getContextNoticeViewModel().detail` 逐字一致 —— 见 `contextWindowDetailOf`。
 * 截图里的 `56.2k / 204.8k · 27%` 就是这个格式（窗口 200k）。
 */

/** 单次调用的 token 用量（与 `ChatView` 的 `TokenUsage` 结构一致）。 */
export type ContextTokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 该轮总 token 数；部分代理只报这个。 */
  totalTokens?: number;
};

/**
 * 上下文「已用」token 数 = `input + cacheRead + cacheWrite`（兜底 `totalTokens`）。
 * 口径说明见文件头注释（**不含 output**）。
 */
export function contextUsedTokensOf(usage: ContextTokenUsage | undefined | null): number {
  if (!usage) return 0;
  const sum = usage.input + usage.cacheRead + usage.cacheWrite;
  if (sum > 0) return sum;
  const total = typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
  return total > 0 ? total : 0;
}

/** 规范化上下文窗口上限；非法值一律视作「未知」（0）。 */
export function normalizeContextWindow(contextWindow: number | null | undefined): number {
  return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : 0;
}

/** 上下文「剩余」token 数 = `max(0, 窗口 − 已用)`；无窗口时返回 0。 */
export function contextRemainingTokensOf(
  usage: ContextTokenUsage | undefined | null,
  contextWindow: number | null | undefined,
): number {
  const window = normalizeContextWindow(contextWindow);
  if (!window) return 0;
  return Math.max(0, window - contextUsedTokensOf(usage));
}

/** 上下文占用百分比（0-100）；无窗口或无用量时返回 null。 */
export function contextPercentOf(
  usage: ContextTokenUsage | undefined | null,
  contextWindow: number | null | undefined,
): number | null {
  const window = normalizeContextWindow(contextWindow);
  if (!window) return null;
  const used = contextUsedTokensOf(usage);
  if (used <= 0) return null;
  return Math.min(Math.round((used / window) * 100), 100);
}

/** 占用率配色类名：>=90% 危险、>=75% 警告（阈值与上游一致）。 */
export function contextPercentClassOf(percent: number | null): string {
  if (percent === null) return "";
  if (percent >= 90) return "ctx-danger";
  if (percent >= 75) return "ctx-warn";
  return "";
}

/**
 * 紧凑 token 计数（**逐字移植**自旧版 `ui/src/lib/format.ts:formatCompactTokenCount`）：
 *
 * ```text
 * 999       → "999"       1_000     → "1k"        27_541    → "27.5k"
 * 204_800   → "204.8k"    1_048_576 → "1M"        1_500_000 → "1.5M"
 * ```
 *
 * 规则：>= 1M 进 M 档；>= 1k 进 k 档（先 `toFixed(1)`，若进位到 `1000.0` 再升到 M，
 * 避免出现 `1000k`）；尾数 `x.0` 去零（`trimTrailingZero`，默认 true）。
 * ⚠️ 与 `formatTokens`（`utils/format.ts`，k 档不带小数当 k>=10）**不是同一套规则**，别互相替换。
 */
export function formatCompactTokenCount(
  tokens: number,
  options: { thousandsSuffix?: string; millionsSuffix?: string; trimTrailingZero?: boolean } = {},
): string {
  const thousandsSuffix = options.thousandsSuffix ?? "k";
  const millionsSuffix = options.millionsSuffix ?? "M";
  const trimTrailingZero = options.trimTrailingZero ?? true;
  const trim = (value: string) => (trimTrailingZero ? value.replace(/\.0$/, "") : value);
  if (tokens >= 1_000_000) {
    return `${trim((tokens / 1_000_000).toFixed(1))}${millionsSuffix}`;
  }
  if (tokens >= 1_000) {
    const thousands = (tokens / 1_000).toFixed(1);
    // 999_500..999_999 会进位成 "1000.0k" → 升到 M 档，而不是显示 1000k
    if (Number(thousands) >= 1_000) {
      return `${trim((tokens / 1_000_000).toFixed(1))}${millionsSuffix}`;
    }
    return `${trim(thousands)}${thousandsSuffix}`;
  }
  return String(tokens);
}

/**
 * 弹层标题行右侧文案 = `已用 / 上限`（旧版 `getContextNoticeViewModel().detail`）。
 * 口径与百分比同源（`contextUsedTokensOf`，**不含 output**），两个数都走紧凑格式：
 * 27,541 / 1,048,576 → `27.5k / 1M`；56,200 / 204,800 → `56.2k / 204.8k`（截图）。
 */
export function contextWindowDetailOf(
  usage: ContextTokenUsage | undefined | null,
  contextWindow: number | null | undefined,
): string {
  const window = normalizeContextWindow(contextWindow);
  return `${formatCompactTokenCount(contextUsedTokensOf(usage))} / ${formatCompactTokenCount(window)}`;
}
