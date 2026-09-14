/**
 * 会话 key / agent 归属工具。
 *
 * 移植自 `ui/src/lib/sessions/session-key.ts` 与 `ui/src/lib/session-display.ts`，
 * 只保留本项目需要的部分。用途：
 * - 从 sessionKey 里解析出 agentId（`agent:<agentId>:<rest>`）；
 * - 判断某个会话是否归属当前选中的 agent（二级目录按 agent 过滤会话行）；
 * - 过滤掉 cron / subagent / global 这类不该出现在「最近会话」里的行。
 */

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

export type ParsedAgentSessionKey = { agentId: string; rest: string };

/** 非空字符串才作数（与上游 normalizeOptionalString 语义一致）。 */
export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `agent:<agentId>:<rest>` → `{ agentId, rest }`；不合法返回 null。 */
export function parseAgentSessionKey(sessionKey?: string | null): ParsedAgentSessionKey | null {
  const raw = (normalizeOptionalString(sessionKey) ?? "").toLowerCase();
  if (!raw) return null;
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") return null;
  const agentId = normalizeOptionalString(parts[1]);
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) return null;
  return { agentId, rest };
}

/** agentId 归一化：无法通过宽松校验时做字符清洗，仍为空则回落默认 agent。 */
export function normalizeAgentId(value?: string | null): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return DEFAULT_AGENT_ID;
  if (VALID_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function normalizeMainKey(value?: string | null): string {
  return normalizeOptionalString(value)?.toLowerCase() ?? DEFAULT_MAIN_KEY;
}

/** 构造某 agent 的主会话 key：`agent:<agentId>:<mainKey>`。 */
export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | null;
}): string {
  return `agent:${normalizeAgentId(params.agentId)}:${normalizeMainKey(params.mainKey)}`;
}

/** 从会话 key 里取 agentId；非 agent 形态的 key 一律视作默认 agent。 */
export function resolveAgentIdFromSessionKey(sessionKey?: string | null): string {
  return normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId ?? DEFAULT_AGENT_ID);
}

/** 子 agent 会话（`subagent:` 前缀）不应出现在二级目录里。 */
export function isSubagentSessionKey(sessionKey?: string | null): boolean {
  const raw = normalizeOptionalString(sessionKey) ?? "";
  if (!raw) return false;
  if (raw.toLowerCase().startsWith("subagent:")) return true;
  return (parseAgentSessionKey(raw)?.rest ?? "").toLowerCase().startsWith("subagent:");
}

/** cron 会话不应出现在二级目录里。 */
export function isCronSessionKey(sessionKey?: string | null): boolean {
  const normalized = (normalizeOptionalString(sessionKey) ?? "").toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("cron:")) return true;
  if (!normalized.startsWith("agent:")) return false;
  const parts = normalized.split(":").filter(Boolean);
  if (parts.length < 3) return false;
  return parts.slice(2).join(":").startsWith("cron:");
}

/**
 * 会话是否归属指定 agent。
 * 非 agent 形态的 key（如裸 `main`）只在目标是默认 agent 时算归属。
 */
export function isSessionKeyTiedToAgent(
  sessionKey: string | undefined | null,
  agentId: string,
  defaultAgentId: string = DEFAULT_AGENT_ID,
): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed) return normalizeAgentId(parsed.agentId) === normalizeAgentId(agentId);
  return normalizeAgentId(agentId) === normalizeAgentId(defaultAgentId);
}

/** 会话 key 等价判断（裸 `main` 视为默认 agent 的主会话别名）。 */
export function areUiSessionKeysEquivalent(
  left: string | undefined | null,
  right: string | undefined | null,
): boolean {
  const normalize = (value?: string | null): string => {
    const raw = (normalizeOptionalString(value) ?? "").toLowerCase();
    if (!raw) return "";
    return raw === DEFAULT_MAIN_KEY
      ? buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID, mainKey: DEFAULT_MAIN_KEY })
      : raw;
  };
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}
