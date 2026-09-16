/**
 * 客户端会话消息缓存（对齐旧版 `ui/src/pages/chat/session-message-cache.ts`）。
 *
 * 拆分视图 / 多会话切换时，同一个会话的历史消息在 `chat.history` 拉取后缓存一份，
 * 切回时直接秒回，避免每次重新联网、丢失滚动位置。
 *
 * ⚠️ 缓存只是「切回时的即时底图」：流式增量仍由事件实时 push 进 `messages`，
 * 这里不拦截运行时更新。缓存按**规范会话 key** 分桶（与运行态桶同源），
 * 保证「裸 key 派生的窗格」和「带 agent 前缀的窗格」命中同一份。
 */

import type { ChatMessage } from "@/types/chat";

const TTL_MS = 60_000;

type CacheEntry = { messages: ChatMessage[]; ts: number };

const cache = new Map<string, CacheEntry>();

/** 命中且未过期返回消息数组，否则返回 `null`（调用方按需回源）。 */
export function getChatMessageCache(key: string): ChatMessage[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.messages;
}

/** 写入 / 覆写某会话的缓存（覆写会刷新 ts）。 */
export function setChatMessageCache(key: string, messages: ChatMessage[]): void {
  cache.set(key, { messages, ts: Date.now() });
}

/** 单会话失效；不传 key 则清空全部（登录态切换等场景）。 */
export function clearChatMessageCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
