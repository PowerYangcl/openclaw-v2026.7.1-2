/**
 * 网关 chat 错误 → 中文用户友好提示（纯函数，见 `web/tests/chatErrorCopy.test.ts`）。
 *
 * ## 文案从哪来
 * 网关 `state: "error"` 事件透传的 `errorMessage` 是**上游拼好的英文句子**
 * （`src/agents/embedded-agent-helpers/sanitize-user-facing-text.ts` 的分类表），
 * 再被 `src/auto-reply/reply/agent-runner-execution.ts:3474` 包成
 * `⚠️ Agent failed before reply: <inner>.\nLogs: openclaw logs --follow`。
 *
 * ## 为什么不能只看外层（2026-09-17 实测踩坑）
 * 上游 `src/gateway/server-chat.ts:216-224` 只对**裸**文案做中文替换
 * （锁竞争 → 「当前会话正在处理中，请稍后。」）。一旦被 `⚠️ Agent failed before reply:`
 * 包一层，那道替换就漏掉了，前端收到的原文是：
 *
 *   `⚠️ Agent failed before reply: session file changed while embedded prompt lock
 *    was released: /Users/…/sessions/<id>.jsonl.\nLogs: openclaw logs --follow`
 *
 * 旧实现在内层匹配不上任何规则时，一律回落成「助手在回复前失败」——于是**任何**
 * 带 ⚠️ 前缀的上游文案（限流 / 余额 / 上下文超长 / 会话接管…）都会被说成「回复前失败」，
 * 用户既看不懂也拿不到下一步。所以这里：
 *   ① 规则表覆盖上游全部用户可见分类（每条都对应一个真实常量/分支，注释里标了出处）；
 *   ② 剥壳后的内层要再匹配一轮；
 *   ③ 兜底只在**确实**带 `Agent failed before reply:` 包装时才用「助手在回复前失败」，
 *      否则用中性的「生成失败」，不再凭一个 ⚠️ 前缀给人扣帽子。
 */

/** 映射结果：`title` 一句话说清是什么，`detail` 给下一步，`retryable` 决定 toast 停留时长。 */
export type FriendlyError = { title: string; detail: string; retryable: boolean };

/** 每条规则对应上游一个已分类的错误文案（顺序敏感：更具体的放前面）。 */
type ErrorRule = { re: RegExp; title: string; detail: string; retryable: boolean };

/**
 * 上游 `agent-runner-execution.ts:798` 的包装前缀（`⚠️ ` + 这句 + ` <inner>.`）。
 * 只有它出现过，才说明「run 真的在产出回复之前就失败了」。
 */
const AGENT_FAILED_PREFIX_RE = /Agent failed before reply[:：]/i;

/**
 * 会话被别的 run 接管 / 嵌入提示锁竞争 —— `AttemptSessionTakeoverError`
 * （`src/agents/embedded-agent-runner/run/attempt.session-lock.ts:1149`）。
 *
 * 上游把这条归为「当前会话正在处理中，请稍后。」（`server-chat.ts:221`），
 * 但**只在裸文案时**生效；被 ⚠️ 包一层后只剩英文。这条必须放在最前面，
 * 否则它会先被「剥壳」逻辑吃掉再落进兜底标题。
 */
const SESSION_TAKEOVER_RE =
  /session file changed while embedded prompt lock was released|EmbeddedAttemptSessionTakeoverError/i;

/**
 * 「智能体已被移除」—— 网关守卫 `resolveDeletedAgentIdFromSessionKey`
 * （`src/gateway/session-utils.ts:1016`）在 `chat.send` / `sessions.send` / `sessions.steer` /
 * `sessions.resolve` 上抛的 `INVALID_REQUEST`：
 *
 *   Agent "<id>" no longer exists in configuration
 *
 * 判据是 `listAgentIds(cfg)`（`src/agents/agent-scope-config.ts:75`）**只读 `cfg.agents.list`**，
 * 而前端侧栏用的是「配置 ∪ `~/.openclaw/agents/*` 目录」的并集（`gateway/agent-list.ts:31`）——
 * 两者口径不一致时就会出现「侧栏列得出来、一发就报错」。
 *
 * 捕获 id：提示里带上具体是哪个智能体，用户才知道该换哪个。
 */
const DELETED_AGENT_RE = /Agent "([^"]+)" no longer exists in configuration/i;

/** 规则表：英文片段 → 中文提示。 */
const RULES: ErrorRule[] = [
  {
    re: /LLM request failed: connection refused by the provider endpoint\./i,
    title: "模型提供方拒绝连接",
    detail: "可能服务未启动或地址错误，请稍后重试",
    retryable: true,
  },
  {
    re: /LLM request failed: DNS lookup for the provider endpoint failed\./i,
    title: "域名解析失败",
    detail: "无法解析模型提供方地址，请检查网络/DNS 设置",
    retryable: true,
  },
  {
    re: /LLM request failed: the provider endpoint is unreachable from this host\./i,
    title: "模型提供方不可达",
    detail: "当前主机无法访问该端点，请检查网络或代理",
    retryable: true,
  },
  {
    re: /LLM request failed: network connection (was interrupted|error)\./i,
    title: "网络连接失败",
    detail: "模型提供方的连接已断开，请稍后重试",
    retryable: true,
  },
  {
    re: /LLM request failed: provider reported a network error\./i,
    title: "模型提供方上报网络错误",
    detail: "请稍后重试",
    retryable: true,
  },
  {
    re: /LLM request failed: proxy or tunnel configuration blocked the provider request\./i,
    title: "代理配置阻断了请求",
    detail: "请检查代理或隧道设置",
    retryable: false,
  },
  {
    re: /LLM request timed out\./i,
    title: "请求超时",
    detail: "模型提供方响应超时，请重试",
    retryable: true,
  },
  {
    re: /LLM request rate limited\.|API rate limit reached|rate limit reached/i,
    title: "请求频率超限",
    detail: "请稍后重试或降低调用频率",
    retryable: true,
  },
  {
    re: /LLM request unauthorized\./i,
    title: "鉴权失败",
    detail: "API 密钥无效或已过期，请联系管理员",
    retryable: false,
  },
  // `agent-runner-execution.ts:926-929`：网关没配该 provider 的密钥
  {
    re: /Missing API key for (?:provider|the selected provider)/i,
    title: "模型密钥未配置",
    detail: "网关缺少该模型提供方的密钥，请联系管理员配置",
    retryable: false,
  },
  // `sanitize-user-facing-text.ts:43-66` 的 billing 分支
  {
    re: /returned a billing error|run out of credits|insufficient balance/i,
    title: "账户余额/额度不足",
    detail: "模型提供方返回账单错误，请充值或更换密钥后重试",
    retryable: false,
  },
  // `sanitize-user-facing-text.ts:71-72` 的模型容量分支
  {
    re: /model is at capacity/i,
    title: "模型容量已满",
    detail: "当前模型满载，请换一个模型或稍后重试",
    retryable: true,
  },
  // `sanitize-user-facing-text.ts:73-74` 的过载分支
  {
    re: /AI service is temporarily overloaded|service is temporarily unavailable \(HTTP \d+\)/i,
    title: "模型服务暂时繁忙",
    detail: "请稍后重试",
    retryable: true,
  },
  // `agent-runner-execution.ts:3471-3472` / sanitize 的上下文溢出分支
  {
    re: /Context overflow|prompt too large for (?:this|the) model|context window exceeded/i,
    title: "上下文过长",
    detail: "提示词超出该模型的上下文窗口，请缩短消息、开启新会话或换用更大上下文的模型",
    retryable: true,
  },
  // `agent-runner-execution.ts:799 / PREFLIGHT_COMPACTION_FAILURE_PREFIX`
  {
    re: /Preflight compaction required but failed/i,
    title: "上下文压缩失败",
    detail: "开启新会话后重试",
    retryable: true,
  },
  // `agent-runner-execution.ts:3259-3265` 的模型热切换失败
  {
    re: /model switch could not be completed/i,
    title: "模型切换失败",
    detail: "请求的模型可能暂时不可用，请稍后重试或在窗格头换一个模型",
    retryable: true,
  },
  // `sanitize-user-facing-text.ts:498` 流式事件顺序异常
  {
    re: /provider returned an invalid streaming response|malformed fragment/i,
    title: "流式响应异常",
    detail: "模型提供方返回了无效的流式响应，请重试",
    retryable: true,
  },
  // `sanitize-user-facing-text.ts:475-480` 消息顺序冲突
  {
    re: /Message ordering conflict|incorrect role information|roles must alternate/i,
    title: "消息顺序冲突",
    detail: "请重试；若持续出现，请开启新会话",
    retryable: true,
  },
  // `sanitize-user-facing-text.ts:211-226` 磁盘写满
  {
    re: /disk is full|no space left on device|disk full/i,
    title: "本地磁盘空间不足",
    detail: "无法写入会话数据，请清理磁盘后重试",
    retryable: false,
  },
  // `assistant-error-format.ts:227-232`：provider 返回 HTML 错误页（CDN/WAF 拦截）
  {
    re: /returned an HTML error page instead of an API response/i,
    title: "提供方返回了网页错误",
    detail: "通常是 CDN/WAF 拦截了请求，请稍后重试或检查提供方状态",
    retryable: true,
  },
  {
    re: /provider rejected the request schema or tool payload\./i,
    title: "模型提供方拒绝了请求结构",
    detail: "通常是消息体或工具定义与服务端契约不一致，可尝试开启新会话重试",
    retryable: true,
  },
  {
    re: /LLM request failed with an unknown error\./i,
    title: "模型提供方返回未知错误",
    detail: "请稍后重试，问题持续请联系管理员",
    retryable: true,
  },
  {
    re: /AI service returned an internal error/i,
    title: "模型服务内部错误",
    detail: "请稍后重试",
    retryable: true,
  },
  {
    // 兜底分类：failover-matches.test.ts:187 把裸 "LLM request failed." 视为 timeout
    re: /LLM request failed\./i,
    title: "生成失败",
    detail: "请求未在预期时间内完成，请重试",
    retryable: true,
  },
];

/** 命中规则表（按顺序返回第一条命中项）。 */
function matchRules(text: string): FriendlyError | null {
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      return { title: rule.title, detail: rule.detail, retryable: rule.retryable };
    }
  }
  return null;
}

/** 剥掉 `⚠️ ` / `Agent failed before reply: ` 包装与 `Logs: …` / `Please try again…` 尾巴。 */
function stripFailureWrapper(raw: string): string {
  return raw
    .replace(/^⚠️\s*/, "")
    .replace(/Agent failed before reply[:：]\s*/i, "")
    .replace(/\.\s*Logs:.*$/s, "")
    .replace(/\.\s*Please try again.*$/i, "")
    .trim();
}

/**
 * 把上游英文 chat 错误文案映射成中文用户友好提示。
 *
 * 匹配顺序：①已知的中文原文（上游已本地化的）→ ②规则表打原文 → ③剥壳后再打一遍
 * → ④兜底（带包装前缀才算「回复前失败」，否则中性文案）。
 */
export function localizeChatError(raw: string): FriendlyError {
  if (!raw) return { title: "生成失败", detail: "", retryable: true };

  // 上游已经本地化的锁竞争提示（见 server-chat.ts:220 buildChatErrorMessage）
  if (/当前会话正在处理中/.test(raw)) {
    return { title: "当前会话正在处理中，请稍后", detail: "", retryable: false };
  }

  // 会话接管 / 提示锁竞争：裸文案与 ⚠️ 包装两种形态都要能命中（见文件头实测记录）
  if (SESSION_TAKEOVER_RE.test(raw)) {
    return {
      title: "会话正在处理其他任务",
      detail: "本次回复被中断，请稍后重新发送",
      retryable: true,
    };
  }

  // 智能体已被移除：重试永远得到同一个错误 ⇒ retryable=false，并告诉用户下一步该做什么。
  const deletedAgent = DELETED_AGENT_RE.exec(raw);
  if (deletedAgent) {
    return {
      title: "该智能体已不可用",
      detail: `「${deletedAgent[1]}」已不在网关配置的智能体列表里，无法收发消息。请联系管理员把它加回配置，或在左侧目录换一个智能体`,
      retryable: false,
    };
  }

  const direct = matchRules(raw);
  if (direct) return direct;

  // 剥掉 "⚠️ Agent failed before reply: …" / "Logs: …" 包装，对内层再匹配一次
  const stripped = stripFailureWrapper(raw);
  if (stripped && stripped !== raw) {
    const inner = matchRules(stripped);
    if (inner) return inner;
    // 只有真的带过 `Agent failed before reply:` 才说「回复前失败」；
    // 其它 ⚠️ 文案（上游还有几十种）一律中性表述 + 原文，别再误伤。
    return {
      title: AGENT_FAILED_PREFIX_RE.test(raw) ? "助手在回复前失败" : "生成失败",
      detail: stripped,
      retryable: true,
    };
  }
  return { title: "生成失败", detail: raw, retryable: true };
}

/** 把 FriendlyError 拍平成单行 toast 文案：title 在前，detail 换行接在后。 */
export function formatFriendlyError(e: FriendlyError): string {
  return e.detail ? `${e.title}\n${e.detail}` : e.title;
}
