/**
 * agent 的**快捷开场白**（`quickStart`）解析 —— 纯函数，便于单测。
 *
 * ## 数据从哪来
 * 每个 agent 的 workspace 里可以放一份 `agent-config.json`，形如：
 * ```json
 * { "quickStart": ["帮我背今天的 30 个词", "把上次的计划再精简一版"] }
 * ```
 * 这是**唯一**来源：网关 `agents.list` 会读它（`src/gateway/session-utils.ts:1370
 * readAgentQuickStart`，调用点 `:1348`），把结果挂在 **agent 行**上；旧版 Lit 界面
 * 据此把空会话的默认推荐换成该 agent 自己的开场白
 * （`ui/src/pages/chat/components/chat-welcome.ts:44 resolveSuggestionTexts`：
 * 「Custom per-agent quickStart wins over the default i18n list」）。
 *
 * ui 层**不直接读文件**（全仓 `ui/src` 无 `agent-config` 字样），只消费列表行上的
 * `quickStart` —— 本模块沿同一分工，前端不做任何文件访问。
 *
 * ## 为什么同时看 `row.quickStart` 与 `row.identity.quickStart`
 * 协议里这两处都声明了该字段（`src/shared/session-types.ts:44` 在行上、`:9` 在
 * identity 上），当前网关版本只在**行**上注入。两个位置都读，是为了：
 * ① 兼容把 quickStart 收敛进 identity 的网关版本；
 * ② **不因字段位置变化而静默丢按钮** —— 这类「配置明明配了、界面就是没有」的问题
 * 没有报错、没有日志，排查成本极高，多读一处是廉价的保险。
 *
 * ## 判定口径（对齐 ui 层）
 * - 缺省 / 不是数组 / 过滤后为空 ⇒ `undefined`（调用方据此回落默认建议列表）；
 * - 只丢掉**空白字符串**，其余元素取 `trim()` 后的值。
 *   ⚠️ ui 层这条链是「`chat-pane.ts:1049 resolveSameAgentQuickStart` 先过滤不 trim →
 *   `chat-welcome.ts:44 resolveSuggestionTexts` 渲染时再 `entry.trim()`」，**最终上屏
 *   的是 trim 后的文本**，且点击后写进输入框 / 直接发送的也是这段 trim 文本
 *   （`onDraftChange(text); onSend()`）。这里一次性 trim 到位，与 ui 的**最终效果**一致，
 *   比照抄中间态更不容易出偏差（缩进/换行会原样带进用户发出去的消息）。
 * - 两个位置都有效时**先取行级**（网关当前的真实来源）。
 */

/** `quickStart` 可能出现的两处载体（只需读这两个字段，故不依赖完整 Gateway 类型）。 */
export type QuickStartCarrier = {
  quickStart?: unknown;
  identity?: { quickStart?: unknown } | null;
};

/** 归一化一个候选值：非数组 / 全空白 ⇒ `undefined`，否则取 trim 后的字符串数组。 */
function normalizeQuickStart(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const texts = value
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .map((entry) => entry.trim());
  return texts.length > 0 ? texts : undefined;
}

/**
 * 从 agent 行（或任意带这两个字段的对象）里取出快捷开场白。
 *
 * 返回 `undefined` 表示「这个 agent 没配」——调用方应回落到默认建议，而不是渲染空位。
 */
export function resolveAgentQuickStart(
  row: QuickStartCarrier | null | undefined,
): string[] | undefined {
  if (!row || typeof row !== "object") return undefined;
  return normalizeQuickStart(row.quickStart) ?? normalizeQuickStart(row.identity?.quickStart);
}
