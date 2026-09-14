import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  storeDeviceAuthToken,
} from "./device";
/**
 * Gateway WebSocket 客户端。
 *
 * 自包含移植自 `ui/src/api/gateway.ts`（原 `GatewayBrowserClient`）。
 * 这是方案 A 最关键的复用资产：握手、设备认证、重连、事件去重全部在此，
 * 框架无关（纯 TS），Vue3 与其它前端可直接复用，**不要重写**。
 */
import {
  ConnectErrorDetailCodes,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  buildDeviceAuthPayload,
  isRetryableGatewayStartupUnavailableError,
  readConnectErrorDetailCode,
  type GatewayClientMode,
  type GatewayClientName,
} from "./protocol";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
};

export type GatewayErrorInfo = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export class GatewayRequestError extends Error {
  readonly gatewayCode: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(error: GatewayErrorInfo) {
    super(error.message);
    this.name = "GatewayRequestError";
    this.gatewayCode = error.code;
    this.details = error.details;
    this.retryable = error.retryable === true;
    this.retryAfterMs = error.retryAfterMs;
  }
}

export type GatewayControlUiPluginTab = {
  pluginId: string;
  id: string;
  label: string;
  description?: string;
  icon?: string;
  path?: string;
  group?: "control" | "agent";
  order?: number;
};

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  server?: { version?: string; connId?: string };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth: { deviceToken?: string; role: string; scopes: string[]; issuedAtMs?: number };
  controlUiTabs?: GatewayControlUiPluginTab[];
  pluginSurfaceUrls?: Record<string, string>;
  policy?: { tickIntervalMs?: number };
};

export type GatewayConnectAuth = { token?: string; deviceToken?: string; password?: string };

type GatewayConnectDevice = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

type GatewayConnectClientInfo = {
  id: GatewayClientName;
  version: string;
  platform: string;
  mode: GatewayClientMode;
  instanceId?: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  method: string;
};

type SelectedConnectAuth = {
  authToken?: string;
  authDeviceToken?: string;
  authPassword?: string;
  resolvedDeviceToken?: string;
  storedToken?: string;
  storedScopes?: string[];
};

export type GatewayBrowserClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientName?: GatewayClientName;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onClose?: (info: {
    code: number;
    reason: string;
    error?: GatewayErrorInfo;
    willRetry: boolean;
  }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

export type GatewayEventListener = (evt: GatewayEventFrame) => void;

const CONTROL_UI_OPERATOR_ROLE = "operator";

export const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

// 4008 = 应用自定义码（浏览器拒绝 1008 "Policy Violation"）
const CONNECT_FAILED_CLOSE_CODE = 4008;
const STARTUP_RETRY_CLOSE_CODE = 4013;
const BROWSER_WEBSOCKET_CLOSE_CODE = 1006;

function isLoopbackIPv4Host(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function isTrustedRetryEndpoint(url: string): boolean {
  try {
    const gatewayUrl = new URL(url, window.location.href);
    const host = gatewayUrl.hostname.trim().toLowerCase();
    const isLoopback =
      host === "localhost" || host === "::1" || host === "[::1]" || isLoopbackIPv4Host(host);
    if (isLoopback) return true;
    const pageUrl = new URL(window.location.href);
    return gatewayUrl.host === pageUrl.host;
  } catch {
    return false;
  }
}

/** 判断连接失败是否在客户端/服务端状态不变的情况下无法自愈。 */
export function isNonRecoverableConnectError(error: { details?: unknown } | undefined): boolean {
  if (!error) return false;
  const code = readConnectErrorDetailCode(error.details);
  return (
    code === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    code === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH ||
    code === ConnectErrorDetailCodes.PROTOCOL_MISMATCH ||
    code === ConnectErrorDetailCodes.PAIRING_REQUIRED ||
    code === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
    code === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED
  );
}

function generateUUID(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function storedDeviceTokenScopesAllowRead(role: string, scopes: readonly string[]): boolean {
  return (
    role !== CONTROL_UI_OPERATOR_ROLE ||
    scopes.includes("operator.read") ||
    scopes.includes("operator.write") ||
    scopes.includes("operator.admin")
  );
}

export class GatewayBrowserClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: number | null = null;
  private connectGeneration = 0;
  private backoffMs = 800;
  private pendingConnectError: GatewayErrorInfo | undefined;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  private eventListeners = new Set<GatewayEventListener>();

  constructor(private opts: GatewayBrowserClientOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearConnectTimer();
    this.ws?.close();
    this.ws = null;
    this.pendingConnectError = undefined;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.flushPending(new Error("gateway client stopped"));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      this.ws = null;
      const error: GatewayErrorInfo = {
        code: "BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR",
        message: `无法创建 Gateway WebSocket：${err instanceof Error ? err.message : String(err)}`,
      };
      this.flushPending(new Error(error.message));
      this.notifyClose({
        code: BROWSER_WEBSOCKET_CLOSE_CODE,
        reason: "websocket error",
        error,
        willRetry: false,
      });
      return;
    }
    const generation = ++this.connectGeneration;
    this.ws = ws;
    ws.addEventListener("open", () => this.queueConnect(ws, generation));
    ws.addEventListener("message", (ev) => {
      if (!this.isActiveSocket(ws, generation)) return;
      this.handleMessage(ws, generation, String(ev.data ?? ""));
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      const reason = ev.reason ?? "";
      const connectError = this.pendingConnectError;
      this.pendingConnectError = undefined;
      this.ws = null;
      const closeError = connectError
        ? new GatewayRequestError(connectError)
        : new Error(`gateway closed (${ev.code}): ${reason}`);
      this.flushPending(closeError);
      const connectErrorCode = readConnectErrorDetailCode(connectError);
      const willRetry =
        !this.closed &&
        (connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
          ? this.pendingDeviceTokenRetry
          : !isNonRecoverableConnectError(connectError));
      this.notifyClose({ code: ev.code, reason, error: connectError, willRetry });
      if (willRetry) this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // 忽略，close 处理器会接管
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, delay);
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private isActiveSocket(ws: WebSocket, generation: number): boolean {
    return !this.closed && this.ws === ws && this.connectGeneration === generation;
  }

  private buildConnectClient(): GatewayConnectClientInfo {
    return {
      id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: this.opts.clientVersion ?? "openclaw-web",
      platform: this.opts.platform ?? navigator.platform ?? "web",
      mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
      instanceId: this.opts.instanceId,
    };
  }

  private selectConnectAuth(params: { role: string; deviceId: string }): SelectedConnectAuth {
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const authPassword = this.opts.password?.trim() || undefined;
    const storedEntry = loadDeviceAuthToken({
      deviceId: params.deviceId,
      gatewayUrl: this.opts.url,
      role: params.role,
    });
    const storedTokenCanRead = storedDeviceTokenScopesAllowRead(
      params.role,
      storedEntry?.scopes ?? [],
    );
    const storedToken = storedTokenCanRead ? storedEntry?.token : undefined;
    const shouldUseDeviceRetryToken =
      this.pendingDeviceTokenRetry &&
      Boolean(explicitGatewayToken) &&
      Boolean(storedToken) &&
      isTrustedRetryEndpoint(this.opts.url);
    const resolvedDeviceToken = !(explicitGatewayToken || authPassword)
      ? (storedToken ?? undefined)
      : undefined;
    return {
      authToken: explicitGatewayToken ?? resolvedDeviceToken,
      authDeviceToken: shouldUseDeviceRetryToken ? (storedToken ?? undefined) : undefined,
      authPassword,
      resolvedDeviceToken,
      storedToken: storedToken ?? undefined,
      storedScopes: storedEntry?.scopes ?? undefined,
    };
  }

  private async buildConnectDevice(params: {
    deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
    client: GatewayConnectClientInfo;
    role: string;
    scopes: string[];
    authToken?: string;
    connectNonce: string | null;
  }): Promise<GatewayConnectDevice | undefined> {
    const { deviceIdentity } = params;
    if (!deviceIdentity) return undefined;
    const signedAtMs = Date.now();
    const nonce = params.connectNonce ?? "";
    const payload = buildDeviceAuthPayload({
      deviceId: deviceIdentity.deviceId,
      clientId: params.client.id,
      clientMode: params.client.mode,
      role: params.role,
      scopes: params.scopes,
      signedAtMs,
      token: params.authToken ?? null,
      nonce,
    });
    const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
    return {
      id: deviceIdentity.deviceId,
      publicKey: deviceIdentity.publicKey,
      signature,
      signedAt: signedAtMs,
      nonce,
    };
  }

  private async sendConnect(ws: WebSocket, generation: number): Promise<void> {
    if (!this.isActiveSocket(ws, generation) || ws.readyState !== WebSocket.OPEN) return;
    if (this.connectSent) return;
    this.connectSent = true;
    this.clearConnectTimer();

    const role = CONTROL_UI_OPERATOR_ROLE;
    const client = this.buildConnectClient();
    // crypto.subtle 仅在安全上下文（HTTPS / localhost）可用。
    // 明文 HTTP 下跳过设备身份，退化为 token-only 认证。
    const isSecureContext = typeof crypto !== "undefined" && Boolean(crypto.subtle);
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let selectedAuth: SelectedConnectAuth = { authToken: this.opts.token?.trim() || undefined };

    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      selectedAuth = this.selectConnectAuth({ role, deviceId: deviceIdentity.deviceId });
    }

    const usingStoredToken =
      Boolean(selectedAuth.storedToken) &&
      (selectedAuth.resolvedDeviceToken === selectedAuth.storedToken ||
        selectedAuth.authDeviceToken === selectedAuth.storedToken);
    const scopes =
      usingStoredToken && selectedAuth.storedScopes && selectedAuth.storedScopes.length > 0
        ? [...selectedAuth.storedScopes]
        : [...CONTROL_UI_OPERATOR_SCOPES];

    const device = await this.buildConnectDevice({
      deviceIdentity,
      client,
      role,
      scopes,
      authToken: selectedAuth.authToken,
      connectNonce: this.connectNonce,
    });

    if (!this.isActiveSocket(ws, generation) || ws.readyState !== WebSocket.OPEN) return;

    const auth: GatewayConnectAuth | undefined =
      selectedAuth.authToken || selectedAuth.authPassword
        ? {
            token: selectedAuth.authToken,
            deviceToken: selectedAuth.authDeviceToken ?? selectedAuth.resolvedDeviceToken,
            password: selectedAuth.authPassword,
          }
        : undefined;

    try {
      const hello = await this.requestOnSocket<GatewayHelloOk>(ws, "connect", {
        minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role,
        scopes,
        device,
        caps: ["tool-events"],
        auth,
        userAgent: navigator.userAgent,
        locale: navigator.language,
      });
      if (!this.isActiveSocket(ws, generation)) return;
      this.pendingDeviceTokenRetry = false;
      this.deviceTokenRetryBudgetUsed = false;
      if (hello?.auth?.deviceToken && deviceIdentity) {
        storeDeviceAuthToken({
          deviceId: deviceIdentity.deviceId,
          gatewayUrl: this.opts.url,
          role: hello.auth.role ?? role,
          token: hello.auth.deviceToken,
          scopes: hello.auth.scopes ?? [],
        });
      }
      this.backoffMs = 800;
      this.notifyHello(hello);
    } catch (err) {
      if (!this.isActiveSocket(ws, generation)) return;
      const usedStoredToken =
        Boolean(selectedAuth.storedToken) &&
        (selectedAuth.resolvedDeviceToken === selectedAuth.storedToken ||
          selectedAuth.authDeviceToken === selectedAuth.storedToken);
      const code = readConnectErrorDetailCode(
        err instanceof GatewayRequestError ? err.details : undefined,
      );
      if (
        usedStoredToken &&
        deviceIdentity &&
        code === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
      ) {
        clearDeviceAuthToken({
          deviceId: deviceIdentity.deviceId,
          gatewayUrl: this.opts.url,
          role,
        });
      }
      if (
        !this.deviceTokenRetryBudgetUsed &&
        !selectedAuth.authDeviceToken &&
        Boolean(this.opts.token?.trim()) &&
        Boolean(deviceIdentity) &&
        Boolean(selectedAuth.storedToken) &&
        isTrustedRetryEndpoint(this.opts.url)
      ) {
        this.pendingDeviceTokenRetry = true;
        this.deviceTokenRetryBudgetUsed = true;
      }
      if (err instanceof GatewayRequestError) {
        this.pendingConnectError = {
          code: err.gatewayCode,
          message: err.message,
          details: err.details,
          retryable: err.retryable,
          retryAfterMs: err.retryAfterMs,
        };
      }
      if (isRetryableGatewayStartupUnavailableError(err)) {
        ws.close(STARTUP_RETRY_CLOSE_CODE, "gateway starting");
        return;
      }
      ws.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
    }
  }

  private handleMessage(ws: WebSocket, generation: number, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const frame = parsed as { type?: unknown };

    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect(ws, generation);
        }
        return;
      }
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.notifyGap({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }
      this.notifyEvent(evt);
      for (const listener of this.eventListeners) {
        try {
          listener(evt);
        } catch (err) {
          console.error("[gateway] event listener error:", err);
        }
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(
          new GatewayRequestError({
            code: res.error?.code ?? "UNAVAILABLE",
            message: res.error?.message ?? "request failed",
            details: res.error?.details,
            retryable: res.error?.retryable,
            retryAfterMs: res.error?.retryAfterMs,
          }),
        );
      }
    }
  }

  private notifyHello(hello: GatewayHelloOk): void {
    try {
      this.opts.onHello?.(hello);
    } catch (err) {
      console.error("[gateway] hello handler error:", err);
    }
  }

  private notifyClose(info: {
    code: number;
    reason: string;
    error?: GatewayErrorInfo;
    willRetry: boolean;
  }): void {
    try {
      this.opts.onClose?.(info);
    } catch (err) {
      console.error("[gateway] close handler error:", err);
    }
  }

  private notifyGap(info: { expected: number; received: number }): void {
    try {
      this.opts.onGap?.(info);
    } catch (err) {
      console.error("[gateway] gap handler error:", err);
    }
  }

  private notifyEvent(evt: GatewayEventFrame): void {
    try {
      this.opts.onEvent?.(evt);
    } catch (err) {
      console.error("[gateway] event handler error:", err);
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    return this.requestOnSocket(this.ws, method, params);
  }

  private requestOnSocket<T = unknown>(
    ws: WebSocket,
    method: string,
    params?: unknown,
  ): Promise<T> {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = generateUUID();
    const frame = { type: "req", id, method, params };
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, method });
    });
    ws.send(JSON.stringify(frame));
    return p;
  }

  addEventListener(listener: GatewayEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private queueConnect(ws: WebSocket, generation: number): void {
    if (!this.isActiveSocket(ws, generation)) return;
    this.connectNonce = null;
    this.connectSent = false;
    this.clearConnectTimer();
    // 部分服务端不主动发 challenge，750ms 后主动发起 connect。
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      void this.sendConnect(ws, generation);
    }, 750);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}

/** 默认网关地址推导：同源优先，Vite dev 页回落到 18789。 */
export function deriveDefaultGatewayUrl(): { pageUrl: string; effectiveUrl: string } {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const pageUrl = `${proto}://${location.host}/`;
  const isViteDev = location.port === "5273" || location.port === "5173";
  if (!isViteDev) {
    return { pageUrl, effectiveUrl: pageUrl };
  }
  return { pageUrl, effectiveUrl: `${proto}://${location.hostname}:18789` };
}
