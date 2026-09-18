/**
 * 「进行中的那一轮对话」的运行态 —— **存在组件外面，按会话 key 分桶**。
 *
 * ## 为什么需要它（真 bug：点「打开拆分视图」会打断进行中的任务）
 *
 * 单窗格 → 拆分时，布局层的 `v-if="!layout"` / `v-else` 会**销毁**那个 `ChatPane`
 * 并新建两个（连 `paneId` 都换了）。而 `sending` / `streamingText` /
 * `streamingThinking` / `streamingSpend` / `steerCount` 原本都是 ChatPane 的
 * **局部 ref**，于是跟着一起没了 —— 用户看到「思考中」气泡整块消失、输入框从
 * 「正在生成」退回「Enter 发送」，像是任务被打断（**后端其实还在跑**，只是没人接了）。
 *
 * 实测（CDP 注入 `sending=true` 后点拆分）：
 *   拆分前 `liveThinking=1 / composerStatus=1`
 *   拆分后 `liveThinking=0 / composerStatus=0 / composerHint=2`
 *
 * 把状态按**会话**搬到组件外之后：窗格怎么重建、拆成几个、关掉再开，只要是同一个
 * 会话，拿到的就是同一个桶 —— 运行态自然接得上。同一会话的两个窗格共享一个桶也
 * 符合直觉（同一个 run，两边看到的应当一样）。
 *
 * ## 与 `utils/chatAttachments.ts` 的区别
 * 同款思路（模块级挂载，组件重建不丢），但这里**按 sessionKey 分桶**，并显式提供
 * 释放接口，避免长期累积空桶。
 */
import { reactive } from "vue";
import { qualifySessionKey } from "@/utils/sessionListSelection";

/** 结构对齐 `ChatPane` 里的 `JdSpendResult`（故意不引过来，避免 view → utils 反向依赖）。 */
export type ChatRunSpend = {
  spend: number;
  balance: number;
};

export type ChatRunState = {
  /** 是否有 run 在进行（`sending`）。 */
  sending: boolean;
  /** 已累积的流式正文。 */
  streamingText: string;
  /** 已累积的思考过程。 */
  streamingThinking: string;
  /** 本轮积分（拿到之前为 `null`）。 */
  streamingSpend: ChatRunSpend | null;
  /** 本轮被引导次数。 */
  steerCount: number;
};

const buckets = new Map<string, ChatRunState>();

function createBucket(): ChatRunState {
  return reactive<ChatRunState>({
    sending: false,
    streamingText: "",
    streamingThinking: "",
    streamingSpend: null,
    steerCount: 0,
  });
}

/**
 * 桶的键：**规范形态**的会话 key。
 *
 * 必须与事件隔离的判定同源（`ChatPane.isEventForCurrentSession` 走
 * `sessionKeysMatch` → `qualifySessionKey`），否则「裸 key 派生的窗格」和
 * 「带 `agent:` 前缀的窗格」会拿到两个不同的桶，运行态就又接不上了。
 */
function bucketKeyOf(
  sessionKey: string | null | undefined,
  defaultAgentId?: string | null,
): string {
  const qualified = qualifySessionKey(sessionKey, defaultAgentId);
  if (qualified) return qualified;
  const raw = typeof sessionKey === "string" ? sessionKey.trim() : "";
  return raw || "main";
}

/**
 * 取（必要时创建）某个会话的运行态桶。
 *
 * 返回的桶是 `reactive` 的：直接读写它的字段即可，同一会话的多个窗格共享同一份。
 */
export function chatRunStateFor(
  sessionKey: string | null | undefined,
  defaultAgentId?: string | null,
): ChatRunState {
  const key = bucketKeyOf(sessionKey, defaultAgentId);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = createBucket();
    buckets.set(key, bucket);
  }
  return bucket;
}

/**
 * 清空某个桶（一轮结束后释放长文本）。
 *
 * ⚠️ **只清字段，不从 Map 里删桶** —— 拆分视图下多个窗格拿的是同一个对象，
 * 把桶删掉会让「还活着的窗格继续写旧对象、新窗格另起一个」，两边立刻分歧
 * （一个还在流式、一个显示已结束）。空桶自身只有 5 个字段，留着没有代价。
 */
export function resetChatRunState(state: ChatRunState): void {
  state.sending = false;
  state.streamingText = "";
  state.streamingThinking = "";
  state.streamingSpend = null;
  state.steerCount = 0;
}

/** 当前活着的桶数量（单测 / 排查用）。 */
export function chatRunStateSize(): number {
  return buckets.size;
}

/**
 * 把**已存在**的某个会话的运行态桶归零（桶不存在时什么都不做，**不新建**）。
 *
 * 用途：切到别的会话后，前一个会话的终止帧会被按会话过滤掉，没人再调
 * `finalizeStreaming()` ⇒ 它的 `sending` 永远停在 true（输入框卡「正在生成」、
 * 回车只会进待执行队列，整个会话像被中断，只有刷新页面能救）。
 * 所以在别的会话里收到那个会话的 `final` / `error` 时，顺手把它的桶收干净。
 *
 * ⚠️ 传进来的 `sessionKey` + `defaultAgentId` 必须与创建桶时的那一对同源
 * （`ChatPane` 用的是 `sessionKey.value` + `paneAgentId.value`），否则键不同、收不到桶。
 */
export function resetChatRunStateForSession(
  sessionKey: string | null | undefined,
  defaultAgentId?: string | null,
): void {
  const bucket = buckets.get(bucketKeyOf(sessionKey, defaultAgentId));
  if (bucket) resetChatRunState(bucket);
}
