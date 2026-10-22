/**
 * 本轮「生成模型」的**兜底估算**（仅在网关没给真值时使用）。
 *
 * ## 为什么需要它
 *
 * `final` 帧从网关带 `provider`/`model` 是**新版网关**才有的字段；老网关上这一帧
 * 里只有 `{role, content, timestamp}`，于是实时落地的那条回复的积分行会**没有模型名**
 * （要刷新走 `chat.history` 才出现）。
 *
 * 直接拿「用户本地选择的模型」补上是不行的 —— 那正是「界面显示 Kimi、后台跑 DeepSeek」
 * 的来源。这里改成**按网关的真实行为规律推断**，并把结果标成
 * `modelEstimated`，随后由 `reconcileRunModel` 用 `chat.history` 的真值校正。
 *
 * ## 推断依据（不是猜）
 *
 * 老网关 `chat.send` 的模型覆盖有一段守卫：
 * `src/gateway/server-methods/chat.ts` 的 `if (modelOverrideRequested && entry && storePath)`
 * —— **只有会话行已存在**时才会把 `providerOverride`/`modelOverride` 写进去。
 * 所以：
 *   - 会话已存在（`sessionExists`）⇒ 覆盖会生效 ⇒ 本轮实际跑 `selected`
 *   - 全新会话的首条消息 ⇒ 覆盖被整段跳过 ⇒ 本轮实际跑 agent 默认模型
 *
 * 这正是我们在本机上实测到的行为（新 key 首条落库为默认模型，第二条才落 Kimi）。
 *
 * ## 边界
 *
 * - 用户选「使用默认模型」（`selected === null`）⇒ 一律取默认模型。
 * - 默认模型也拿不到 ⇒ 返回 `null`，**宁可不显示也不猜**。
 * - 新版网关（final 带 model）不会走到这里。
 */

export type ModelParts = { provider: string; model: string };

export type RoundModelEstimateInput = {
  /** 用户显式选中的模型；`null` = 选了/等价于「使用默认模型」。 */
  selected: ModelParts | null;
  /** 网关侧的 agent 默认模型（`agents.list` 或 `sessions.list.defaults`）。 */
  defaultModel: ModelParts | null;
  /**
   * 发送这一条时，该会话行是否**已存在**（有 `sessionId` 即算存在）。
   *
   * 语义是「老网关会不会应用模型覆盖」，不是「有没有聊天记录」：一条只有失败用户
   * 消息的会话同样已经有 entry，覆盖照样生效。
   */
  sessionExists: boolean;
};

/**
 * 估算本轮实际会用的模型。
 *
 * 返回值只用于「先把位置占上」，调用方必须把它标成估算态，并用 `chat.history`
 * 里本轮落库的助手消息校正（历史投影每条都带当轮真值）。
 */
export function estimateRoundModel(input: RoundModelEstimateInput): ModelParts | null {
  const { selected, defaultModel, sessionExists } = input;
  if (!selected) return defaultModel;
  // 会话已存在 ⇒ 老网关会应用覆盖。
  if (sessionExists) return selected;
  // 全新会话首条 ⇒ 老网关丢弃覆盖，落到 agent 默认。
  return defaultModel;
}

/** `chat.history` 里一条消息的**最小**字段集（其余字段不关心）。 */
type HistoryMessageLike = {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  timestamp?: unknown;
};

/**
 * 从 `chat.history` 的结果里挑出**本轮**助手消息的模型（真值）。
 *
 * 返回 `null` 表示本轮还没落库 —— 调用方应等下一阶梯重试，**不要**退化成别的来源：
 * 会话行上的 `model` 走 `selectedModel ?? runtime`，实测可能落后于最后一条消息
 * （`agent:cet4:main` 行是 GLM-5.1、消息是 Kimi-K2.5），拿它校正会把对的改成错的。
 *
 * ⚠️ 时间下界是这个函数的关键：final 落地后 transcript 可能还没写完，此时列表尾部
 * 是**上一轮**的助手消息；没有 `startedAt` 下界就会把上一轮的模型「校正」到本轮头上。
 *
 * @param messages `chat.history` 返回的 `messages`（按时间正序）
 * @param startedAt 本轮发送时刻（ms）
 * @param toleranceMs 允许的时钟偏差（默认 1500ms）
 */
export function pickRoundModelFromHistory(
  messages: readonly unknown[],
  startedAt: number,
  toleranceMs = 1500,
): ModelParts | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i] as HistoryMessageLike | null;
    if (!item || item.role !== "assistant") continue;
    const provider = typeof item.provider === "string" ? item.provider.trim() : "";
    const model = typeof item.model === "string" ? item.model.trim() : "";
    // 老网关的 `toolResult` / 失败的助手段可能没有模型字段 ⇒ 继续往前找同轮的其它段。
    if (!provider || !model) continue;
    const ts = typeof item.timestamp === "number" ? item.timestamp : 0;
    if (startedAt > 0 && ts > 0 && ts < startedAt - toleranceMs) return null;
    return { provider, model };
  }
  return null;
}
