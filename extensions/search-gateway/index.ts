// Search-gateway plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSearchGatewayWebSearchProvider } from "./src/sg-search-provider.js";

export default definePluginEntry({
  id: "search-gateway",
  name: "Search Gateway Plugin",
  description: "Bundled internal Bing search gateway web-search plugin",
  register(api) {
    api.registerWebSearchProvider(createSearchGatewayWebSearchProvider());
  },
});
