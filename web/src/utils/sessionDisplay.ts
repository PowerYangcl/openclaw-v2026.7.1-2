/**
 * 会话展示名解析。
 *
 * 移植自 `ui/src/lib/session-display.ts` 的 `parseSessionKey` /
 * `resolveSessionDisplayName`：优先用网关给的 `label` / `displayName`，
 * 都没有时按 sessionKey 的形态生成可读兜底名（主会话 / Telegram · xxx 等）。
 *
 * 相对上游的两处**本地化改造**（web 端渠道会话要能被认出来，见文件底部注释）：
 *   1. 渠道表补上微信系（`openclaw-weixin` / `wechat` / `weixin`）。
 *   2. 裸联系人 key（`<id>@im.<channel>`）与网关填的**原始联系人 id** 也能给出可读名。
 */
import { normalizeOptionalString } from "@/utils/sessionKey";

const CHANNEL_LABELS: Record<string, string> = {
  imessage: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
  // 微信系。⚠️ 网关侧的渠道 id 是**插件名** `openclaw-weixin`（实测
  // `sessions.list` 的 `origin.provider` / `deliveryContext.channel` 都是它），
  // 会话 key 里还可能写成 `wechat` / `weixin`；`wecom` 是预留的企业微信。
  wechat: "微信",
  weixin: "微信",
  "openclaw-weixin": "微信",
  wecom: "企业微信",
  "openclaw-wecom": "企业微信",
};

const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

/**
 * 这个字符串是不是**已知渠道段**（`wechat` / `telegram` / `openclaw-weixin`…）。
 *
 * 给调用方判「某个会话 key 的 rest 段是渠道而不是主会话标记」用 —— 例如窗格头
 * 在把主会话改写成 agent 名之前，必须先排除 `agent:<id>:wechat` 这种**渠道会话键**，
 * 否则渠道行会被误改成 agent 名。渠道清单只在本文件维护，别在调用方再抄一份。
 */
export function isKnownChannelSegment(value: string): boolean {
  return KNOWN_CHANNEL_KEYS.includes(value.trim().toLowerCase());
}

/**
 * 裸渠道联系人 key：`o9cq802Wwly5Q2a-jZ90V3y0lxrE@im.wechat`。
 *
 * 这是微信这类渠道的**历史形态**会话 key —— 没有 `agent:<id>:` 前缀，
 * 也没有 `:<channel>:` 段，渠道只能从 `@im.<channel>` 后缀读出来。
 * 用户截图里窗格下拉的第一行就是这种 key。
 *
 * ⚠️ 渠道段必须命中 `CHANNEL_LABELS`（见 `matchBareChannelHandle`）：
 * 否则 `user@example.com` 这类普通邮箱也会被当成渠道联系人 id。
 */
const BARE_CHANNEL_HANDLE = /^([^@\s]+)@(?:im\.)?([a-z0-9_-]+)$/i;

/** 匹配裸渠道联系人 key；渠道段不认识时返回 null（避免误伤邮箱/域名）。 */
function matchBareChannelHandle(key: string): { identifier: string; channel: string } | null {
  const match = key.match(BARE_CHANNEL_HANDLE);
  if (!match) return null;
  const channel = match[2].toLowerCase();
  if (!KNOWN_CHANNEL_KEYS.includes(channel)) return null;
  return { identifier: match[1], channel };
}

/**
 * 该值是否是「渠道原始联系人 id」而不是人写的会话标题。
 *
 * 网关对渠道会话会把 `label` / `displayName` 填成原始 id
 * （实测微信会话：`displayName = "o9cq802Wwly5Q2a-jZ90V3y0lxrE@im.wechat"`），
 * 直接展示就是给用户看一串乱码。识别出来后才好改走按渠道推导的可读名。
 *
 * 只认 `xxx@im.<channel>` 这一类**带渠道后缀**的 id：普通的用户名/标题
 * （哪怕恰好和会话 id 同名）不会命中，避免误伤其它渠道的人名标题。
 */
export function isRawChannelHandle(value: string | null | undefined): boolean {
  const raw = normalizeOptionalString(value) ?? "";
  return raw.length > 0 && matchBareChannelHandle(raw) !== null;
}

function channelLabel(channel: string): string {
  const key = channel.toLowerCase();
  return CHANNEL_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function parseSessionKey(key: string): { prefix: string; fallbackName: string } {
  const normalized = key.toLowerCase();
  if (key === "main" || key === "agent:main:main") {
    return { prefix: "", fallbackName: "主会话" };
  }
  if (key.includes(":subagent:")) {
    return { prefix: "Subagent:", fallbackName: "子智能体会话" };
  }
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    return { prefix: "Cron:", fallbackName: "定时任务" };
  }
  const directMatch = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (directMatch) {
    return { prefix: "", fallbackName: `${channelLabel(directMatch[1])} · ${directMatch[2]}` };
  }
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    return { prefix: "", fallbackName: `${channelLabel(groupMatch[1])} 群组` };
  }
  // 裸联系人 key（无 agent 前缀、无渠道段）：`<id>@im.<channel>`。
  const bare = matchBareChannelHandle(key);
  if (bare) {
    return { prefix: "", fallbackName: `${channelLabel(bare.channel)} · ${bare.identifier}` };
  }
  for (const channel of KNOWN_CHANNEL_KEYS) {
    if (key === channel || normalized.startsWith(`${channel}:`)) {
      return { prefix: "", fallbackName: `${CHANNEL_LABELS[channel]} 会话` };
    }
  }
  return { prefix: "", fallbackName: key };
}

export function resolveSessionDisplayName(
  key: string,
  row?: { label?: string; displayName?: string } | null,
): string {
  const label = normalizeOptionalString(row?.label) ?? "";
  const displayName = normalizeOptionalString(row?.displayName) ?? "";
  const { prefix, fallbackName } = parseSessionKey(key);

  const applyTypedPrefix = (name: string): string => {
    if (!prefix) return name;
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
    return pattern.test(name) ? name : `${prefix} ${name}`;
  };

  // 网关给的 label / displayName 优先 —— **但原始联系人 id 除外**（见
  // `isRawChannelHandle`）：那种值对用户没有信息量，按渠道推导更可读。
  const usable = (value: string): boolean =>
    Boolean(value) && value !== key && !isRawChannelHandle(value);
  if (usable(label)) return applyTypedPrefix(label);
  if (usable(displayName)) return applyTypedPrefix(displayName);
  return fallbackName;
}
