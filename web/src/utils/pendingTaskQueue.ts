/**
 * 待执行（引导）任务队列的**持久化层** —— 让「生成中回车加入的待执行任务」
 * 熬过一次整页刷新。
 *
 * ## 为什么按会话分桶存在 localStorage
 * 队列是「本会话还没提交给网关的消息」，天然属于某一条会话：切走要收起、
 * 切回要复原。放内存则刷新即丢（用户辛苦敲的任务在 F5 后凭空消失），
 * 放服务端则要给网关加一个前端交互态的表 —— 都不合适，localStorage 分桶最贴合。
 *
 * ## 桶 key 是这套机制唯一的死穴（真事故）
 * 桶 key 用**规范会话 key**（`agent:<agentId>:<rest>`，与消息缓存同源）。
 * 而会话 key 是**裸 key** 时（入口 token 派生的 `id-<hash8>`，或 `main`），
 * 规范前缀里的 agentId 只能由 agents store 的 `defaultId` 推出 ——
 * 这个值在**冷启动窗口内会变**：
 *
 *   t0  挂载：`agents.list` 还没回来、本地又没侧栏快照 ⇒ `defaultId = ""`
 *            ⇒ 桶 key = `agent:main:<rest>`
 *   t1  `agents.list` 回来：`defaultId = "cel4"` ⇒ 桶 key 变成 `agent:cel4:<rest>`
 *
 * 入队时（上一个页面周期，store 早已就绪）写的是 t1 那个桶，刷新后挂载读的是
 * t0 那个桶 ⇒ **读不到**，而且 key 变到 t1 之后**没有任何东西会重读一次**。
 * 症状就是「刷新后待执行任务列表不再展示」。
 *
 * 所以本模块把 key 的两种形态都显式摊开（`pendingTaskBucketKey` 兜底不为空串），
 * 并由调用方在 key **细化**（同一会话、只是 agent 前缀补齐）时把桶搬过去
 * —— 判定逻辑在 `planPendingTaskBucketChange`，纯函数、有单测。
 */

import type { ChatAttachment } from "@/utils/chatAttachments";
import { normalizeOptionalString } from "@/utils/sessionKey";
import { qualifySessionKey } from "@/utils/sessionListSelection";

/** 队列项。 */
export type PendingTask = {
  id: string;
  text: string;
  /** 随引导一起下发的附件（流式中入队时拷贝，通常为空 —— 流式阶段附件入口被禁用）。 */
  attachments?: ChatAttachment[];
  /** 上次提交失败标记，用于展示重试入口。 */
  failed?: boolean;
  /** 失败原因（**已本地化**的中文标题，直接上屏，见 ChatPane 的 markPendingTaskFailed）。 */
  error?: string;
};

/** localStorage 键（分桶：`{ [bucketKey]: PendingTask[] }`）。 */
export const PENDING_TASKS_STORAGE_KEY = "openclaw.web.pendingTasks.v1";

/** 桶 key 全部拿不到时的兜底桶（正常流程不会走到，只为「绝不写空串键」）。 */
export const FALLBACK_PENDING_TASKS_BUCKET = "__default__";

type BucketMap = Record<string, PendingTask[]>;

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // 隐私策略 / 无 window（单测外的非浏览器环境）下统一降级为「没有存储」
    return null;
  }
}

/**
 * 队列持久化的分桶 key —— 与消息缓存同源（规范会话 key），保证拆分视图下
 * 多个窗格指向同一条会话时共享同一份队列。
 *
 * ⚠️ 这里**必须**自己做空值兜底，不能写 `qualifySessionKey(...) ?? xxx`：
 * `qualifySessionKey` 在入参为空串时返回的是**空串**（不是 null/undefined），
 * `??` 不认空串 ⇒ 会得到一个空串桶 key，把所有「会话还没就绪」的窗格混进同一个桶。
 * 本仓库已经因为这一条踩过一次 `sessionKey: ""` 的坑（见 stores/settings.ts 注释）。
 */
export function pendingTaskBucketKey(
  sessionKey: string | null | undefined,
  agentId?: string | null,
): string {
  const qualified = qualifySessionKey(sessionKey, agentId);
  if (qualified) return qualified;
  const raw = normalizeOptionalString(sessionKey)?.toLowerCase() ?? "";
  if (raw) return `raw:${raw}`;
  return FALLBACK_PENDING_TASKS_BUCKET;
}

/** 形状校验：只要 `text` 是字符串就算有效项（其余字段逐个归一）。 */
export function normalizePendingTasks(value: unknown): PendingTask[] {
  if (!Array.isArray(value)) return [];
  const out: PendingTask[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<PendingTask>;
    const text = typeof record.text === "string" ? record.text : "";
    if (!text.trim()) continue;
    const id =
      typeof record.id === "string" && record.id.trim()
        ? record.id
        : `pending-restored-${out.length}`;
    out.push({
      id,
      text,
      ...(Array.isArray(record.attachments) && record.attachments.length > 0
        ? { attachments: record.attachments }
        : {}),
      ...(record.failed === true ? { failed: true } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
    });
  }
  return out;
}

/** 读全部桶（解析失败 / 存储不可用 ⇒ 空对象）。 */
export function readPendingTasksMap(): BucketMap {
  const storage = getLocalStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(PENDING_TASKS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: BucketMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const list = normalizePendingTasks(value);
      if (list.length > 0) out[key] = list;
    }
    return out;
  } catch {
    return {};
  }
}

function writePendingTasksMap(map: BucketMap): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(PENDING_TASKS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 配额满 / 隐私模式：静默降级，队列退化成「内存内有效」，不阻塞交互
  }
}

/**
 * 读某个桶的队列。
 *
 * ⚠️ **桶缺失一律返回空数组**（而不是 undefined / 保留调用方的旧值）：
 * 调用方拿到结果就直接 `pendingTasks.value = 读到的值`，这样「切到一条没有队列的
 * 会话」会正确清空视图；若这里偷懒返回 undefined 让调用方自己判断，切换会话时
 * 上一个会话的任务会留在界面上（串味），而它们其实属于别的会话。
 */
export function readPendingTasks(bucketKey: string): PendingTask[] {
  if (!bucketKey) return [];
  const map = readPendingTasksMap();
  return normalizePendingTasks(map[bucketKey]);
}

/** 写某个桶；空列表 = 删桶（不留空壳，避免读回时反复命中空数组）。 */
export function writePendingTasks(bucketKey: string, tasks: readonly PendingTask[]): void {
  if (!bucketKey) return;
  const map = readPendingTasksMap();
  const list = normalizePendingTasks(tasks);
  if (list.length > 0) map[bucketKey] = list;
  else delete map[bucketKey];
  writePendingTasksMap(map);
}

/** 删某个桶（迁移完成后清理旧桶，避免同一份队列残留在两个桶里）。 */
export function deletePendingTasksBucket(bucketKey: string): void {
  if (!bucketKey) return;
  const map = readPendingTasksMap();
  if (!(bucketKey in map)) return;
  delete map[bucketKey];
  writePendingTasksMap(map);
}

/** 把队列从一个桶搬到另一个桶（写入目标 + 删除来源，一步到位）。 */
export function movePendingTasksBucket(fromKey: string, toKey: string): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const map = readPendingTasksMap();
  const list = map[fromKey] ?? [];
  if (list.length === 0) return;
  map[toKey] = list;
  delete map[fromKey];
  writePendingTasksMap(map);
}

/**
 * 桶 key 变化时该做什么 —— 纯函数，便于单测。
 *
 * - `"hydrate"`：直接读新桶（**桶缺失即清空视图**）。适用于首次挂载、
 *   真的换了会话、以及「新桶已经有内容（以磁盘为准）」。
 * - `"migrate"`：**同一个会话**、只是 agent 前缀被补齐（冷启动窗口结束，
 *   见文件头的时间线）⇒ 把内存里的队列写进新桶再读回，否则用户会看到
 *   「任务本来在界面上，刷新一下反而没了」。
 *
 * 判定「同一个会话」由调用方给（它才拿得到原始 prop），这里只负责决策表。
 */
export function planPendingTaskBucketChange(params: {
  previousKey: string;
  nextKey: string;
  /** 两次变化之间，窗格渲染的**会话本身**有没有换（代理层给的原始 prop 是否相同）。 */
  sameSession: boolean;
  /** 当前内存里的队列长度。 */
  currentCount: number;
  /** 目标桶里已持久化的队列长度。 */
  nextBucketCount: number;
}): "migrate" | "hydrate" {
  const { previousKey, nextKey, sameSession, currentCount, nextBucketCount } = params;
  if (!nextKey) return "hydrate";
  if (!previousKey || previousKey === nextKey) return "hydrate";
  if (!sameSession) return "hydrate";
  if (currentCount === 0) return "hydrate";
  // 目标桶已有数据：磁盘是权威（正常写入路径已经同步过），别用内存覆盖
  if (nextBucketCount > 0) return "hydrate";
  return "migrate";
}

/** 队列项 id 的自增种子（`Date.now()` 同毫秒内连点两次也能拿到不同 id）。 */
let pendingTaskSeed = 0;

/** 造一个新队列项（id 稳定且同页唯一）。 */
export function createPendingTask(
  text: string,
  attachments?: readonly ChatAttachment[],
): PendingTask {
  pendingTaskSeed += 1;
  return {
    id: `pending-${Date.now()}-${pendingTaskSeed}`,
    text,
    ...(attachments && attachments.length > 0
      ? { attachments: attachments.map((item) => ({ ...item })) }
      : {}),
  };
}
