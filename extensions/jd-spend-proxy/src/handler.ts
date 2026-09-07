/**
 * HTTP handler for the JD spend proxy endpoint.
 * Reads jd-llm provider config and proxies the spend query to the upstream API.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function resolveJdLlmConfig(): { apiKey: string; spendBaseUrl: string } | null {
  const config = getRuntimeConfig();
  if (!config) return null;
  // apiKey from models.providers.jd-llm
  const models = config.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;
  const jdLlm = providers?.["jd-llm"] as Record<string, unknown> | undefined;
  if (!jdLlm) return null;
  const apiKey = typeof jdLlm.apiKey === "string" ? jdLlm.apiKey : "";
  // spendBaseUrl from models.providers.jd-llm.baseUrl
  const spendBaseUrl = typeof jdLlm.baseUrl === "string" ? jdLlm.baseUrl : "";
  if (!apiKey || !spendBaseUrl) return null;
  return { apiKey, spendBaseUrl };
}

function extractCompletionId(url: string): string | null {
  // Matches /api/v1/jd/spend/:completionId
  const match = /\/api\/v1\/jd\/spend\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]!) : null;
}

function extractIncludeKeyInfo(url: string): boolean {
  // Parse ?include_key_info=true from request URL
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return false;
  const query = url.slice(qIdx + 1);
  const params = new URLSearchParams(query);
  const v = params.get("include_key_info");
  return v === "true" || v === "1";
}

/** Handle one gateway-authenticated JD spend proxy request. */
export async function handleJdSpendRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, {
      ok: false,
      error: { type: "method_not_allowed", message: "Method Not Allowed" },
    });
    return true;
  }

  const completionId = extractCompletionId(req.url ?? "");
  if (!completionId) {
    sendJson(res, 400, {
      ok: false,
      error: { type: "invalid_request", message: "Missing completionId" },
    });
    return true;
  }

  const jdConfig = resolveJdLlmConfig();
  if (!jdConfig) {
    sendJson(res, 503, {
      ok: false,
      error: {
        type: "unavailable",
        message: "jd-llm provider not configured or spendBaseUrl missing",
      },
    });
    return true;
  }

  const base = jdConfig.spendBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const includeKeyInfo = extractIncludeKeyInfo(req.url ?? "");
  const upstreamUrl = includeKeyInfo
    ? `${base}/spend/logs/ui/${encodeURIComponent(completionId)}?include_key_info=true`
    : `${base}/spend/logs/ui/${encodeURIComponent(completionId)}`;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jdConfig.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: { type: "upstream_error", message: String(err) } });
    return true;
  }

  if (upstreamRes.status === 202) {
    sendJson(res, 202, {
      ok: false,
      error: { type: "pending", message: "spend data not ready yet" },
    });
    return true;
  }

  if (!upstreamRes.ok) {
    sendJson(res, upstreamRes.status, {
      ok: false,
      error: { type: "upstream_error", message: `upstream returned ${upstreamRes.status}` },
    });
    return true;
  }

  let data: unknown;
  try {
    data = await upstreamRes.json();
  } catch {
    sendJson(res, 502, {
      ok: false,
      error: { type: "upstream_error", message: "upstream returned invalid JSON" },
    });
    return true;
  }

  const record = data as Record<string, unknown>;
  const rawSpend = record?.spend;
  // rawSpend × 1000 后保留两位小数：先整体放大到 ×1e5 取整，再 ÷100，
  // 全程只有一次浮点乘法,最终除法结果为精确两位小数，不会产生尾差。
  const spend = typeof rawSpend === "number" ? Math.round(rawSpend * 1e5) / 100 : null;

  // balance：上游 spend ready 时 key.balance 是"上一轮"的旧值（不包含当次消费）。
  // handler 额外再 fetch 一次同 URL，等上游把当次消费累加完再覆盖。
  // 对前端等效"前端多请求一次 v1/jd/spend"——后端内部完成，前端 HTTP 仍只发一次。
  // 重试失败/上游未返回 key 字段时回退到第一次结果。
  // 长重试（指数退避）由前端 fetchJdSpend 承担。
  const firstKey = record?.key as Record<string, unknown> | undefined;
  let rawBalance: number | null = typeof firstKey?.balance === "number" ? firstKey.balance : null;
  try {
    const retryRes = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jdConfig.apiKey}`,
        Accept: "application/json",
      },
    });
    if (retryRes.ok) {
      const data2 = (await retryRes.json()) as Record<string, unknown>;
      const key2 = data2?.key as Record<string, unknown> | undefined;
      if (typeof key2?.balance === "number") rawBalance = key2.balance;
    }
  } catch {
    // 忽略额外请求错误，使用第一次结果
  }
  const balance = rawBalance !== null ? Math.round(rawBalance * 1e5) / 100 : null;

  sendJson(res, 200, { ok: true, spend, balance });
  return true;
}
