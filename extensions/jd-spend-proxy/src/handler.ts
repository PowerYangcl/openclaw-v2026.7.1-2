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
  const upstreamUrl = `${base}/spend/logs/ui/${encodeURIComponent(completionId)}`;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jdConfig.apiKey}`,
        Accept: "application/json",
      },
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

  // 上游 spend 按 8 位小数定点取整后再 ×1000（整数刻度换算），避免浮点乘法
  // 把 0.163944 × 1000 算成 163.94400000000002 的尾差。
  const spend = typeof rawSpend === "number" ? Math.round(rawSpend * 1e8) / 1e5 : null;

  sendJson(res, 200, { ok: true, spend });
  return true;
}
