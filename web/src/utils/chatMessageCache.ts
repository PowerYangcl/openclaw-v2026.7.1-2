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
  // ⚠️ 显式传入的 hasMore **优先**：只更新消息（不传 cursor）时沿用旧游标；
  // 但翻到最后一页时 `loadOlderHistory` 会显式传 `hasMore: false`，这里必须能把它落下去，
  // 否则游标永远停在「还有更早」，切回会话后会反复发起注定为空的翻页请求。
  const hasMore =
    cursor?.hasMore !== undefined ? cursor.hasMore === true : existing?.hasMore === true || false;
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
  if (key) {
    cache.delete(key);
    backgroundAssistantMessages.delete(key);
    return;
  }
  cache.clear();
  backgroundAssistantMessages.clear();
}

/**
 * 「别的会话刚结束」的助手回复暂存 —— 切走之后，前一个会话的结果不能丢。
 *
 * ## 为什么需要它（对齐旧版 `ui/src/pages/chat/chat-gateway.ts:156-177`）
 * 会话 A 正在生成时点侧栏切到 B。`ChatPane` 按会话过滤掉 A 的所有帧（视图不能被
 * 别的会话污染，这是对的），但**终止帧 `final` 里带着 A 那条助手回复** ——
 * 直接一起丢掉的话：
 * ① A 的回复谁都没接（内存里没有，消息缓存也停在切换前那一刻）⇒ 切回 A 看不到回复；
 * ② A 的运行态桶里 `sending` 永远是 true（只有 `finalizeStreaming()` 会清它，
 *    而它在别的会话里永远不会被调到）⇒ 输入框卡「正在生成」、回车只进待执行队列。
 *
 * 所以：**视图不动，回复按会话 key 暂存**，`loadHistory` 拿到服务端结果或读缓存时
 * 按稳定 id 去重合并进去。服务端 transcript 落库偶尔晚于终止帧，所以暂存**不清性**读取，
 * 等「服务端结果里已经出现同一个 id」再清掉那几条。
 *
 * 键与消息缓存同源（`qualifySessionKey` 的规范形态），保证「裸 key 派生的窗格」和
 * 「带 agent 前缀的窗格」落到同一个桶。
 */
const backgroundAssistantMessages = new Map<string, ChatMessage[]>();

/** 单会话暂存上限：正常一轮就是 1 条，留出余量避免极端情况下无限累积。 */
const BACKGROUND_MAX = 20;

/** 记下一条「别的会话刚结束」的助手回复（只进暂存，不动当前视图）。 */
export function noteBackgroundAssistantMessage(key: string, message: ChatMessage): void {
  if (!key || !message?.id) return;
  const list = backgroundAssistantMessages.get(key) ?? [];
  if (list.some((item) => item.id === message.id)) return;
  backgroundAssistantMessages.set(key, [...list, message].slice(-BACKGROUND_MAX));
}

/** 读取暂存（**不销毁**，见上文「不清性」说明）。 */
export function readBackgroundAssistantMessages(key: string): ChatMessage[] {
  return backgroundAssistantMessages.get(key) ?? [];
}

/**
 * 清掉暂存里「服务端结果已包含」的那些 id。
 * 不传 `presentIds` = 清空该会话的全部暂存（会话被重置等场景）。
 */
export function clearBackgroundAssistantMessages(
  key: string,
  presentIds?: ReadonlySet<string>,
): void {
  const list = backgroundAssistantMessages.get(key);
  if (!list || list.length === 0) return;
  if (!presentIds) {
    backgroundAssistantMessages.delete(key);
    return;
  }
  const rest = list.filter((item) => !presentIds.has(item.id));
  if (rest.length > 0) backgroundAssistantMessages.set(key, rest);
  else backgroundAssistantMessages.delete(key);
}
