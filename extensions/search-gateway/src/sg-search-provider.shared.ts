// Search-gateway provider module implements model/runtime integration.
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

const SEARCH_GATEWAY_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];

export function createSearchGatewayWebSearchProviderBase() {
  return {
    id: "search-gateway",
    label: "Search Gateway (internal Bing)",
    hint: "Web search through the internal Bing search gateway (no API key required)",
    onboardingScopes: [...SEARCH_GATEWAY_ONBOARDING_SCOPES],
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 200,
    credentialPath: "",
    ...createWebSearchProviderContractFields({
      credentialPath: "",
      searchCredential: { type: "scoped", scopeId: "search-gateway" },
      selectionPluginId: "search-gateway",
    }),
  };
}
