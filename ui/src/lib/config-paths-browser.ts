// Browser-safe stub for src/config/paths.ts.
//
// The Control UI bundle transitively pulls in the CLI module graph, which
// imports node-only filesystem path helpers from config/paths. Those modules
// perform top-level fs/path side effects (STATE_DIR / CONFIG_PATH) that crash
// in the browser once node:path/node:fs are externalized to empty objects
// (`default.join is not a function`).
//
// The UI never actually reads these values at runtime, so this stub provides
// the same named exports with no node:fs / node:path usage and no top-level
// side effects. Keep the export surface in sync with config/paths.ts.

import type { OpenClawConfig } from "../../../src/config/types.js";

export const DEFAULT_GATEWAY_PORT = 18789;

export function resolveIsNixMode(): boolean {
  return false;
}

export let isNixMode = false;

export let STATE_DIR = "";

export let CONFIG_PATH = "";

export function resolveStateDir(): string {
  return "";
}

export function normalizeStateDirEnv(): void {}

export function resolveLegacyStateDirs(): string[] {
  return [];
}

export function resolveNewStateDir(): string {
  return "";
}

export function resolveIncludeRoots(): string[] {
  return [];
}

export function resolveConfigPathCandidate(): string {
  return "";
}

export function resolveConfigPath(): string {
  return "";
}

export function resolveDefaultConfigCandidates(): string[] {
  return [];
}

export function pinRuntimePaths(): { configPath: string; stateDir: string } {
  return { configPath: CONFIG_PATH, stateDir: STATE_DIR };
}

export function resolveGatewayLockDir(): string {
  return "";
}

export function resolveOAuthDir(): string {
  return "";
}

export function resolveOAuthPath(): string {
  return "";
}

export function resolveGatewayPort(cfg?: OpenClawConfig): number {
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) {
    return configPort;
  }
  return DEFAULT_GATEWAY_PORT;
}
