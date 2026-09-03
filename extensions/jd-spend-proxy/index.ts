/**
 * JD spend proxy plugin entry. Exposes a gateway-authenticated HTTP endpoint
 * to proxy spend queries for the jd-llm provider.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { handleJdSpendRequest } from "./src/handler.js";

export default definePluginEntry({
  id: "jd-spend-proxy",
  name: "JD Spend Proxy",
  description: "Proxy jd-llm spend queries for the frontend",
  register(api) {
    api.registerHttpRoute({
      path: "/api/v1/jd/spend",
      auth: "plugin",
      match: "prefix",
      handler: handleJdSpendRequest,
    });
  },
});
