/**
 * OpenResponses HTTP Handler
 *
 * Implements the OpenResponses `/v1/responses` endpoint for OpenClaw Gateway.
 *
 * @see https://www.open-responses.com/
 */

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { isClientToolNameConflictError } from "../agents/agent-tool-definition-adapter.js";
import type { ImageContent } from "../agents/command/types.js";
import type { ClientToolDefinition } from "../agents/embedded-agent-runner/run/params.js";
import { createDefaultDeps } from "../cli/deps.js";
import type { CliDeps } from "../cli/deps.types.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { getRuntimeConfig } from "../config/config.js";
import type { GatewayHttpResponsesConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { renderFileContextBlock } from "../media/file-context.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractFileContentFromSource,
  extractImageContentFromSource,
  normalizeMimeList,
  resolveInputFileLimits,
  type InputFileLimits,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { defaultRuntime } from "../runtime.js";
import {
  isReplaceableAssistantStreamEvent,
  resolveAssistantStreamDeltaText,
  resolveAssistantStreamSnapshotText,
} from "./agent-event-assistant-text.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  sendJson,
  sendMissingScopeForbidden,
  setSseHeaders,
  watchClientDisconnect,
  writeDone,
} from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  authorizeOpenAiCompatibleHttpModelOverride,
  getBearerToken,
  getHeader,
  isGatewaySessionKeyOverrideError,
  isUnknownGatewayAgentError,
  resolveAgentIdForRequest,
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";
import {
  CreateResponseBodySchema,
  type CreateResponseBody,
  type OutputItem,
  type ResponseResource,
  type StreamingEvent,
  type Usage,
} from "./open-responses.schema.js";
import { resolveOpenAiCompatError } from "./openai-compat-errors.js";
import {
  isToolChoiceConstraintSatisfied,
  resolveUnsatisfiedToolChoiceMessage,
  toolChoiceConstraintPrompt,
  type ToolChoiceConstraint,
} from "./openai-tool-choice.js";
import { wrapUntrustedFileContent } from "./openresponses-file-content.js";
import { buildAgentPrompt } from "./openresponses-prompt.js";
import { createAssistantOutputItem, createFunctionCallOutputItem } from "./openresponses-shape.js";

type OpenResponsesHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  config?: GatewayHttpResponsesConfig;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

const DEFAULT_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_URL_PARTS = 8;

// In-memory map from responseId -> sessionKey for previous_response_id continuity.
// Entries are evicted after 30 minutes to bound memory usage.
const RESPONSE_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_RESPONSE_SESSION_ENTRIES = 500;
type ResponseSessionScope = {
  authSubject: string;
  agentId: string;
  requestedSessionKey?: string;
};

type ResponseSessionEntry = ResponseSessionScope & {
  sessionKey: string;
  ts: number;
};

const responseSessionMap = new Map<string, ResponseSessionEntry>();

function normalizeResponseSessionScope(scope: ResponseSessionScope): ResponseSessionScope {
  const authSubject = scope.authSubject.trim();
  const requestedSessionKey = scope.requestedSessionKey?.trim();
  return {
    authSubject,
    agentId: scope.agentId,
    requestedSessionKey: requestedSessionKey || undefined,
  };
}

function resolveResponseSessionAuthSubject(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
}): string {
  const bearer = getBearerToken(params.req);
  if (bearer) {
    return `bearer:${createHash("sha256").update(bearer).digest("hex")}`;
  }
  if (params.auth.mode === "trusted-proxy" && params.auth.trustedProxy?.userHeader) {
    const user = getHeader(params.req, params.auth.trustedProxy.userHeader)?.trim();
    if (user) {
      return `trusted-proxy:${user}`;
    }
  }
  return `gateway-auth:${params.auth.mode}`;
}

function createResponseSessionScope(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  agentId: string;
}): ResponseSessionScope {
  return normalizeResponseSessionScope({
    authSubject: resolveResponseSessionAuthSubject({ req: params.req, auth: params.auth }),
    agentId: params.agentId,
    requestedSessionKey: getHeader(params.req, "x-openclaw-session-key"),
  });
}

function matchesResponseSessionScope(
  entry: ResponseSessionEntry,
  scope: ResponseSessionScope,
): boolean {
  return (
    entry.authSubject === scope.authSubject &&
    entry.agentId === scope.agentId &&
    entry.requestedSessionKey === scope.requestedSessionKey
  );
}

function pruneExpiredResponseSessions(now: number) {
  while (responseSessionMap.size > 0) {
    const oldest = responseSessionMap.entries().next().value;
    if (!oldest) {
      return;
    }
    const [oldestKey, oldestValue] = oldest;
    if (now - oldestValue.ts <= RESPONSE_SESSION_TTL_MS) {
      return;
    }
    responseSessionMap.delete(oldestKey);
  }
}

function evictOverflowResponseSessions() {
  while (responseSessionMap.size > MAX_RESPONSE_SESSION_ENTRIES) {
    const oldestKey = responseSessionMap.keys().next().value;
    if (!oldestKey) {
      return;
    }
    responseSessionMap.delete(oldestKey);
  }
}

function storeResponseSession(
  responseId: string,
  sessionKey: string,
  scope: ResponseSessionScope,
  now = Date.now(),
) {
  // Reinsert existing keys so the map stays ordered by freshest timestamp.
  responseSessionMap.delete(responseId);
  responseSessionMap.set(responseId, { ...scope, sessionKey, ts: now });
  pruneExpiredResponseSessions(now);
  evictOverflowResponseSessions();
}

function lookupResponseSession(
  responseId: string | undefined,
  scope: ResponseSessionScope,
  now = Date.now(),
): string | undefined {
  if (!responseId) {
    return undefined;
  }
  const entry = responseSessionMap.get(responseId);
  if (!entry) {
    return undefined;
  }
  if (now - entry.ts > RESPONSE_SESSION_TTL_MS) {
    responseSessionMap.delete(responseId);
    return undefined;
  }
  if (!matchesResponseSessionScope(entry, scope)) {
    return undefined;
  }
  return entry.sessionKey;
}

export const testing = {
  resetResponseSessionState() {
    responseSessionMap.clear();
  },
  wrapUntrustedFileContent,
  storeResponseSessionAt(
    responseId: string,
    sessionKey: string,
    now: number,
    scope: ResponseSessionScope = { authSubject: "test", agentId: "main" },
  ) {
    storeResponseSession(responseId, sessionKey, normalizeResponseSessionScope(scope), now);
  },
  lookupResponseSessionAt(
    responseId: string | undefined,
    now: number,
    scope: ResponseSessionScope = { authSubject: "test", agentId: "main" },
  ) {
    return lookupResponseSession(responseId, normalizeResponseSessionScope(scope), now);
  },
  getResponseSessionIds() {
    return [...responseSessionMap.keys()];
  },
  resolveResponsesLimits,
};

function writeSseEvent(res: ServerResponse, event: StreamingEvent) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

type ResolvedResponsesLimits = {
  maxBodyBytes: number;
  maxUrlParts: number;
  files: InputFileLimits;
  images: InputImageLimits;
};

function resolveResponsesLimits(
  config: GatewayHttpResponsesConfig | undefined,
): ResolvedResponsesLimits {
  const files = config?.files;
  const images = config?.images;
  const fileLimits = resolveInputFileLimits(files);
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    maxUrlParts: resolveIntegerOption(config?.maxUrlParts, DEFAULT_MAX_URL_PARTS, { min: 0 }),
    files: {
      ...fileLimits,
      urlAllowlist: normalizeInputHostnameAllowlist(files?.urlAllowlist),
    },
    images: {
      allowUrl: images?.allowUrl ?? true,
      urlAllowlist: normalizeInputHostnameAllowlist(images?.urlAllowlist),
      allowedMimes: normalizeMimeList(images?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: images?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: images?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: images?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function extractClientTools(body: CreateResponseBody): ClientToolDefinition[] {
  // Normalize from Responses API flat format to the internal wrapped format.
  return (body.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
  }));
}

function applyToolChoice(params: {
  tools: ClientToolDefinition[];
  toolChoice: CreateResponseBody["tool_choice"];
}): {
  tools: ClientToolDefinition[];
  extraSystemPrompt?: string;
  constraint?: ToolChoiceConstraint;
} {
  const { tools, toolChoice } = params;
  if (!toolChoice) {
    return { tools };
  }

  if (toolChoice === "none") {
    return { tools: [] };
  }

  if (toolChoice === "required") {
    if (tools.length === 0) {
      throw new Error("tool_choice=required but no tools were provided");
    }
    const constraint: ToolChoiceConstraint = { type: "required" };
    return { tools, extraSystemPrompt: toolChoiceConstraintPrompt(constraint), constraint };
  }

  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const targetName = ("name" in toolChoice ? toolChoice.name : toolChoice.function.name).trim();
    if (!targetName) {
      throw new Error("tool_choice.name is required");
    }
    const matched = tools.filter((tool) => tool.function?.name === targetName);
    if (matched.length === 0) {
      throw new Error(`tool_choice requested unknown tool: ${targetName}`);
    }
    const constraint: ToolChoiceConstraint = { type: "function", name: targetName };
    return {
      tools: matched,
      extraSystemPrompt: toolChoiceConstraintPrompt(constraint),
      constraint,
    };
  }

  return { tools };
}

export { buildAgentPrompt } from "./openresponses-prompt.js";

function createEmptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function toUsage(
  value:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined,
): Usage {
  if (!value) {
    return createEmptyUsage();
  }
  const input = value.input ?? 0;
  const output = value.output ?? 0;
  const cacheRead = value.cacheRead ?? 0;
  const cacheWrite = value.cacheWrite ?? 0;
  const total = value.total ?? input + output + cacheRead + cacheWrite;
  return {
    input_tokens: Math.max(0, input),
    output_tokens: Math.max(0, output),
    total_tokens: Math.max(0, total),
  };
}

function extractUsageFromResult(result: unknown): Usage {
  const meta = (result as { meta?: { agentMeta?: { usage?: unknown } } } | null)?.meta;
  const usage = meta && typeof meta === "object" ? meta.agentMeta?.usage : undefined;
  return toUsage(
    usage as
      | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
      | undefined,
  );
}

type PendingToolCall = { id: string; name: string; arguments: string };

function resolveStopReasonAndPendingToolCalls(meta: unknown): {
  stopReason: string | undefined;
  pendingToolCalls: PendingToolCall[] | undefined;
} {
  if (!meta || typeof meta !== "object") {
    return { stopReason: undefined, pendingToolCalls: undefined };
  }
  const record = meta as { stopReason?: string; pendingToolCalls?: PendingToolCall[] };
  return { stopReason: record.stopReason, pendingToolCalls: record.pendingToolCalls };
}

function createResponseResource(params: {
  id: string;
  model: string;
  status: ResponseResource["status"];
  output: OutputItem[];
  usage?: Usage;
  error?: { code: string; message: string };
  spendResult?: { spend: number | null; balance: number | null };
}): ResponseResource {
  return {
    id: params.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: params.status,
    model: params.model,
    output: params.output,
    usage: params.usage ?? createEmptyUsage(),
    error: params.error,
    spendResult: params.spendResult,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// JD-LLM spend polling
// ─────────────────────────────────────────────────────────────────────────
//
// After every non-streaming chat completion the gateway polls the upstream
// JD-LLM spend log endpoint to learn how much the request cost and what the
// account balance is. The result is attached to the outgoing response as
// `spendResult` so independent frontends can show per-turn spend without
// having to call `GET /api/v1/jd/spend/:completionId` themselves.
//
// Polling cadence (cumulative ~3.8s) tolerates the upstream's async
// accounting pipeline, where the cost record sometimes lands a few hundred
// milliseconds after the completion itself.

const JD_SPEND_POLL_DELAYS_MS = [300, 500, 1000, 2000] as const;
const JD_SPEND_FETCH_TIMEOUT_MS = 3000;

export function resolveJdLlmProviderConfig(): { apiKey: string; spendBaseUrl: string } | null {
  const config = getRuntimeConfig();
  if (!config) {
    return null;
  }
  const models = config.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;
  const jdLlm = providers?.["jd-llm"] as Record<string, unknown> | undefined;
  if (!jdLlm) {
    return null;
  }
  const apiKey = typeof jdLlm.apiKey === "string" ? jdLlm.apiKey : "";
  // Spend queries live on the JD spend gateway (HTTPS, no /v1 suffix), NOT on
  // the LLM baseUrl. Resolution order: jd-llm.spendBaseUrl (explicit) →
  // jd-spend-proxy plugin config spendBaseUrl → jd-llm.baseUrl (legacy fallback).
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const pluginEntries = plugins?.entries as Record<string, unknown> | undefined;
  const spendProxyEntry = pluginEntries?.["jd-spend-proxy"] as Record<string, unknown> | undefined;
  const spendProxyConfig = spendProxyEntry?.config as Record<string, unknown> | undefined;
  const pluginSpendBaseUrl =
    typeof spendProxyConfig?.spendBaseUrl === "string" ? spendProxyConfig.spendBaseUrl : "";
  const providerSpendBaseUrl = typeof jdLlm.spendBaseUrl === "string" ? jdLlm.spendBaseUrl : "";
  const legacyBaseUrl = typeof jdLlm.baseUrl === "string" ? jdLlm.baseUrl : "";
  const spendBaseUrl = providerSpendBaseUrl || pluginSpendBaseUrl || legacyBaseUrl;
  if (!apiKey || !spendBaseUrl) {
    return null;
  }
  return { apiKey, spendBaseUrl };
}

export async function fetchJdSpendOnce(
  base: string,
  apiKey: string,
  completionId: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean;
  status: number;
  spend: number | null;
  balance: number | null;
  /**
   * 账户累计消费（上游 `key.spend`），换算到与 `spend` **同一量纲**（×1000）。
   *
   * ⚠️ 必须换算：`spend` 走的是 `Math.round(raw * 1e5) / 100`（= raw×1000），
   * 而 `key.spend` 原先直接用原始值，两个数字量纲差 1000 倍 ⇒ 任何增量比较
   * 都永远不成立，`pollJdSpendForChat` 会逐轮落进兜底分支。
   *
   * `null` 表示记录未就绪或上游没返回 `key` 对象。
   */
  keySpend: number | null;
}> {
  const upstreamUrl = `${base}/spend/logs/ui/${encodeURIComponent(completionId)}?include_key_info=true`;
  let res: Response;
  try {
    res = await fetch(upstreamUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(JD_SPEND_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, spend: null, balance: null, keySpend: null };
  }
  if (res.status === 202) {
    return { ok: false, status: 202, spend: null, balance: null, keySpend: null };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, spend: null, balance: null, keySpend: null };
  }
  // The upstream may answer 200 with an HTML error page (CDN interception) or
  // an error JSON instead of the spend record. Treat non-JSON bodies as a
  // retryable failure so callers poll instead of resolving to a null spend.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { ok: false, status: res.status, spend: null, balance: null, keySpend: null };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, status: res.status, spend: null, balance: null, keySpend: null };
  }
  const record = data as Record<string, unknown>;
  const rawSpend = typeof record?.spend === "number" ? record.spend : null;
  const key = record?.key as Record<string, unknown> | undefined;
  const rawBalance = typeof key?.balance === "number" ? key.balance : null;
  const rawKeySpend = typeof key?.spend === "number" ? key.spend : null;
  return {
    ok: true,
    status: res.status,
    spend: rawSpend !== null ? Math.round(rawSpend * 1e5) / 100 : null,
    balance: rawBalance !== null ? Math.round(rawBalance * 1e5) / 100 : null,
    // 与 `spend`/`balance` 统一到 ×1000 口径；不取整，保留原始精度用于增量比较。
    keySpend: rawKeySpend !== null ? rawKeySpend * 1e3 : null,
  };
}

/**
 * Poll the upstream JD-LLM spend endpoint until a non-pending response
 * arrives or the budget is exhausted. Returns `{spend, balance}` — both
 * fields are `null` on any error, timeout, or pending state. Never throws.
 */
export async function fetchAndPollJdSpend(
  completionId: string,
): Promise<{ spend: number | null; balance: number | null }> {
  const cfg = resolveJdLlmProviderConfig();
  if (!cfg) {
    return { spend: null, balance: null };
  }
  const base = cfg.spendBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  let attempt = 0;
  while (true) {
    const result = await fetchJdSpendOnce(base, cfg.apiKey, completionId);
    if (result.ok) {
      return { spend: result.spend, balance: result.balance };
    }
    if (attempt >= JD_SPEND_POLL_DELAYS_MS.length) {
      return { spend: null, balance: null };
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, JD_SPEND_POLL_DELAYS_MS[attempt]!);
    });
    attempt += 1;
  }
}

const JD_SPEND_CHAT_POLL_DEADLINE_MS = 15_000;
const JD_SPEND_CHAT_POLL_RETRY_DELAY_MS = 2_000;
/**
 * 金额比较容差。`spend` 被四舍五入到两位小数（`Math.round(raw * 1e5) / 100`），
 * 而累计值保留上游原始精度，两者比较必须容忍半个最小单位，否则「已入账」
 * 会被判成「没入账」。
 */
const JD_SPEND_AMOUNT_EPSILON = 1e-2;
/** 账户级快照的条数上限与过期时间（充值 / 换 key 后自然老化）。 */
const JD_SPEND_KEY_STATE_LIMIT = 32;
const JD_SPEND_KEY_STATE_TTL_MS = 15 * 60_000;

/**
 * 账户级状态：最近一次**已确认入账**的（累计消费, 余额）。
 *
 * 为什么需要它：上游的 `spend` 记录和 `key.balance` 不是同一个事务写出来的，
 * 只看一次响应无法判断「这个 balance 是否已经扣掉本轮」。把上一条已确认消息
 * 观测到的 `key.spend` 当基线，用「累计增量 ≈ 本轮 spend」即可判定 —— 全程
 * 只比较上游给的数字，不做任何加减推算。
 */
type JdSpendKeyState = { keySpend: number; balance: number; at: number };

const jdSpendKeyStates = new Map<string, JdSpendKeyState>();

function jdSpendKeyStateId(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function readJdSpendKeyState(apiKey: string): JdSpendKeyState | null {
  const id = jdSpendKeyStateId(apiKey);
  const state = jdSpendKeyStates.get(id);
  if (!state) {
    return null;
  }
  if (Date.now() - state.at > JD_SPEND_KEY_STATE_TTL_MS) {
    jdSpendKeyStates.delete(id);
    return null;
  }
  return state;
}

/**
 * 记录一次**已确认**的账户观测。
 *
 * 只在 `key.spend` 前进时覆盖：累计消费单调不减，值越大越新。
 * `chat.spend.getBatch` 会 4 路并发回填历史，乱序返回的旧观测不能把基线写回去。
 */
function rememberJdSpendKeyState(
  apiKey: string,
  keySpend: number | null,
  balance: number | null,
): void {
  if (typeof keySpend !== "number" || typeof balance !== "number") {
    return;
  }
  const id = jdSpendKeyStateId(apiKey);
  const prev = jdSpendKeyStates.get(id);
  if (prev) {
    if (keySpend < prev.keySpend - JD_SPEND_AMOUNT_EPSILON) {
      // 累计值回退 ⇒ 充值重置 / 换了 key，旧基线失效，落到下面重建。
      jdSpendKeyStates.delete(id);
    } else if (keySpend <= prev.keySpend + JD_SPEND_AMOUNT_EPSILON) {
      // 没有更新的观测（历史回填乱序返回等）⇒ 只续期，不覆盖。
      prev.at = Date.now();
      return;
    }
  }
  if (jdSpendKeyStates.size >= JD_SPEND_KEY_STATE_LIMIT) {
    const oldest = jdSpendKeyStates.keys().next();
    if (!oldest.done) {
      jdSpendKeyStates.delete(oldest.value);
    }
  }
  jdSpendKeyStates.set(id, { keySpend, balance, at: Date.now() });
}

/**
 * 累计消费自 `baseKeySpend` 起是否已经吃进本轮 `spend`。
 *
 * 两个字段都换算到同一量纲（`key.spend` 与 `spend` 都 ×1000）后再比。
 * 缺任一数字 ⇒ 无法判定，返回 false（不猜）。
 */
function hasSettledSpend(
  baseKeySpend: number | null,
  keySpend: number | null,
  spend: number,
): boolean {
  if (typeof baseKeySpend !== "number" || typeof keySpend !== "number") {
    return false;
  }
  return keySpend - baseKeySpend + JD_SPEND_AMOUNT_EPSILON >= spend;
}

/**
 * Clamp a numeric balance at zero. `null` (unknown) is preserved so callers
 * can distinguish "upstream not yet known" from "depleted to zero". `spend`
 * is left untouched — zero-spend completions are valid and must surface as 0.
 */
function clampBalanceFloor(balance: number | null): number | null {
  return typeof balance === "number" ? Math.max(0, balance) : balance;
}

/**
 * Polls the JD spend endpoint and reports **上游原值**：
 *  - `spend`：本轮消耗（上游 `spend` 字段，×1000 保留两位）；
 *  - `balance`：上游 `key.balance`，**原样透出，绝不加减推算**。
 *
 * 两阶段：
 *  1. 等 `spend` 出数；
 *  2. 确认「本轮消费已入账」就返回那一刻的 `key.balance`。窗口内确认不了，
 *     回退到**最后一次观测到的上游原值** —— 它可能还没扣掉本轮（偏大），
 *     但仍是上游给的真数字，且保证「剩余积分永远有数」。
 *
 * 入账判据只有一条：账户累计消费 `key.spend` 相对基线（上一条已确认消息的
 * 观测值）增长了 ≈ 本轮 `spend`。
 *
 * ⚠️ 这里**不能**用 `firstBalance - spend` 兜底。上游常常在 final 帧到达之前
 * 就已完成入账，此时 `firstBalance` 已经是扣过的值，再减一次就等于把本轮
 * 花费扣第二遍（实测：真实 4911.87 / spend 0.78 被算成 4911.09）。用户看到
 * 的「后面的消息剩余积分反而变多」，就是这个偏差与相邻轮次正确值混排的结果。
 *
 * 规则：
 *  - history：历史轮次早已入账，直接用首探 `key.balance`，不等待、不推算；
 *  - spend === 0：本轮没有消费，同样直接透出原值；
 *  - final 未确认入账：返回窗口内最后一次观测到的原值（偏大但绝不偏小）；
 *  - 上游连 `key` 对象都没给：`balance: null`（没有数字可用，不编造）。
 *
 * 为什么判不准时宁可给偏大的旧值、也不给 `null`：产品要求「剩余积分行一直有数」。
 * 偏大值的相邻轮次表现是「持平 → 下一轮递减」，不会出现「余额变多」的错觉
 * （余额单调不增，旧值一定 ≥ 后续真值）；而 `null` 会让整行消失。
 *
 * Never throws. Returns `{ spend, balance }`；只有连 `spend` 都拿不到时才
 * 两个字段都为 `null`。
 */
export async function pollJdSpendForChat(
  completionId: string,
  opts?: {
    signal?: AbortSignal;
    retryDelayMs?: number;
    deadlineMs?: number;
    /**
     * Caller context:
     *  - "final"（默认）：刚结束的轮次，需要等上游把本轮消费入账；
     *  - "history"：历史轮次，记录已是终态，直接用观测值。
     */
    mode?: "final" | "history";
  },
): Promise<{ spend: number | null; balance: number | null }> {
  const cfg = resolveJdLlmProviderConfig();
  if (!cfg) {
    return { spend: null, balance: null };
  }
  const base = cfg.spendBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const deadline = Date.now() + (opts?.deadlineMs ?? JD_SPEND_CHAT_POLL_DEADLINE_MS);
  const retryDelay = opts?.retryDelayMs ?? JD_SPEND_CHAT_POLL_RETRY_DELAY_MS;
  const mode = opts?.mode ?? "final";
  const isAborted = () => opts?.signal?.aborted === true;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (opts?.signal) {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });

  // Phase 1 — wait for `spend` to resolve.
  let result = await fetchJdSpendOnce(base, cfg.apiKey, completionId, opts?.signal);
  while ((!result.ok || result.spend === null) && !isAborted() && Date.now() < deadline) {
    await sleep(retryDelay);
    if (isAborted() || Date.now() >= deadline) {
      break;
    }
    result = await fetchJdSpendOnce(base, cfg.apiKey, completionId, opts?.signal);
  }
  if (!result.ok || result.spend === null) {
    return { spend: null, balance: null };
  }
  const spend = result.spend;

  // history — 历史轮次的消费早已入账，上游给的 `key.balance` 就是终值：
  // 直接透出，既不等待也不推算。同时用它的累计值维护账户基线（只在前进时覆盖）。
  if (mode === "history") {
    rememberJdSpendKeyState(cfg.apiKey, result.keySpend, result.balance);
    return { spend, balance: clampBalanceFloor(result.balance) };
  }

  // spend === 0 — 本轮没有消费，余额不会变，原值直接透出。
  if (spend === 0) {
    rememberJdSpendKeyState(cfg.apiKey, result.keySpend, result.balance);
    return { spend: 0, balance: clampBalanceFloor(result.balance) };
  }

  // Phase 2 — 只等「入账」这一个事实，等到了就用上游原值。
  const baseline = readJdSpendKeyState(cfg.apiKey);
  // 没有基线（进程刚起 / 新 key）时退化为「首探 → 后续」的增量观察：
  // 这样仍能覆盖「首探未入账、窗口内入账」的常规路径；而首探就已入账且
  // 全程无变化的情况无法判定，会在超时后返回 null（交给历史回填），
  // 而不是靠减法去猜。
  const baseKeySpend = baseline ? baseline.keySpend : result.keySpend;

  // 首探就可能已经是入账后的终值（final 帧晚于上游出账，最常见）。
  if (baseline && hasSettledSpend(baseline.keySpend, result.keySpend, spend)) {
    rememberJdSpendKeyState(cfg.apiKey, result.keySpend, result.balance);
    return { spend, balance: clampBalanceFloor(result.balance) };
  }

  // 兜底值：窗口内**最后一次看到的上游余额**。它只会被更小的值替换（余额单调
  // 不增），所以「判不准」时给出的是「最接近真值但仍可能偏大」的原值。
  let latestBalance: number | null = result.balance;
  while (!isAborted() && Date.now() < deadline) {
    await sleep(retryDelay);
    if (isAborted() || Date.now() >= deadline) {
      break;
    }
    const refined = await fetchJdSpendOnce(base, cfg.apiKey, completionId, opts?.signal);
    if (!refined.ok || refined.balance === null) {
      continue;
    }
    latestBalance = refined.balance;
    if (hasSettledSpend(baseKeySpend, refined.keySpend, spend)) {
      rememberJdSpendKeyState(cfg.apiKey, refined.keySpend, refined.balance);
      return { spend, balance: clampBalanceFloor(refined.balance) };
    }
  }

  // 判不准入账 ⇒ 仍然给数：用最近一次观测到的上游原值，绝不加减推算。
  return { spend, balance: clampBalanceFloor(latestBalance) };
}

export interface PollSpendBatchOptions {
  /** Maximum number of concurrent polls (default 4). */
  concurrency?: number;
  /** Per-message wall-clock budget; once exceeded, the poll is aborted and
   *  the best-known `spend`/`balance` (or computed fallback) is returned. */
  perMessageTimeoutMs?: number;
  /** Override the inter-retry delay (default 2000ms). */
  retryDelayMs?: number;
  /** Context passed through to each per-message poll. History backfill uses
   *  "history" so a never-transitioned record is trusted as-is. */
  mode?: "final" | "history";
}

/**
 * Batch variant used by `chat.history` to backfill `spendResult` on existing
 * transcript messages. Deduplicates the input, fans out polls with bounded
 * concurrency, and aborts stragglers once each message's budget is exhausted.
 * Never throws — failed/aborted messages resolve to `{spend: null, balance: null}`
 * so the caller can always attach a stable envelope.
 */
export async function pollSpendResultsForResponseIds(
  responseIds: readonly string[],
  opts?: PollSpendBatchOptions,
): Promise<Map<string, { spend: number | null; balance: number | null }>> {
  const out = new Map<string, { spend: number | null; balance: number | null }>();
  const unique = Array.from(new Set(responseIds.filter((id) => typeof id === "string" && id)));
  if (unique.length === 0) {
    return out;
  }

  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? 4));
  const perMessageTimeoutMs = Math.max(100, Math.floor(opts?.perMessageTimeoutMs ?? 6_000));
  const retryDelayMs = opts?.retryDelayMs;

  let cursor = 0;
  const total = unique.length;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= total) {
        return;
      }
      const id = unique[idx]!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perMessageTimeoutMs);
      try {
        const result = await pollJdSpendForChat(id, {
          signal: controller.signal,
          ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
          ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
        });
        out.set(id, result);
      } catch {
        out.set(id, { spend: null, balance: null });
      } finally {
        clearTimeout(timer);
      }
    }
  };

  const workerCount = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

async function runResponsesAgentCommand(params: {
  message: string;
  images: ImageContent[];
  clientTools: ClientToolDefinition[];
  extraSystemPrompt: string;
  modelOverride?: string;
  streamParams: { maxTokens?: number; temperature?: number; topP?: number } | undefined;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  deps: CliDeps;
  abortSignal?: AbortSignal;
}) {
  return agentCommandFromIngress(
    {
      message: params.message,
      images: params.images.length > 0 ? params.images : undefined,
      clientTools: params.clientTools.length > 0 ? params.clientTools : undefined,
      extraSystemPrompt: params.extraSystemPrompt || undefined,
      model: params.modelOverride,
      streamParams: params.streamParams ?? undefined,
      sessionKey: params.sessionKey,
      runId: params.runId,
      deliver: false,
      messageChannel: params.messageChannel,
      bestEffortDeliver: false,
      allowModelOverride: params.modelOverride !== undefined,
      abortSignal: params.abortSignal,
    },
    defaultRuntime,
    params.deps,
  );
}

export async function handleOpenResponsesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenResponsesHttpOptions,
): Promise<boolean> {
  const limits = resolveResponsesLimits(opts.config);
  const maxBodyBytes =
    opts.maxBodyBytes ??
    (opts.config?.maxBodyBytes
      ? limits.maxBodyBytes
      : Math.max(limits.maxBodyBytes, limits.files.maxBytes * 2, limits.images.maxBytes * 2));
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/responses",
    requiredOperatorMethod: "chat.send",
    // Compat HTTP uses a different scope model from generic HTTP helpers:
    // shared-secret bearer auth is treated as full operator access here.
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  const modelOverrideAuth = authorizeOpenAiCompatibleHttpModelOverride(req, handled.requestAuth);
  if (!modelOverrideAuth.allowed) {
    sendMissingScopeForbidden(res, modelOverrideAuth.missingScope);
    return true;
  }
  // Validate request body with Zod
  const parseResult = CreateResponseBodySchema.safeParse(handled.body);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    const message = issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request body";
    sendJson(res, 400, {
      error: { message, type: "invalid_request_error" },
    });
    return true;
  }

  const payload: CreateResponseBody = parseResult.data;
  const stream = Boolean(payload.stream);
  const model = payload.model;
  const user = payload.user;
  let agentId: string;
  try {
    agentId = resolveAgentIdForRequest({ req, model });
  } catch (err) {
    if (isUnknownGatewayAgentError(err)) {
      sendJson(res, 400, {
        error: { message: err.message, type: "invalid_request_error" },
      });
      return true;
    }
    throw err;
  }
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendJson(res, 400, {
      error: { message: modelError, type: "invalid_request_error" },
    });
    return true;
  }

  // Extract images + files from input (Phase 2)
  let images: ImageContent[] = [];
  const fileContexts: string[] = [];
  let urlParts = 0;
  const markUrlPart = () => {
    urlParts += 1;
    if (urlParts > limits.maxUrlParts) {
      throw new Error(
        `Too many URL-based input sources: ${urlParts} (limit: ${limits.maxUrlParts})`,
      );
    }
  };
  try {
    if (Array.isArray(payload.input)) {
      for (const item of payload.input) {
        if (item.type === "message" && typeof item.content !== "string") {
          for (const part of item.content) {
            if (part.type === "input_image") {
              const source = part.source as {
                type?: string;
                url?: string;
                data?: string;
                media_type?: string;
              };
              const sourceType =
                source.type === "base64" || source.type === "url" ? source.type : undefined;
              if (!sourceType) {
                throw new Error("input_image must have 'source.url' or 'source.data'");
              }
              if (sourceType === "url") {
                markUrlPart();
              }
              const imageSource: InputImageSource =
                sourceType === "url"
                  ? {
                      type: "url",
                      url: source.url ?? "",
                      mediaType: source.media_type,
                    }
                  : {
                      type: "base64",
                      data: source.data ?? "",
                      mediaType: source.media_type,
                    };
              const image = await extractImageContentFromSource(imageSource, limits.images);
              images.push(image);
              continue;
            }

            if (part.type === "input_file") {
              const source = part.source as {
                type?: string;
                url?: string;
                data?: string;
                media_type?: string;
                filename?: string;
              };
              const sourceType =
                source.type === "base64" || source.type === "url" ? source.type : undefined;
              if (!sourceType) {
                throw new Error("input_file must have 'source.url' or 'source.data'");
              }
              if (sourceType === "url") {
                markUrlPart();
              }
              const file = await extractFileContentFromSource({
                source:
                  sourceType === "url"
                    ? {
                        type: "url",
                        url: source.url ?? "",
                        mediaType: source.media_type,
                        filename: source.filename,
                      }
                    : {
                        type: "base64",
                        data: source.data ?? "",
                        mediaType: source.media_type,
                        filename: source.filename,
                      },
                limits: limits.files,
              });
              const rawText = file.text;
              if (rawText?.trim()) {
                fileContexts.push(
                  renderFileContextBlock({
                    filename: file.filename,
                    content: wrapUntrustedFileContent(rawText),
                  }),
                );
              } else if (file.images && file.images.length > 0) {
                fileContexts.push(
                  renderFileContextBlock({
                    filename: file.filename,
                    content: "[PDF content rendered to images]",
                    surroundContentWithNewlines: false,
                  }),
                );
              } else {
                fileContexts.push(
                  renderFileContextBlock({
                    filename: file.filename,
                    content: "[No extractable text]",
                    surroundContentWithNewlines: false,
                  }),
                );
              }
              if (file.images && file.images.length > 0) {
                images = images.concat(file.images);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logWarn(`openresponses: request parsing failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid request", type: "invalid_request_error" },
    });
    return true;
  }

  const clientTools = extractClientTools(payload);
  let toolChoicePrompt: string | undefined;
  let toolChoiceConstraint: ToolChoiceConstraint | undefined;
  let resolvedClientTools = clientTools;
  try {
    const toolChoiceResult = applyToolChoice({
      tools: clientTools,
      toolChoice: payload.tool_choice,
    });
    resolvedClientTools = toolChoiceResult.tools;
    toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
    toolChoiceConstraint = toolChoiceResult.constraint;
  } catch (err) {
    logWarn(`openresponses: tool configuration failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid tool configuration", type: "invalid_request_error" },
    });
    return true;
  }
  let resolved: ReturnType<typeof resolveGatewayRequestContext>;
  try {
    resolved = resolveGatewayRequestContext({
      req,
      model,
      user,
      sessionPrefix: "openresponses",
      defaultMessageChannel: "webchat",
      useMessageChannelHeader: true,
    });
  } catch (err) {
    if (isUnknownGatewayAgentError(err) || isGatewaySessionKeyOverrideError(err)) {
      sendJson(res, 400, {
        error: { message: err.message, type: "invalid_request_error" },
      });
      return true;
    }
    throw err;
  }
  const responseSessionScope = createResponseSessionScope({
    req,
    auth: opts.auth,
    agentId: resolved.agentId,
  });
  // Resolve session key: reuse previous_response_id only when it matches the
  // same auth-subject/agent/requested-session scope as the current request.
  const previousSessionKey = lookupResponseSession(
    payload.previous_response_id,
    responseSessionScope,
  );
  const sessionKey = previousSessionKey ?? resolved.sessionKey;
  const messageChannel = resolved.messageChannel;

  // Build prompt from input
  const prompt = buildAgentPrompt(payload.input);

  const fileContext = fileContexts.length > 0 ? fileContexts.join("\n\n") : undefined;
  const toolChoiceContext = toolChoicePrompt?.trim();

  // Handle instructions + file context as extra system prompt
  const extraSystemPrompt = [
    payload.instructions,
    prompt.extraSystemPrompt,
    toolChoiceContext,
    fileContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `input`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const responseId = `resp_${randomUUID()}`;
  const rememberResponseSession = () =>
    storeResponseSession(responseId, sessionKey, responseSessionScope);
  const outputItemId = `msg_${randomUUID()}`;
  const deps = createDefaultDeps();
  const abortController = new AbortController();
  const streamMaxTokens =
    typeof payload.max_output_tokens === "number" ? payload.max_output_tokens : undefined;
  const streamTemperature =
    typeof payload.temperature === "number" ? payload.temperature : undefined;
  const streamTopP = typeof payload.top_p === "number" ? payload.top_p : undefined;
  const streamParams =
    streamMaxTokens !== undefined || streamTemperature !== undefined || streamTopP !== undefined
      ? {
          ...(streamMaxTokens !== undefined ? { maxTokens: streamMaxTokens } : {}),
          ...(streamTemperature !== undefined ? { temperature: streamTemperature } : {}),
          ...(streamTopP !== undefined ? { topP: streamTopP } : {}),
        }
      : undefined;

  if (!stream) {
    const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
    try {
      const result = await runResponsesAgentCommand({
        message: prompt.message,
        images,
        clientTools: resolvedClientTools,
        extraSystemPrompt,
        modelOverride,
        streamParams,
        sessionKey,
        runId: responseId,
        messageChannel,
        deps,
        abortSignal: abortController.signal,
      });

      if (abortController.signal.aborted) {
        return true;
      }

      const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
      const usage = extractUsageFromResult(result);
      const meta = (result as { meta?: unknown } | null)?.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);

      // A `required`/pinned `tool_choice` must reject a text-only turn instead
      // of returning ordinary assistant prose, mirroring /v1/chat/completions.
      // Shared satisfaction check lives in openai-tool-choice.ts.
      if (
        toolChoiceConstraint &&
        !isToolChoiceConstraintSatisfied({ constraint: toolChoiceConstraint, pendingToolCalls })
      ) {
        const failed = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: {
            code: "api_error",
            message: resolveUnsatisfiedToolChoiceMessage(toolChoiceConstraint),
          },
          usage,
        });
        const spendResult = await fetchAndPollJdSpend(responseId);
        failed.spendResult = spendResult;
        rememberResponseSession();
        sendJson(res, 502, failed);
        return true;
      }

      // If the agent invoked client tools, return one `function_call`
      // output item per call (in arrival order) plus any assistant text the
      // model produced before the tool calls. Pre-#52288 only the first
      // pending call was emitted, so multi-tool turns lost every call but
      // the leading one.
      if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
        const assistantText =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "";

        const output: OutputItem[] = [];
        if (assistantText) {
          output.push(
            createAssistantOutputItem({
              id: outputItemId,
              text: assistantText,
              phase: "commentary",
              status: "completed",
            }),
          );
        }
        for (const functionCall of pendingToolCalls) {
          output.push(
            createFunctionCallOutputItem({
              id: `call_${randomUUID()}`,
              callId: functionCall.id,
              name: functionCall.name,
              arguments: functionCall.arguments,
            }),
          );
        }

        const response = createResponseResource({
          id: responseId,
          model,
          status: "incomplete",
          output,
          usage,
        });
        const spendResult = await fetchAndPollJdSpend(responseId);
        response.spendResult = spendResult;
        rememberResponseSession();
        sendJson(res, 200, response);
        return true;
      }

      const content =
        Array.isArray(payloads) && payloads.length > 0
          ? payloads
              .map((p) => (typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n")
          : "No response from OpenClaw.";

      const response = createResponseResource({
        id: responseId,
        model,
        status: "completed",
        output: [
          createAssistantOutputItem({
            id: outputItemId,
            text: content,
            phase: "final_answer",
            status: "completed",
          }),
        ],
        usage,
      });

      const spendResult = await fetchAndPollJdSpend(responseId);
      response.spendResult = spendResult;

      rememberResponseSession();
      sendJson(res, 200, response);
    } catch (err) {
      if (abortController.signal.aborted) {
        return true;
      }
      logWarn(`openresponses: non-stream response failed: ${String(err)}`);
      if (isClientToolNameConflictError(err)) {
        const response = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: { code: "invalid_request_error", message: "invalid tool configuration" },
        });
        const spendResult = await fetchAndPollJdSpend(responseId);
        response.spendResult = spendResult;
        sendJson(res, 400, response);
        return true;
      }
      const response = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
      });
      const mapped = resolveOpenAiCompatError(err);
      if (mapped) {
        const mappedResponse = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: {
            code: mapped.error.type,
            message: mapped.error.message,
          },
        });
        const spendResult = await fetchAndPollJdSpend(responseId);
        mappedResponse.spendResult = spendResult;
        rememberResponseSession();
        sendJson(res, mapped.status, mappedResponse);
        return true;
      }
      const spendResult = await fetchAndPollJdSpend(responseId);
      response.spendResult = spendResult;
      rememberResponseSession();
      sendJson(res, 500, response);
    } finally {
      stopWatchingDisconnect();
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming mode
  // ─────────────────────────────────────────────────────────────────────────

  setSseHeaders(res);

  let accumulatedText = "";
  let bufferedReplaceableAssistantContent = "";
  let sawAssistantDelta = false;
  let closed = false;
  let unsubscribe = () => {};
  let stopWatchingDisconnect = () => {};
  let finalUsage: Usage | undefined;
  let finalizeStatus: ResponseResource["status"] | null = null;
  let finalizeRequested: { status: ResponseResource["status"]; text: string } | null = null;

  const maybeFinalize = () => {
    if (closed) {
      return;
    }
    if (!finalizeRequested) {
      return;
    }
    if (!finalUsage) {
      return;
    }
    const usage = finalUsage;

    closed = true;
    stopWatchingDisconnect();
    unsubscribe();

    writeSseEvent(res, {
      type: "response.output_text.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      text: finalizeRequested.text,
    });

    writeSseEvent(res, {
      type: "response.content_part.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: finalizeRequested.text },
    });

    const completedItem = createAssistantOutputItem({
      id: outputItemId,
      text: finalizeRequested.text,
      phase: finalizeRequested.status === "completed" ? "final_answer" : "commentary",
      status: "completed",
    });

    writeSseEvent(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: completedItem,
    });

    const finalResponse = createResponseResource({
      id: responseId,
      model,
      status: finalizeRequested.status,
      output: [completedItem],
      usage,
    });

    rememberResponseSession();
    writeSseEvent(res, { type: "response.completed", response: finalResponse });
    writeDone(res);
    res.end();
  };

  const requestFinalize = (status: ResponseResource["status"], text: string) => {
    if (finalizeRequested) {
      return;
    }
    finalizeStatus = status;
    finalizeRequested = { status, text };
    maybeFinalize();
  };

  // Send initial events
  const initialResponse = createResponseResource({
    id: responseId,
    model,
    status: "in_progress",
    output: [],
  });

  writeSseEvent(res, { type: "response.created", response: initialResponse });
  writeSseEvent(res, { type: "response.in_progress", response: initialResponse });

  // Add output item
  const outputItem = createAssistantOutputItem({
    id: outputItemId,
    text: "",
    status: "in_progress",
  });

  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: outputItem,
  });

  // Add content part
  writeSseEvent(res, {
    type: "response.content_part.added",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== responseId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      if (isReplaceableAssistantStreamEvent(evt)) {
        const snapshot = resolveAssistantStreamSnapshotText(evt);
        if (snapshot) {
          bufferedReplaceableAssistantContent = snapshot;
        }
        return;
      }

      const text = evt.data?.text;
      const replace = evt.data?.replace === true;
      const hadAssistantDelta = sawAssistantDelta;
      if (replace && typeof text === "string") {
        accumulatedText = text;
      }

      const content = resolveAssistantStreamDeltaText(evt);
      if (!content) {
        if (
          replace &&
          typeof text === "string" &&
          text &&
          !toolChoiceConstraint &&
          !hadAssistantDelta
        ) {
          sawAssistantDelta = true;
          writeSseEvent(res, {
            type: "response.output_text.delta",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            delta: text,
          });
        }
        return;
      }

      // Hold assistant prose until the tool-choice contract is confirmed. A
      // `required`/pinned request must reject text-only turns, so streaming
      // deltas now could leak output we may have to fail. Buffered text is
      // still flushed as commentary if a matching tool call arrives, matching
      // the openai-http.ts streaming buffer.
      if (toolChoiceConstraint) {
        accumulatedText += content;
        return;
      }

      sawAssistantDelta = true;
      accumulatedText += content;

      writeSseEvent(res, {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: content,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        const finalText =
          accumulatedText || bufferedReplaceableAssistantContent || "No response from OpenClaw.";
        const finalStatus = phase === "error" ? "failed" : "completed";
        requestFinalize(finalStatus, finalText);
      }
    }
  });

  stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await runResponsesAgentCommand({
        message: prompt.message,
        images,
        clientTools: resolvedClientTools,
        extraSystemPrompt,
        modelOverride,
        streamParams,
        sessionKey,
        runId: responseId,
        messageChannel,
        deps,
        abortSignal: abortController.signal,
      });

      finalUsage = extractUsageFromResult(result);

      // Check for pending client tool calls BEFORE maybeFinalize() because the
      // lifecycle:end event may already have requested finalization.
      const resultAny = result as { payloads?: Array<{ text?: string }>; meta?: unknown };
      const resultPayloadText = Array.isArray(resultAny.payloads)
        ? resultAny.payloads
            .map((p) => (typeof p.text === "string" ? p.text : ""))
            .filter(Boolean)
            .join("\n\n")
        : "";
      const meta = resultAny.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);

      // Reject an unsatisfied `required`/pinned `tool_choice` before any
      // buffered prose is flushed, mirroring the non-streaming path and
      // /v1/chat/completions. Closes the stream with a `response.failed` event.
      if (
        !closed &&
        toolChoiceConstraint &&
        !isToolChoiceConstraintSatisfied({ constraint: toolChoiceConstraint, pendingToolCalls })
      ) {
        const failed = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: {
            code: "api_error",
            message: resolveUnsatisfiedToolChoiceMessage(toolChoiceConstraint),
          },
          usage: finalUsage ?? createEmptyUsage(),
        });
        closed = true;
        stopWatchingDisconnect();
        unsubscribe();
        rememberResponseSession();
        writeSseEvent(res, { type: "response.failed", response: failed });
        writeDone(res);
        res.end();
        return;
      }

      if (
        !closed &&
        stopReason === "tool_calls" &&
        pendingToolCalls &&
        pendingToolCalls.length > 0
      ) {
        const usage = finalUsage ?? createEmptyUsage();
        const finalText =
          accumulatedText || resultPayloadText || bufferedReplaceableAssistantContent;

        if (toolChoiceConstraint && finalText && !sawAssistantDelta) {
          sawAssistantDelta = true;
          writeSseEvent(res, {
            type: "response.output_text.delta",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            delta: finalText,
          });
        }
        writeSseEvent(res, {
          type: "response.output_text.done",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          text: finalText,
        });
        writeSseEvent(res, {
          type: "response.content_part.done",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: finalText },
        });

        const completedItem = createAssistantOutputItem({
          id: outputItemId,
          text: finalText,
          phase: "commentary",
          status: "completed",
        });
        writeSseEvent(res, {
          type: "response.output_item.done",
          output_index: 0,
          item: completedItem,
        });

        // Emit one `function_call` output item per pending call, preserving
        // arrival order. `output_index` continues past the assistant
        // message at index 0 so the SSE stream keeps a single, monotonic
        // index per response. Pre-#52288 the streaming path read only
        // `pendingToolCalls[0]` and hard-coded `output_index: 1`, so a turn
        // with multiple client tool calls dropped every call past the
        // first.
        const functionCallItems: OutputItem[] = [];
        let nextStreamOutputIndex = 1;
        for (const functionCall of pendingToolCalls) {
          const functionCallItemId = `call_${randomUUID()}`;
          const functionCallItem = createFunctionCallOutputItem({
            id: functionCallItemId,
            callId: functionCall.id,
            name: functionCall.name,
            arguments: functionCall.arguments,
          });
          writeSseEvent(res, {
            type: "response.output_item.added",
            output_index: nextStreamOutputIndex,
            item: functionCallItem,
          });
          const completedFunctionCallItem = createFunctionCallOutputItem({
            id: functionCallItemId,
            callId: functionCall.id,
            name: functionCall.name,
            arguments: functionCall.arguments,
            status: "completed",
          });
          writeSseEvent(res, {
            type: "response.output_item.done",
            output_index: nextStreamOutputIndex,
            item: completedFunctionCallItem,
          });
          functionCallItems.push(functionCallItem);
          nextStreamOutputIndex += 1;
        }

        const incompleteResponse = createResponseResource({
          id: responseId,
          model,
          status: "incomplete",
          output: [completedItem, ...functionCallItems],
          usage,
        });
        closed = true;
        stopWatchingDisconnect();
        unsubscribe();
        rememberResponseSession();
        writeSseEvent(res, { type: "response.completed", response: incompleteResponse });
        writeDone(res);
        res.end();
        return;
      }

      // Fallback: if no streaming deltas were received, send the full response as text
      if (!sawAssistantDelta) {
        const content =
          resultPayloadText || bufferedReplaceableAssistantContent || "No response from OpenClaw.";

        accumulatedText = content;
        sawAssistantDelta = true;
        if (finalizeStatus !== null) {
          finalizeRequested = { status: finalizeStatus, text: content };
        }

        writeSseEvent(res, {
          type: "response.output_text.delta",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          delta: content,
        });
      }

      maybeFinalize();
    } catch (err) {
      if (closed || abortController.signal.aborted) {
        return;
      }
      logWarn(`openresponses: streaming response failed: ${String(err)}`);

      finalUsage = finalUsage ?? createEmptyUsage();
      if (isClientToolNameConflictError(err)) {
        const errorResponse = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: { code: "invalid_request_error", message: "invalid tool configuration" },
          usage: finalUsage,
        });

        writeSseEvent(res, { type: "response.failed", response: errorResponse });
        emitAgentEvent({
          runId: responseId,
          stream: "lifecycle",
          data: { phase: "error" },
        });
        return;
      }
      const errorResponse = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
        usage: finalUsage,
      });

      const mapped = resolveOpenAiCompatError(err);
      if (mapped) {
        const mappedResponse = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: {
            code: mapped.error.type,
            message: mapped.error.message,
          },
          usage: finalUsage,
        });
        rememberResponseSession();
        writeSseEvent(res, { type: "response.failed", response: mappedResponse });
        emitAgentEvent({
          runId: responseId,
          stream: "lifecycle",
          data: { phase: "error" },
        });
        return;
      }
      rememberResponseSession();
      writeSseEvent(res, { type: "response.failed", response: errorResponse });
      emitAgentEvent({
        runId: responseId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        // Emit lifecycle end to trigger completion
        emitAgentEvent({
          runId: responseId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}
export { testing as __testing };
