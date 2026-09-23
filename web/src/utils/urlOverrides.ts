/**
 * URL 一次性覆盖项的捕获与净化。
 *
 * ## 为什么独立成模块
 *
 * `src/router/index.ts` 里的 `createWebHistory()` 会**立刻**读取 `location`，
 * 之后 `router.beforeEach` 又把 `to.fullPath` 原样塞进 `redirect` 查询参数。
 * 如果清理动作晚于路由创建（例如放在 store 的 setup 里），会出现两个后果：
 *
 * 1. 敏感参数（`token`）被编码进 `redirect=/?token=...`，顶层已经看不到 `token` 键，
 *    常规清理逻辑会漏掉它 —— 登录成功后 `router.push(redirect)` 又把 token
 *    写回地址栏，并进入浏览器历史。
 * 2. 每次刷新都重新注入一次 token，行为难以预测。
 *
 * 因此：**必须在创建 router 之前、且只执行一次**。入口见 `src/router/index.ts`。
 */
const SENSITIVE_KEYS = ["token", "gatewayUrl", "session", "password"] as const;

export type UrlOverrides = {
  gatewayUrl?: string;
  token?: string;
  session?: string;
};

let cached: UrlOverrides | null = null;

function parseParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

function stripSensitive(params: URLSearchParams): boolean {
  let changed = false;
  for (const key of SENSITIVE_KEYS) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  return changed;
}

/**
 * 净化内部跳转路径：去掉 `redirect` 里可能嵌套的敏感参数。
 * 例如 `/?token=abc` → `/`。空串 / 非法值返回原值。
 */
export function sanitizeInternalPath(fullPath: string): string {
  try {
    const queryIndex = fullPath.indexOf("?");
    if (queryIndex < 0) return fullPath;
    const pathPart = fullPath.slice(0, queryIndex);
    const hashIndex = fullPath.indexOf("#", queryIndex);
    const searchPart = hashIndex < 0 ? fullPath.slice(queryIndex + 1) : fullPath.slice(queryIndex + 1, hashIndex);
    const params = new URLSearchParams(searchPart);
    const changed = stripSensitive(params);
    const search = params.toString();
    const hash = hashIndex < 0 ? "" : fullPath.slice(hashIndex);
    return changed ? `${pathPart}${search ? `?${search}` : ""}${hash}` : fullPath;
  } catch {
    return fullPath;
  }
}

function readAndStrip(): UrlOverrides {
  try {
    if (!window.location.search && !window.location.hash) return {};
    const params = new URLSearchParams(window.location.search);
    const hashParams = parseParams(window.location.hash);

    const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
    const tokenRaw = params.get("token") ?? hashParams.get("token");
    const sessionRaw = params.get("session") ?? hashParams.get("session");

    // 注意：两个分支都要执行 —— 用 `||` 会把第二个 stripSensitive 短路掉，
    // 于是「?gatewayUrl=... 在 search、#token=... 在 hash」这种组合只会清掉 search，
    // token 就留在 hash 里，登录时又被写回地址栏。
    const strippedSearch = stripSensitive(params);
    const strippedHash = stripSensitive(hashParams);
    const changed = strippedSearch || strippedHash;
    // `redirect` 里嵌套的敏感参数一并清掉（守住 router.beforeEach 那条路径）
    if (params.has("redirect")) {
      const sanitized = sanitizeInternalPath(params.get("redirect") ?? "");
      if (sanitized !== params.get("redirect")) params.set("redirect", sanitized);
    }
    if (changed || params.has("redirect")) {
      const search = params.toString();
      const hash = hashParams.toString();
      const nextUrl =
        window.location.pathname + (search ? `?${search}` : "") + (hash ? `#${hash}` : "");
      window.history.replaceState(window.history.state, "", nextUrl);
    }

    return {
      gatewayUrl: gatewayUrlRaw?.trim() || undefined,
      token: tokenRaw?.trim() || undefined,
      session: sessionRaw?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * 解析并把敏感参数从地址栏清理掉；同一页面生命周期内只真正执行一次。
 * **必须在 `createWebHistory()` 之前调用**。
 */
export function captureUrlOverridesOnce(): UrlOverrides {
  if (cached) return cached;
  cached = readAndStrip();
  return cached;
}

/** 读取已捕获的 URL 覆盖项（未捕获时返回空对象）。 */
export function getUrlOverrides(): UrlOverrides {
  return cached ?? {};
}

/**
 * 入口意图：这次访问「从哪里来、想去哪」。
 *
 * - `chat`：带 `#token=`（上游 MAAS 静默登录）或 `?session=` 进入 —— 用户的目的是对话，
 *   落地页应该是 `/chat`，而不是先甩到概览页让用户自己点一下。
 * - `overview`：普通访问（无 token / 无 session），保持概览首页。
 */
export type EntryIntent = "chat" | "overview";

export function getEntryIntent(): EntryIntent {
  const overrides = getUrlOverrides();
  return overrides.token || overrides.session ? "chat" : "overview";
}

/**
 * 入口意图对应的落地路径，供路由 `/` 的 redirect 与登录后跳转复用。
 *
 * 产品调整（2026-09-17）：落地页统一为 `/chat`，不再区分入口意图 —— 侧栏只保留「对话」，
 * 概览页不再作为默认首页。`getEntryIntent()` 仍保留，用于描述这次访问的来源。
 */
export function entryLandingPath(): string {
  return "/chat";
}
