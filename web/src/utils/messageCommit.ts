/**
 * 「助手这一轮的产出如何落进消息列表」的三个判断点。
 *
 * ## 为什么要单独抽出来（这是一个真 bug 的现场）
 * 助手把文件「交给用户」的方式，是在**正文**里写一行 `MEDIA:<路径>`（见
 * `utils/mediaMarker.ts` 文件头）。`normalizeMessage` 会把这一行**从正文里剥掉**，
 * 换成 `contentAttachments` / `contentImages` —— 气泡里因此才有按钮 / 播放器。
 *
 * 于是「只回了一个 mp3」的那一轮，`normalized.text` 是**空串**（整行都被剥掉了）。
 * 而 `ChatPane.vue` 里 `final` 的处理原本写的是：
 * ```ts
 * if (normalized && (normalized.text || normalized.thinking)) { ...push(normalized) }
 * else if (hasStreamedContent) { commitStreamingMessage(); }   // ← 没过 normalizeMessage
 * ```
 * 纯媒体回复必然掉进第二分支：那条消息是**手搓对象**（没有 contentAttachments），
 * 正文还留着被文字彩排过的 `MEDIA:/…mp3` 原文。
 * ⇒ 用户视角：**下载按钮 / 播放器要刷新页面（走 `loadHistory` 的 normalize）才出现**。
 *
 * 把「有没有可见内容」「正文取哪个」「哪些 role 该渲染」这三件事挪到这里，
 * 一是让 `ChatPane.vue` 的两条落库路径共用同一套口径，二是这三个判断都能写单测钉住。
 * （这三个函数**刻意不依赖 Vue**，`tests/messageCommit.test.ts` 直接 import 跑。）
 */

/** 已经过 `normalizeMessage` 的助手消息里，我们关心的那几个字段。 */
export type NormalizedAssistantLike = {
  text?: string;
  thinking?: string;
  contentImages?: readonly unknown[];
  contentAttachments?: readonly unknown[];
  historyMedia?: readonly unknown[];
};

/**
 * 这条产物里有没有「值得落地成一条消息」的内容。
 *
 * ⚠️ **必须把媒体算进来**：只回一个 mp3 / 一张图的那一轮，正文被 `MEDIA:` 剥离后
 * 是空串、也没有思考过程 —— 不算进来的话它会掉进「final 帧无效」的兜底分支，
 * 那条分支生成的手搓对象没有 `contentAttachments`，界面上就什么都不显示。
 */
/** 有没有任何「媒体位」（图片 / 附件 / 顶层 MediaPaths）。 */
export function hasMediaContent(msg: NormalizedAssistantLike | null | undefined): boolean {
  if (!msg) return false;
  if (msg.contentImages && msg.contentImages.length > 0) return true;
  if (msg.contentAttachments && msg.contentAttachments.length > 0) return true;
  if (msg.historyMedia && msg.historyMedia.length > 0) return true;
  return false;
}

export function hasVisibleMessageContent(
  msg: NormalizedAssistantLike | null | undefined,
): msg is NormalizedAssistantLike {
  if (!msg) return false;
  if (msg.text) return true;
  if (msg.thinking) return true;
  return hasMediaContent(msg);
}

/**
 * 要不要拿「本地流式正文」里解析出的媒体，去补 final 帧的解析结果。
 *
 * 场景：final 帧的文本是服务端投影 / 净化过的（`normalizeLiveAssistantBufferedText`），
 * 偶尔会丢掉正文里的 `MEDIA:` 行，而本地累积的 `streamedText` 里还留着。此时
 * `normalizeMessage(payload.message)` 解析不出任何媒体位 ⇒ 首次返回没有下载卡片，
 * 只有刷新（走 `chat.history`，那份正文带 `MEDIA:` 行）才出现 —— 与历史消息不一致。
 *
 * 只在「final 解析结果一个媒体都没有、但流式正文里有」时才补，绝不覆盖服务端数据。
 */
export function shouldAdoptStreamedMedia(
  normalized: NormalizedAssistantLike | null | undefined,
  streamedMediaCount: number,
): boolean {
  if (streamedMediaCount <= 0) return false;
  return !hasMediaContent(normalized);
}

/**
 * 落库时这条消息的正文取哪个值。
 *
 * 取值优先级：`normalized.text` → `streamedText`（本地 accumulated 的流式正文）。
 *
 * ⚠️ 第二条**只在 normalized 没有任何媒体时才生效**：正文全是 `MEDIA:` 行的那一类回复，
 * `normalized.text` 为空是**预期结果**（行被剥走了换成附件位），此时回落到
 * `streamedText` 会把 `MEDIA:/…mp3` 这行脏文本又塞回正文 —— 卡片旁边多一行路径，
 * 正是修 bug 之前的样子。
 */
export function resolveCommittedText(
  normalized: NormalizedAssistantLike | null | undefined,
  streamedText: string,
): string {
  if (normalized?.text) return normalized.text;
  if (!streamedText) return "";
  return hasMediaContent(normalized) ? "" : streamedText;
}

/**
 * 该不该把这条消息渲染给用户。
 *
 * 对齐参考页（历史 `ui/`）：`system` 角色作为通用气泡渲染（系统提示词回写、
 * 上下文压缩/摘要提示等属于会话内部记录，但参考页选择展示）。故此处不再隐藏 system。
 *
 * ⚠️ 这里只做**渲染层过滤**，不动数据：`ChatPane` 的 `messages` 数组保持原样
 * （里面还有 index 派生的稳定 key、批量删消息的命中、上下文占用统计在用），
 * 只是模板遍历的 `computed` 少了这几条。
 *
 * 顺带说明：`ChatPane.vue` 现在对 `role:"toolResult"` 单独渲染成可折叠的
 * 「Activity」卡片（连续多条合并为一个折叠块，默认收起），对 `role:"tool"` 渲染为
 * 结构化工具卡。两者都应可见。`HIDDEN_MESSAGE_ROLES` 现为空集；若需隐藏某类角色，
 * 往里加对应 role 字符串即可。
 */
export const HIDDEN_MESSAGE_ROLES: ReadonlySet<string> = new Set<string>([]);

export function isRenderableMessageRole(role: string | undefined): boolean {
  return !role || !HIDDEN_MESSAGE_ROLES.has(role);
}
