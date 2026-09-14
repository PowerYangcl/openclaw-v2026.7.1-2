/**
 * 会话展示名解析。
 *
 * 移植自 `ui/src/lib/session-display.ts` 的 `parseSessionKey` /
 * `resolveSessionDisplayName`：优先用网关给的 `label` / `displayName`，
 * 都没有时按 sessionKey 的形态生成可读兜底名（Main Session / Telegram · xxx 等）。
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
};

const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
    const channel = directMatch[1];
    const identifier = directMatch[2];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} · ${identifier}` };
  }
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    const channel = groupMatch[1];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} 群组` };
  }
  for (const channel of KNOWN_CHANNEL_KEYS) {
    if (key === channel || key.startsWith(`${channel}:`)) {
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

  if (label && label !== key) return applyTypedPrefix(label);
  if (displayName && displayName !== key) return applyTypedPrefix(displayName);
  return fallbackName;
}
