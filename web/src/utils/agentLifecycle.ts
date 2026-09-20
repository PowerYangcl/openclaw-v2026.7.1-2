/**
 * 上游 `agent` 事件的 **lifecycle 流** —— 一轮 run 自己的开始 / 收尾信号。
 *
 * ## 为什么前端需要它（本文件的存在理由）
 * 「每条回复下方的积分」要求：**生成过程中不显示积分，回复完成后先显示加载态，
 * 拿到数值再显示结果**。难点在于「回复完成」这一刻前端有没有信号 —— 因为网关
 * 的积分是**在 final 帧广播之前**同步轮询出来的：
 *
 * ```
 * src/gateway/server-chat.ts:974-988
 *   decorateChatFinalMessageWithSpend() → pollJdSpendForChat(responseId, { deadlineMs: 6_000 })
 * src/gateway/server-chat.ts:1542-1545
 *   lifecycle phase === "end"  →  finalizeLifecycleEvent() → void emitChatTerminal(...)
 * ```
 * 也就是说 `chat state=final` 帧里**已经带着** `spendResult`，但它要等积分轮询完
 * 才发出来。实测（2026-09-18，`agent:main:main` / GLM-5.1）：
 *
 * ```
 *  +5895ms  agent lifecycle phase=end      ← 生成结束，积分轮询从这一刻开始
 *  +5895ms  chat  delta（正文最后一段）
 * +12723ms  chat  state=final  spend={spend:43.68,balance:963833.94}
 * ```
 * ⇒ 生成结束到 final 之间有 **~6.8s 真空**。这正好就是「积分计算中」该出现的位置。
 *
 * ## 这个事件的来源与顺序保证
 * `finalizeLifecycleEvent` 之外，同一条 agent 事件在 `server-chat.ts:1448-1464`
 * 就已经被 `sendAgentPayload` 广播给 control-ui 了，**早于** 1542 行的
 * `finalizeLifecycleEvent`（后者才去 await 积分轮询）。所以前端能稳定地先收到
 * lifecycle `end`、后收到带积分的 `final`，**不需要自己再发一次查询**。
 *
 * 事件形态（`src/auto-reply/reply/agent-lifecycle-terminal.ts:76-120`）：
 * ```jsonc
 * { "event": "agent",
 *   "payload": { "runId": "...", "sessionKey": "agent:main:main",
 *                "stream": "lifecycle",
 *                "data": { "phase": "end", "endedAt": 1758...,
 *                          "responseId": "chatcmpl-...", "aborted": false,
 *                          "stopReason": "stop" } } }
 * ```
 */

/** 一轮 run 的生命周期阶段（上游 `agent-lifecycle-terminal.ts` 的 `data.phase`）。 */
export type AgentLifecyclePhase = "start" | "finishing" | "end" | "error";

export type AgentLifecycleEventPayload = {
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  stream: "lifecycle";
  data?: {
    phase?: string;
    /** 本轮是被中断收尾的（stop / 引导打断），但**积分照样要算**。 */
    aborted?: boolean;
    stopReason?: string;
    /** 上游完成 id（`chatcmpl-…`），同时也是积分查询的 key。 */
    responseId?: string;
    endedAt?: number;
  } | null;
};

/** payload 是对象就返回它，否则 null（事件来自 WS，字段一律不可信）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** 读出 lifecycle 阶段；不是 lifecycle 事件 / 没带 phase 时返回 null。 */
export function readAgentLifecyclePhase(payload: unknown): AgentLifecyclePhase | null {
  const record = asRecord(payload);
  if (!record || record.stream !== "lifecycle") return null;
  const data = asRecord(record.data);
  const phase = data?.phase;
  if (phase === "start" || phase === "finishing" || phase === "end" || phase === "error") {
    return phase;
  }
  return null;
}

/**
 * 是否属于「**本轮生成已经结束**」的 agent 事件（`stream=lifecycle` + `phase=end`）。
 *
 * 只认 `end`，不认 `error`：错误收尾的 run 走 `emitChatTerminal(jobState: "error")`，
 * 那条路径**不做**积分装饰（`server-chat.ts:1017` 的 `if (jobState !== "error")`），
 * 所以错误轮次没有「等积分」这回事，不该进加载态。
 *
 * `finishing` 同样不认：它是 with-in run 的收尾前哨（`agent-lifecycle-terminal.ts:67`），
 * 之后还可能再产出内容。
 */
export function isReplyFinishedAgentEvent(evt: {
  event?: unknown;
  payload?: unknown;
}): evt is { event: "agent"; payload: AgentLifecycleEventPayload } {
  if (evt.event !== "agent") return false;
  if (readAgentLifecyclePhase(evt.payload) !== "end") return false;
  return true;
}
