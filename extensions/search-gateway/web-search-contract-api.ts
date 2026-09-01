// Search-gateway API module exposes the plugin public contract.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createSearchGatewayWebSearchProviderBase } from "./src/sg-search-provider.shared.js";

export function createSearchGatewayWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createSearchGatewayWebSearchProviderBase(),
    createTool: () => null,
  };
}
