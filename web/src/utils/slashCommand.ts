/**
 * 斜杠指令（`/xxx`）的**纯解析 + 路由表** —— 供 composer 与单测使用。
 *
 * ## 为什么要这一层
 * 网关自己就有一套文本指令（`src/auto-reply/commands-registry.shared.ts` 里
 * `textAlias: "/help"` 这类注册项，由 `src/auto-reply/reply/commands-core.ts:34`
 * 的 `handleCommands` 在**入站文本**上处理）。也就是说：**把 `/help` 当普通消息发出去，
 * 网关会当指令执行、不会交给模型**（判定见 `src/auto-reply/commands-text-routing.ts:40`
 * `shouldHandleTextCommands`：`cfg.commands?.text !== false` 即放行，默认未配置 ⇒ 放行）。
 *
 * 但有几条指令**只能前端自己做**，或者前端做体验明显更好：
 * - `/clear`、`/redirect` 在旧版 Lit 界面里就是 **UI-only**（注册表里根本没有它们的
 *   `textAlias`）⇒ 发出去只会被模型当成一句话；
 * - `/export-session` 网关会把文件落到**服务端磁盘**，用户在浏览器里拿不到；
 *   web 层已有纯前端导出（`exportConversation()`）。
 *
 * 还有几条指令是**产品口径要求禁用**的（`"blocked"`）：
 * - `/new`：本系统只维护一个固定主会话（见 `utils/canonicalSession.ts`）。⚠️ 注意它
 *   **不能靠「从表里删掉」来禁用** —— 下面「表里没有的名字不拦」那条规则会把删掉的
 *   `/new` 原样转发给网关，而网关注册表里**是有 `/new` 的**，结果是真建出一个新会话。
 *
 * 所以这里把指令分三档（`scope`）：
 * - `"local"`：web 层自己执行（见 `ChatPane.vue` 的 `runSlashCommand`）；
 * - `"gateway"`：原样发给网关，由网关的文本指令处理，回复走正常消息流；
 * - `"blocked"`：web 层截获并回一句说明，**绝不外发**（网关那头也不认这件事）。
 *
 * ## ⚠️ 刻意不做候选浮窗
 * 需求明确：**输入 `/` 之后不弹可用指令列表**。所以本模块只做「解析 + 路由」，
 * 不产出任何候选数据，也不监听输入过程；用户必须把指令名打完再回车。
 * 想查有哪些指令就发 `/help`。
 *
 * ## ⚠️ 表里没有的名字**不拦**
 * 本表只是「常用子集 + 需要前端自己执行的条目」，**不是网关指令全集**：插件可以在
 * 运行时往注册表里加指令，网关也能通过配置增删。所以调用方的口径必须是
 * 「命中且 `scope === "local"` 才本地执行，其余**一律原样发给网关**」——
 * 对未登记的名字回一句「未知指令」会把网关其实支持的指令一起打死。
 *
 * ## 与旧版 Lit 界面的关系
 * 旧版是「命令面板（浮窗候选）+ 客户端执行」两件事；这里只搬**执行/路由**那一半，
 * 面板那一半按需求去掉。指令清单取自同一份注册表，避免两边漂移。
 */

/** 指令由谁执行。 */
export type SlashCommandScope =
  /** web 层自己执行（不经过网关）。 */
  | "local"
  /** 原样发给网关，由网关的文本指令处理。 */
  | "gateway"
  /**
   * 已禁用：web 层截获并回一句说明，**绝不外发**。
   *
   * ⚠️ 不能改成「从表里删掉」—— 删掉会命中下面「表里没有的名字不拦」的规则，
   * 指令会被原样发给网关，而网关很可能真的认这条指令（`/new` 就是这种）。
   */
  | "blocked";

export type SlashCommandCategory = "session" | "model" | "status" | "tools" | "agents";

export type SlashCommandDef = {
  /** 规范名（不含 `/`，小写）。 */
  name: string;
  /** 别名（不含 `/`，小写）。 */
  aliases?: string[];
  /** 参数占位符，仅用于 `/help` 展示。 */
  args?: string;
  description: string;
  scope: SlashCommandScope;
  category: SlashCommandCategory;
  /** `scope: "blocked"` 时给用户看的说明（为什么不能用）。 */
  disabledReason?: string;
};

/**
 * 指令表。
 *
 * `scope: "gateway"` 的条目**必须**能在网关注册表里找到同名 `textAlias`，否则发出去
 * 只会被模型当成一句普通话（这正是本表存在的意义：把「发出去没用」的指令挡下来）。
 * 对应关系见每条后面的注释。
 */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  // ── web 层本地执行 ──────────────────────────────────────────────────
  {
    name: "help",
    description: "查看可用指令",
    scope: "local",
    category: "status",
  },
  {
    name: "stop",
    description: "停止当前正在生成的回复",
    scope: "local",
    category: "session",
  },
  {
    name: "clear",
    description: "清空当前会话的历史（同时重置网关侧会话）",
    scope: "local",
    category: "session",
  },
  {
    // ⚠️ 已禁用（产品口径：本系统只维护一个固定主会话）。**必须保留在表里**，
    // 见文件头「表里没有的名字不拦」那条 —— 删掉它反而会被转发给网关真建会话。
    name: "new",
    description: "开一个全新会话（已禁用）",
    scope: "blocked",
    category: "session",
    disabledReason: "本系统只维护一个主会话，不再新建会话。",
  },
  {
    name: "export-session",
    aliases: ["export"],
    description: "把当前会话导出为 Markdown 文件",
    scope: "local",
    category: "session",
  },
  {
    name: "redirect",
    args: "<消息>",
    description: "打断当前回复，并用新消息重新开始",
    scope: "local",
    category: "session",
  },
  {
    // ⚠️ 别名 `tell` 已去掉：网关注册表里只有 `/steer`，`/tell` 是本表凭空造的
    // 名字，用户在任何别处都查不到它。本地指令只保留「与网关同名或网关有同义别名」
    // 的写法，不自造新词汇。
    name: "steer",
    description: "给正在进行的回复发一条引导，不中断整轮",
    args: "[消息]",
    scope: "local",
    category: "session",
  },
  {
    name: "model",
    args: "[provider/model]",
    description: "查看或切换本会话使用的模型（不带参数则打开选择器）",
    scope: "local",
    category: "model",
  },

  // ── 交给网关（均有同名 textAlias，见 src/auto-reply/commands-registry.shared.ts）──
  // ⚠️ 别名**只能写注册表里真实存在的**（注册表用 `textAliases: [...]` 声明的那些：
  // `/btw`+`/side`、`/export-session`+`/export`、`/export-trajectory`+`/trajectory`、
  // `/plugins`+`/plugin`）。别凭印象补 `/t`、`/v`、`/thinking`、`/reason`、`/id`
  // 这类「看起来应该有」的短别名 —— 网关不认，用户按 `/help` 打出来只会得到一句
  // 模型回复（本表把「发出去没用」的指令挡下来的意义正是如此）。
  { name: "status", description: "查看当前会话/运行状态", scope: "gateway", category: "status" },
  { name: "usage", args: "[mode]", description: "用量与费用统计", scope: "gateway", category: "status" },
  { name: "context", description: "说明上下文是如何拼装与消耗的", scope: "gateway", category: "status" },
  { name: "whoami", description: "查看你的发送者 id", scope: "gateway", category: "status" },
  { name: "commands", description: "列出网关侧全部斜杠指令", scope: "gateway", category: "status" },
  { name: "diagnostics", description: "输出运行时诊断信息", scope: "gateway", category: "status" },
  { name: "config", args: "[路径]", description: "查看 / 修改网关配置", scope: "gateway", category: "status" },
  { name: "login", description: "管理登录 / 凭据", scope: "gateway", category: "status" },
  { name: "debug", args: "[mode]", description: "切换调试输出", scope: "gateway", category: "status" },
  { name: "trace", args: "[mode]", description: "切换链路追踪输出", scope: "gateway", category: "status" },

  { name: "reset", description: "重置当前会话（保留会话本身）", scope: "gateway", category: "session" },
  { name: "name", args: "[标题]", description: "给当前会话命名 / 改名", scope: "gateway", category: "session" },
  { name: "compact", args: "[说明]", description: "压缩当前会话的上下文", scope: "gateway", category: "session" },
  { name: "session", args: "[action]", description: "查看 / 调整当前会话设置", scope: "gateway", category: "session" },
  { name: "queue", args: "[mode]", description: "调整发送队列策略", scope: "gateway", category: "session" },
  { name: "send", args: "[mode]", description: "设置回复发送策略（on / off / inherit）", scope: "gateway", category: "session" },
  { name: "activation", args: "[mode]", description: "设置群聊激活方式（mention / always）", scope: "gateway", category: "session" },

  { name: "think", args: "[level]", description: "设置思考等级", scope: "gateway", category: "model" },
  { name: "verbose", args: "[mode]", description: "切换详细输出模式", scope: "gateway", category: "model" },
  { name: "fast", args: "[mode]", description: "切换快速模式", scope: "gateway", category: "model" },
  { name: "reasoning", args: "[mode]", description: "切换推理过程可见性", scope: "gateway", category: "model" },
  { name: "models", args: "[provider]", description: "列出可用的模型供应商 / 模型", scope: "gateway", category: "model" },
  { name: "elevated", args: "[mode]", description: "切换提权执行模式", scope: "gateway", category: "model" },

  { name: "agents", description: "列出当前会话绑定 / 可用的 agent", scope: "gateway", category: "agents" },
  { name: "subagents", args: "[action]", description: "查看子代理运行情况", scope: "gateway", category: "agents" },
  { name: "acp", args: "[action]", description: "管理 ACP 接入的智能体", scope: "gateway", category: "agents" },
  { name: "focus", args: "[目标]", description: "把某个 agent / 会话设为焦点", scope: "gateway", category: "agents" },
  { name: "unfocus", description: "取消焦点设置", scope: "gateway", category: "agents" },

  { name: "tools", args: "[mode]", description: "列出可用工具", scope: "gateway", category: "tools" },
  { name: "skill", args: "<name> [input]", description: "按名字执行一个 skill", scope: "gateway", category: "tools" },
  { name: "learn", args: "[路径]", description: "把一份文档 / 知识装进技能库", scope: "gateway", category: "tools" },
  { name: "tasks", description: "列出当前会话的后台任务", scope: "gateway", category: "tools" },
  { name: "approve", description: "批准 / 拒绝待授权的执行请求", scope: "gateway", category: "tools" },
  { name: "goal", args: "[action] [text]", description: "查看或控制当前目标", scope: "gateway", category: "tools" },
  { name: "btw", aliases: ["side"], args: "[问题]", description: "问一个不影响主线的旁支问题", scope: "gateway", category: "tools" },
  { name: "export-trajectory", aliases: ["trajectory"], args: "[目录]", description: "导出会话的 JSONL 轨迹包（落到服务端磁盘）", scope: "gateway", category: "tools" },
  { name: "tts", args: "[action]", description: "控制语音合成（TTS）", scope: "gateway", category: "tools" },
  { name: "allowlist", args: "[action]", description: "查看 / 维护命令白名单", scope: "gateway", category: "tools" },
  { name: "mcp", args: "[action]", description: "查看 / 管理 MCP 服务", scope: "gateway", category: "tools" },
  { name: "plugins", aliases: ["plugin"], args: "[action]", description: "查看 / 管理插件", scope: "gateway", category: "tools" },
  { name: "crestodian", args: "[action]", description: "运行内置的会话巡检器", scope: "gateway", category: "tools" },
  { name: "exec", args: "<命令>", description: "在会话工作目录里执行一条命令", scope: "gateway", category: "tools" },
  { name: "bash", args: "<命令>", description: "在 shell 里执行一条命令", scope: "gateway", category: "tools" },
  { name: "restart", description: "重启 OpenClaw", scope: "gateway", category: "tools" },
];

/** 指令名合法形态（与旧版 Lit 界面 `REMOTE_SLASH_IDENTIFIER_PATTERN` 同口径）。 */
const SLASH_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** 按规范名 + 别名建索引（小写）。 */
const COMMAND_INDEX: ReadonlyMap<string, SlashCommandDef> = (() => {
  const index = new Map<string, SlashCommandDef>();
  for (const command of SLASH_COMMANDS) {
    index.set(command.name, command);
    for (const alias of command.aliases ?? []) index.set(alias, command);
  }
  return index;
})();

export type SlashCommandInvocation = {
  /** 规范名（小写、别名已归一）。**未知指令时保留用户输入的原始名（小写）**。 */
  name: string;
  /** 用户实际输入的指令名（小写），用于「未知指令」提示里回显。 */
  rawName: string;
  /** 指令名之后的全部内容（已 trim）。 */
  args: string;
  /** 命中的指令定义；未知指令为 `undefined`。 */
  command: SlashCommandDef | undefined;
};

/**
 * 把输入解析成一次指令调用；不是指令形态时返回 `null`。
 *
 * 返回 `null` 的几种情况（都交给普通发送路径，不要吞掉）：
 * - 不是以 `/` 开头；
 * - 只有一个 `/`（没有指令名）；
 * - 指令名含非法字符（例如 `/Users/xxx`、`/怎么弄`）—— 这类更可能是用户真要说的正文。
 *
 * ⚠️ 指令名要求第一个字符是**字母或数字**，所以以 `/` 开头的路径（`/Users/...`）
 * 不会被误判成指令。
 */
export function parseSlashCommand(input: unknown): SlashCommandInvocation | null {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw.startsWith("/")) return null;
  const body = raw.slice(1);
  if (!body) return null;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return null;
  const rawName = (match[1] ?? "").toLowerCase();
  if (!SLASH_NAME_RE.test(rawName)) return null;
  const args = (match[2] ?? "").trim();
  const command = COMMAND_INDEX.get(rawName);
  return { name: command?.name ?? rawName, rawName, args, command };
}

/** 按名字（含别名）取指令定义，大小写不敏感。 */
export function resolveSlashCommand(name: unknown): SlashCommandDef | undefined {
  const key = typeof name === "string" ? name.trim().toLowerCase() : "";
  return key ? COMMAND_INDEX.get(key) : undefined;
}

/** 该名字是否是**已登记**的指令（含别名）。 */
export function isKnownSlashCommand(name: unknown): boolean {
  return resolveSlashCommand(name) !== undefined;
}

/** 是否是 web 层自己执行的指令。未知指令返回 `false`（调用方另行处理）。 */
export function isLocalSlashCommand(name: unknown): boolean {
  return resolveSlashCommand(name)?.scope === "local";
}

/**
 * 该指令是否由 web 层**截获**（本地执行 or 已禁用）—— 这两种都**不发网关**。
 *
 * 调用方（composer）必须用这个判据，而不是 `isLocalSlashCommand`：只看 `local`
 * 会把 `blocked` 漏给网关，正是 `/new` 会重新建会话的那条路。
 * 未知指令（插件动态注册的）仍返回 `false` ⇒ 原样外发，不误杀网关能力。
 */
export function isInterceptedSlashCommand(name: unknown): boolean {
  const scope = resolveSlashCommand(name)?.scope;
  return scope === "local" || scope === "blocked";
}

const CATEGORY_LABELS: Record<SlashCommandCategory, string> = {
  session: "会话",
  model: "模型",
  status: "状态",
  tools: "工具",
  agents: "智能体",
};

const CATEGORY_ORDER: readonly SlashCommandCategory[] = ["session", "model", "status", "tools", "agents"];

/**
 * `/help` 的正文（Markdown，按分类分组）。
 *
 * 刻意**不带**「输入 / 打开指令菜单」这类提示 —— 本实现没有候选浮窗（需求明确），
 * 写了会让用户去找一个不存在的面板。
 */
export function formatSlashCommandHelp(): string {
  const lines: string[] = ["**可用指令**"];
  for (const category of CATEGORY_ORDER) {
    // `blocked`（已禁用）不进清单：列出来只会让用户去试一条注定被拒的指令。
    const commands = SLASH_COMMANDS.filter(
      (command) => command.category === category && command.scope !== "blocked",
    );
    if (commands.length === 0) continue;
    lines.push("");
    lines.push(`**${CATEGORY_LABELS[category]}**`);
    for (const command of commands) {
      const usage = command.args ? ` ${command.args}` : "";
      const alias = command.aliases?.length
        ? `（别名 ${command.aliases.map((item) => `/${item}`).join("、")}）`
        : "";
      lines.push(`- \`/${command.name}${usage}\` — ${command.description}${alias}`);
    }
  }
  lines.push("");
  lines.push("直接输入指令后回车即可；也可以把指令名打完再补参数，例如 `/model deepseek/deepseek-chat`。");
  return lines.join("\n");
}
