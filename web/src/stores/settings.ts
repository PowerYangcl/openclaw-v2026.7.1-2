/**
 * 本地设置持久化。
 *
 * ## 两层存储（核心：登录态必须 per-tab 隔离）
 *
 * - **会话态 → sessionStorage（per-tab）**：`gatewayUrl` / `token` / `sessionKey`。
 *   上游 MAAS 控制台给每个用户签发各自的 `#token=` 跳转链接，同一浏览器很可能同时
 *   打开多个 tab。这些字段一旦放 localStorage，多 tab 会互相覆盖 —— 表现为
 *   「登录网关报错」+「不同 token 串到同一个会话」。放 sessionStorage 后：
 *   每个 tab 保留自己的入口令牌，**刷新不丢**，且互相不可见。
 *
 * - **UI 偏好 → localStorage（跨 tab 共享）**：`themeMode` / `selectedModel`。
 *   纯展示偏好，共享无副作用，用户换 tab 后应保持一致。
 *
 * ## 会话隔离
 *
 * `sessionKey` 默认由入口 token 指纹派生（`id-<hash8>`）：
 * 不同 token → 不同 sessionKey → 不同会话 → 消息互不可见。
 * `?session=` / `#session=` 显式指定时优先级最高，且不再跟随 token 变化。
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { deriveDefaultGatewayUrl } from "@/api/gateway";
import { resolveGatewayHttpBase } from "@/utils/avatar";
import { getUrlOverrides } from "@/utils/urlOverrides";

/** 登录态：per-tab（sessionStorage），刷新保留、跨 tab 隔离。 */
const SESSION_KEY = "openclaw.web.session.v1";
/** UI 偏好：跨 tab 共享（localStorage）。 */
const PREFS_KEY = "openclaw.web.prefs.v1";
/** 默认会话 key（无入口 token 时使用，例如纯设备身份配对）。 */
const DEFAULT_SESSION_KEY = "main";

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  themeMode: "light" | "dark" | "system";
  /** 当前选中的模型（格式："provider/modelId" 或空串代表默认） */
  selectedModel: string;
};

type SessionState = Pick<UiSettings, "gatewayUrl" | "token" | "sessionKey">;
type PrefsState = Pick<UiSettings, "themeMode" | "selectedModel">;

/**
 * 会话态在**存储层**的表示：缺失 / 空串统一用 `undefined`。
 *
 * 为什么必须区分「空串」与「缺失」：解析时用的是 `??` 链
 * （`overrides ?? 派生值 ?? 存储值 ?? 默认值`），而 `""` 不是 nullish，
 * 一旦存储里落下空串，整条链就会在此截断，`DEFAULT_SESSION_KEY` 永远取不到 ——
 * 表现就是 `chat.history` 收到 `sessionKey: ""` 报
 * "must not have fewer than 1 characters"。
 */
type SessionPatch = Partial<Record<keyof SessionState, string | undefined>>;

/** 非空字符串才作数，其余（含空串 / 纯空白 / 非字符串）一律视作「未设置」。 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** sessionStorage 在部分隐私策略下会抛异常，这里统一降级为「无存储」。 */
function getStorage(kind: "session" | "local"): Storage | null {
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function readPartial<T extends object>(storage: Storage | null, key: string): Partial<T> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

function writePartial(storage: Storage | null, key: string, value: object): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额满 / 隐私策略下静默降级
  }
}

/** 读出会话态，空值全部归一为 `undefined`。 */
function readSession(): SessionPatch {
  const raw = readPartial<SessionState>(getStorage("session"), SESSION_KEY);
  return {
    gatewayUrl: nonEmpty(raw.gatewayUrl),
    token: nonEmpty(raw.token),
    sessionKey: nonEmpty(raw.sessionKey),
  };
}

function sanitizePrefs(input: Partial<PrefsState>): PrefsState {
  return {
    themeMode:
      input.themeMode === "light" || input.themeMode === "dark" || input.themeMode === "system"
        ? input.themeMode
        : "system",
    selectedModel: typeof input.selectedModel === "string" ? input.selectedModel : "",
  };
}

/**
 * 同步写会话态（绕开 watch 的下一拍延迟，避免同 tab 马上刷新读到旧值）。
 * 空值会被**删除**而不是写成空串 —— 见 `SessionPatch` 的说明。
 */
function persistSession(patch: SessionPatch): void {
  const storage = getStorage("session");
  const merged: SessionPatch = { ...readSession(), ...patch };
  const out: Record<string, string> = {};
  const gatewayUrl = nonEmpty(merged.gatewayUrl);
  const token = nonEmpty(merged.token);
  const sessionKey = nonEmpty(merged.sessionKey);
  if (gatewayUrl) out.gatewayUrl = gatewayUrl;
  if (token) out.token = token;
  if (sessionKey) out.sessionKey = sessionKey;
  writePartial(storage, SESSION_KEY, out);
}

/** 同步写偏好。 */
function persistPrefs(patch: Partial<PrefsState>): void {
  const storage = getStorage("local");
  const merged = { ...sanitizePrefs(readPartial<PrefsState>(storage, PREFS_KEY)), ...patch };
  writePartial(storage, PREFS_KEY, merged);
}

/**
 * 由入口 token 派生稳定、短小、可读的会话 key。
 *
 * 用 FNV-1a 32 位哈希（纯前端、无依赖、稳定）：同一个 token 永远得到同一个 key，
 * 刷新后能续上历史；不同 token 得到不同 key，实现会话隔离。
 * 无 token（纯设备身份）时返回 null，由调用方回落到 `main`。
 */
export function deriveSessionKeyFromToken(token: string): string | null {
  const value = token.trim();
  if (!value) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `id-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export const useSettingsStore = defineStore("settings", () => {
  const persistedSession = readSession();
  const persistedPrefs = sanitizePrefs(readPartial<PrefsState>(getStorage("local"), PREFS_KEY));
  // URL 覆盖项在 router 创建前就已捕获并清理地址栏（见 src/utils/urlOverrides.ts）
  const overrides = getUrlOverrides();

  // 注意：这里一律用 `nonEmpty(...)` 而不是裸 `overrides.x ?? ...`。
  // URL 覆盖项与存储值都可能是空串，而 `??` 只认 null/undefined，
  // 用 `??` 会让空串截断整条回落链（曾经导致 sessionKey 变成 ""）。
  const gatewayUrl = ref<string>(
    nonEmpty(overrides.gatewayUrl) ??
      persistedSession.gatewayUrl ??
      deriveDefaultGatewayUrl().effectiveUrl,
  );
  const token = ref<string>(nonEmpty(overrides.token) ?? persistedSession.token ?? "");

  /** `?session=` 显式指定 → 冻结，不再由 token 派生。 */
  const explicitSessionKey = nonEmpty(overrides.session);
  const frozenSessionKey = Boolean(explicitSessionKey);

  /**
   * 本次页面加载是否「从 URL 入口进来」。
   *
   * 带 `token` 或 `session` 说明是一次新的入口（可能是新身份签发的链接），
   * 此时按 token 指纹派生会话 key；**两者都没有**则是普通刷新 / 直接访问，
   * 必须沿用上次的会话 key —— 否则刷新会静默跳到 `id-<token哈希>` 那个空会话，
   * 用户看到的「历史消息」会凭空换一批（曾表现为「删掉的消息刷新又出现」）。
   */
  const enteringViaUrl = Boolean(nonEmpty(overrides.token) || explicitSessionKey);

  const sessionKey = ref<string>(
    explicitSessionKey ??
      (enteringViaUrl ? deriveSessionKeyFromToken(token.value) : undefined) ??
      persistedSession.sessionKey ??
      deriveSessionKeyFromToken(token.value) ??
      DEFAULT_SESSION_KEY,
  );
  // 硬不变量：sessionKey 绝不能为空（网关 schema 要求 minLength 1）。
  if (!sessionKey.value) sessionKey.value = DEFAULT_SESSION_KEY;

  const themeMode = ref<UiSettings["themeMode"]>(persistedPrefs.themeMode);
  const selectedModel = ref<string>(persistedPrefs.selectedModel);

  // URL 覆盖项立即同步落盘：watch 在下一拍才跑，期间用户刷新 / 关 tab 会丢登录态。
  // 同时把历史遗留的空串 / 非法值洗掉（`persistSession` 会删除空值键），
  // 避免脏值长期留在 sessionStorage 里反复触发「空串截断 `??` 链」这类问题。
  persistSession({
    gatewayUrl: gatewayUrl.value,
    token: token.value,
    sessionKey: sessionKey.value,
  });

  /**
   * 入口 token 变化即代表身份变化：重新派生会话 key，保证「换 token = 换会话」。
   * 令牌为空（如主动清空 / 设备身份自带会话）时回落默认 key。
   */
  watch(token, (next) => {
    if (frozenSessionKey) return;
    const derived = deriveSessionKeyFromToken(next) ?? DEFAULT_SESSION_KEY;
    if (derived !== sessionKey.value) sessionKey.value = derived;
  });

  // 登录态写入 sessionStorage（per-tab）
  watch([gatewayUrl, token, sessionKey], () => {
    persistSession({
      gatewayUrl: gatewayUrl.value,
      token: token.value,
      sessionKey: sessionKey.value,
    });
  });
  // UI 偏好写入 localStorage（跨 tab 共享）
  watch([themeMode, selectedModel], () => {
    persistPrefs({ themeMode: themeMode.value, selectedModel: selectedModel.value });
  });

  function isDark(): boolean {
    if (themeMode.value === "system") {
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    }
    return themeMode.value === "dark";
  }

  function applyTheme(): void {
    const dark = isDark();
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }

  function setSelectedModel(model: string): void {
    selectedModel.value = model;
    persistPrefs({ selectedModel: model });
  }

  /**
   * 网关 **HTTP** 源（+ base path），用于取由网关 HTTP 服务提供的站内资源：
   * `/avatar/<agentId>`（头像）、`/__openclaw__/assistant-media`（音频/图片附件）。
   *
   * 必须由 WS 地址推导：前端可能与网关不同源（Vite dev 5273 vs 网关 18789），
   * 直接用相对路径会被解析到前端自己的源上 → 404。
   * 实测网关这些路由**没有 CORS 响应头**，所以只能靠 `<img>/<audio>` 直出，
   * 不能跨源 `fetch`。
   */
  const gatewayHttpBase = computed<string>(() => resolveGatewayHttpBase(gatewayUrl.value));

  /**
   * 显式写入 token：立即同步落盘，绕过 watch 的下一拍延迟。
   * 主要在登录页提交、或令牌失效被网关踢回等场景使用。
   */
  function setToken(next: string): void {
    token.value = next;
    persistSession({ token: next });
  }

  /** 显式写入 gatewayUrl：立即同步落盘。 */
  function setGatewayUrl(next: string): void {
    gatewayUrl.value = next;
    persistSession({ gatewayUrl: next });
  }

  /** 显式指定会话 key（如「会话」页点进某个历史会话）。 */
  function setSessionKey(next: string): void {
    const key = next.trim() || DEFAULT_SESSION_KEY;
    sessionKey.value = key;
    persistSession({ sessionKey: key });
  }

  /**
   * 重新读取跨 tab 共享的 UI 偏好（localStorage）。
   * 由 App.vue 在收到 `storage` 事件时调用。
   *
   * 注意：这里**故意不**重读登录态 —— 登录态是 per-tab 的，跨 tab 覆盖会破坏隔离。
   */
  function reloadSharedPrefs(): void {
    const next = sanitizePrefs(readPartial<PrefsState>(getStorage("local"), PREFS_KEY));
    if (next.themeMode !== themeMode.value) themeMode.value = next.themeMode;
    if (next.selectedModel !== selectedModel.value) selectedModel.value = next.selectedModel;
  }

  return {
    gatewayUrl,
    token,
    sessionKey,
    themeMode,
    selectedModel,
    isDark,
    gatewayHttpBase,
    applyTheme,
    setSelectedModel,
    setToken,
    setGatewayUrl,
    setSessionKey,
    reloadSharedPrefs,
  };
});
