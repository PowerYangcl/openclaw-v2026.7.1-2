/**
 * 智能体（agent）状态。
 *
 * 对应上游 `ui/src/lib/agents/index.ts` 的 `agents.state.agentsList` +
 * `ui/src/lib/agents/identity.ts` 的 `agentIdentity` 能力，以及
 * `ui/src/app/config.ts` 里的 `assistantIdentity`（对话页的「助手名称 + 头像」）。
 *
 * 数据来源：
 * - `agents.list` → agent 列表（名称 / emoji / 头像 / 描述由 identity 承载）
 * - `agent.identity.get` → 单个 agent 的最终身份（含运行时覆盖的头像地址）
 *
 * 对话页用 `assistantName` / `assistantAvatar` 渲染消息气泡旁的头像与名字，
 * 二级目录用 `agents` 渲染 agent 行（头像 + 名称 + 描述）。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useSettingsStore } from "@/stores/settings";
import type { AgentIdentityResult, AgentsListResult, GatewayAgentRow } from "@/api/types";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "@/utils/sessionKey";
import { resolveAgentDisplayName } from "@/utils/avatar";
import { resolveAgentQuickStart } from "@/utils/quickStart";
import { resolveSessionDisplayName } from "@/utils/sessionDisplay";
import { readSidebarSnapshot, writeSidebarSnapshot } from "@/utils/sidebarSnapshot";

/** agent.identity.get 的返回（缺字段时按可选处理）。 */
type AgentIdentityResponse = Partial<AgentIdentityResult> & { agentId?: string };

/** `ensureIdentities()` 的并发上限（见函数注释）。 */
const IDENTITY_FETCH_CONCURRENCY = 4;

export const useAgentsStore = defineStore("agents", () => {
  const gateway = useGatewayStore();
  const settings = useSettingsStore();

  /**
   * 首屏就用「上次见到的 agent 列表」渲染，避免 `agents.list` 还没回来时侧栏只剩
   * 「当前会话兜底」一行（表现为「左侧菜单只有当前选中的那条」）。
   * `loaded` 刻意仍为 `false`，所以 `ensureLoaded()` 照常会去拉最新数据并整表替换。
   */
  const bootstrap = readSidebarSnapshot(settings.gatewayUrl);

  const agents = ref<GatewayAgentRow[]>(bootstrap?.agents ?? []);
  const defaultId = ref<string>(bootstrap?.defaultId ?? "");
  const mainKey = ref<string>(bootstrap?.mainKey ?? "main");
  const scope = ref<string>("");
  const loading = ref(false);
  const loaded = ref(false);

  /**
   * agentId → 运行时身份（`agent.identity.get` 的结果），失败/未取到则不落缓存。
   *
   * 首屏从本地快照 hydrate：`agents.list` 的行里**没有** `name`/`avatar`
   * （实测只有 `id/workspace/agentRuntime/model`），侧栏的名称与图标全靠这份 identity。
   * 不 hydrate 的话首屏会先画「名称首字母」（本机实测 t=80ms 是 `M`），
   * identity 回来后翻转成真实头像（t=250ms 变 `🐾`）—— 视觉上「icon 闪一下才对」。
   */
  const identities = ref<Record<string, AgentIdentityResult>>(bootstrap?.identities ?? {});

  /**
   * 来自本地快照、**尚未**与网关核对过的 identity id。
   *
   * 它们可以立刻用于渲染（stale-while-revalidate），但 `ensureIdentity()` 不能把它们
   * 当成「已有缓存」直接返回 —— 否则用户在网关侧改了头像后，这个 tab 永远不会刷新。
   * 取到新值后即从本集合移除。
   */
  const hydratedIdentityIds = new Set<string>(Object.keys(bootstrap?.identities ?? {}));

  const identityInflight = new Map<string, Promise<AgentIdentityResult | null>>();

  /**
   * 当前会话（`settings.sessionKey`）归属的 agentId。
   * 会话 key 带 `agent:` 前缀时取前缀里的 agentId，否则回落到网关默认 agent。
   *
   * ⚠️ 回落链里**不要**放裸 `settings.sessionKey`：它是 `id-<hash8>` 或 `main` 这种
   * **会话** key，不是 agentId。混进来会让 `selectedAgentId` 变成一个匹配不到任何 agent
   * 的字符串 → 侧栏 agent 行的 `--active` 高亮丢失（尤其在 `agents.list` 还没回来的首屏）。
   */
  const selectedAgentId = computed<string>(() => {
    const parsed = parseAgentSessionKey(settings.sessionKey);
    const fallback = defaultId.value.trim() || DEFAULT_AGENT_ID;
    return normalizeAgentId(parsed?.agentId ?? fallback);
  });

  /** 当前选中的 agent 行（没匹配到时回落到默认 agent / 第一项）。 */
  const selectedAgent = computed<GatewayAgentRow | null>(() => {
    const id = selectedAgentId.value;
    return (
      agents.value.find((agent) => normalizeAgentId(agent.id) === id) ??
      agents.value.find((agent) => normalizeAgentId(agent.id) === normalizeAgentId(defaultId.value)) ??
      agents.value[0] ??
      null
    );
  });

  /** 当前 agent 的运行时身份（可能为 null，未加载时用 agent 行兜底）。 */
  const selectedIdentity = computed<AgentIdentityResult | null>(
    () => identities.value[selectedAgentId.value] ?? null,
  );

  /**
   * 对话页展示的助手名称。
   *
   * 链：运行时身份（跳过网关泛化默认名 `Assistant`）> agent 行的 name/identity.name > **agent id**。
   * ⚠️ 泛化默认名不算名字：预发 8 个 agent 里有 7 个没有配置身份，网关统一回 `Assistant`，
   * 旧实现直接采信 ⇒ 侧栏与窗格标题出现 7 个同名 `Assistant`。
   */
  const assistantName = computed<string>(() =>
    resolveAgentDisplayName({
      agentId: selectedAgentId.value,
      agent: selectedAgent.value,
      identity: selectedIdentity.value,
    }),
  );

  /**
   * 对话页展示的助手头像**原始值**（图片路径 / URL / emoji / 文字）。
   *
   * 刻意不在 store 里预先判断「是图片还是文字」：网关返回的图片头像可能是
   * `/avatar/<agentId>`（能直接给 `<img>`），也可能是未转换的 fs 路径；
   * 统一交给 `ChatAvatar` 按最终形态判定（它内建了完整降级链），
   * 避免这里过早过滤把「本地头像」整条路径丢掉。
   */
  const assistantAvatar = computed<string>(() => {
    const runtime = selectedIdentity.value;
    const row = selectedAgent.value;
    return (
      (runtime?.avatar ?? "").trim() ||
      (runtime?.emoji ?? "").trim() ||
      (row?.identity?.avatar ?? "").trim() ||
      (row?.emoji ?? "").trim() ||
      ""
    );
  });

  /** 头像归因状态（`local` 表示由网关 `/avatar/<agentId>` 提供）。 */
  const assistantAvatarStatus = computed<string | null>(
    () => selectedIdentity.value?.avatarStatus?.trim() || null,
  );

  /** 当前 agent 的 id（用于把 fs 路径回退成 `/avatar/<agentId>`）。 */
  const assistantAvatarAgentId = computed<string>(() => selectedAgentId.value);

  // ---------------------------------------------------------------------------
  // 按 agentId 取身份 —— 拆分视图「多 agent 同时对话」的地基
  //
  // 上面那组 `assistant*` / `selectedAgentId` 都**绑定全局选中 agent**（派生自
  // `settings.sessionKey`），只适用于「整个页面只有一个对话」的单窗格场景。
  // 拆分视图下必须能「按任意 agentId 取身份」，否则所有窗格会一起显示活动窗格的
  // agent。下面这组函数就是为此提供的，语义与对应 computed 完全一致。
  // ---------------------------------------------------------------------------

  /** 指定 agent 的运行时身份（未加载 / 未知 agent 时为 `null`）。 */
  function identityForAgent(agentId: string): AgentIdentityResult | null {
    return identities.value[normalizeAgentId(agentId)] ?? null;
  }

  /**
   * 从会话 key 推导它归属的 agentId。
   *
   * 拆分视图下每个窗格的会话 key 自带 `agent:<id>:` 前缀（`agent:cel4:main`），
   * 所以**每个窗格都能独立算出自己的 agent**。
   *
   * ⚠️ 绝不能改用 `selectedAgentId`：它派生自全局 `settings.sessionKey`，只代表
   * **活动窗格**；用它会让所有窗格一起显示活动窗格的 agent —— 这正是「窗格之间
   * 互相影响」的根因（左窗格明明是 `agent:cel4:main`，标题和头像却是学习辅导员）。
   *
   * 会话 key 没有 agent 前缀时（裸 `main` / `id-<hash8>`）回落到网关默认 agent，
   * 与 `selectedAgentId` 的回落口径保持一致。
   */
  function agentIdForSession(sessionKey: string | null | undefined): string {
    const raw = typeof sessionKey === "string" ? sessionKey.trim() : "";
    // 回落链里**不要**放裸 sessionKey：它是会话 key 不是 agentId（同 selectedAgentId 的说明）。
    const fallback = defaultId.value.trim() || DEFAULT_AGENT_ID;
    return normalizeAgentId(parseAgentSessionKey(raw)?.agentId ?? fallback);
  }

  /**
   * 指定 agent 的展示名（链与 `assistantName` 完全一致，见其注释）：
   * 运行时身份（非泛化）> agent 行 > **agent id**。
   */
  function nameForAgent(agentId: string): string {
    const id = normalizeAgentId(agentId);
    return resolveAgentDisplayName({
      agentId: id,
      agent: agentById(id),
      identity: identityForAgent(id),
    });
  }

  /**
   * 指定 agent 的头像**原始值**（图片路径 / URL / emoji / 文字）。
   *
   * 与 `assistantAvatar` 一样刻意不预先判定「图片还是文字」：网关返回的图片头像
   * 可能是 `/avatar/<agentId>`，也可能是未转换的 fs 路径，统一交给 `ChatAvatar`
   * 按最终形态判定（它内建了完整降级链）。
   */
  function avatarForAgent(agentId: string): string {
    const id = normalizeAgentId(agentId);
    const runtime = identityForAgent(id);
    const row = agentById(id);
    return (
      (runtime?.avatar ?? "").trim() ||
      (runtime?.emoji ?? "").trim() ||
      (row?.identity?.avatar ?? "").trim() ||
      (row?.emoji ?? "").trim() ||
      ""
    );
  }

  /** 指定 agent 的头像归因状态（`local` 表示由网关 `/avatar/<agentId>` 提供）。 */
  function avatarStatusForAgent(agentId: string): string | null {
    return identityForAgent(agentId)?.avatarStatus?.trim() || null;
  }

  /**
   * 会话 key → 窗格头下拉里的展示名。
   *
   * `resolveSessionDisplayName` 对 `agent:<id>:main` 这类**没有 label / displayName**
   * 的会话会原样返回 key，下拉里就显示成 `agent:cel4:main` 这种不可读的裸 key。
   * 这里在它之上补一层兜底：**只有当拿到的是裸 key 时**才去掉 `agent:<id>:` 前缀、
   * 把主会话收敛成「主会话」。网关给了 label / displayName 的会话完全不受影响。
   */
  function sessionDisplayNameFor(
    sessionKey: string,
    row?: Parameters<typeof resolveSessionDisplayName>[1],
  ): string {
    const name = resolveSessionDisplayName(sessionKey, row);
    if (name !== sessionKey) return name;
    const parsed = parseAgentSessionKey(sessionKey);
    if (!parsed) return name;
    const rest = parsed.rest.trim();
    if (!rest || rest === "main" || rest === mainKey.value) return "主会话";
    return rest;
  }

  /**
   * 加载 agent 列表（幂等；`force` 时强制刷新）。
   *
   * 返回的是**本次真实加载**的 promise：并发调用共享同一个（`inflightLoad`），
   * 已加载过则立即 resolve。调用方可以安全地 `.finally()` 来判断「首次加载是否已落定」——
   * 若只依赖 `loading` 短路（早返回），调用方会以为加载已经结束，于是在数据到位前
   * 就把骨架屏换成空列表。
   */
  let inflightLoad: Promise<void> | null = null;

  function ensureLoaded(force = false): Promise<void> {
    if (inflightLoad) return inflightLoad;
    if (loaded.value && !force) return Promise.resolve();
    loading.value = true;

    const task = (async (): Promise<void> => {
      try {
        const res = await gateway.request<AgentsListResult>("agents.list", {});
        agents.value = Array.isArray(res?.agents) ? res.agents : [];
        defaultId.value = typeof res?.defaultId === "string" ? res.defaultId : "";
        mainKey.value = typeof res?.mainKey === "string" ? res.mainKey : "main";
        scope.value = typeof res?.scope === "string" ? res.scope : "";
        loaded.value = true;
        // 落盘快照：下次首屏直接渲染完整菜单（见 utils/sidebarSnapshot.ts）
        writeSidebarSnapshot(settings.gatewayUrl, {
          agents: agents.value,
          defaultId: defaultId.value,
          mainKey: mainKey.value,
        });
        // 列表就绪后补齐**所有** agent 的运行时身份（头像/名称的最终来源）。
        // 只取当前选中的那一个会让侧栏其余行永远停在裸 id —— 因为 `agents.list`
        // 的行里没有 `name`/`avatar`，且没有任何地方会为「没被点过」的 agent 拉 identity。
        void ensureIdentities(agents.value.map((agent) => String(agent.id ?? "")));
      } catch {
        // 静默降级：agent 列表拿不到时，对话页用兜底名称 + 角色默认头像。
      } finally {
        loading.value = false;
        inflightLoad = null;
      }
    })();

    inflightLoad = task;
    return task;
  }

  /**
   * 一次性补齐一批 agent 的运行时身份（侧栏渲染完列表后调用）。
   *
   * 为什么要批量：侧栏每一行的名称/图标都来自 identity，而 `agents.list` 的行里
   * 没有这两个字段。只给「当前选中」的 agent 拉 identity，其余行会一直显示裸 id
   * （`main`）加「首字母头像」——直到用户点过它们为止。
   *
   * 并发限制 4：agent 数量通常很少（个位数），但不做限制会在成规模部署上打出
   * 一连串 RPC。已缓存 / 未过期的调用在 `ensureIdentity` 里立即返回，所以重复调用廉价。
   */
  async function ensureIdentities(agentIds: Array<string | null | undefined>): Promise<void> {
    const ids = Array.from(
      new Set(agentIds.map((agentId) => normalizeAgentId(agentId ?? "")).filter((id) => Boolean(id))),
    );
    for (let i = 0; i < ids.length; i += IDENTITY_FETCH_CONCURRENCY) {
      const batch = ids.slice(i, i + IDENTITY_FETCH_CONCURRENCY);
      await Promise.all(batch.map((id) => ensureIdentity(id).catch(() => null)));
    }
  }

  /** 取某个 agent 的运行时身份（带内存缓存与并发去重）。 */
  async function ensureIdentity(agentId: string): Promise<AgentIdentityResult | null> {
    const id = normalizeAgentId(agentId);
    if (!id) return null;
    const cached = identities.value[id];
    // ⚠️ snapshot hydrate 来的值只能用于渲染，不能当缓存短路 —— 必须向网关确认一次。
    if (cached && !hydratedIdentityIds.has(id)) return cached;
    const inflight = identityInflight.get(id);
    if (inflight) return inflight;

    const task = (async (): Promise<AgentIdentityResult | null> => {
      try {
        const res = await gateway.request<AgentIdentityResponse | null>("agent.identity.get", {
          agentId: id,
        });
        if (!res || typeof res !== "object") return null;
        const identity: AgentIdentityResult = {
          agentId: typeof res.agentId === "string" ? res.agentId : id,
          name: typeof res.name === "string" ? res.name : "",
          avatar: typeof res.avatar === "string" ? res.avatar : "",
          emoji: typeof res.emoji === "string" ? res.emoji : undefined,
          avatarStatus: typeof res.avatarStatus === "string" ? res.avatarStatus : undefined,
          avatarReason: typeof res.avatarReason === "string" ? res.avatarReason : undefined,
        };
        identities.value = { ...identities.value, [id]: identity };
        hydratedIdentityIds.delete(id);
        // 落盘快照：下次首屏直接用真实头像/名称渲染，不再先画错的首字母。
        writeSidebarSnapshot(settings.gatewayUrl, { identities: identities.value });
        return identity;
      } catch {
        // 网关未实现该方法 / 权限不足 —— 静默降级到 agent 行里的身份字段。
        // 保留 snapshot hydrate 的值（它比没有强），下次调用再重试。
        return null;
      } finally {
        identityInflight.delete(id);
      }
    })();

    identityInflight.set(id, task);
    return task;
  }

  /** 按 id 找 agent 行。 */
  function agentById(agentId: string): GatewayAgentRow | null {
    const id = normalizeAgentId(agentId);
    return agents.value.find((agent) => normalizeAgentId(agent.id) === id) ?? null;
  }

  /**
   * 指定 agent 的**快捷开场白**（`agents.list` 行里的 `quickStart`）。
   *
   * 数据来源：网关按 agent workspace 里的 `agent-config.json` 的 `quickStart` 注入
   * （`src/gateway/session-utils.ts:1370 readAgentQuickStart`，调用点 `:1348`）。
   *
   * 判定口径全部在 `utils/quickStart.ts` 里（对齐旧版 Lit 界面的
   * `ui/src/pages/chat/chat-pane.ts:1049 resolveSameAgentQuickStart` +
   * `ui/src/pages/chat/components/chat-welcome.ts:44 resolveSuggestionTexts`），
   * 这里只负责**按 id 找到行**并转交 —— 不再自己写过滤逻辑，避免两处口径漂移。
   *
   * 按 `agentId` 取而不是读全局选中 agent：拆分视图下每个窗格要用**自己**的 agent
   * 的开场白（同 `identityForAgent` / `nameForAgent` 的拆分视图口径）。
   */
  function quickStartForAgent(agentId: string): string[] | undefined {
    return resolveAgentQuickStart(agentById(agentId));
  }

  return {
    agents,
    defaultId,
    mainKey,
    scope,
    loading,
    loaded,
    identities,
    selectedAgentId,
    selectedAgent,
    selectedIdentity,
    assistantName,
    assistantAvatar,
    assistantAvatarStatus,
    assistantAvatarAgentId,
    // 拆分视图用：按 agentId 取身份（见各自函数上的说明）
    agentIdForSession,
    identityForAgent,
    nameForAgent,
    avatarForAgent,
    avatarStatusForAgent,
    sessionDisplayNameFor,
    ensureLoaded,
    ensureIdentity,
    ensureIdentities,
    agentById,
    quickStartForAgent,
  };
});
