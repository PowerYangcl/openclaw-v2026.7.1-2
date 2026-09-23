/**
 * 网关连接状态（Pinia）。
 *
 * 把 GatewayBrowserClient 的生命周期与 Vue 的响应式系统桥接：
 * 组件只关心 connected / hello / error，不直接持有 WebSocket。
 */
import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import {
  GatewayBrowserClient,
  GatewayRequestError,
  deriveDefaultGatewayUrl,
  type GatewayErrorInfo,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "@/api/gateway";
import { ConnectErrorDetailCodes, readConnectErrorDetailCode } from "@/api/protocol";
import { useSettingsStore } from "@/stores/settings";

export type ConnectionPhase = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

/** 一条连接 / 请求耗时记录（诊断用）。 */
export type GatewayTimingEntry = {
  at: number;
  label: string;
  ms: number;
  ok: boolean;
};

export const useGatewayStore = defineStore("gateway", () => {
  const url = ref<string>(deriveDefaultGatewayUrl().effectiveUrl);
  const token = ref<string>("");
  const password = ref<string>("");

  const phase = ref<ConnectionPhase>("idle");
  const hello = shallowRef<GatewayHelloOk | null>(null);
  const lastError = ref<string | null>(null);
  const lastErrorCode = ref<string | null>(null);
  /** 结构化的最后一次错误（含 code / details / retryAfterMs），供 `formatConnectError` 出可读文案。 */
  const lastErrorInfo = ref<GatewayErrorInfo | null>(null);
  const everConnected = ref(false);

  // -------------------------------------------------------------------------
  // 连接 / 请求计时（诊断用，见 DebugView 的「网关诊断」面板）
  // -------------------------------------------------------------------------
  const MAX_TIMING_ENTRIES = 50;
  const timings = ref<GatewayTimingEntry[]>([]);
  function pushTiming(entry: GatewayTimingEntry): void {
    timings.value.unshift(entry);
    if (timings.value.length > MAX_TIMING_ENTRIES) timings.value.pop();
  }

  /** 客户端实例非响应式，避免 Vue 深度代理 WebSocket。 */
  let client: GatewayBrowserClient | null = null;
  const eventListeners = new Set<(evt: GatewayEventFrame) => void>();
  /** 连续「可自动重试」的失败次数：用于决定过渡错误是否值得弹给用户看。 */
  let consecutiveRetries = 0;

  const connected = computed(() => phase.value === "connected");

  /**
   * 会话 key 统一由 settings store 托管（会话隔离策略见 `stores/settings.ts`），
   * 这里只做一层读写代理，避免两处状态各自漂移。
   */
  const sessionKey = computed<string>({
    get: () => useSettingsStore().sessionKey,
    set: (value: string) => useSettingsStore().setSessionKey(value),
  });

  function setError(
    message: string | null,
    code: string | null = null,
    info: GatewayErrorInfo | null = null,
  ): void {
    lastError.value = message;
    lastErrorCode.value = code;
    lastErrorInfo.value = info;
  }

  function connect(overrides: { url?: string; token?: string; password?: string } = {}): void {
    if (overrides.url !== undefined) url.value = overrides.url;
    if (overrides.token !== undefined) token.value = overrides.token;
    if (overrides.password !== undefined) password.value = overrides.password;

    client?.stop();
    client = null;
    hello.value = null;
    setError(null);
    // 换网关 / 重连后旧缓存没有意义（可能是另一台机器上的会话与模型目录）。
    clearSharedCache();
    phase.value = everConnected.value ? "reconnecting" : "connecting";

    client = new GatewayBrowserClient({
      url: url.value,
      token: token.value.trim() ? token.value : undefined,
      password: password.value.trim() ? password.value : undefined,
      clientName: "openclaw-control-ui",
      clientVersion: "openclaw-web",
      mode: "webchat",
      onHello: (next) => {
        hello.value = next;
        everConnected.value = true;
        phase.value = "connected";
        consecutiveRetries = 0;
        setError(null);
        // 一旦连接到网关，本 tab 即视为「就绪」，刷新 / 重开 tab
        // 都能直接落到受保护页面；多 tab 各自独立 sessionStorage 互不影响。
        try {
          sessionStorage.setItem("openclaw.gateway.ready", "1");
        } catch {
          // 忽略 sessionStorage 不可用（如隐身模式的某些策略）
        }
      },
      onClose: ({ code, reason, error, willRetry }) => {
        hello.value = null;
        const detailCode = readConnectErrorDetailCode(error?.details);
        if (willRetry) {
          consecutiveRetries += 1;
          phase.value = everConnected.value ? "reconnecting" : "connecting";
          // 自动重连进行中：过渡错误不该弹给用户。
          // 典型场景：上游 MAAS 链接里的 `#token=` 是**身份令牌**而非网关 auth token，
          // 首连必然 `token_mismatch`，客户端随即用已配对设备令牌重连成功。
          // 这条红条属于噪音，且会误导用户去改 Control UI 设置。
          // 连续多次仍失败（真的连不上）时才在第 4 次暴露错误，避免用户干等。
          if (consecutiveRetries > 3) {
            setError(error?.message ?? `连接已断开 (${code})`, error?.code ?? null, error ?? null);
          } else {
            setError(null);
          }
          return;
        }
        consecutiveRetries = 0;
        phase.value = "failed";
        setError(error?.message ?? `连接失败 (${code}): ${reason}`, error?.code ?? null, error ?? null);
        // 清理过期的 token，避免下次自动连接仍用同一个坏 token 死循环
        if (
          detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH ||
          detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED ||
          detailCode === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID
        ) {
          try {
            useSettingsStore().setToken("");
          } catch {
            // settings store 可能在销毁中，吞掉
          }
          sessionStorage.removeItem("openclaw.gateway.ready");
          sessionStorage.removeItem("openclaw.gateway.intentional-disconnect");
        }
      },
      onEvent: (evt) => {
        for (const listener of eventListeners) listener(evt);
      },
      onConnectTiming: ({ ms, ok }) => {
        pushTiming({ at: Date.now(), label: "connect", ms, ok });
      },
      onRequestTiming: ({ method, ms, ok }) => {
        pushTiming({ at: Date.now(), label: method, ms, ok });
      },
    });
    client.start();
  }

  /**
   * 静默启动一次连接：
   * - 若当前已是 connected / connecting / reconnecting：直接返回，不重复握手。
   * - 若用户在当前 tab 主动断开了（sessionStorage.intentional-disconnect）：跳过，避免被自动重连。
   * - 否则读取 settings 里的 url/token 调 connect()，URL token 与 localStorage token 都覆盖同一路径。
   *
   * 设计要点：App.vue 在 onMounted + storage event + pageshow(BFCache) 都调一次，
   * 同一个 tab 一天里可被触发多次；本 action 是幂等的，重复触发仅多走一次开关。
   */
  function autoConnect(): void {
    if (typeof sessionStorage !== "undefined") {
      if (sessionStorage.getItem("openclaw.gateway.intentional-disconnect") === "1") return;
    }
    if (
      phase.value === "connected" ||
      phase.value === "connecting" ||
      phase.value === "reconnecting"
    ) {
      return;
    }
    let settings;
    try {
      settings = useSettingsStore();
    } catch {
      return;
    }
    const nextUrl = (settings.gatewayUrl || deriveDefaultGatewayUrl().effectiveUrl).trim();
    if (!nextUrl) return;
    if (nextUrl !== url.value) {
      url.value = nextUrl;
    }
    if (settings.token !== token.value) {
      token.value = settings.token;
    }
    connect({ url: nextUrl, token: settings.token });
  }

  function disconnect(): void {
    client?.stop();
    client = null;
    hello.value = null;
    phase.value = "idle";
    everConnected.value = false;
    consecutiveRetries = 0;
    setError(null);
    try {
      sessionStorage.removeItem("openclaw.gateway.ready");
    } catch {
      // 忽略
    }
  }

  /**
   * 等待 phase 进入 connected（用于自动连接竞态）：
   * - 视图层（例如 ChatView、OverviewView）在 onMounted 调 request() 时，
   *   通常 App.vue 的 autoConnect 还没握手完成，此时 client 已存在但 ws 未开。
   *   直接 reject 会让 UI 抛一堆错误。
   * - 这里把 request 转成最多 30 秒的等待，避免在握手完成前误报。
   */
  function waitForConnection(timeoutMs = 30_000): Promise<void> {
    if (phase.value === "connected") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        unwatch();
        reject(new Error("gateway connection timeout"));
      }, timeoutMs);
      const unwatch = watch(phase, (next) => {
        if (settled) return;
        if (next === "connected") {
          settled = true;
          window.clearTimeout(timer);
          unwatch();
          resolve();
        } else if (next === "failed" || next === "idle") {
          settled = true;
          window.clearTimeout(timer);
          unwatch();
          reject(new Error("gateway connection failed"));
        }
      });
      if (phase.value === "connected") {
        settled = true;
        window.clearTimeout(timer);
        unwatch();
        resolve();
      }
    });
  }

  async function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!client) {
      // 第一次 page load 还没人触发 connect() —— 试着把自动连接挂上，再等握手。
      try {
        autoConnect();
      } catch {
        // settings store 不可用等场景吞掉，下面再抛常规错误
      }
      if (!client) {
        throw new Error("gateway not connected");
      }
    }
    if (phase.value !== "connected") {
      try {
        await waitForConnection();
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    if (!client) {
      throw new Error("gateway not connected");
    }
    try {
      return await client.request<T>(method, params);
    } catch (err) {
      if (err instanceof GatewayRequestError) {
        setError(err.message, err.gatewayCode, {
          code: err.gatewayCode,
          message: err.message,
          details: err.details,
          retryable: err.retryable,
          retryAfterMs: err.retryAfterMs,
        });
      }
      throw err;
    }
  }

  /**
   * 只读目录类 RPC 的**并发去重 + 短 TTL 缓存**。
   *
   * ## 为什么需要它（首屏实测）
   * `web/tests/smoke/probe-first-paint-rpc.mjs` 抓到的首屏 RPC 序列：
   * 进一次聊天页共 18 条 RPC，其中
   * - `sessions.list` **2 条**（侧栏 `loadSessions` + 窗格 `loadContextWindow`，入参完全一样），
   *   各自 ~150-290ms；
   * - `models.list` **2 条**（`onMounted` 的 `loadModelList` + `loadHistory` 命中缓存时又拉一次），
   *   合计 ~417ms；
   * - `config.get` 1 条 ~301ms，而它只是给侧栏取 agent 描述，是**静态配置**。
   *
   * 同一屏里把同一份只读数据拉两遍，白等一次往返；网关是单线程 Node，
   * 这些重复请求还会和真正的 `chat.history` 抢事件循环。这里把它们收敛成一次。
   *
   * ## 使用边界（重要）
   * 只给「**只读、短期内可容忍陈旧、无副作用**」的目录类方法用
   * （`sessions.list` / `models.list` / `config.get` 这一类）。
   * **绝对不要**用于 `chat.history`（用户就是要看最新）、`chat.send` / `sessions.patch`
   * 等有状态或写操作的方法 —— 缓存住它们会吞掉写操作或让用户看到旧数据。
   *
   * 键 = `method` + 规范化后的 params（键序无关），所以同方法不同入参互不污染。
   * 连接重建（`connect()`）时整表清空：换网关后旧数据没有意义。
   */
  const SHARED_CACHE_MAX_ENTRIES = 32;
  const sharedCache = new Map<string, { at: number; value: unknown }>();
  const sharedInflight = new Map<string, Promise<unknown>>();

  function sharedCacheKey(method: string, params: unknown): string {
    let normalized = "";
    try {
      normalized = params === undefined ? "" : JSON.stringify(sortJsonKeys(params));
    } catch {
      normalized = String(params);
    }
    return `${method}\u0000${normalized}`;
  }

  /** 递归按键排序，让 `{a,b}` 与 `{b,a}` 命中同一个缓存键。 */
  function sortJsonKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJsonKeys);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortJsonKeys((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  }

  async function requestShared<T = unknown>(
    method: string,
    params: unknown,
    ttlMs: number,
    options?: { force?: boolean },
  ): Promise<T> {
    const key = sharedCacheKey(method, params);
    const hit = sharedCache.get(key);
    if (!options?.force && hit && Date.now() - hit.at < ttlMs) {
      return hit.value as T;
    }
    const inflight = sharedInflight.get(key);
    if (inflight) return inflight as Promise<T>;
    const task = (async (): Promise<T> => {
      try {
        const value = await request<T>(method, params);
        sharedCache.set(key, { at: Date.now(), value });
        // 简单 LRU 上限：目录类数据条目本来就少，防的是「无限增长的入参组合」。
        while (sharedCache.size > SHARED_CACHE_MAX_ENTRIES) {
          const oldest = sharedCache.keys().next().value;
          if (oldest === undefined) break;
          sharedCache.delete(oldest);
        }
        return value;
      } finally {
        sharedInflight.delete(key);
      }
    })();
    sharedInflight.set(key, task);
    return task;
  }

  /** 清空 `requestShared` 的缓存（断开 / 重连时调用）。 */
  function clearSharedCache(): void {
    sharedCache.clear();
    sharedInflight.clear();
  }

  function onEvent(listener: (evt: GatewayEventFrame) => void): () => void {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }

  /** 连接失败是否属于需要用户干预的类型（如未配对 / 认证失败）。 */
  const needsUserAction = computed(() => {
    const code = lastErrorCode.value;
    if (!code) return false;
    return (
      code.includes("PAIRING") ||
      code.includes("AUTH_") ||
      code === "PROTOCOL_MISMATCH" ||
      code.includes("DEVICE_IDENTITY")
    );
  });

  const errorDetailCode = computed(() => readConnectErrorDetailCode({ code: lastErrorCode.value }));

  return {
    url,
    token,
    password,
    phase,
    hello,
    lastError,
    lastErrorCode,
    lastErrorInfo,
    timings,
    connected,
    needsUserAction,
    errorDetailCode,
    sessionKey,
    connect,
    disconnect,
    autoConnect,
    request,
    requestShared,
    clearSharedCache,
    onEvent,
    waitForConnection,
  };
});
