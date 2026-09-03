// Browser stub for @openclaw/fs-safe/config.
// The Control UI never runs fs-safe configuration in the browser; these are
// no-op shims so the shared modules that import them can be bundled.

export function configureFsSafePython(): void {}

export function getFsSafePythonConfig(): { mode: "off" } {
  return { mode: "off" };
}

export function configureFsSafeLocks(): void {}

export function getFsSafeLockConfig(): Record<string, never> {
  return {};
}
