/**
 * 侧栏「最近会话」的选取逻辑（纯函数，便于单元测试）。
 *
 * 背景：同一 agent 下会并存多条会话 —— 规范主会话 `agent:<id>:main` 之外，
 * 入口 token 不同还会派生出 `agent:<id>:id-<hash8>`（见 `stores/settings.ts`
 * 的 `deriveSessionKeyFromToken`），历史累积后一个 agent 铺开好几行。
 *
 * 展示目标（用户确认的口径）：
 *   1) **不同 agent 并存** —— 每个 agent 至少（也至多）占一行；
 *   2) **每个 agent 只保留一条「代表会话」**，且优先是它的 main 会话。
 *
 * 本模块把「选谁」和「排什么」都抽出来，`ChatSidebar.vue` 只负责渲染。
 */

import type { GatewaySessionRow } from "@/api/types";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  isCronSessionKey,
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeOptionalString,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "@/utils/sessionKey";

/** 只依赖 `id`，避免和 stores 里的 AgentSummary 类型耦合。 */
export type SidebarAgentLike = { id?: string | null };

/**
 * 把会话 key 补全成规范形态 `agent:<agentId>:<rest>`。
 *
 * 必要性：入口 token 派生的会话 key 是**裸的** `id-<hash8>`（见
 * `stores/settings.ts` 的 `deriveSessionKeyFromToken`），而网关 `sessions.list`
 * 返回的是**带 agent 前缀的规范 key**（`agent:main:id-<hash8>`）。
 * 两者字符串不相等 —— 直接比会「认不出这是同一个会话」，导致
 * ① 用户正在聊的会话被判成「不在列表里」；② 侧栏高亮失效。
 *
 * 裸 `main` 会补成 `agent:main:main`，与 `areUiSessionKeysEquivalent` 语义一致。
 */
export function qualifySessionKey(
  sessionKey: string | null | undefined,
  defaultAgentId?: string | null,
): string {
  const raw = normalizeOptionalString(sessionKey)?.toLowerCase() ?? "";
  if (!raw) return "";
  const parsed = parseAgentSessionKey(raw);
  if (parsed) return `agent:${normalizeAgentId(parsed.agentId)}:${parsed.rest}`;
  return buildAgentMainSessionKey({
    agentId: normalizeAgentId(defaultAgentId ?? DEFAULT_AGENT_ID),
    mainKey: raw,
  });
}

/**
 * 两个会话 key 是否指同一条会话 —— 先补全成规范形态再比。
 * 比 `areUiSessionKeysEquivalent` 更进一步：它只认裸 `main`，本例还要认
 * 入口 token 派生的裸 `id-<hash8>`。
 */
export function sessionKeysMatch(
  left: string | null | undefined,
  right: string | null | undefined,
  defaultAgentId?: string | null,
): boolean {
  const a = qualifySessionKey(left, defaultAgentId);
  const b = qualifySessionKey(right, defaultAgentId);
  return Boolean(a && b && a === b);
}

/**
 * 命中「代表会话」的保留规则，顺序即优先级。
 * 显式返回规则名，方便日志排查与测试断言。
 */
export type RepresentativeRule =
  /** ① 用户当前所在会话（且网关里真实存在）—— 保证正在聊的那条永远可见。 */
  | "current"
  /** ② 规范主会话 `agent:<id>:<mainKey>`。 */
  | "canonical-main"
  /** ③ 其余里最近更新的一条。 */
  | "most-recent"
  /** ④ 当前会话，但网关尚未落库（入口 token 刚派生出来的新会话）。 */
  | "current-fallback"
  /** ⑤ 兜底：规范主会话 key（点了开一条新的）。 */
  | "canonical-main-fallback"
  /** 不产出任何行（调用方要求首屏不要合成行时使用，见 `allowSyntheticRows`）。 */
  | "none";

export type RepresentativeSession = {
  key: string;
  rule: RepresentativeRule;
  /** key 是否真实存在于网关返回的列表里（false 表示是合成行）。 */
  exists: boolean;
};

/**
 * 可展示的会话：去掉归档 / cron / subagent / global / unknown / 被派生的行，
 * 再按 agent 归属过滤。
 */
export function eligibleSessionsForAgent(
  sessions: readonly GatewaySessionRow[],
  agentId: string,
  defaultAgentId?: string | null,
): GatewaySessionRow[] {
  const id = normalizeAgentId(agentId);
  const fallbackAgentId = normalizeAgentId(defaultAgentId ?? DEFAULT_AGENT_ID);
  return sessions.filter(
    (row) =>
      !row.archived &&
      row.kind !== "global" &&
      row.kind !== "unknown" &&
      !isCronSessionKey(row.key) &&
      !isSubagentSessionKey(row.key) &&
      !row.spawnedBy &&
      isSessionKeyTiedToAgent(row.key, id, fallbackAgentId),
  );
}

/**
 * 为单个 agent 选一条代表会话。保留优先级见 `RepresentativeRule`。
 *
 * 注意 ①④ 的区别：只有当「当前会话」确实存在于网关列表里、或该 agent
 * 底下**一条别的会话都没有**时，才让当前会话占位。否则一个刚派生出来的
 * 空 `id-<hash8>` 会把该 agent 真正的 main 会话永久挡在列表外
 * （本地实测：10 条 `agent:main:*` 只剩一行裸 `id-225a9df9`）。
 *
 * ## `allowSyntheticRows`：禁止「网关里并不存在的行」占位
 *
 * 规则 ④⑤ 产出的 key **不在** `sessions` 里，是前端合成的。首屏（`sessions.list`
 * 还没回来）时 `sessions` 为空，④⑤ 恰好都会命中，于是侧栏只剩**一行**
 * ——用户看到的「初始化时只有当前选中的那一条」。所以「首次加载未落定」的调用方
 * 必须传 `false`，此时本函数返回 `{ key: "", rule: "none" }`（调用方 `if (!picked.key) continue`），
 * 让列表留空去渲染骨架屏，而不是把残缺结果画出来。
 *
 * ⚠️ 曾经只在外层「当前会话兜底」分支上做了这个拦截，漏了这里的 ④⑤ ——
 * 症状一模一样（首屏一行裸哈希），排查成本极高。**合成行只有这一处出口。**
 */
export function pickRepresentativeSession(params: {
  agentId: string;
  sessions: readonly GatewaySessionRow[];
  currentSessionKey?: string | null;
  mainKey?: string | null;
  defaultAgentId?: string | null;
  /** 是否允许合成「网关里并不存在」的行（规则 ④⑤），默认 `true`。 */
  allowSyntheticRows?: boolean;
}): RepresentativeSession {
  const id = normalizeAgentId(params.agentId);
  const fallbackAgentId = normalizeAgentId(params.defaultAgentId ?? DEFAULT_AGENT_ID);
  const canonicalMainKey = buildAgentMainSessionKey({ agentId: id, mainKey: params.mainKey });

  const eligible = eligibleSessionsForAgent(params.sessions, id, fallbackAgentId);
  const findExisting = (key: string): GatewaySessionRow | undefined =>
    eligible.find((row) => sessionKeysMatch(row.key, key, fallbackAgentId));

  const current = normalizeOptionalString(params.currentSessionKey);
  const currentBelongsToAgent =
    Boolean(current) && isSessionKeyTiedToAgent(current, id, fallbackAgentId);

  // ① 当前会话（且真实存在）
  if (current && currentBelongsToAgent) {
    const currentRow = findExisting(current);
    if (currentRow) return { key: currentRow.key, rule: "current", exists: true };
  }

  // ② 规范主会话
  const mainRow = findExisting(canonicalMainKey);
  if (mainRow) return { key: mainRow.key, rule: "canonical-main", exists: true };

  // ③ 最近更新的一条
  const mostRecent = [...eligible].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  if (mostRecent) return { key: mostRecent.key, rule: "most-recent", exists: true };

  // 到这里以后都是**合成行**（key 不在网关列表里）：首屏落定前一律不产出。
  if (params.allowSyntheticRows === false) return { key: "", rule: "none", exists: false };

  // ④ 当前会话（网关尚未落库）
  if (current && currentBelongsToAgent) {
    return { key: current, rule: "current-fallback", exists: false };
  }

  // ⑤ 规范主会话 key
  return { key: canonicalMainKey, rule: "canonical-main-fallback", exists: false };
}

/**
 * 组装侧栏「最近会话」列表。
 *
 * - 每个 agent 一条代表会话（不同 agent 并存）；agent 列表里重复的 id 会去重
 *   （防御后端返回重复 agent）。
 * - 当前会话仅在其**归属 agent 完全未被覆盖**时补一行，避免同一 agent 出现两行。
 * - 排序：置顶优先，其次 `updatedAt` 倒序。
 *
 * ## `allowSyntheticRows`：首屏别把「合成行」当成完整菜单
 *
 * 「合成行」= key 并不在 `sessions`（网关返回值）里的行，共三处出口：
 * ① `pickRepresentativeSession` 的规则 ④「当前会话尚未落库」、
 * ② 同函数的规则 ⑤「规范主会话 key」、
 * ③ 本函数末尾的「当前会话兜底」。
 *
 * 它们的本意是「agents/sessions 拿不到时至少让当前会话可见」，但**首屏恰好就是这个状态**
 * （RPC 还没回来 ⇒ `sessions` 为空 ⇒ ①②③ 全都命中），于是侧栏只产出**一行**，
 * 用户看到的是「左侧菜单只有当前选中的那一条」，RPC 回来后突然铺开 —— 观感极差。
 *
 * 所以「首次加载尚未落定」的调用方传 `false`：三处合成行全部关闭，宁可返回空数组
 * 去渲染骨架屏，也不要把残缺结果画出来。
 *
 * ⚠️ 血泪教训：最初只拦了 ③，漏了 ①② —— 症状一模一样（首屏一行裸 `id-<hash8>` + 头像图标），
 * 但改动看起来「已经修了」。**凡是新增合成行出口，都要接同一个开关。**
 */
export function buildSidebarSessionRows(params: {
  agents: readonly SidebarAgentLike[];
  sessions: readonly GatewaySessionRow[];
  currentSessionKey?: string | null;
  mainKey?: string | null;
  defaultAgentId?: string | null;
  limit?: number;
  /** 是否允许合成「网关里并不存在」的行，默认 `true`（保持非首屏场景的原有行为）。 */
  allowSyntheticRows?: boolean;
}): GatewaySessionRow[] {
  const { sessions } = params;
  const rows: GatewaySessionRow[] = [];
  const seenKeys = new Set<string>();
  const seenAgents = new Set<string>();

  const push = (row: GatewaySessionRow): void => {
    const norm = qualifySessionKey(row.key, params.defaultAgentId);
    if (!norm || seenKeys.has(norm)) return;
    seenKeys.add(norm);
    rows.push(row);
  };

  for (const agent of params.agents) {
    const id = normalizeAgentId(agent?.id);
    if (seenAgents.has(id)) continue;
    seenAgents.add(id);

    const picked = pickRepresentativeSession({
      agentId: id,
      sessions,
      currentSessionKey: params.currentSessionKey,
      mainKey: params.mainKey,
      defaultAgentId: params.defaultAgentId,
      allowSyntheticRows: params.allowSyntheticRows,
    });
    if (!picked.key) continue;

    const row = sessions.find((r) => sessionKeysMatch(r.key, picked.key, params.defaultAgentId));
    push(row ?? { key: picked.key, updatedAt: null, kind: "direct" });
  }

  // 当前会话兜底（合成行出口 ③）：agents 还没加载 / 归属 agent 不在列表里时，
  // 至少让当前会话可见。首屏（`allowSyntheticRows === false`）跳过 ——
  // 否则这个「至少一行」会被当成完整菜单。
  const current =
    params.allowSyntheticRows === false ? "" : (normalizeOptionalString(params.currentSessionKey) ?? "");
  if (current && !rows.some((row) => sessionKeysMatch(row.key, current, params.defaultAgentId))) {
    const currentAgentId = resolveAgentIdFromSessionKey(current);
    const agentAlreadyCovered = rows.some(
      (row) => resolveAgentIdFromSessionKey(row.key) === currentAgentId,
    );
    if (!agentAlreadyCovered) {
      const row = sessions.find((r) => sessionKeysMatch(r.key, current, params.defaultAgentId));
      if (row) push(row);
      else rows.unshift({ key: current, updatedAt: null, kind: "direct" });
    }
  }

  const sorted = [...rows].sort((a, b) => {
    const pinnedDiff = Number(b.pinned === true) - Number(a.pinned === true);
    if (pinnedDiff !== 0) return pinnedDiff;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });

  const limit = params.limit ?? 40;
  return sorted.slice(0, limit);
}
