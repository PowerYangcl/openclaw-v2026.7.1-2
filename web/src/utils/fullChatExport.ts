/**
 * 对话**全量导出**的纯逻辑：分页推进决策、页序拼装、去重、停因文案。
 *
 * ## 为什么要单独成模块
 * 「导出」原先只把 `messages.value` 交给 `buildChatMarkdown` —— 那只是**已加载的窗口**
 * （首屏一页 + 用户手动翻过的页），长会话导出出来是**残缺**的。要做到「全量」，
 * 必须顺着 `chat.history` 的 offset 游标一路翻到最早一条。翻页循环本身是 I/O
 * （留在 `ChatPane.vue`，复用既有的参数降级通道），但「下一页该请求哪个 offset」
 * 「什么时候必须停下」「几页怎么拼回时间顺序」这些判定全是纯的、且都踩过坑，值得钉住。
 *
 * ## offset 语义（搞反了一定会漏消息或死循环）
 * 网关 `readSessionMessagesPageWithStatsAsync` 的算法是
 * `endExclusive = totalMessages - offset; start = max(0, endExclusive - maxMessages)`
 * （`src/gateway/session-utils.fs.ts:846-850`）——**`offset` 是「从最新一条往回数的
 * 跳过量」，offset 越大拿到越早的消息**。所以：
 * - `offset: 0` 是**特殊分支**，走 `readRecentSessionMessagesWithStatsAsync`
 *   （尾部窗口读取），拿到的就是「最新的一页」；
 * - 之后按响应里的 `nextOffset` 递增（`0 → 500 → 1000 …`），每页都是**一页比一页早**，
 *   而**页内**顺序仍是时间正序（旧 → 新）。
 * ⇒ 抓取顺序是「批新 → 批旧」，拼装时必须**把页整段倒序**再摊平。
 *
 * ## 终止条件
 * `hasMore = nextOffset < totalMessages`（`src/gateway/server-methods/chat.ts:3286-3287`）。
 * 游标停不下来时必须靠本地闸门兜住（`max-pages` / `stalled`），见 `planFullExportStep`。
 */

/**
 * 全量导出最多翻多少页。
 *
 * 50 页 × `CHAT_HISTORY_PAGE_SIZE`(500) = 25000 条，远超真实会话长度；它纯粹是
 * 「网关给了不推进的游标」时的兜底 —— 没有这道闸，导出会变成一个用户看不见的
 * 无限请求循环（比导不出来糟得多）。
 */
export const FULL_EXPORT_MAX_PAGES = 50;

/**
 * 全量导出时单条消息正文的字符上限。
 *
 * 与首屏的 `CHAT_HISTORY_MAX_CHARS`(200000) 分开，是因为**出口不同**：
 * 首屏是渲染给眼睛看的，正文过长时让网关截断无所谓；导出是**存档**，
 * 被截掉的正文就是永久丢失（会在 md 里留下 `...(truncated)...`）。
 * 取协议 `ChatHistoryParamsSchema.maxChars` 允许的最大值（50 万，无被拒风险）。
 *
 * ⚠️ `maxChars` 是**单条正文**的上限，不是整页预算
 * （`src/gateway/chat-display-projection.ts:56-62` 的 `truncateChatHistoryText`）。
 */
export const FULL_EXPORT_MAX_CHARS = 500_000;

/** 分页游标（与 `utils/chatHistoryPager.ts` 的 `HistoryCursor` 同形，单独声明以免耦合）。 */
export type FullExportCursor = {
  hasMore: boolean;
  nextOffset?: number | null;
};

/** 为什么停下（每一种都对应一条给用户的提示）。 */
export type FullExportStopReason =
  /** 服务端明确说没有更早的消息了 —— 正常收尾。 */
  | "exhausted"
  /** `hasMore` 为真却没有可用的 `nextOffset`（老网关 / 入参被降级）⇒ 翻不动。 */
  | "missing-offset"
  /** 触到本地上限 `FULL_EXPORT_MAX_PAGES`。 */
  | "max-pages"
  /** 游标没推进（下一页还是同一个 offset）⇒ 再请求只会拿回同一页。 */
  | "stalled";

/** 单步决策：要么去抓某一页，要么停下并说明原因。 */
export type FullExportStep =
  | { action: "fetch"; offset: number; page: number }
  | { action: "stop"; reason: FullExportStopReason };

/**
 * 决定下一步：继续抓，还是停。
 *
 * 判定顺序是刻意的 —— 先报「服务端到底了」这种**真实完成**，再报本地闸门，
 * 最后才报脏游标；否则一个既到底又撞上限的会话会得到误导性的提示。
 */
export function planFullExportStep(state: {
  cursor: FullExportCursor;
  /** 已经抓过的页数（`0` = 一页都还没抓，此时 `cursor` 来自当前视图）。 */
  pageIndex: number;
  /** 已经请求过的 offset 集合（抓过的 offset 再出现就是游标没推进）。 */
  seenOffsets: ReadonlySet<number>;
  maxPages?: number;
}): FullExportStep {
  const maxPages =
    typeof state.maxPages === "number" && Number.isFinite(state.maxPages) && state.maxPages > 0
      ? Math.floor(state.maxPages)
      : FULL_EXPORT_MAX_PAGES;
  // 服务端说没有更早的了 —— 这才是「全量导出」的正常终点。
  if (state.cursor.hasMore !== true) return { action: "stop", reason: "exhausted" };
  if (state.pageIndex >= maxPages) return { action: "stop", reason: "max-pages" };
  const offset = state.cursor.nextOffset;
  // ⚠️ 只有 hasMore 没有 nextOffset 是脏态：请求会退化成「不传 offset」，
  // 网关按无 offset 分支把最新一页糊回来 ⇒ 拿到同一页、游标不动 ⇒ 死循环。
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    return { action: "stop", reason: "missing-offset" };
  }
  // 同一个 offset 请求第二次，结果必然与第一次相同 —— 这是 `nextOffset` 不推进时的兜底。
  if (state.seenOffsets.has(offset)) return { action: "stop", reason: "stalled" };
  return { action: "fetch", offset, page: state.pageIndex };
}

/**
 * 把「按**抓取顺序**（批新 → 批旧）」的页拼成一份完整的时间正序列表，并按 id 去重。
 *
 * - 页内顺序就是时间正序，所以只倒**页序**、不倒页内；
 * - 重复 id（页边界的投影重叠 / 服务端消息更新）保留**较新的那一份**——
 *   与视图里 `pickUnseenById` 前置插入时的取舍一致（新页已在列表里，旧页的副本被丢弃）。
 */
export function assembleFullExportMessages<T extends { id: string }>(
  pagesNewestFirst: ReadonlyArray<ReadonlyArray<T>>,
): T[] {
  const out: T[] = [];
  const indexById = new Map<string, number>();
  // 从**最早**的一页开始落地（倒序遍历抓取顺序），后落地的较新副本覆盖先落地的旧副本。
  for (let p = pagesNewestFirst.length - 1; p >= 0; p -= 1) {
    const page = pagesNewestFirst[p];
    if (!Array.isArray(page)) continue;
    for (const item of page) {
      if (!item) continue;
      const id = typeof item.id === "string" ? item.id : "";
      // 没有稳定 id 的项无法去重，原样保留（宁可重复也不丢内容）。
      if (!id) {
        out.push(item);
        continue;
      }
      const at = indexById.get(id);
      if (at === undefined) {
        indexById.set(id, out.length);
        out.push(item);
      } else {
        out[at] = item;
      }
    }
  }
  return out;
}

/**
 * 合并「翻页拿到的更早消息」与「视图里已有的消息（含本地尚未落库的尾部）」。
 *
 * 视图里的数组**就是** offset=0 那一页（`loadHistory` 的产物，本来还叠了
 * `preserveLocalTailMessages` / 背景助手消息），所以它天然是「最新的一段」：
 * 直接把它当成抓取顺序里的第一页，与更早的页一起交给
 * `assembleFullExportMessages` 即可，无需单独排序。
 *
 * 复用它（而不是重新从 offset=0 抓一遍）还顺带拿到两个好处：少一轮请求；
 * 以及**流式刚生成、服务端还没投影出来的那几条不会丢**——它们只存在于视图里。
 */
export function mergeFullExportMessages<T extends { id: string }>(
  olderPagesNewestFirst: ReadonlyArray<ReadonlyArray<T>>,
  liveMessages: ReadonlyArray<T>,
): T[] {
  return assembleFullExportMessages<T>([liveMessages, ...olderPagesNewestFirst]);
}

/** 导出中的进度文案（`messageCount` 是**当前已收集**的条数，会随翻页增长）。 */
export function describeFullExportProgress(pageIndex: number, messageCount: number): string {
  if (pageIndex <= 0) return `正在导出 ${messageCount} 条消息…`;
  return `正在导出 ${messageCount} 条消息…（已抓取 ${pageIndex + 1} 页）`;
}

/**
 * 停因 → 给用户的收尾说明；`null` 表示这是正常完成、不必多说什么。
 *
 * `exhausted` 之外的三种都意味着**导出的内容可能不完整**，必须让用户知道，
 * 否则他会以为手里那份 md 就是全部。
 */
export function describeFullExportStop(reason: FullExportStopReason): string | null {
  switch (reason) {
    case "exhausted":
      return null;
    case "missing-offset":
      return "网关未返回分页游标，已导出当前已加载的消息";
    case "max-pages":
      return `已达单次导出上限（${FULL_EXPORT_MAX_PAGES} 页），更早的消息未包含`;
    case "stalled":
      return "分页游标未推进，已导出当前已收集到的消息";
    default:
      return null;
  }
}

/**
 * 文件名安全化：把路径分隔符与常见非法字符换成 `-`。
 *
 * 助手名来自网关配置 / 会话标题，未必是纯文本（可能含 `/`、`:`、换行），
 * 直接拼进 `download` 会让文件落到意外的目录或直接失败。
 */
export function safeFilenameSegment(
  raw: string | null | undefined,
  fallback = "assistant",
): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  const cleaned = text
    // 控制字符 + Windows/macOS 非法字符 + 路径分隔符
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    // 首尾的点与横线（`..` 之类会让浏览器改语义）
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

/**
 * 导出文件名：`chat-{助手名}-{时间戳}.md`（对齐上游 `export.ts` 的约定）。
 *
 * 时间戳由调用方注入（而不是内部 `Date.now()`），以保证可单测。
 */
export function fullExportFilename(assistantName: string | null | undefined, now: number): string {
  const name = safeFilenameSegment(assistantName);
  const stamp = Number.isFinite(now) ? Math.floor(now) : Date.now();
  return `chat-${name}-${stamp}.md`;
}
