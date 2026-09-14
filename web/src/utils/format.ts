import dayjs from "dayjs";

/** 时间戳格式化为本地可读字符串。 */
export function formatTime(ts?: number | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 时间戳格式化为 `YYYY-MM-DD HH:MM:ss`（用于 hover 复制按钮左侧的紧凑时间戳）。
 * 不用 zh-CN locale 是为了拿到 ASCII 分隔符（`-` / `:`），便于等宽对齐。
 */
export function formatDateTimeMinute(ts?: number | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
  return dayjs(ts).format("YYYY-MM-DD HH:mm:ss");
}

/** 相对时间（多久之前）。 */
export function formatRelative(ts?: number | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "-";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatTime(ts);
}

/**
 * 侧边栏会话行用的紧凑相对时间（仿目标页 `formatSidebarTimestamp`）：
 * 刚刚 / 12分 / 3时 / 5天 / MM-DD。
 */
export function formatSidebarTime(ts?: number | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天`;
  const date = new Date(ts);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 毫秒时长格式化。 */
export function formatDuration(ms?: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes}m ${restSeconds}s`;
}

/** 金额格式化。 */
export function formatCost(usd?: number | null): string {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "-";
  return `$${usd.toFixed(4)}`;
}

/** 大数字紧凑显示。 */
export function formatCount(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
