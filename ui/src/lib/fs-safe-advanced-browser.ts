// Browser stub for @openclaw/fs-safe/advanced.
// The Control UI pulls this module in transitively (e.g. via the logger), but
// the underlying node filesystem implementation is not usable in the browser
// and its node:path usage crashes when bundled. These shims only need to exist
// so the shared modules can be bundled; they throw if actually invoked.

function unavailable(name: string): never {
  throw new Error(`fs-safe/${name} is not available in the browser`);
}

export type RegularFileStatResult = {
  size: number;
  mtimeMs: number;
};

export function appendRegularFile(): never {
  unavailable("appendRegularFile");
}
export function appendRegularFileSync(): never {
  unavailable("appendRegularFileSync");
}
export function readRegularFile(): never {
  unavailable("readRegularFile");
}
export function readRegularFileSync(): never {
  unavailable("readRegularFileSync");
}
export function resolveRegularFileAppendFlags(): never {
  unavailable("resolveRegularFileAppendFlags");
}
export function statRegularFile(): never {
  unavailable("statRegularFile");
}
export function statRegularFileSync(): never {
  unavailable("statRegularFileSync");
}
