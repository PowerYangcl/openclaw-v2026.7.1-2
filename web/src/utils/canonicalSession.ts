/**
 * 会话口径：**每个 agent 只维护一条「规范主会话」**，入口默认落在
 * `agent:resume-assistant:main`。
 *
 * ## 要消除的现象（改动的真正目标）
 * 旧口径下 `stores/settings.ts` 用**入口 token 指纹**派生会话 key（`id-<hash8>`）：
 * 同一个 agent 名下于是同时存在 `agent:cet4:main` 与 `agent:cet4:id-4daf4b7d`
 * （本机 `~/.openclaw/agents/cet4/sessions/sessions.json` 实测就有这两条）。
 * 每换一次入口 token 就多一条，历史越攒越多，地址栏里也会出现 `?session=agent:cet4:id-4daf4b7d`
 * 这种既不可读、也不是「主会话」的标识。
 *
 * ## 现在的规则
 * 1. 会话 key **只允许**规范主会话形态 `agent:<agentId>:<mainKey>`；
 *    任何来源（URL 入参、localStorage 旧值、token 派生）的 key 都经
 *    `canonicalMainSessionKey()` 归一 —— 不是「优先取主会话」，而是**其它形态直接改写**。
 * 2. 入口默认会话 = `agent:resume-assistant:main`（`DEFAULT_AGENT_SESSION_KEY`）：
 *    带 `#token=` 的静默登录、直接访问落地页，地址栏就是这个值。
 * 3. **侧栏点击仍可切换 agent**（切换到该 agent 的规范主会话）——
 *    切的是「哪条主会话」，而不是「新建一条会话」。
 *
 * ⚠️ 本文件是这条口径的**唯一常量来源**：别在别处硬编码
 * `agent:resume-assistant:main`，也别在别处 `sessions.create`（`/new` 已禁用）。
 */
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "@/utils/sessionKey";

/** 入口默认会话 key（地址栏首屏就是它）。 */
export const DEFAULT_AGENT_SESSION_KEY = "agent:resume-assistant:main";

/** 入口默认会话归属的 agentId（从 key 解析，避免两处硬编码漂移）。 */
export const ENTRY_AGENT_ID = resolveAgentIdFromSessionKey(DEFAULT_AGENT_SESSION_KEY);

/**
 * 把任意会话 key 归一成「该 agent 的规范主会话」。
 *
 * - `agent:<id>:<别的 rest>`（含 `id-<hash8>` / `cron:...` / 子会话）→ `agent:<id>:<mainKey>`；
 * - 裸 key（`main` / `id-xxxxxxxx`）：取不到 agent 归属 ⇒ 落到入口默认 agent；
 * - 空值同理。
 *
 * `mainKey` 由调用方传入网关的 `agents.mainKey`（缺省 `main`）。
 */
export function canonicalMainSessionKey(candidate?: string | null, mainKey?: string | null): string {
  const raw = typeof candidate === "string" ? candidate.trim() : "";
  const parsed = raw ? parseAgentSessionKey(raw) : null;
  return buildAgentMainSessionKey({
    agentId: parsed?.agentId ?? ENTRY_AGENT_ID,
    mainKey,
  });
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
 * 地址栏的 `session` 查询参数是否需要改写（缺失 / 空 / 不是规范主会话）。
 *
 * ⚠️ 只有「要改写」时才 `router.replace`：切 agent 是**用户动作**，
 * 那种情况走 `push`（保留后退）；这里是「把异常值拉回规范」的兜底，不该进历史。
 */
export function needsSessionQueryNormalize(
  current: unknown,
  mainKey?: string | null,
): boolean {
  return !isCanonicalMainSessionKey(typeof current === "string" ? current : "", mainKey);
}

/** 入口落地路径（`entryLandingPath()` / 登录后跳转共用）。 */
export function entryChatPath(): string {
  return `/chat?session=${DEFAULT_AGENT_SESSION_KEY}`;
}
