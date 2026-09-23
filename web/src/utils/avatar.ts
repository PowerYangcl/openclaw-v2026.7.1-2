/**
 * 头像 / 名称解析工具。
 *
 * 移植自上游：
 * - `ui/src/lib/avatar.ts`（isRenderableControlUiAvatarUrl / resolveAssistantTextAvatar）
 * - `ui/src/lib/agents/display.ts`（normalizeAgentLabel / resolveAgentTextAvatar）
 * - `ui/src/pages/chat/chat-avatar.ts`（withChatAvatarToken）
 * - `ui/src/app/user-identity.ts`（resolveLocalUserName / resolveLocalUserAvatarText）
 *
 * 这些函数是纯函数，不依赖任何框架，便于在 Vue 组件里复用。
 */

/** 可渲染的头像地址：data:image/* 或站内绝对路径（但排除 `//` 协议相对地址）。 */
const CONTROL_UI_AVATAR_URL_RE = /^(data:image\/|\/(?!\/))/i;
/** 文本头像里的不可见控制字符（零宽、方向控制符等），命中则拒绝渲染。 */
const UNSAFE_TEXT_AVATAR_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

export const DEFAULT_ASSISTANT_NAME = "Assistant";
export const DEFAULT_ASSISTANT_AVATAR = "A";

type AgentLike = {
  id?: string;
  name?: string;
  identity?: {
    name?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
    avatarStatus?: string;
  };
};

type AgentIdentityLike = {
  name?: string;
  avatar?: string;
  emoji?: string;
  /** `agent.identity.get` 返回：`local` 表示头像由网关托管的本地文件提供。 */
  avatarStatus?: string;
} | null | undefined;

export function isRenderableControlUiAvatarUrl(value: string): boolean {
  return CONTROL_UI_AVATAR_URL_RE.test(value);
}

/**
 * 判断一个字符串能否当「文本头像」展示（例如 emoji 或单个字母）。
 * 返回 null 表示不可用，调用方应回落到图片头像或角色默认图标。
 */
export function resolveAssistantTextAvatar(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed === DEFAULT_ASSISTANT_AVATAR) return null;
  if (trimmed.startsWith("blob:") || isRenderableControlUiAvatarUrl(trimmed)) return null;
  if (
    trimmed.length > 8 ||
    /\s/.test(trimmed) ||
    /[\\/.:]/.test(trimmed) ||
    UNSAFE_TEXT_AVATAR_CHARS.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/** agent 展示名：`name` > `identity.name` > `id`。 */
export function normalizeAgentLabel(agent: AgentLike): string {
  const name = typeof agent.name === "string" ? agent.name.trim() : "";
  if (name) return name;
  const identityName = typeof agent.identity?.name === "string" ? agent.identity.name.trim() : "";
  if (identityName) return identityName;
  return agent.id ?? "";
}

/**
 * 网关的**泛化默认名**。
 *
 * `resolveAssistantIdentity`（`src/gateway/assistant-identity.ts:103-105`）在某个 agent
 * 既没有配置身份、也没有工作区身份文件时，会回落到全局默认名 `Assistant`
 * （`DEFAULT_ASSISTANT_IDENTITY`）。它**不是**任何 agent 的真实名字：把它当名字用，
 * 侧栏与窗格标题里所有 agent 会一起显示成 `Assistant`
 * （用户预发实测：8 行 = `[年间, Assistant × 7]`）。
 */
export function isGenericAssistantName(value: string | null | undefined): boolean {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === DEFAULT_ASSISTANT_NAME;
}

/**
 * agent 展示名的**唯一**解析链（侧栏行 / 窗格标题 / 输入框占位符 / 消息头像共用）。
 *
 * 优先级：
 *   ① `identity.name`（运行时身份，来自 `agent.identity.get`）——**跳过泛化默认名**；
 *   ② 调用方直接给出的名字（侧栏行名、组件的 `name` prop）；
 *   ③ `agents.list` 行自带的 `name` > `identity.name`；
 *   ④ **该 agent 自己的 id**（没有任何名字时的兜底命名）；
 *   ⑤ 前面都空（理论上不会）：运行时名 → 全局默认名。
 *
 * 为什么必须有 ④：网关只认配置里声明的名字，没配就只能给泛化默认名；
 * 展示层宁可用 id（`thesis-writing-mentor`）也不能让一批 agent 同名，
 * 否则用户无法分辨谁是谁，也无法判断窗格绑定的是哪个 agent。
 */
export function resolveAgentDisplayName(params: {
  agentId?: string | null;
  /** 调用方已解析出的名字（侧栏行名 / 组件 prop），可为空。 */
  name?: string | null;
  agent?: AgentLike | null;
  identity?: AgentIdentityLike;
}): string {
  const runtimeName = typeof params.identity?.name === "string" ? params.identity.name.trim() : "";
  if (runtimeName && !isGenericAssistantName(runtimeName)) return runtimeName;
  const explicit = typeof params.name === "string" ? params.name.trim() : "";
  if (explicit && !isGenericAssistantName(explicit)) return explicit;
  const own = params.agent ? normalizeAgentLabel(params.agent) : "";
  if (own) return own;
  // ⚠️ 这里**不能**用 `normalizeAgentId()`：它对空值会回落成 `main`
  // （`utils/sessionKey.ts:39-41`），于是「谁都不是」的输入会被错标成默认 agent。
  const id = typeof params.agentId === "string" ? params.agentId.trim() : "";
  if (id) return id;
  return explicit || runtimeName || DEFAULT_ASSISTANT_NAME;
}

/**
 * agent 的展示名：**运行时身份优先**，但泛化默认名不算名字。
 *
 * 必要性：`agents.list` 的行里常常没有 `name`（实测本机只有 `id/workspace/model`），
 * 真正的名字来自 `agent.identity.get`（本机 `main` → `"年间"`）。只调
 * `normalizeAgentLabel(agent)` 会退化成裸 id —— 侧栏显示 `main`、聊天页头显示 `年间`，
 * 同一实体两个名字。
 */
export function resolveAgentLabel(
  agent: AgentLike | null | undefined,
  agentIdentity?: AgentIdentityLike,
): string {
  return resolveAgentDisplayName({ agentId: agent?.id, agent, identity: agentIdentity });
}

/**
 * ⚠️ 故意**不**提供 `resolveAgentAvatarUrl(agent)` 这类「先过滤出图片候选」的函数。
 *
 * 上游 `ui/src/lib/avatar.ts` 有它，本项目移植时也写过一版，但它只认「URL 形态」的候选
 * （`isRenderableControlUiAvatarUrl`）。网关返回的头像可能是 `/avatar/<id>`（能过）
 * 也可能是 fs 路径 / emoji（过不了），一旦漏过就被**整条丢掉**，连文本头像也不尝试
 * —— 表现为「头像空着」。改用 `resolveAgentAvatarValue`（原样交下去）+ `ChatAvatar`
 * 按最终形态判定，调用方零判断。
 */

/** agent 的文本头像：`identity.emoji` > `identity.avatar` > 运行时 identity 的同名字段。 */
export function resolveAgentTextAvatar(
  agent: AgentLike,
  agentIdentity?: AgentIdentityLike,
): string | null {
  const candidates = [
    agent.identity?.emoji,
    agent.identity?.avatar,
    agentIdentity?.emoji,
    agentIdentity?.avatar,
  ];
  for (const candidate of candidates) {
    const text = resolveAssistantTextAvatar(candidate);
    if (text) return text;
  }
  return null;
}

/**
 * agent 头像的**原始值**（图片路径 / URL / emoji / 文字，不预先分类），
 * 直接交给 `ChatAvatar` 自行判定「图片 → 文本 → 首字母 → 角色图标」。
 *
 * 为什么不再由调用方提前拆成「图片链 + 文本链」：旧实现先过一遍「只认 URL 形态」的
 * 过滤器，而网关返回的头像可能是 `/avatar/<agentId>`（能过）也可能是 fs 路径 / emoji
 * （过不了），一旦漏过就被整条丢掉，连文本头像也不会尝试 —— 表现为「头像空着」。
 * 现在把原始值交下去，由组件按最终形态决定，调用方零判断。
 */
export function resolveAgentAvatarValue(
  agent: AgentLike,
  agentIdentity?: AgentIdentityLike,
): string {
  const candidates = [
    agentIdentity?.avatar,
    agentIdentity?.emoji,
    agent.identity?.avatar,
    agent.identity?.emoji,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value) return value;
  }
  return "";
}

/** agent 图片头像的归因状态（`agent.identity.get` 的 `avatarStatus`）。 */
export function resolveAgentAvatarStatus(
  agentIdentity?: AgentIdentityLike,
): string | null {
  const status = typeof agentIdentity?.avatarStatus === "string"
    ? agentIdentity.avatarStatus.trim()
    : "";
  return status || null;
}

/**
 * 站内头像经 HTTP 直出时需要拼上网关鉴权 token（否则 401 破图）。
 * 仅对以 `/` 开头的本地路径生效；data: / blob: / 远程 URL 原样返回。
 *
 * 注意：**不要**给远端 URL 补 token —— 那会把网关凭据泄露给第三方。
 */
export function withChatAvatarToken(
  url: string,
  token: string | null | undefined,
): string {
  const value = typeof url === "string" ? url.trim() : "";
  if (!value) return value;
  const secret = typeof token === "string" ? token.trim() : "";
  if (!secret) return value;
  // 只给「站内相对路径」补：`http(s)://` 可能是外部地址，补 token 等于外泄凭据。
  if (!value.startsWith("/") || value.startsWith("//")) return value;
  return appendQueryToken(value, secret);
}

/**
 * 追加 `?token=` / `&token=`。
 *
 * ⚠️ 与 `withChatAvatarToken` 的区别：本函数**不判断**地址形态，调用方必须已经确认
 * 目标是我们自己构造出来的网关地址。存在的理由见 `resolveAvatarImageSrc` 的注释。
 */
function appendQueryToken(url: string, token: string): string {
  if (!url || !token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * 服务器本地文件系统路径（而不是「URL 路径」）。
 *
 * 为什么必须区分：网关配置里的 avatar 可以是 workspace 相对路径 / `~` 路径 /
 * 绝对路径（见 `src/agents/identity-avatar.ts`），这类值**不能**直接给浏览器 ——
 * 浏览器会把它当站内 URL 去请求（`/Users/xx/avatar.png` → 404）。
 * 网关对 `local` 类型的头像会改用 `/avatar/<agentId>` 暴露，前端要跟着走那条路。
 */
const FILESYSTEM_PATH_RE =
  /^\/(?:Users|home|root|private|var|tmp|opt|etc|usr|mnt|Volumes|System|Library|Applications|srv|data)\//i;

export function looksLikeFilesystemPath(value: string | null | undefined): boolean {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return false;
  if (v.startsWith("file://")) return true;
  if (FILESYSTEM_PATH_RE.test(v)) return true;
  return /^[a-z]:[\\/]/i.test(v); // Windows 盘符
}

/**
 * 由网关 **WebSocket** 地址推导「网关 HTTP 源（+ base path）」。
 *
 * 头像 `/avatar/<id>`、助手媒体 `/__openclaw__/assistant-media` 都由**网关的 HTTP
 * 服务**提供，而前端可能跑在另一个源（例如 Vite dev server 5273 vs 网关 18789）。
 * 不做这一步，浏览器就会把这些路径解析到前端自己的源上 → 404 → 头像/音频全部加载失败。
 *
 * 实测（网关 2026.7.1）：这些路由**不带 CORS 响应头**，OPTIONS 直接 404，
 * 所以跨源 `fetch` 一定失败 —— 只能用 `<img src>` / `<audio src>` 直出。
 *
 * @example resolveGatewayHttpBase("ws://127.0.0.1:18789") === "http://127.0.0.1:18789"
 * @example resolveGatewayHttpBase("wss://host/openclaw/") === "https://host/openclaw"
 */
export function resolveGatewayHttpBase(
  gatewayUrl: string | null | undefined,
  pageHref?: string | null,
): string {
  const raw = typeof gatewayUrl === "string" ? gatewayUrl.trim() : "";
  if (!raw) return "";
  const match = /^(wss?|https?):\/\/([^/?#]+)(\/[^?#]*)?/i.exec(raw);
  if (!match) return "";
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!;
  // 保留 base path（网关可挂在子路径下），去掉尾部斜杠
  const path = (match[3] ?? "").replace(/\/+$/, "");
  let httpScheme = scheme === "wss" || scheme === "https" ? "https" : "http";
  let resolvedHost = host;

  // 混合内容兜底：页面是 HTTPS 而推导结果是 HTTP 时，头像 / 附件下载会被浏览器拦
  // （控制台 "was loaded over an insecure connection ... should be served over HTTPS"）。
  // 只在**同源**时升级 —— 跨源明文网关是用户显式指定的，升级会直接连不上；
  // 而同源却降级成 http，只可能是网关地址里写死了 ws://（登录页手输 / 入口链接带入）。
  const page = parsePageOrigin(pageHref ?? defaultPageHref());
  if (httpScheme === "http" && page && page.protocol === "https:" && sameHostname(host, page.host)) {
    httpScheme = "https";
    // 未显式给端口或给的是 80：直接用页面 origin（TLS 终止在 LB 上时端口就是 443）。
    // 显式给了非 80 端口（如 18789）说明网关就在这个端口上，保留。
    const port = portOfHost(host);
    resolvedHost = port && port !== "80" ? host : page.host;
  }

  return `${httpScheme}://${resolvedHost}${path}`;
}

/** 测试/SSR 下没有 `window`，返回 null 表示「不参与升级判断」。 */
function defaultPageHref(): string | null {
  try {
    return typeof window === "undefined" ? null : window.location.href;
  } catch {
    return null;
  }
}

/** 取页面的协议与 host（含端口）；无法解析时返回 null。 */
function parsePageOrigin(href: string | null | undefined): { protocol: string; host: string } | null {
  const value = typeof href === "string" ? href.trim() : "";
  if (!value) return null;
  try {
    const url = new URL(value);
    return { protocol: url.protocol, host: url.host };
  } catch {
    return null;
  }
}

/** `[::1]:18789` / `host:80` / `host` → 主机名部分（比较用，小写不敏感）。 */
function hostnameOfHost(host: string): string {
  const value = host.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end >= 0 ? value.slice(0, end + 1) : value;
  }
  const colon = value.lastIndexOf(":");
  return colon >= 0 ? value.slice(0, colon) : value;
}

function portOfHost(host: string): string {
  const value = host.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end >= 0 && value[end + 1] === ":" ? value.slice(end + 2) : "";
  }
  const parts = value.split(":");
  return parts.length === 2 ? parts[1] ?? "" : "";
}

function sameHostname(a: string, b: string): boolean {
  const left = hostnameOfHost(a).toLowerCase();
  const right = hostnameOfHost(b).toLowerCase();
  return left.length > 0 && left === right;
}

/**
 * 把站内路径拼成绝对地址。
 * - 已经是 `http(s)://` 的原样返回；
 * - `base` 为空时返回原路径（兜底：同源部署下也能工作）。
 */
export function resolveGatewayAssetUrl(
  base: string | null | undefined,
  path: string,
): string {
  const value = typeof path === "string" ? path.trim() : "";
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("data:") || value.startsWith("blob:")) {
    return value;
  }
  const normalizedBase = (typeof base === "string" ? base.trim() : "").replace(/\/+$/, "");
  if (!normalizedBase) return value;
  return value.startsWith("/") ? `${normalizedBase}${value}` : `${normalizedBase}/${value}`;
}

/**
 * 图片头像最终 `<img src>`。
 *
 * 与旧实现的差别：旧版把 `/avatar/<id>` 当**同源相对路径**用（真机上那是网关的
 * 路由，不是前端的），于是破图；这里统一解析成网关源上的绝对地址，并只对
 * 「我们构造出来的网关地址」补 token（远端 URL 绝不补，避免凭据外泄）。
 *
 * ⚠️ **补 token 必须在绝对化之后**。踩过的坑：先 `resolveGatewayAssetUrl` 得到
 * `http://gw/avatar/main`，再交给只认「以 `/` 开头」的 `withChatAvatarToken` —— 开头
 * 已经变成 `http`，守卫直接 return，token 被静默丢掉 → 网关 401 → 破图，
 * 而请求 URL 在 Network 面板里看起来「源是对的」，非常难查。所以这里用
 * `appendQueryToken`（不判形态），只在**已经确认是站内地址**的分支里调用。
 *
 * @returns 可直接用于 `<img src>` 的地址；空串表示「不是图片头像」。
 */
export function resolveAvatarImageSrc(params: {
  raw?: string | null;
  gatewayBaseUrl?: string | null;
  token?: string | null;
  /** 网关 `agent.identity.get` 的 `avatarStatus`：`local` 说明是网关托管的本地文件。 */
  status?: string | null;
  /** 归属 agent，用于在拿到 fs 路径时回退到 `/avatar/<agentId>` 路由。 */
  agentId?: string | null;
}): string {
  const raw = typeof params.raw === "string" ? params.raw.trim() : "";
  if (!raw) return "";
  if (raw.startsWith("blob:") || raw.startsWith("data:")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;

  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  const isLocal = params.status === "local";
  const secret = typeof params.token === "string" ? params.token.trim() : "";
  const avatarRoute = `/avatar/${encodeURIComponent(agentId)}`;

  /** 站内头像路由 → 网关源绝对地址 → 补 token（顺序不能颠倒，见上）。 */
  const toGatewayAvatarUrl = (routePath: string): string =>
    appendQueryToken(resolveGatewayAssetUrl(params.gatewayBaseUrl, routePath), secret);

  if (looksLikeFilesystemPath(raw)) {
    // fs 路径不能给浏览器（会被当成站内 URL → 404）；网关用 /avatar/<agentId> 暴露它
    if (!agentId) return "";
    return toGatewayAvatarUrl(avatarRoute);
  }

  // `//host/x` 是协议相对地址，绝不能补 token
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return toGatewayAvatarUrl(raw);
  }

  // 既不是 URL 也不是路径：agent 声明头像在本地但值不可用 → 走 agent 路由兜底
  if (isLocal && agentId) {
    return toGatewayAvatarUrl(avatarRoute);
  }
  return "";
}

/** 本地用户名称（本项目未做用户身份配置，仅用于兜底文案）。 */
export function resolveLocalUserName(
  input?: { name?: string | null } | null,
  fallback = "你",
): string {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  return name || fallback;
}

/** 本地用户文本头像（图片地址在 web 端无鉴权通道，故只认文本头像）。 */
export function resolveLocalUserAvatarText(
  input?: { avatar?: string | null } | null,
): string | null {
  const avatar = typeof input?.avatar === "string" ? input.avatar.trim() : "";
  if (!avatar) return null;
  if (isRenderableControlUiAvatarUrl(avatar) || avatar.startsWith("blob:")) return null;
  return avatar.length <= 16 ? avatar : null;
}
