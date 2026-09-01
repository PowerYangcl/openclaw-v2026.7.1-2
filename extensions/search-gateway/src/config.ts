// Search-gateway helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
export const DEFAULT_TIMEOUT_SECONDS = 20;

type SearchGatewayPluginConfig = {
  webSearch?: {
    baseUrl?: string;
    timeoutSeconds?: number;
  };
};

function resolveSearchGatewayWebSearchConfig(
  config?: OpenClawConfig,
): SearchGatewayPluginConfig["webSearch"] | undefined {
  const pluginConfig = config?.plugins?.entries?.["search-gateway"]?.config as
    | SearchGatewayPluginConfig
    | undefined;
  const webSearch = pluginConfig?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveBaseUrl(config?: OpenClawConfig): string {
  const baseUrl = resolveSearchGatewayWebSearchConfig(config)?.baseUrl;
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    return baseUrl.trim().replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

export function resolveTimeoutSeconds(config?: OpenClawConfig): number {
  const timeout = resolveSearchGatewayWebSearchConfig(config)?.timeoutSeconds;
  if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
    return timeout;
  }
  return DEFAULT_TIMEOUT_SECONDS;
}
