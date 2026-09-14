// Resolves and checks packaged Control UI assets.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import * as controlUiFsRuntime from "./control-ui-assets.fs.runtime.js";
import { resolveOpenClawPackageRoot, resolveOpenClawPackageRootSync } from "./openclaw-root.js";

const CONTROL_UI_DIST_PATH_SEGMENTS = ["dist", "control-ui", "index.html"] as const;

export function resolveControlUiDistIndexPathForRoot(root: string): string {
  return path.join(root, ...CONTROL_UI_DIST_PATH_SEGMENTS);
}

type ControlUiDistIndexHealth = {
  indexPath: string | null;
  exists: boolean;
};

export async function resolveControlUiDistIndexHealth(
  opts: {
    root?: string;
    argv1?: string;
    moduleUrl?: string;
  } = {},
): Promise<ControlUiDistIndexHealth> {
  const indexPath = opts.root
    ? resolveControlUiDistIndexPathForRoot(opts.root)
    : await resolveControlUiDistIndexPath({
        argv1: opts.argv1 ?? process.argv[1],
        moduleUrl: opts.moduleUrl,
      });
  return {
    indexPath,
    exists: Boolean(indexPath && controlUiFsRuntime.existsSync(indexPath)),
  };
}

export function resolveControlUiRepoRoot(
  argv1: string | undefined = process.argv[1],
): string | null {
  if (!argv1) {
    return null;
  }
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const srcIndex = parts.lastIndexOf("src");
  if (srcIndex !== -1) {
    const root = parts.slice(0, srcIndex).join(path.sep);
    if (
      controlUiFsRuntime.existsSync(path.join(root, "ui", "vite.config.ts")) ||
      controlUiFsRuntime.existsSync(path.join(root, "web", "vite.config.ts"))
    ) {
      return root;
    }
  }

  let dir = path.dirname(normalized);
  for (let i = 0; i < 8; i++) {
    if (
      controlUiFsRuntime.existsSync(path.join(dir, "package.json")) &&
      (controlUiFsRuntime.existsSync(path.join(dir, "ui", "vite.config.ts")) ||
        controlUiFsRuntime.existsSync(path.join(dir, "web", "vite.config.ts")))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

export async function resolveControlUiDistIndexPath(
  argv1OrOpts?: string | { argv1?: string; moduleUrl?: string },
): Promise<string | null> {
  const argv1 =
    typeof argv1OrOpts === "string" ? argv1OrOpts : (argv1OrOpts?.argv1 ?? process.argv[1]);
  const moduleUrl = typeof argv1OrOpts === "object" ? argv1OrOpts?.moduleUrl : undefined;
  if (!argv1) {
    return null;
  }
  const normalized = path.resolve(argv1);
  const entrypointCandidates = [normalized];
  try {
    const realpathEntrypoint = controlUiFsRuntime.realpathSync(normalized);
    if (realpathEntrypoint !== normalized) {
      entrypointCandidates.push(realpathEntrypoint);
    }
  } catch {
    // Ignore missing/non-realpath argv1 and keep path-based candidates.
  }

  // Case 1: entrypoint is directly inside dist/ (e.g., dist/entry.js).
  // Include symlink-resolved argv1 so global wrappers (e.g. Bun) still map to dist/control-ui.
  for (const entrypoint of entrypointCandidates) {
    const distDir = path.dirname(entrypoint);
    if (path.basename(distDir) === "dist") {
      return path.join(distDir, "control-ui", "index.html");
    }
  }

  const packageRoot = await resolveOpenClawPackageRoot({ argv1: normalized, moduleUrl });
  if (packageRoot) {
    return path.join(packageRoot, "dist", "control-ui", "index.html");
  }

  // Fallback: traverse up and find package.json with name "openclaw" + dist/control-ui/index.html
  // This handles global installs where path-based resolution might fail.
  const fallbackStartDirs = new Set(
    entrypointCandidates.map((candidate) => path.dirname(candidate)),
  );
  for (const startDir of fallbackStartDirs) {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
      const pkgJsonPath = path.join(dir, "package.json");
      const indexPath = path.join(dir, "dist", "control-ui", "index.html");
      if (controlUiFsRuntime.existsSync(pkgJsonPath)) {
        try {
          const raw = controlUiFsRuntime.readFileSync(pkgJsonPath, "utf-8");
          const parsed = JSON.parse(raw) as { name?: unknown };
          if (parsed.name === "openclaw") {
            return controlUiFsRuntime.existsSync(indexPath) ? indexPath : null;
          }
          // Stop at the first package boundary to avoid resolving through unrelated ancestors.
          break;
        } catch {
          // Invalid package.json at package boundary; abort this candidate chain.
          break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  return null;
}

type ControlUiRootResolveOptions = {
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
};

function pathsMatchByRealpathOrResolve(left: string, right: string): boolean {
  let realLeft: string;
  let realRight: string;
  try {
    realLeft = controlUiFsRuntime.realpathSync(left);
  } catch {
    realLeft = path.resolve(left);
  }
  try {
    realRight = controlUiFsRuntime.realpathSync(right);
  } catch {
    realRight = path.resolve(right);
  }
  return realLeft === realRight;
}

function addCandidate(candidates: Set<string>, value: string | null) {
  if (!value) {
    return;
  }
  candidates.add(path.resolve(value));
}

export function resolveControlUiRootOverrideSync(rootOverride: string): string | null {
  const resolved = path.resolve(rootOverride);
  try {
    const stats = controlUiFsRuntime.statSync(resolved);
    if (stats.isFile()) {
      return path.basename(resolved) === "index.html" ? path.dirname(resolved) : null;
    }
    if (stats.isDirectory()) {
      const indexPath = path.join(resolved, "index.html");
      return controlUiFsRuntime.existsSync(indexPath) ? resolved : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveControlUiRootSync(opts: ControlUiRootResolveOptions = {}): string | null {
  const candidates = new Set<string>();
  const argv1 = opts.argv1 ?? process.argv[1];
  const cwd = opts.cwd ?? process.cwd();
  const moduleDir = opts.moduleUrl ? path.dirname(fileURLToPath(opts.moduleUrl)) : null;
  const argv1Dir = argv1 ? path.dirname(path.resolve(argv1)) : null;
  const argv1RealpathDir = (() => {
    if (!argv1) {
      return null;
    }
    try {
      return path.dirname(controlUiFsRuntime.realpathSync(path.resolve(argv1)));
    } catch {
      return null;
    }
  })();
  const execDir = (() => {
    try {
      const execPath = opts.execPath ?? process.execPath;
      return path.dirname(controlUiFsRuntime.realpathSync(execPath));
    } catch {
      return null;
    }
  })();
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1,
    moduleUrl: opts.moduleUrl,
    cwd,
  });

  // Packaged app: prefer bundled resources, then support legacy alongside-executable layout.
  addCandidate(candidates, execDir ? path.join(execDir, "../Resources/control-ui") : null);
  addCandidate(candidates, execDir ? path.join(execDir, "control-ui") : null);
  if (moduleDir) {
    // dist/<bundle>.js -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "control-ui"));
    // dist/gateway/control-ui.js -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "../control-ui"));
    // src/gateway/control-ui.ts -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "../../dist/control-ui"));
    // src/infra/control-ui-assets.ts -> web/dist (new Vue 3 UI)
    addCandidate(candidates, path.join(moduleDir, "../../web/dist"));
  }
  if (argv1Dir) {
    // openclaw.mjs or dist/<bundle>.js
    addCandidate(candidates, path.join(argv1Dir, "dist", "control-ui"));
    addCandidate(candidates, path.join(argv1Dir, "control-ui"));
    // New Vue 3 UI lives at <repo>/web/dist
    addCandidate(candidates, path.join(argv1Dir, "web", "dist"));
  }
  if (argv1RealpathDir && argv1RealpathDir !== argv1Dir) {
    // Symlinked wrappers (e.g. ~/.bun/bin/openclaw -> .../dist/index.js)
    addCandidate(candidates, path.join(argv1RealpathDir, "dist", "control-ui"));
    addCandidate(candidates, path.join(argv1RealpathDir, "control-ui"));
    addCandidate(candidates, path.join(argv1RealpathDir, "web", "dist"));
  }
  if (packageRoot) {
    addCandidate(candidates, path.join(packageRoot, "dist", "control-ui"));
    addCandidate(candidates, path.join(packageRoot, "web", "dist"));
  }
  addCandidate(candidates, path.join(cwd, "dist", "control-ui"));
  addCandidate(candidates, path.join(cwd, "web", "dist"));

  for (const dir of candidates) {
    const indexPath = path.join(dir, "index.html");
    if (controlUiFsRuntime.existsSync(indexPath)) {
      return dir;
    }
  }
  return null;
}

export function isPackageProvenControlUiRootSync(
  root: string,
  opts: ControlUiRootResolveOptions = {},
): boolean {
  const argv1 = opts.argv1 ?? process.argv[1];
  const cwd = opts.cwd ?? process.cwd();
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1,
    moduleUrl: opts.moduleUrl,
    cwd,
  });
  if (!packageRoot) {
    return false;
  }
  const packageDistRoot = path.join(packageRoot, "dist", "control-ui");
  return pathsMatchByRealpathOrResolve(root, packageDistRoot);
}

type EnsureControlUiAssetsResult = {
  ok: boolean;
  built: boolean;
  message?: string;
};

function summarizeCommandOutput(text: string): string | undefined {
  const lines = normalizeStringEntries(text.split(/\r?\n/g));
  if (!lines.length) {
    return undefined;
  }
  const last = lines.at(-1);
  if (!last) {
    return undefined;
  }
  return last.length > 240 ? `${truncateUtf16Safe(last, 239)}…` : last;
}

export async function ensureControlUiAssetsBuilt(
  runtime: RuntimeEnv = defaultRuntime,
  opts?: { timeoutMs?: number },
): Promise<EnsureControlUiAssetsResult> {
  const health = await resolveControlUiDistIndexHealth({ argv1: process.argv[1] });
  const indexFromDist = health.indexPath;
  if (health.exists) {
    return { ok: true, built: false };
  }

  const repoRoot = resolveControlUiRepoRoot(process.argv[1]);
  if (!repoRoot) {
    const hint = indexFromDist
      ? `Missing Control UI assets at ${indexFromDist}`
      : "Missing Control UI assets";
    return {
      ok: false,
      built: false,
      message: `${hint}. Build them with \`pnpm web:build\` (auto-installs web deps).`,
    };
  }

  const indexPath = resolveControlUiDistIndexPathForRoot(repoRoot);
  const webIndexPath = path.join(repoRoot, "web", "dist", "index.html");
  if (controlUiFsRuntime.existsSync(indexPath) || controlUiFsRuntime.existsSync(webIndexPath)) {
    return { ok: true, built: false };
  }

  const legacyUiScript = path.join(repoRoot, "scripts", "ui.js");
  const webScript = path.join(repoRoot, "scripts", "web.js");
  // Decide which build script to try. Both scripts are optional in the source
  // checkout. Existing UI behavior (Lit + dist/control-ui) must remain working:
  // - If scripts/ui.js exists, use it as the primary path (unchanged behavior).
  // - If only scripts/web.js exists (web/ is the only UI), use it.
  // - If both exist (transition period), try web.js first and fall back to
  //   ui.js so a partial web/ checkout does not break the legacy UI flow.
  const candidates = [webScript, legacyUiScript].filter((p) => controlUiFsRuntime.existsSync(p));
  if (candidates.length === 0) {
    return {
      ok: false,
      built: false,
      message: `Control UI assets missing but neither ${webScript} nor ${legacyUiScript} is available.`,
    };
  }

  let lastBuild = null;
  for (const candidate of candidates) {
    const label = candidate === webScript ? "web:build" : "ui:build";
    runtime.log(`Control UI assets missing; building (${label}, auto-installs deps)…`);
    const build = await runCommandWithTimeout([process.execPath, candidate, "build"], {
      cwd: repoRoot,
      timeoutMs: opts?.timeoutMs ?? 10 * 60_000,
    });
    lastBuild = build;
    if (build.code === 0) {
      break;
    }
    // First script failed; if a fallback candidate remains, log the warning
    // and continue. We surface the last failure to the caller only after all
    // candidates are exhausted.
    const candidateIndex = candidates.indexOf(candidate);
    if (candidateIndex < candidates.length - 1) {
      const next = candidates[candidateIndex + 1];
      const nextLabel = next === webScript ? "web:build" : "ui:build";
      runtime.log(`Control UI build via ${label} failed; falling back to ${nextLabel}.`);
    }
  }
  if (!lastBuild || lastBuild.code !== 0) {
    return {
      ok: false,
      built: false,
      message: `Control UI build failed: ${summarizeCommandOutput(lastBuild?.stderr) ?? `exit ${lastBuild?.code ?? "?"}`}`,
    };
  }

  if (!controlUiFsRuntime.existsSync(indexPath) && !controlUiFsRuntime.existsSync(webIndexPath)) {
    return {
      ok: false,
      built: true,
      message: `Control UI build completed but neither ${indexPath} nor ${webIndexPath} is present.`,
    };
  }

  return { ok: true, built: true };
}
