/**
 * 设备身份与凭据存储。
 *
 * 自包含移植自 `ui/src/lib/nodes/index.ts` 的设备身份部分：
 * Ed25519 密钥对 + 公钥指纹作为 deviceId，私钥用于握手签名。
 * 全部落在 localStorage，与原生客户端共享同一套协议语义。
 */
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";

const DEVICE_IDENTITY_STORAGE_KEY = "openclaw.device.identity.v1";
const DEVICE_AUTH_TOKEN_KEY = "openclaw.device.auth.tokens.v1";

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

export type StoredDeviceToken = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs?: number;
};

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", publicKey.slice().buffer);
  return bytesToHex(new Uint8Array(hash));
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  const deviceId = await fingerprintPublicKey(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
}

/** 同步探测已存储的设备 id，无副作用（用于渲染前判断是否持有凭据）。 */
export function peekStoredDeviceIdentityId(): string | null {
  try {
    const raw = safeStorage()?.getItem(DEVICE_IDENTITY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredIdentity;
    return parsed?.version === 1 && typeof parsed.deviceId === "string" && parsed.deviceId
      ? parsed.deviceId
      : null;
  } catch {
    return null;
  }
}

/** 读取或创建本机设备身份（首次调用会生成 Ed25519 密钥对）。 */
export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const storage = safeStorage();
  try {
    const raw = storage?.getItem(DEVICE_IDENTITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string"
      ) {
        const derivedId = await fingerprintPublicKey(base64UrlDecode(parsed.publicKey));
        if (derivedId !== parsed.deviceId) {
          const updated: StoredIdentity = { ...parsed, deviceId: derivedId };
          storage?.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(updated));
          return {
            deviceId: derivedId,
            publicKey: parsed.publicKey,
            privateKey: parsed.privateKey,
          };
        }
        return {
          deviceId: parsed.deviceId,
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
        };
      }
    }
  } catch {
    // 本地身份损坏时走下方重新生成。
  }

  const identity = await generateIdentity();
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  };
  storage?.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(stored));
  return identity;
}

/** 用设备私钥签名握手载荷。 */
export async function signDevicePayload(
  privateKeyBase64Url: string,
  payload: string,
): Promise<string> {
  const key = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const sig = await signAsync(data, key);
  return base64UrlEncode(sig);
}

type TokenStore = Record<string, StoredDeviceToken>;

function readTokenStore(): TokenStore {
  try {
    const raw = safeStorage()?.getItem(DEVICE_AUTH_TOKEN_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as TokenStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeTokenStore(store: TokenStore): void {
  try {
    safeStorage()?.setItem(DEVICE_AUTH_TOKEN_KEY, JSON.stringify(store));
  } catch {
    // 存储不可用时静默降级。
  }
}

function tokenStoreKey(deviceId: string, gatewayUrl: string, role: string): string {
  return `${deviceId}::${gatewayUrl}::${role}`;
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
}): StoredDeviceToken | null {
  const store = readTokenStore();
  return store[tokenStoreKey(params.deviceId, params.gatewayUrl, params.role)] ?? null;
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
  token: string;
  scopes?: string[];
}): void {
  const store = readTokenStore();
  store[tokenStoreKey(params.deviceId, params.gatewayUrl, params.role)] = {
    token: params.token,
    role: params.role,
    scopes: params.scopes ?? [],
    updatedAtMs: Date.now(),
  };
  writeTokenStore(store);
}

export function clearDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
}): void {
  const store = readTokenStore();
  delete store[tokenStoreKey(params.deviceId, params.gatewayUrl, params.role)];
  writeTokenStore(store);
}
