// Search-gateway client: talks to the internal Bing search gateway /search endpoint.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_SEARCH_COUNT,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveSearchCount,
  resolveSiteName,
  withSelfHostedWebSearchEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveBaseUrl, resolveTimeoutSeconds } from "./config.js";

const SG_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

export type SearchGatewayResult = {
  title: string;
  url: string;
  snippet: string;
};

type GatewaySearchResponse = {
  query?: string;
  results?: Array<{ title?: string; href?: string; body?: string }>;
  count?: number;
};

function toResult(r: { title?: string; href?: string; body?: string }): SearchGatewayResult {
  return {
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.href === "string" ? r.href : "",
    snippet: typeof r.body === "string" ? r.body : "",
  };
}

export async function runSearchGatewaySearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Promise<Record<string, unknown>> {
  const count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);
  const timeoutSeconds = resolveTimeoutSeconds(params.config);
  const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: "search-gateway",
      query: params.query,
      count,
    }),
  );

  const cached = readCache(SG_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const baseUrl = resolveBaseUrl(params.config);
  const url = `${baseUrl}/search?q=${encodeURIComponent(params.query)}&max_results=${count}`;

  const startedAt = Date.now();
  const results = await withSelfHostedWebSearchEndpoint(
    {
      url,
      timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new Error(
          `Search gateway error (${response.status}): ${detail || response.statusText}`,
        );
      }
      const text = (await readResponseText(response, { maxBytes: 256_000 })).text;
      let payload: GatewaySearchResponse;
      try {
        payload = JSON.parse(text) as GatewaySearchResponse;
      } catch {
        throw new Error("Search gateway returned non-JSON response.");
      }
      const raw = Array.isArray(payload.results) ? payload.results : [];
      return raw
        .filter((r) => (r.title && r.title.trim()) || (r.href && r.href.trim()))
        .slice(0, count)
        .map(toResult);
    },
  );

  const payload = {
    query: params.query,
    provider: "search-gateway",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "search-gateway",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: wrapWebContent(result.snippet, "web_search"),
      siteName: resolveSiteName(result.url) || undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCache(SG_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
  return payload;
}

export const testing = {
  toResult,
};
export { testing as __testing };
