/**
 * 连接错误 → 「人能看懂 + 知道下一步该干什么」的文案。
 *
 * 网关返回的错误码（`ConnectErrorDetailCodes`）是给机器看的：直接把
 * `AUTH_TOKEN_MISMATCH` / `CONTROL_UI_ORIGIN_NOT_ALLOWED` 原样贴到界面上，用户
 * 只能一脸茫然地刷新。这里按错误码给出**标题 + 可操作步骤**（对齐旧版
 * `ui/src/lib/connect-error.ts` 的做法），登录页与主布局共用同一套口径。
 *
 * 未收录的错误码会退化成「原始 message + 错误码」，不会丢信息。
 */

import { ConnectErrorDetailCodes } from "@/api/protocol";
import type { GatewayErrorInfo } from "@/api/gateway";

export type ConnectErrorAdvice = {
  /** 一句话说清「出了什么事」。 */
  title: string;
  /** 可操作的下一步（没有就省略）。 */
  detail?: string;
};

const BY_CODE: Record<string, ConnectErrorAdvice> = {
  [ConnectErrorDetailCodes.AUTH_TOKEN_MISSING]: {
    title: "网关要求令牌，但当前没有提供",
    detail: "在网关地址下方填写 token，或改用设备身份配对。",
  },
  [ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH]: {
    title: "网关令牌不正确",
    detail: "检查 token 是否复制完整、是否与目标网关一致；修改后重新连接。",
  },
  [ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID]: {
    title: "引导令牌无效或已过期",
    detail: "重新生成一个引导令牌再连接。",
  },
  [ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING]: {
    title: "网关要求密码，但当前没有提供",
    detail: "填写网关配置的密码后重试。",
  },
  [ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH]: {
    title: "网关密码不正确",
    detail: "确认密码后重新连接；连续失败会触发限流。",
  },
  [ConnectErrorDetailCodes.AUTH_RATE_LIMITED]: {
    title: "认证失败次数过多，已被限流",
    detail: "等待片刻后重试；确认凭据正确再连续尝试。",
  },
  [ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH]: {
    title: "当前凭据权限不足",
    detail: "改用具备 operator 权限的 token，或在网关侧为设备身份授予相应 scope。",
  },
  [ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH]: {
    title: "本机保存的设备令牌已失效",
    detail: "已自动清除本地设备令牌，重新连接以完成配对。",
  },
  [ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED]: {
    title: "网关不允许当前来源访问控制台",
    detail:
      "在网关配置里把本页来源加入 controlUi.allowedOrigins，或改用网关自身提供的页面地址访问。",
  },
  [ConnectErrorDetailCodes.PROTOCOL_MISMATCH]: {
    title: "客户端与网关的协议版本不兼容",
    detail: "请升级网关或控制台到匹配的版本。",
  },
  [ConnectErrorDetailCodes.PAIRING_REQUIRED]: {
    title: "设备需要配对",
    detail: "在网关侧批准本设备的配对请求，然后会自动继续连接。",
  },
  [ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED]: {
    title: "控制台需要设备身份才能连接",
    detail: "请通过 HTTPS 或 localhost 访问（明文 HTTP 下无法生成设备身份）。",
  },
  [ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED]: {
    title: "网关要求设备身份",
    detail: "请通过 HTTPS 或 localhost 访问，以便生成并使用设备身份。",
  },
  // 浏览器侧（本文件自造的码，非网关下发）
  BROWSER_WEBSOCKET_SECURITY_ERROR: {
    title: "浏览器阻止了不安全的 WebSocket 连接",
    detail: "页面是 HTTPS 时不能连 ws:// —— 请改用 wss://，或通过 http://<host> 的网关页面访问。",
  },
  BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR: {
    title: "无法创建到网关的 WebSocket",
    detail: "检查网关地址格式是否正确（形如 ws://127.0.0.1:18789 或 wss://gateway.example.com）。",
  },
};

/**
 * 抹掉文本里可能泄露的凭据。
 *
 * 网关的原始报错偶尔会把 URL / query 原样带回来（例如 `...#token=abcd1234`），
 * 直接渲染就是「把密码贴在登录页上」。这里做两层处理：
 * 1. 把调用方传入的**已知**密钥值（token / 密码）整体替换掉；
 * 2. 兜底抹掉 `token=xxx` / `password: xxx` 这类**形似**凭据的片段。
 */
const TOKENISH_RE =
  /\b(token|password|passwd|pwd|secret|authorization|bearer|api[_-]?key)\b(\s*[:=]\s*)(\S+)/gi;

export function redactSecrets(
  text: string,
  secrets?: readonly (string | null | undefined)[],
): string {
  let out = text;
  for (const candidate of secrets ?? []) {
    const value = (candidate ?? "").trim();
    // 太短的值（比如 "1"）替换掉会把正常文本打花，只处理像样的密钥。
    if (value.length >= 6) out = out.split(value).join("***");
  }
  return out.replace(TOKENISH_RE, (_match, key: string, sep: string) => `${key}${sep}***`);
}

/**
 * 连接错误 → 可读文案；未收录的码退化成「原始信息 + 错误码」。
 *
 * `secrets` 用于把已知凭据从原始 message 里抹掉，避免登录页把 token 回显出来。
 */
export function formatConnectError(
  info: GatewayErrorInfo | null | undefined,
  secrets?: readonly (string | null | undefined)[],
): ConnectErrorAdvice {
  if (!info) return { title: "未连接到网关" };
  const hit = BY_CODE[info.code];
  if (hit) return hit;
  const message = redactSecrets((info.message ?? "").trim(), secrets);
  return {
    title: message || "连接失败",
    ...(info.code ? { detail: `错误码：${info.code}` } : {}),
  };
}
