// Search-gateway tests cover sg search provider plugin behavior.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchGatewayWebSearchProvider as createSearchGatewayWebSearchContractProvider } from "../web-search-contract-api.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_SECONDS,
  resolveBaseUrl,
  resolveTimeoutSeconds,
} from "./config.js";

const { runSearchGatewaySearch } = vi.hoisted(() => ({
  runSearchGatewaySearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

vi.mock("./sg-client.js", () => ({
  runSearchGatewaySearch,
}));

describe("search-gateway web search provider", () => {
  let createSearchGatewayWebSearchProvider: typeof import("./sg-search-provider.js").createSearchGatewayWebSearchProvider;

  afterAll(() => {
    vi.doUnmock("./sg-client.js");
    vi.resetModules();
  });

  beforeAll(async () => {
    ({ createSearchGatewayWebSearchProvider } = await import("./sg-search-provider.js"));
    await import("../index.js");
  });

  beforeEach(() => {
    runSearchGatewaySearch.mockReset();
    runSearchGatewaySearch.mockImplementation(async (params: Record<string, unknown>) => params);
  });

  it("exposes keyless metadata and enables the plugin in config", () => {
    const provider = createSearchGatewayWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("search-gateway");
    expect(provider.label).toBe("Search Gateway (internal Bing)");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(createSearchGatewayWebSearchContractProvider().onboardingScopes).toEqual([
      "text-inference",
    ]);
    expect(provider.requiresCredential).toBe(false);
    expect(provider.credentialPath).toBe("");
    const pluginEntry = applied.plugins?.entries?.["search-gateway"];
    if (!pluginEntry) {
      throw new Error("expected search-gateway plugin entry");
    }
    expect(pluginEntry.enabled).toBe(true);
  });

  it("maps generic tool arguments into search-gateway params", async () => {
    const provider = createSearchGatewayWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "openclaw docs",
      count: 4,
    });

    expect(runSearchGatewaySearch).toHaveBeenCalledWith({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
    });
    expect(result).toEqual({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
    });
  });

  it("rejects fractional and out-of-range counts before searching", async () => {
    const provider = createSearchGatewayWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(tool.execute({ query: "openclaw docs", count: 4.5 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    await expect(tool.execute({ query: "openclaw docs", count: 11 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    expect(runSearchGatewaySearch).not.toHaveBeenCalled();
  });

  it("reads base url and timeout from plugin config with sane defaults", () => {
    expect(resolveBaseUrl(undefined)).toBe(DEFAULT_BASE_URL);
    expect(resolveTimeoutSeconds(undefined)).toBe(DEFAULT_TIMEOUT_SECONDS);

    expect(
      resolveBaseUrl({
        plugins: {
          entries: {
            "search-gateway": {
              config: {
                webSearch: {
                  baseUrl: "http://127.0.0.1:9999/",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("http://127.0.0.1:9999"); // trailing slash trimmed

    expect(
      resolveTimeoutSeconds({
        plugins: {
          entries: {
            "search-gateway": {
              config: {
                webSearch: {
                  timeoutSeconds: 7,
                },
              },
            },
          },
        },
      } as never),
    ).toBe(7);
  });
});
