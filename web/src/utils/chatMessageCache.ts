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

/**
 * 会话消息缓存条目。
 *
 * `messages`  已加载到客户端的最新一段消息快照（供切回会话秒回）。
 * `hasMore` / `nextOffset`
 *             会话历史分页游标（对应后端 `chat.history` 响应的同名字段）：
 *             还有更早消息时 `hasMore === true` 且 `nextOffset` 给出下一次
 *             offset；否则没有更早可加载。缓存命中时恢复游标，用户切回本会话
 *             后仍可继续向上翻更早历史，无需重新联网探测。
 *
 * @author yangchenglin11@jd.com
 * @date 2026年9月16日 17:42:00
 * @version feature_web
 */
type CacheEntry = {
  messages: ChatMessage[];
  ts: number;
  hasMore?: boolean;
  nextOffset?: number;
};

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

/**
 * 读取会话分页游标（缓存命中时由聊天窗格恢复，用于继续加载更早历史）。
 * 无缓存 / 已过期 / 无更早可加载均返回 `null`。
 *
 * @author yangchenglin11@jd.com
 * @date 2026年9月16日 17:42:00
 * @version feature_web
 */
export function getChatHistoryCursor(key: string): {
  hasMore: boolean;
  nextOffset?: number;
} | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(key);
    return null;
  }
  if (!entry.hasMore) return null;
  return { hasMore: true, nextOffset: entry.nextOffset };
}

/** 写入 / 覆写某会话的缓存（覆写会刷新 ts）。 */
export function setChatMessageCache(
  key: string,
  messages: ChatMessage[],
  cursor?: { hasMore?: boolean; nextOffset?: number },
): void {
  const existing = cache.get(key);
  const hasMore = cursor?.hasMore === true || existing?.hasMore === true || false;
  const nextOffset =
    typeof cursor?.nextOffset === "number"
      ? cursor.nextOffset
      : typeof existing?.nextOffset === "number"
        ? existing.nextOffset
        : undefined;
  cache.set(key, {
    messages,
    ts: Date.now(),
    ...(hasMore ? { hasMore: true } : {}),
    ...(typeof nextOffset === "number" ? { nextOffset } : {}),
  });
}

/** 单会话失效；不传 key 则清空全部（登录态切换等场景）。 */
export function clearChatMessageCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
