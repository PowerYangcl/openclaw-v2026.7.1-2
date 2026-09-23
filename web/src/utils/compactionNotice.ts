/**
 * 对话压缩（Compaction）提示的识别 —— **只用于渲染层过滤**。
 *
 * ## 背景
 * 压缩是网关侧的正常运行逻辑（上下文超窗前自动摘要/裁剪），它本身必须跑；
 * 但压缩过程中网关会往会话里投递一批「用户可见」的进度提示，例如：
 *
 * - `src/auto-reply/reply/compaction-notice.ts` 的 `COMPACTION_NOTICE_TEXT`：
 *   `🧹 Compacting context...` / `🧹 Compaction complete` / `🧹 Compaction incomplete` /
 *   `🧹 Compaction not needed` / `⚠️ Memory maintenance temporarily failed; ...`
 * - `src/hooks/bundled/compaction-notifier/handler.ts` 的 hook 文案：
 *   `🧹 Compacting context (42 messages) so I can continue without losing history…`
 *   `✅ Context compacted (12,345 → 4,321 tokens). Continuing from where I left off.`
 *
 * 这些 payload 最终会作为一条普通的 assistant / system 消息出现在对话流里，
 * 用户视角就是「聊天中间突然插一句正在压缩」。这里把它们挡在**界面之外**。
 *
 * ## 硬边界
 * - **只过滤渲染**：`messages` 数组保持原样（index 派生 key、上下文占用统计、
 *   链式删除、导出都还在用它），只是模板遍历的 `computed` 少了这几条。
 *   与 `utils/messageCommit.ts` 的 `isRenderableMessageRole` 同一套口径。
 * - **不改后端**：压缩逻辑、checkpoint、transcript 落盘全部不受影响；
 *   这里也没有任何 RPC / 配置开关，纯字符串判定。
 * - **不碰 toolResult**：会话状态里的 `🧹 Compactions: 0` 属于工具结果正文，
 *   它不是压缩提示，且本就折叠在 Activity 卡片里，故按 role 排除。
 */

/** 只有这两类角色会承载压缩提示（normalizeMessage 对缺失 role 默认 assistant）。 */
const NOTICE_ROLES: ReadonlySet<string> = new Set(["assistant", "system"]);

/**
 * 整条消息匹配：一条消息**从头到尾**就是一句压缩提示时才命中。
 *
 * ⚠️ 刻意用「整条匹配」而不是「包含即命中」：助手完全可能在正常回复里
 * 提到 compaction 这个词，那种情况必须照常显示。
 */
const COMPACTION_NOTICE_PATTERNS: readonly RegExp[] = [
  // `compaction-notice.ts` 的 start 阶段（含 hook 加了 `(N messages)` 后缀的版本）
  /^🧹\s*Compacting context\b[\s\S]*$/i,
  // end / incomplete / skipped 三个阶段
  /^🧹\s*Compaction\s+(complete|incomplete|not\s+needed)\b[\s\S]*$/i,
  // memory_flush_degraded
  /^⚠️\s*Memory maintenance temporarily failed\b[\s\S]*$/i,
  // `compaction-notifier` hook 的 compact:after
  /^✅\s*Context compacted\b[\s\S]*$/i,
];

/**
 * 流式前缀匹配：正文还在往外出的时候只能看到开头几个字，
 * 此时用前缀判断，避免压缩提示在流式气泡里闪一下。
 *
 * ⚠️ `✅` 是助手常用符号，**不能**裸匹配 `^✅`；只有跟 `Context compacted`
 * 连写才算。`🧹` 在正常回复里极少单独出现，可以裸匹配开头。
 */
const COMPACTION_NOTICE_PREFIX_PATTERNS: readonly RegExp[] = [
  /^🧹/,
  /^✅\s*Context compacted\b/i,
  /^⚠️\s*Memory maintenance\b/i,
];

export type CompactionNoticeCandidate = {
  role?: string;
  text?: string | null;
};

/** 整段正文是不是一句压缩提示（流式落库 / 历史消息都走这条）。 */
export function isCompactionNoticeText(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return COMPACTION_NOTICE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** 流式过程中的部分正文：是不是已经能看出这是一句压缩提示。 */
export function looksLikeStreamingCompactionNotice(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  return COMPACTION_NOTICE_PREFIX_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * 这条消息该不该因为「是压缩提示」而从对话界面隐藏。
 *
 * 注意返回 `true` 只是**不渲染**，消息对象本身仍然留在数据源里。
 */
export function isCompactionNoticeMessage(msg: CompactionNoticeCandidate | null | undefined): boolean {
  if (!msg) return false;
  // role 缺失时 normalizeMessage 会按 assistant 处理，这里同口径放行。
  if (msg.role && !NOTICE_ROLES.has(msg.role)) return false;
  return isCompactionNoticeText(msg.text);
}
