// Search-gateway provider module implements model/runtime integration.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createSearchGatewayWebSearchProviderBase } from "./sg-search-provider.shared.js";

const loadSearchGatewayClientModule = createLazyRuntimeModule(() => import("./sg-client.js"));

const SearchGatewaySearchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
  },
  required: ["query"],
} satisfies Record<string, unknown>;

export function createSearchGatewayWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createSearchGatewayWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web through the internal Bing search gateway. Returns titles, URLs, and snippets. No API key required.",
      parameters: SearchGatewaySearchSchema,
      execute: async (args) => {
        const { runSearchGatewaySearch } = await loadSearchGatewayClientModule();
        return await runSearchGatewaySearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readPositiveIntegerParam(args, "count", {
            max: 10,
            message: "count must be an integer from 1 to 10.",
          }),
        });
      },
    }),
  };
}
