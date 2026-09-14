/**
 * 与网关交互的共享数据结构。
 *
 * 移植自 `ui/src/api/types.ts`，已去除对 `src/**` 的 `import type` 依赖，
 * 使 web/ 完全自包含（方案 A 的「类型下沉」目标）。
 */

export type SessionRunStatus = "running" | "done" | "failed" | "killed" | "timeout";

export type GatewaySessionRow = {
  key: string;
  kind?: "cron" | "direct" | "group" | "global" | "unknown";
  label?: string;
  category?: string;
  displayName?: string;
  channel?: string;
  surface?: string;
  subject?: string;
  room?: string;
  space?: string;
  updatedAt: number | null;
  unread?: boolean;
  lastActivityAt?: number;
  archived?: boolean;
  pinned?: boolean;
  sessionId?: string;
  abortedLastRun?: boolean;
  /** 由其它会话派生的子会话（如 subagent），二级目录里不展示。 */
  spawnedBy?: string | null;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  estimatedCostUsd?: number;
  status?: SessionRunStatus;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
  compactionCheckpointCount?: number;
};

export type GatewaySessionsDefaults = {
  modelProvider: string | null;
  model: string | null;
  contextTokens: number | null;
};

export type SessionsListResult = {
  ts?: number;
  path?: string;
  count?: number;
  totalCount?: number;
  defaults?: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
  hasMore?: boolean;
  nextOffset?: number | null;
};

export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string | null;
  enabled?: boolean | null;
  configured?: boolean | null;
  linked?: boolean | null;
  running?: boolean | null;
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  mode?: string | null;
  dmPolicy?: string | null;
  allowFrom?: string[] | null;
  tokenSource?: string | null;
  botTokenSource?: string | null;
  webhookUrl?: string | null;
  baseUrl?: string | null;
  port?: number | null;
  probe?: unknown;
};

export type ChannelUiMetaEntry = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export type ChannelsStatusSnapshot = {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  channels: Record<string, unknown>;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
  channelDefaultAccountId: Record<string, string>;
  partial?: boolean;
  warnings?: string[];
};

export type ConfigSnapshotIssue = { path: string; message: string };

export type ConfigSnapshot = {
  path?: string | null;
  exists?: boolean | null;
  hash?: string | null;
  parsed?: unknown;
  valid?: boolean | null;
  resolved?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  issues?: ConfigSnapshotIssue[] | null;
};

export type ConfigSchemaResponse = {
  schema: unknown;
  uiHints: Record<string, unknown>;
  version: string;
  generatedAt: string;
};

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | { kind: "on-exit"; command: string; cwd?: string };

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "command"; argv: string[]; cwd?: string; timeoutSeconds?: number }
  | {
      kind: "agentTurn";
      message: string;
      model?: string;
      deliver?: boolean;
      channel?: string;
      to?: string;
    };

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDelivered?: boolean;
};

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  sessionTarget?: string;
  wakeMode?: string;
  payload: CronPayload;
  delivery?: { mode: string; channel?: string; to?: string };
  state?: CronJobState;
};

export type CronStatus = { enabled: boolean; jobs: number; nextWakeAtMs?: number | null };

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action?: string;
  status?: string;
  durationMs?: number;
  error?: string;
  summary?: string;
  delivered?: boolean;
  sessionId?: string;
  sessionKey?: string;
  model?: string;
  provider?: string;
  jobName?: string;
};

export type CronJobsListResult = { jobs: CronJob[]; total?: number };
export type CronRunsResult = { entries: CronRunLogEntry[]; total?: number };

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: { bins: string[]; env: string[]; config: string[]; os: string[] };
  missing: { bins: string[]; env: string[]; config: string[]; os: string[] };
  install: Array<{ id: string; kind: string; label: string; bins: string[] }>;
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  agentId?: string;
  skills: SkillStatusEntry[];
};

export type GatewayAgentIdentity = {
  name?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
  /** 兼容旧字段：部分网关版本把 emoji/avatar 平铺在 agent 上。 */
  avatar?: string;
  emoji?: string;
  isDefault?: boolean;
  /** 新版网关把身份信息收敛到 identity 下。 */
  identity?: GatewayAgentIdentity;
  workspace?: string;
  model?: { primary?: string; fallbacks?: string[] };
};

export type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  scope: string;
  agents: GatewayAgentRow[];
};

export type AgentIdentityResult = {
  agentId: string;
  name: string;
  avatar: string;
  emoji?: string;
  /**
   * 头像的归因状态（网关 `resolveAgentAvatar` 的结果）：
   * - `local`：网关托管的本地文件，经 `/avatar/<agentId>` 暴露；
   * - `remote`：远端 http(s) URL，可直接用；
   * - `data`：data URI；
   * - `none`：没有头像（`avatarReason` 说明原因，如 `missing` / `outside_workspace`）。
   */
  avatarStatus?: string;
  /** `avatarStatus === "none"` 时的原因。 */
  avatarReason?: string;
};

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  available?: boolean;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "document">;
};

export type PresenceEntry = {
  instanceId?: string | null;
  host?: string | null;
  ip?: string | null;
  version?: string | null;
  platform?: string | null;
  roles?: string[] | null;
  scopes?: string[] | null;
  mode?: string | null;
  lastInputSeconds?: number | null;
  reason?: string | null;
  ts?: number | null;
};

export type SessionsUsageTotals = {
  totalCost?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type SessionsUsageEntry = {
  provider?: string;
  model?: string;
  totals?: SessionsUsageTotals;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalCost?: number;
};

export type SessionsUsageResult = {
  totals?: SessionsUsageTotals;
  daily?: Array<{ date: string; totals?: SessionsUsageTotals }>;
  sessions?: SessionsUsageEntry[];
};

export type HealthSnapshot = Record<string, unknown>;

export type LogEntry = {
  ts?: number;
  level?: string;
  message?: string;
  [key: string]: unknown;
};
