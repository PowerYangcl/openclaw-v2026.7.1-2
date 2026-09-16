/**
 * 「最新这条助手消息的附件/播放器」补齐时的两个判定助手。
 *
 * ## 为什么要它（live final 帧天生没有媒体字段）
 * 网关眼里 assistant 是这样捏出来的（见 `server-chat.ts: emitChatTerminal`）：
 * ```ts
 * message = { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() }
 * ```
 * —— **只有文本**。`MediaPaths` / content 里的 image·audio 块是 `chat.history` 的
 * display projection（`chat-display-projection.ts`）才有的东西，live 帧一次都不会带。
 *
 * 于是两类轮次表现完全不同：
 * 1. 助手在正文里写了 `MEDIA:/…mp3` ⇒ 客户端本地 `splitMediaMarkers` 能解出来 ⇒ 即时有卡片；
 * 2. 文件由工具产出、助手正文没写 `MEDIA:` ⇒ live 帧什么都不带 ⇒ **最新消息永远没有
 *    附件/播放器，只有 F5 刷新（走 `chat.history`）之后才出现**。
 *
 * 第 2 类的唯一解法是回源一趟 `chat.history`。本文件把「有没有媒体」「历史里的哪一条
 * 就是当前这一轮」抽成纯函数，好在单测里钉住（组件里的编排不在测试中）。
 */

import type { ContentAttachmentItem, ContentImageBlock } from "@/utils/contentMedia";
import type { TranscriptMediaItem } from "@/utils/transcriptMedia";

/** 只需要「身份 + 媒体位」字段的消息视图（`ChatMessage` 的结构子集，便于单测构造）。 */
export type MediaAwareMessage = {
  id?: string;
  role?: string;
  text?: string;
  /** 跨来源稳定身份（responseId / transcript id …），见 `ChatPane.stableMessageKey`。 */
  rawId?: string;
  completionId?: string;
  historyMedia?: TranscriptMediaItem[];
  contentImages?: ContentImageBlock[];
  contentAttachments?: ContentAttachmentItem[];
};

/** 这条消息有没有任何可渲染的媒体位（附件卡片 / `<img>` / 历史附件条）。 */
export function hasAnyMedia(msg: MediaAwareMessage | null | undefined): boolean {
  if (!msg) return false;
  if (msg.contentAttachments && msg.contentAttachments.length > 0) return true;
  if (msg.contentImages && msg.contentImages.length > 0) return true;
  if (msg.historyMedia && msg.historyMedia.length > 0) return true;
  return false;
}

/**
 * 从 history 结果里找出「就是当前这一轮」的那条助手消息；找不到返回 `null`。
 *
 * 匹配优先级：`rawId`（responseId，最稳）→ `completionId` → `id` → **正文完全相同**
 * （同一轮文本被投影后应当一致，用它兜住「两边 id 推导不一致」的情况）。
 *
 * ⚠️ 只接受 role 为 assistant 的候选，且绝不跨轮抓：宁可补不上（保持现状），
 * 也不能把上一轮的文件挂到这一条消息上 —— 那比没有附件更难排查。
 */
export function findSameTurnAssistant(
  candidates: readonly MediaAwareMessage[],
  target: MediaAwareMessage,
): MediaAwareMessage | null {
  if (!target) return null;
  const targetText = typeof target.text === "string" ? target.text.trim() : "";

  const assistants = candidates.filter((item) => (item?.role ?? "assistant") === "assistant");

  /**
   * 同一优先级里可能有多个命中（极少见，但发生过：同一轮的 voice 说明被拆成两条记录）。
   * **优先返回带媒体的那条**，补媒体才有意义；都没有就返回第一条。
   */
  const pick = (matches: MediaAwareMessage[]): MediaAwareMessage | null => {
    if (matches.length === 0) return null;
    return matches.find((item) => hasAnyMedia(item)) ?? matches[0] ?? null;
  };

  const byRawId = pick(
    assistants.filter((item) => target.rawId && item.rawId && item.rawId === target.rawId),
  );
  if (byRawId) return byRawId;

  const byCompletion = pick(
    assistants.filter(
      (item) =>
        target.completionId && item.completionId && item.completionId === target.completionId,
    ),
  );
  if (byCompletion) return byCompletion;

  const byId = pick(assistants.filter((item) => target.id && item.id && item.id === target.id));
  if (byId) return byId;

  if (targetText) {
    return pick(
      assistants.filter((item) => typeof item.text === "string" && item.text.trim() === targetText),
    );
  }
  return null;
}

/**
 * 该不该为这条目标消息回源一次 `chat.history`。
 *
 * 只在「这条消息一个媒体位都没有」时才补 —— 正文里写了 `MEDIA:` 的那些轮次
 * 客户端已经解析出卡片了，没必要多发一次 RPC。
 */
export function needsHistoryMediaBackfill(target: MediaAwareMessage | null | undefined): boolean {
  return Boolean(target) && !hasAnyMedia(target);
}
