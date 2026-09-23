/**
 * 会话口径：**每个 agent 只维护一条「规范主会话」**，且入口会话由**链接携带的
 * `session` 参数动态决定**；链接没带时就落到 **chat 页的首个会话**。
 *
 * ## 要消除的现象（改动的真正目标）
 * 1. 旧口径下 `stores/settings.ts` 用**入口 token 指纹**派生会话 key（`id-<hash8>`）：
 *    同一个 agent 名下于是同时存在 `agent:cet4:main` 与 `agent:cet4:id-4daf4b7d`
 *    （本机 `~/.openclaw/agents/cet4/sessions/sessions.json` 实测就有这两条）。
 *    每换一次入口 token 就多一条，历史越攒越多。
 * 2. 入口 agent **写死**（曾是 `DEFAULT_AGENT_SESSION_KEY = "agent:resume-assistant:main"`，
 *    后改为 `FALLBACK_AGENT_ID = "resume-assistant"`）会造成两个后果：
 *    - 上游控制台发来的 `?session=study-abroad-consultant` 被静默丢弃 —— 点 A 顾问的链接
 *      却进了 B 顾问的会话，地址栏还跟着被改写成 B；
 *    - 那个被写死的 agent 一旦在网关侧改名 / 下线，整站入口直接失效。
 *
 * ## 现在的规则
 * 1. 会话 key **只允许**规范主会话形态 `agent:<agentId>:<mainKey>`；
 *    任何来源（URL 入参、localStorage 旧值、token 派生）的 key 都经
 *    `canonicalMainSessionKey()` 归一 —— 不是「优先取主会话」，而是**其它形态直接改写**。
 * 2. `?session=` 支持**两种写法**（见 `resolveSessionParam`）：
 *    - 完整形态 `agent:<agentId>:<rest>`（`rest` 一律收敛成 `mainKey`）；
 *    - **裸 agentId** `study-abroad-consultant` ⇒ `agent:study-abroad-consultant:<mainKey>`。
 *      ← 上游控制台签发的链接就是这个形态。
 *    其余（空 / 裸 `main` / `id-<hash>` / 渠道键 / `cron:…`）都**不携带 agent 信息**，
 *    落回兜底链（见第 3 条）。
 * 3. **兜底链里没有任何写死的 agent** —— 每一级都由调用方在**运行时**提供：
 *    ① 链接的 `?session=`（唯一「显式」来源）
 *    → ② **chat 页的首个会话**（侧栏 `agents.list` 第一条 ⇒ `options.firstAgentId`）
 *    → ③ 网关 `agents.defaultId`（表还没回来时的过渡值）
 *    → ④ 空串 = 「还没定下来」（`agents.list` 回来后由 `ChatView` 再收敛一次）。
 *    ② 排在 ③ 前面就是产品口径：**没带 session 就进第一个会话**，
 *    而不是「进某个固定顾问的会话」。
 * 4. **侧栏点击仍可切换 agent**（切换到该 agent 的规范主会话）——
 *    切的是「哪条主会话」，而不是「新建一条会话」。
 *
 * ⚠️ 本文件**不写死任何 agentId**，也不认识任何业务 agent：所有候选值都是参数。
 * 别在这里 import `stores/agents`（会形成
 * `agents → settings → urlOverrides → canonicalSession` 的环），
 * 需要网关数据时一律**当参数传进来**。
 * 也别在别处硬编码 agentId，更别在别处 `sessions.create`（`/new` 已禁用）。
 */
import {
  buildAgentMainSessionKey,
  isAgentIdShaped,
  isDerivedEntrySessionKey,
  isReservedAgentIdSegment,
  normalizeAgentId,
  normalizeOptionalString,
  parseAgentSessionKey,
} from "@/utils/sessionKey";
import { isKnownChannelSegment } from "@/utils/sessionDisplay";

/** 会话解析 / 归一的统一选项。**全部是运行时值**，本模块不提供任何默认 agent。 */
export type SessionResolveOptions = {
  /** 网关 `agents.mainKey`（缺省 `main`）；决定规范主会话的尾段。 */
  mainKey?: string | null;
  /**
   * **chat 页首个会话**对应的 agentId —— 即侧栏 `agents.list` 的第一条。
   *
   * 这是「链接没带 `session`」时的**首选**兜底：用户进 chat 页看到的第一行是谁，
   * 就落到谁的会话上。由调用方从运行时列表传入（`agents.agents[0]?.id`）。
   */
  firstAgentId?: string | null;
  /**
   * 网关 `agents.defaultId`：`firstAgentId` 还拿不到时的**过渡值**
   * （冷启动窗口内 `agents.list` 尚未回来）。网关一旦回表，`firstAgentId` 接管。
   */
  defaultAgentId?: string | null;
};

/**
 * 从一个**裸值**（不含 `agent:` 前缀）里读 agentId；读不出来返回 `null`。
 *
 * 只有「纯 agentId 形态」才作数，下面几类一律拒绝（它们都会凭空造出不存在的 agent）：
 * - 含 `:`（`wechat:direct:xxx` / `cron:job` / `subagent:x`）—— 复合裸 key，不是 agentId；
 * - 形态不合法（含空格 / 点号 / 太长…）；
 * - 保留段（`main` / `cron` / `subagent` / `global`）；
 * - 旧入口指纹 `id-<hash>`；
 * - **已知渠道键**（`wechat` / `telegram`…）—— 与窗格头「渠道行不改名」共用同一份清单，
 *   避免 `?session=wechat` 变成 `agent:wechat:main`。
 */
function bareAgentIdOf(raw: string): string | null {
  if (raw.includes(":")) return null;
  if (!isAgentIdShaped(raw)) return null;
  if (isReservedAgentIdSegment(raw)) return null;
  if (isDerivedEntrySessionKey(raw)) return null;
  if (isKnownChannelSegment(raw)) return null;
  return normalizeAgentId(raw);
}

/**
 * 解析会话参数（URL `?session=` / 侧栏点击值 / 旧存储值都走这里）。
 *
 * 返回**规范主会话 key**；候选值里读不出 agent 归属时返回 `null`
 * （由调用方决定怎么兜底，见 `canonicalMainSessionKey`）。
 */
export function resolveSessionParam(
  candidate: unknown,
  options?: SessionResolveOptions,
): string | null {
  const raw = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
  if (!raw) return null;

  const parsed = parseAgentSessionKey(raw);
  if (parsed) return buildAgentMainSessionKey({ agentId: parsed.agentId, mainKey: options?.mainKey });

  const agentId = bareAgentIdOf(raw);
  if (!agentId) return null;
  return buildAgentMainSessionKey({ agentId, mainKey: options?.mainKey });
}

/**
 * 依次取第一个**非空** agentId 构成的规范主会话；都没有返回 `null`。
 *
 * ⚠️ 必须先判非空再 `buildAgentMainSessionKey`：`normalizeAgentId("")` 会回落成
 * `main`，直接调用会把「没有候选」静默变成 `agent:main:main`。
 */
function firstAgentMainSessionKey(
  agentIds: ReadonlyArray<string | null | undefined>,
  mainKey?: string | null,
): string | null {
  for (const agentId of agentIds) {
    if (!normalizeOptionalString(agentId)) continue;
    return buildAgentMainSessionKey({ agentId: agentId as string, mainKey });
  }
  return null;
}

/** 兼容两种第 2 参写法：老的 `mainKey` 字符串，或完整的 `SessionResolveOptions`。 */
function resolveOptions(
  mainKeyOrOptions?: string | SessionResolveOptions | null,
  legacyFallbackAgentId?: string | null,
): SessionResolveOptions {
  if (mainKeyOrOptions && typeof mainKeyOrOptions === "object") return mainKeyOrOptions;
  // 旧签名是 `(candidate, mainKey, fallbackAgentId)`；那个 fallback 的语义等同「首个候选」。
  return { mainKey: mainKeyOrOptions ?? null, firstAgentId: legacyFallbackAgentId ?? null };
}

/**
 * 把任意会话 key 归一成「该 agent 的规范主会话」——**全局唯一入口**。
 *
 * - `agent:<id>:<别的 rest>`（含 `id-<hash8>` / `cron:...` / 子会话）→ `agent:<id>:<mainKey>`；
 * - **裸 agentId**（`study-abroad-consultant`）→ `agent:study-abroad-consultant:<mainKey>`；
 * - 读不出 agent 归属 → 依次用 `options.firstAgentId`（chat 页首个会话）、
 *   `options.defaultAgentId`（网关默认 agent）；**两者都没有时返回空串**。
 *
 * ⚠️ **返回空串是刻意的**，不是错误：本函数不写死任何 agent，冷启动窗口内确实无从判断。
 * 调用方必须按「还没定下来」处理：
 * - `ChatPane` 本来就能容忍（`props.sessionKey.trim() || settings.sessionKey || "main"`）；
 * - `ChatView` 会在 `agents.list` 回来后重新收敛一次（见其 `watch`）。
 * 写进 store / 地址栏之前**必须先判空** —— 别把空串 persist 进去。
 */
export function canonicalMainSessionKey(
  candidate?: string | null,
  mainKeyOrOptions?: string | SessionResolveOptions | null,
  legacyFallbackAgentId?: string | null,
): string {
  const options = resolveOptions(mainKeyOrOptions, legacyFallbackAgentId);

  const explicit = resolveSessionParam(candidate, options);
  if (explicit) return explicit;

  return (
    firstAgentMainSessionKey([options.firstAgentId, options.defaultAgentId], options.mainKey) ?? ""
  );
}

/** 这个 key 是不是「规范主会话」形态（`agent:<id>:<mainKey>`）。 */
export function isCanonicalMainSessionKey(
  candidate?: string | null,
  mainKey?: string | null,
): boolean {
  const raw = typeof candidate === "string" ? candidate.trim() : "";
  if (!raw) return false;
  const parsed = parseAgentSessionKey(raw);
  if (!parsed) return false;
  const expected = buildAgentMainSessionKey({ agentId: parsed.agentId, mainKey });
  return expected === raw.toLowerCase();
}

/**
 * 地址栏的 `session` 参数是否已处于**最终形态**。
 *
 * 判据是「**原文**是否等于它解析出来的规范 key」，而不是「是不是规范形态」——这样：
 * - `?session=study-abroad-consultant` ⇒ 解析成 `agent:study-abroad-consultant:main`
 *   ≠ 原文 ⇒ 需要规范化（**agent 被保留**，只把写法规范掉）；
 * - `?session=agent:study-abroad-consultant:main` ⇒ 相等 ⇒ 不必动；
 * - 缺失 / 空 / 裸 `main` / `id-<hash>` ⇒ 解析不出 agent ⇒ 需要规范化。
 *
 * ⚠️ `ChatView` 的入口收敛并不调用本函数 —— 它手里已经有解析后的最终 key，
 * 直接 `route.query.session === key` 比再解析一遍更省；本函数是这条判据的
 * **可测试出口**（纯函数，不依赖 Vue / router / 网关）。
 */
export function isSessionQueryFinal(current: unknown, options?: SessionResolveOptions): boolean {
  const raw = typeof current === "string" ? current.trim() : "";
  if (!raw) return false;
  const resolved = resolveSessionParam(raw, options);
  return resolved === raw.toLowerCase();
}
