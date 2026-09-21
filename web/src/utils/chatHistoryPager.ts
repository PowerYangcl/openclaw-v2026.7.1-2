/**
 * 会话历史分页（`chat.history` 向上翻页）的**纯逻辑**：常量、游标解析、
 * 「什么时候该自动拉下一页」与「滚动位置是否在底部」的判定。
 *
 * ## 为什么要单独成模块
 * 分页状态（`hasMore` / `nextOffset` / `loading`）散在 `ChatPane.vue` 里时，
 * 触发条件只能靠读模板 + 滚动回调拼出来，**无法单测**；而这里每条规则都是
 * 一次真实事故的产物（重复请求、视口跳动、到底后请求雪崩），值得钉住。
 *
 * ## 方向口径（重要，别被「滚到底部」的字面意思带偏）
 * 对话按**时间正序**渲染（旧 → 新，最新一条在最下方），后端 `chat.history` 的
 * `offset` 游标指向的是**更早**的一页（`offset: 0` = 最新一页，实测
 * 0 → 500 → 1000 一路往 2026-09-02 走）。
 * 于是：
 * - 「再看更早的消息」这个动作在 UI 上必然发生在**列表顶部**，哨兵/阈值都在顶部；
 * - 列表**底部**是「最新消息」，它的内容由流式推送负责，**没有下一页可翻**。
 *   把「滚到底部」实现成翻页会让用户一打开会话（打开即停在底部）就把整段
 *   历史一次性全拉下来，分页直接失效 —— 所以底部只做两件事：
 *   ① 自动跟随新消息（`isNearBottom`）；② 当内容**撑不满一屏**（顶部即底部、
 *   用户根本无法再上滑）时补拉下一页，见 `shouldAutoLoadOlder`。
 */

/**
 * 单页历史条数（`chat.history` 的 `limit`）。
 *
 * 从 200 提到 500 的依据（实测 1328 条会话，页面同源上下文发 RPC，只算网关侧）：
 *
 * | limit | 响应体积 | 网关中位耗时 | 拉完全部需 |
 * |-------|----------|--------------|------------|
 * | 200   | 221.4KB  | 99ms         | 7 次       |
 * | 500   | 814.1KB  | 107ms        | 3 次       |
 * | 1000  | 1260.9KB | 176ms        | 2 次       |
 *
 * 500 是拐点：耗时代价 +8ms（1.08x，感知不到），往返次数 7→3。
 * 1000 单帧涨到 1.26MB 且耗时 1.78x，收益（3→2 次）远不及代价，故不取。
 * 协议上限为 1000（`ChatHistoryParamsSchema.limit`），改这里不必动网关。
 *
 * ⚠️ 首屏（offset=0）另有约 100ms 固定成本（疑似 totalMessages 全量计数），
 * 与 limit 无关 —— 调这个常量压不掉它。
 */
export const CHAT_HISTORY_PAGE_SIZE = 500;

/**
 * 单条消息正文的字符上限。
 *
 * 网关默认只给 8000 字符（`DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS`），超了就在尾部追加
 * `...(truncated)...` —— 长回复在历史里会被静默切掉。协议
 * `ChatHistoryParamsSchema.maxChars` 允许到 50 万，这里由请求端显式放大。
 */
export const CHAT_HISTORY_MAX_CHARS = 200_000;

/**
 * 入参降级时用的**保守页大小**（`requestChatHistory` 第二次尝试才用）。
 *
 * 为什么要「降」而不是沿用 `CHAT_HISTORY_PAGE_SIZE`：老网关的 schema 是
 * `additionalProperties: false` **且**每个字段带 `maximum`。只删新增字段、把 `limit`
 * 原样重发，会被同一个 `invalid chat.history params` **再拒一次** —— 降级等于没写，
 * 症状与「历史一条都不显示」完全相同。100 在所有历史版本的 schema 里都合法。
 */
export const CHAT_HISTORY_FALLBACK_PAGE_SIZE = 100;

/** `chat.history` 的分页游标（首屏与翻页共用一份）。 */
export type HistoryCursor = {
  /** 后端是否还有**更早**的消息。 */
  hasMore: boolean;
  /** 下一次翻页要传的 `offset`（服务端游标）。 `hasMore=false` 时无意义。 */
  nextOffset?: number;
};

/** `chat.history` 响应里与分页有关的那几个字段（只声明我们读的部分）。 */
export type HistoryCursorResponse = {
  hasMore?: unknown;
  nextOffset?: unknown;
};

/** 「还没有任何分页信息」的游标：首屏请求发出前 / 切换会话时用它复位。 */
export const EMPTY_HISTORY_CURSOR: HistoryCursor = { hasMore: false, nextOffset: undefined };

/** 距顶多少像素内算「在顶」，触发自动加载更早历史。 */
export const HISTORY_TOP_TRIGGER_PX = 120;

/** 距底多少像素内算「在近底」，用于决定新消息是否把视口拽回底部。 */
export const NEAR_BOTTOM_PX = 450;

/**
 * 内容高度不足视口多少像素时，视为「撑不满一屏」。
 *
 * 留一点余量是因为 `scrollHeight` 与 `clientHeight` 都是整数取整值，
 * 内容刚好等于一屏时会随机落在 ±1px，判定不该跟着抖。
 */
export const VIEWPORT_FILL_SLACK_PX = 24;

/** 滚动容器的三个尺寸（`scrollTop` / `scrollHeight` / `clientHeight` 的投影）。 */
export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** 从 `chat.history` 响应里解析游标（形状不对一律按「没有更早」处理，不抛异常）。 */
export function readHistoryCursor(res: HistoryCursorResponse | null | undefined): HistoryCursor {
  const hasMore = res?.hasMore === true;
  const nextOffset =
    hasMore && typeof res?.nextOffset === "number" && Number.isFinite(res.nextOffset)
      ? res.nextOffset
      : undefined;
  return { hasMore, nextOffset };
}

/** 从缓存里带回的游标（可能是脏数据）归一成合法形态。 */
export function normalizeHistoryCursor(cursor: HistoryCursor | null | undefined): HistoryCursor {
  if (!cursor || cursor.hasMore !== true) return { ...EMPTY_HISTORY_CURSOR };
  return {
    hasMore: true,
    nextOffset:
      typeof cursor.nextOffset === "number" && Number.isFinite(cursor.nextOffset)
        ? cursor.nextOffset
        : undefined,
  };
}

/**
 * 现在能不能发一次翻页请求。
 *
 * ⚠️ 必须有 `nextOffset` 才算能翻：网关只在**显式传 offset** 时才在响应里给
 * `hasMore`/`nextOffset`（`src/gateway/server-methods/chat.ts` 的 `readChatHistoryPage`
 * 无 offset 分支不返回这两个字段），所以「hasMore=true 但 nextOffset=undefined」
 * 是可能的脏态，这时翻页请求会退回无 offset 分支、拿回同一页 ⇒ 死循环。
 */
export function canLoadOlder(cursor: HistoryCursor, loading: boolean): boolean {
  if (loading) return false;
  if (!cursor.hasMore) return false;
  return typeof cursor.nextOffset === "number" && Number.isFinite(cursor.nextOffset);
}

/** 是否已滚到（接近）顶部。 */
export function isAtTop(metrics: ScrollMetrics, thresholdPx = HISTORY_TOP_TRIGGER_PX): boolean {
  return metrics.scrollTop <= thresholdPx;
}

/** 是否已滚到（接近）底部 —— 决定新 token 要不要把视口拽回底部。 */
export function isNearBottom(metrics: ScrollMetrics, thresholdPx = NEAR_BOTTOM_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

/** 内容是否**撑不满一屏**（此时顶部与底部是同一个位置，用户无法再上滑）。 */
export function cannotScrollFurther(
  metrics: ScrollMetrics,
  slackPx = VIEWPORT_FILL_SLACK_PX,
): boolean {
  return metrics.scrollHeight <= metrics.clientHeight + slackPx;
}

/**
 * 该不该自动拉更早的一页？
 *
 * 两个来源，任满足其一：
 * 1. **触顶**（`scrollTop <= HISTORY_TOP_TRIGGER_PX`）—— 常规无限滚动；
 * 2. **撑不满一屏**（`cannotScrollFurther`）—— 此时哨兵永远不会进入视口，
 *    只认触顶会让「没有滚动条」的会话卡住：用户停在列表底部（= 顶部），
 *    看着一个「加载更早消息」按钮却没有任何自动续拉。
 *
 * ⚠️ 第 2 条**只在容器确实没有可滚动空间时**成立。别把它放宽成
 * 「滚到底部就翻页」：打开会话时视口就在底部，那会一次性拉完全部历史。
 */
export function shouldAutoLoadOlder(params: {
  cursor: HistoryCursor;
  loading: boolean;
  metrics: ScrollMetrics;
}): boolean {
  if (!canLoadOlder(params.cursor, params.loading)) return false;
  return isAtTop(params.metrics) || cannotScrollFurther(params.metrics);
}

/**
 * 从新一页里挑出**尚未出现过**的消息（按稳定 id 去重）。
 *
 * `offset` 返回的边界条可能与已加载部分重叠，直接前置插入会出现重复渲染，
 * 且重复节点的 `:key` 会撞车（Vue 复用错节点 → 删除/复制错位）。
 */
export function pickUnseenById<T extends { id: string }>(
  page: readonly T[],
  knownIds: ReadonlySet<string>,
): T[] {
  return page.filter((item) => !knownIds.has(item.id));
}

/**
 * 前置插入更早一页后，为「视口不跳动」计算新的 `scrollTop`。
 *
 * 内容从顶部插入会让 scrollHeight 变大；若不同步把 scrollTop 补上新增高度，
 * 用户看到的内容会整体下移（表现为「一翻页就跳到别的地方」）。
 * `prevScrollHeight <= 0`（首帧）或高度没变时返回原值。
 */
export function anchoredScrollTop(params: {
  prevScrollTop: number;
  prevScrollHeight: number;
  nextScrollHeight: number;
}): number {
  const delta = params.nextScrollHeight - params.prevScrollHeight;
  if (params.prevScrollHeight <= 0 || delta <= 0) return params.prevScrollTop;
  return params.prevScrollTop + delta;
}
