/**
 * 侧栏（二级目录）结构的本地快照 —— 让首屏就能渲染**完整**菜单。
 *
 * ## 为什么需要它
 *
 * `agents.list` / `sessions.list` 都是异步 RPC，首屏必然还没数据。而
 * `buildSidebarSessionRows()` 在「agents 还空着」时会走「当前会话兜底」分支，
 * 只产出一行 —— 用户看到的就是**左侧菜单只有当前选中的那一条**，等 RPC 回来才补齐。
 * 远端网关（跨公网）时这个窗口能到 1~3 秒，观感就是「菜单缺了」。
 *
 * 握手（`connect`）返回的 `snapshot` 里只有 presence / health / stateVersion 等，
 * **没有 agent 列表**（实测网关 2026.7.1），所以拿不到免费的同步数据源。
 * 结论：把上一次成功加载到的结构存本地，store 初始化时**同步**读回，首屏即完整；
 * RPC 回来后整表替换（stale-while-revalidate）。
 *
 * ## 存储策略
 * - 按 **gatewayUrl** 分桶，**不按 token**：同一网关换 token 只是换会话，菜单结构相同；
 *   不同网关（不同入口链接）之间互不污染。
 * - 只存「上次见到的结构」（id / 名称 / 头像 / 时间戳），**不含任何凭据**。
 * - 写入前裁剪条数，读回时做形状校验，解析失败一律当作「没有快照」，绝不抛异常。
 * - 超过 `TTL_MS` 视为过期（长期不回访的旧结构不应一直冒出来）。
 */
import type { AgentIdentityResult, GatewayAgentRow, GatewaySessionRow } from "@/api/types";

/** 快照的 localStorage 键。 */
const SNAPSHOT_KEY = "openclaw.web.sidebarSnapshot.v1";

/** 最多保留的 agent / session / identity 条数（防御脏数据把 localStorage 撑爆）。 */
const MAX_AGENTS = 50;
const MAX_SESSIONS = 200;
const MAX_IDENTITIES = 50;

/** 超过 7 天不再用于首屏。 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SidebarSnapshot = {
  agents: GatewayAgentRow[];
  sessions: GatewaySessionRow[];
  /**
   * agentId → 上次见到的运行时身份（`agent.identity.get` 的结果）。
   *
   * **为什么必须存**：`agents.list` 的行里**没有** `name` / `avatar` 字段
   * （实测只有 `id/workspace/agentRuntime/model`），侧栏 agent 行的名称与图标
   * 全都只能等 `agent.identity.get`。不缓存的话首屏会先画「名称首字母」（本机实测
   * `t=80ms` 显示 `M`），identity 回来后再翻转成真实头像（`t=250ms` 变 `🐾`）
   * —— 用户看到的是「icon 闪一下才对」。
   */
  identities: Record<string, AgentIdentityResult>;
  defaultId: string;
  mainKey: string;
  /** 写入时间（ms），用于 TTL 判定。 */
  savedAt: number;
};

/** 写入时的增量（agents / sessions / identities 由不同调用方分别写）。 */
export type SidebarSnapshotSlice = Partial<Omit<SidebarSnapshot, "savedAt">>;

type SnapshotBucketMap = Record<string, SidebarSnapshot>;

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // 隐私策略下可能直接抛异常
    return null;
  }
}

function readBuckets(): SnapshotBucketMap {
  const storage = getLocalStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(SNAPSHOT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SnapshotBucketMap) : {};
  } catch {
    return {};
  }
}

function writeBuckets(buckets: SnapshotBucketMap): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(SNAPSHOT_KEY, JSON.stringify(buckets));
  } catch {
    // 配额满 / 隐私策略：静默降级（快照只是加速，丢了大不了多一次骨架屏）
  }
}

/** 分桶键：网关地址本身（去掉首尾空白）。 */
function bucketKey(gatewayUrl: string | null | undefined): string {
  return typeof gatewayUrl === "string" ? gatewayUrl.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function sanitizeAgents(value: unknown): GatewayAgentRow[] {
  if (!Array.isArray(value)) return [];
  const out: GatewayAgentRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    out.push(item as GatewayAgentRow);
    if (out.length >= MAX_AGENTS) break;
  }
  return out;
}

function sanitizeSessions(value: unknown): GatewaySessionRow[] {
  if (!Array.isArray(value)) return [];
  const out: GatewaySessionRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!key) continue;
    out.push(item as GatewaySessionRow);
    if (out.length >= MAX_SESSIONS) break;
  }
  return out;
}

/**
 * 身份缓存只保留展示必需的字段（**绝不含凭据**：`avatar` 是「网关相对路由 / fs 路径 /
 * emoji / 远端 URL」，token 是渲染时另拼的）。
 */
function sanitizeIdentities(value: unknown): Record<string, AgentIdentityResult> {
  if (!isRecord(value)) return {};
  const out: Record<string, AgentIdentityResult> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isRecord(item)) continue;
    const agentId =
      typeof item.agentId === "string" && item.agentId.trim()
        ? item.agentId.trim()
        : typeof key === "string"
          ? key.trim()
          : "";
    if (!agentId) continue;
    out[agentId] = {
      agentId,
      name: typeof item.name === "string" ? item.name : "",
      avatar: typeof item.avatar === "string" ? item.avatar : "",
      emoji: typeof item.emoji === "string" ? item.emoji : undefined,
      avatarStatus: typeof item.avatarStatus === "string" ? item.avatarStatus : undefined,
      avatarReason: typeof item.avatarReason === "string" ? item.avatarReason : undefined,
    };
    if (Object.keys(out).length >= MAX_IDENTITIES) break;
  }
  return out;
}

function sanitizeSnapshot(value: unknown, now: number): SidebarSnapshot | null {
  if (!isRecord(value)) return null;
  const savedAt =
    typeof value.savedAt === "number" && Number.isFinite(value.savedAt) ? value.savedAt : 0;
  if (!savedAt || now - savedAt > TTL_MS) return null;
  const agents = sanitizeAgents(value.agents);
  const sessions = sanitizeSessions(value.sessions);
  // 完全没有列表内容就没必要用（避免「有快照但等于空」时既不给骨架屏也不给数据）。
  // 只有 identities 不算数 —— 它单独渲染不出任何列表。
  if (!agents.length && !sessions.length) return null;
  return {
    agents,
    sessions,
    identities: sanitizeIdentities(value.identities),
    defaultId: typeof value.defaultId === "string" ? value.defaultId : "",
    mainKey: typeof value.mainKey === "string" && value.mainKey.trim() ? value.mainKey : "main",
    savedAt,
  };
}

/** 读回某个网关的侧栏快照；没有 / 过期 / 解析失败都返回 `null`。 */
export function readSidebarSnapshot(gatewayUrl: string | null | undefined): SidebarSnapshot | null {
  const key = bucketKey(gatewayUrl);
  if (!key) return null;
  const buckets = readBuckets();
  return sanitizeSnapshot(buckets[key], Date.now());
}

/**
 * 写入（合并）某个网关的侧栏快照。
 *
 * 合并而非覆盖：`agents` 由 agents store 写，`sessions` 由 `ChatSidebar` 写，
 * 两边各自成功时只更新自己那一部分。
 */
export function writeSidebarSnapshot(
  gatewayUrl: string | null | undefined,
  patch: SidebarSnapshotSlice,
): void {
  const key = bucketKey(gatewayUrl);
  if (!key) return;

  const buckets = readBuckets();
  const previous = sanitizeSnapshot(buckets[key], Date.now());
  const next: SidebarSnapshot = {
    agents: patch.agents !== undefined ? sanitizeAgents(patch.agents) : (previous?.agents ?? []),
    sessions:
      patch.sessions !== undefined ? sanitizeSessions(patch.sessions) : (previous?.sessions ?? []),
    identities:
      patch.identities !== undefined
        ? sanitizeIdentities(patch.identities)
        : (previous?.identities ?? {}),
    defaultId: patch.defaultId !== undefined ? patch.defaultId : (previous?.defaultId ?? ""),
    mainKey: patch.mainKey !== undefined ? patch.mainKey : (previous?.mainKey ?? "main"),
    savedAt: Date.now(),
  };
  if (!next.agents.length && !next.sessions.length) return;

  // 顺手清掉过期分桶，避免长期累积
  const now = Date.now();
  for (const [bucket, value] of Object.entries(buckets)) {
    const saved = isRecord(value) && typeof value.savedAt === "number" ? value.savedAt : 0;
    if (!saved || now - saved > TTL_MS) delete buckets[bucket];
  }
  buckets[key] = next;
  writeBuckets(buckets);
}

/** 清掉某个网关的侧栏快照（如主动断开、切换网关后不想复用旧结构）。 */
export function clearSidebarSnapshot(gatewayUrl: string | null | undefined): void {
  const key = bucketKey(gatewayUrl);
  if (!key) return;
  const buckets = readBuckets();
  if (!(key in buckets)) return;
  delete buckets[key];
  writeBuckets(buckets);
}
