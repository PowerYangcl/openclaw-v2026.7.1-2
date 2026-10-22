/**
 * 「同一条助手回复被落地两次」的内容级兜底判重。
 *
 * ## 为什么不能只靠 runId
 *
 * `ChatPane` 已有一层 `committedFinalRuns`（按 `payload.runId` 判重）。但网关侧
 * **同一个 run 可能产生两个 terminal 帧**，而且第二次拿不到 registry 里的注册项：
 *
 *   `src/gateway/server-chat.ts:669`  `const terminalRunId = finished?.clientRunId ?? eventRunId;`
 *   `src/gateway/server-chat.ts:617`  `const eventRunId = chatLink?.clientRunId ?? evt.runId;`
 *
 * 第一次收尾时 `registry.shift()` 成功 ⇒ `runId` = clientRunId；
 * 第二次收尾时 registry 已空 ⇒ `runId` 退化成 agent 内部的 `evt.runId`。
 * 两个 id 不同 ⇒ 按 runId 的判重**完全失效**，同一条回复被 push 两遍，
 * 用户看到「回复了两次」，思考块还会跟着重挂一次（观感上像频闪）。
 *
 * 本机实测（本地网关，error 路径）确认一次 `chat.send` 会收到两个 terminal 帧，
 * 且 `seq` 乱序（4 先到、1 后到），证明收尾确实有两条独立路径。
 *
 * ## 判据
 *
 * 「正文 + 思考一字不差」且落在窗口内才算重复：
 * - 只比较内容，不猜 run 归属 —— 两个 run 撞上完全相同正文的概率极低；
 * - 加时间窗，避免把用户**隔段时间又问一遍同样问题**得到的同样回答吞掉；
 * - 空内容不参与（空 final 走的是「回源历史」那条路，有自己的处理）。
 */

export type CommittedFinalSignature = {
  /** 已落地那条的正文（已 `trim`）。 */
  text: string;
  /** 已落地那条的思考过程（已 `trim`；没有则为空串）。 */
  thinking: string;
  /** 落地时刻（ms）。 */
  at: number;
};

/** 重复 terminal 通常在同一秒内到达；3 秒足够覆盖，又不会误伤正常的连续提问。 */
export const DUPLICATE_FINAL_WINDOW_MS = 3000;

/**
 * 本次 final 是否与「刚刚落地的那条」完全重复。
 *
 * @param last 上一次成功落地的签名（没有则 `null`）
 * @param next 本次待落地的正文 / 思考（调用方需先做与落地时相同的归一化）
 * @param now 当前时刻（ms）
 * @param windowMs 判定窗口
 */
export function isDuplicateFinal(
  last: CommittedFinalSignature | null,
  next: { text: string; thinking: string },
  now: number,
  windowMs = DUPLICATE_FINAL_WINDOW_MS,
): boolean {
  if (!last) return false;
  // 空内容不参与判重：空 final 是「被打断 / 失败兜底」的收尾信号，不是一条回复。
  if (!next.text && !next.thinking) return false;
  if (next.text !== last.text) return false;
  if (next.thinking !== last.thinking) return false;
  const elapsed = now - last.at;
  // 时钟回拨（负数）也当作窗口外，避免把后续所有同文本回复都吞掉。
  return elapsed >= 0 && elapsed <= windowMs;
}
