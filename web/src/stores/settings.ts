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
 * ## 会话：每个 agent 只一条「规范主会话」（2026-09-23）
 *
 * `sessionKey` 只能是规范主会话形态 `agent:<agentId>:<mainKey>`
 * （见 `utils/canonicalSession.ts`）：入口默认 `agent:resume-assistant:main`，
 * 侧栏切换 agent 时落到该 agent 的主会话。
 *
 * 旧策略会按入口 token 指纹派生 `agent:<id>:id-<hash8>` —— 同一个 agent 名下于是
 * 同时累积出 `:main` 与 `:id-xxxxxxxx` 多条会话（本机 cet4 实测两条并存），
 * 这正是本次要消除的现象；任何非规范形态一律**改写**为该 agent 的主会话。
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { deriveDefaultGatewayUrl } from "@/api/gateway";
import { getUrlOverrides } from "@/utils/urlOverrides";
import { resolveGatewayHttpBase } from "@/utils/avatar";
import {
  DEFAULT_AGENT_SESSION_KEY,
  canonicalMainSessionKey,
  isCanonicalMainSessionKey,
} from "@/utils/canonicalSession";

/** 登录态：per-tab（sessionStorage），刷新保留、跨 tab 隔离。 */
const SESSION_KEY = "openclaw.web.session.v1";
/** UI 偏好：跨 tab 共享（localStorage）。 */
const PREFS_KEY = "openclaw.web.prefs.v1";

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  /**
   * 主题：**默认 `light`**（`sanitizePrefs` 把缺失值 / 历史 `system` 一律归一为 light）。
   * `system` 仅给将来的「跟随系统」开关预留，当前没有 UI 入口，落盘不会出现。
   */
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
 * 一旦存储里落下空串，整条链就会在此截断，最后那档固定 key 永远取不到 ——
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

/**
 * 归一化 UI 偏好。
 *
 * **默认浅色**：没有落过盘的取值一律进 `light`（不再跟随系统）。
 * ⚠️ `system` 一并归一为 `light` —— 界面上只有「浅色/深色」开关（`MainLayout.vue` 的
 * toggle 只在 `light` ↔ `dark` 之间翻），`system` 没有入口，只可能是旧默认值遗留；
 * 若原样保留，macOS 深色用户永远进不到浅色。想恢复「跟随系统」需要同时补 UI 入口。
 */
function sanitizePrefs(input: Partial<PrefsState>): PrefsState {
  return {
    themeMode: input.themeMode === "dark" ? "dark" : "light",
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
 * 由入口 token 派生稳定、短小、可读的会话 key（FNV-1a 32 位哈希）。
 *
 * ⚠️ **单会话口径（2026-09-23）起不再用于 `sessionKey`**（见 `utils/canonicalSession.ts`）。
 * 保留实现而不是删掉：「每个入口 token 一个会话」是一套自洽的（前）策略，
 * 将来若要恢复，只需把 `sessionKey` 的初始化换回这个函数即可；删掉会让那段口径
 * 与代码彻底失联、只剩注释。
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

  /**
   * 会话 key。初值取「存储值归一化」后的结果，没有存储值时用入口默认会话
   * （`agent:resume-assistant:main`）。
   *
   * ⚠️ 归一化**不是格式化**：历史 `agent:cet4:id-4daf4b7d` 这类存储值会被改写成
   * `agent:cet4:main`。这是「不保留其他会话」的落地点 —— 旧值沿用一次，
   * 那条旧会话就在界面上复活一次。
   */
  const sessionKey = ref<string>(
    canonicalMainSessionKey(nonEmpty(persistedSession.sessionKey) ?? DEFAULT_AGENT_SESSION_KEY),
  );

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

  // 同理把 UI 偏好的历史遗留值洗回盘：读取时 `system` 已被归一为 `light`，
  // 若只归一在内存里，localStorage 会一直留着那个再也读不出来的 `system`。
  persistPrefs({ themeMode: themeMode.value, selectedModel: selectedModel.value });

  /**
   * ⚠️ 入口 token 变化**不再派生会话 key**（旧行为见 `deriveSessionKeyFromToken` 的注释）。
   * 「换 token = 换会话」产生的正是 `agent:<id>:id-<hash8>` 那类多余会话。
   * 保留 watch 只为把任何偏移拉回规范形态（例如别处直接写了 `settings.sessionKey = ...`）。
   */
  watch(token, () => {
    if (isCanonicalMainSessionKey(sessionKey.value)) return;
    sessionKey.value = canonicalMainSessionKey(sessionKey.value);
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

  /**
   * 显式指定会话 key（侧栏点智能体、窗格头下拉、`gateway.sessionKey = ...` 代理写入）。
   *
   * ⚠️ 入参一律经 `canonicalMainSessionKey` 归一：切 agent 有效（落到该 agent 的主会话），
   * 但**切不到主会话以外的会话**（`id-xxxx` / 子会话 / cron 会话都会被改写）。
   * 把这条收敛到唯一写入口，比在每个调用点各写一遍判断可靠得多。
   */
  function setSessionKey(next: string): void {
    const key = canonicalMainSessionKey(next || DEFAULT_AGENT_SESSION_KEY);
    if (sessionKey.value !== key) sessionKey.value = key;
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
