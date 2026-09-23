#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Control UI 更新包打包器
//
//   产物：web/release/update-<id>.zip
//           ├── update-config.json   ← 版本 id / 网关重启命令 / 落地映射
//           └── dist.zip             ← 前端产物（内容直放根目录，无 dist/ 前缀）
//
// 用法：
//   node scripts/pack-update.mjs                 构建 + 打包（默认）
//   node scripts/pack-update.mjs --no-build      跳过构建，用现有 web/dist
//   node scripts/pack-update.mjs --id=v20260921150333
//   node scripts/pack-update.mjs --desc="xxx"    覆盖描述
//   node scripts/pack-update.mjs --prepare-only  只准备 release/<id>/ 暂存目录，不压缩
//   node scripts/pack-update.mjs --verify-only=<某个 dist.zip>   体检结构，不打包
//   node scripts/pack-update.mjs --with-templates[=<目标目录>]
//                                  额外打一份工作区模板包（默认 /app/src/agents/templates），
//                                  用于修复「打包漏带 src/agents/templates，网关每条消息全挂」
//
// 版本号规则：v + 14 位时间戳（YYYYMMDDHHmmss）
//   例：v20260921150333  →  update-v20260921150333.zip
//   （生成器是 deploy-lib 的 makeUpdateId()，与写进 dist/sw.js 的缓存 build id 是两套编号）
//
// ⚠️ dist.zip 的内容必须**直放根目录**（不是先套一层 dist/）。
//    落地映射是 `dist.zip -> /app/web/dist`，解包即把压缩包内容铺进该目录；
//    若压缩包内自带 dist/ 前缀，结果会变成 /app/web/dist/dist/…，前端 404 白屏。
//    本脚本末尾有硬断言拦截这种错误（见 verifyDistZip）。
//
// ⚠️ 工作区模板（--with-templates）：`src/agents/templates/*.md` 是运行期**兜底**模板目录，
//    与 `docs/reference/templates/` 并列在搜索路径里。两者都缺时，`loadTemplate()` 会抛
//    `Missing workspace template: AGENTS.md (<模板目录>/AGENTS.md)`，而该抛错发生在
//    `ensureAgentWorkspace()` 最前面 ⇒ 整台网关**每条消息**都是「生成失败」，与工作区是否
//    已初始化无关。所以模板必须随包投递，且落在 <packageRoot>/src/agents/templates。
//    未加 --with-templates 时行为与历史完全一致（只出 dist.zip）。
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { execute, readConfig, makeUpdateId, UPDATE_ID_RE } from "./deploy-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const distDir = path.join(webRoot, "dist");
const releaseDir = path.join(webRoot, "release");
const templatePath = path.join(webRoot, "update-config.json");

const DEFAULT_HOST = "http://116.198.29.26:8080";
const REQUIRED_KEYS = ["id", "description", "gateway", "cmd"];

const repoRoot = path.resolve(webRoot, "..");
const templatesSourceDir = path.join(repoRoot, "src", "agents", "templates");
const TEMPLATES_ZIP_NAME = "templates.zip";
const DEFAULT_TEMPLATES_TARGET = "/app/src/agents/templates";
// 工作区引导模板：AGENTS/SOUL/TOOLS/IDENTITY/USER/BOOTSTRAP 来自 docs（读时剥 frontmatter），
// HEARTBEAT 只在运行期目录里。缺任何一个都可能让对应平台/形状的部署整台挂掉。
const WORKSPACE_TEMPLATE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
}

const id = String(flags.id || makeUpdateId()).trim();
if (!UPDATE_ID_RE.test(id)) {
  console.error(`版本 id 不符合规则 v+14位时间戳(YYYYMMDDHHmmss)：${id}`);
  console.error("例：v20260921150333  →  update-v20260921150333.zip");
  process.exit(2);
}
const shouldBuild = flags.build !== false && !flags["no-build"];
const baseUrl = String(flags["base-url"] || DEFAULT_HOST).replace(/\/+$/, "");
// ⚠️ 头部注释一直写着 --desc= 但从未实现（描述只能改 update-config.json）。这里补上。
const description =
  typeof flags.desc === "string" && flags.desc ? String(flags.desc) : undefined;
const templatesFlag = flags["with-templates"];
const withTemplates = templatesFlag !== undefined && templatesFlag !== false;
const templatesTarget =
  typeof templatesFlag === "string" && templatesFlag ? templatesFlag : DEFAULT_TEMPLATES_TARGET;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sh(cmd, args, { cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const tail = [];
    const pipe = (stream) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (c) => {
        buf += c;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          if (l.trim()) {
            tail.length < 30 ? tail.push(l) : (tail.shift(), tail.push(l));
            onLine?.(l);
          }
        }
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("error", (e) => reject(new Error(`${cmd} 启动失败：${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}\n${tail.slice(-10).join("\n")}`)),
    );
  });
}

/** 用 unzip -Z1 拿条目名（裸名，无长度/日期列） */
async function listZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/unzip", ["-Z1", zipPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      code === 0
        ? resolve(out.split("\n").map((s) => s.trim()).filter(Boolean))
        : reject(new Error(`unzip -Z1 ${zipPath} 失败：${err.trim()}`)),
    );
  });
}

function fail(msg) {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
async function verifyDistZip(zipPath) {
  const entries = await listZipEntries(zipPath);
  if (entries.length === 0) fail("dist.zip 是空的");

  // ⚠️ unzip -Z1 对目录条目会带尾斜杠（assets/），比较前必须归一化，
  //    否则 includes("assets") 恒假 —— 曾因此误报「根目录没有 assets」。
  const norm = (e) => e.replace(/^\.\//, "").replace(/\/+$/, "");
  const bare = entries.map(norm).filter(Boolean);
  const topLevel = new Set(bare.map((e) => e.split("/")[0]));

  // 断言 1：index.html 必须在根，不能是 dist/index.html 这种被套了一层的
  if (!bare.includes("index.html")) {
    const wrapped = bare.find((e) => /^[^/]+\/index\.html$/.test(e));
    fail(
      wrapped
        ? `dist.zip 里 index.html 被套了一层目录（实际是 ${wrapped}）。\n` +
          "  落地映射 dist.zip -> /app/web/dist 会把内容直接铺进去，套一层会变成 /app/web/dist/" +
          `${wrapped.split("/")[0]}/… ，前端会 404 白屏。\n` +
          "  重新打包时请用 `cd dist && zip -r ../dist.zip .`（内容直放根）。"
        : "dist.zip 里找不到 index.html，产物不完整",
    );
  }
  // 断言 2：sw.js 必须在根（PWA 缓存版本文件）
  if (!bare.includes("sw.js")) fail("dist.zip 里根目录没有 sw.js");
  // 断言 3：assets 必须在根
  if (!bare.includes("assets")) fail("dist.zip 里根目录没有 assets/");
  // 断言 4：不接受以 dist/ 开头的一整棵（就是参考目录那份坏包的特征）
  if (topLevel.size === 1 && topLevel.has("dist")) {
    fail("dist.zip 只有一层 dist/ 目录，正是需要修掉的错误形态");
  }
  return { entries, bare };
}

async function verifyOuterZip(zipPath, allowedEntries = []) {
  const entries = await listZipEntries(zipPath);
  const bare = entries.map((e) => e.replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  const want = ["update-config.json", "dist.zip"];
  const missing = want.filter((w) => !bare.includes(w));
  if (missing.length) fail(`外层包缺少：${missing.join(", ")}（实际 ${bare.join(", ")}）`);
  const declared = new Set([...want, ...allowedEntries]);
  const extra = bare.filter((b) => !declared.has(b));
  if (extra.length) fail(`外层包含多余条目：${extra.join(", ")}`);
  return bare;
}

/** 体检工作区模板包：必须是 *.md 直放根，不能套一层目录。 */
async function verifyTemplatesZip(zipPath) {
  const entries = await listZipEntries(zipPath);
  const bare = entries.map((e) => e.replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  if (bare.length === 0) fail(`${TEMPLATES_ZIP_NAME} 是空的`);
  const nested = bare.filter((e) => e.includes("/"));
  if (nested.length) {
    fail(
      `${TEMPLATES_ZIP_NAME} 里出现了子目录：${nested.join(", ")}\n` +
        `  落地映射是 ${TEMPLATES_ZIP_NAME} -> <模板目录>，模板必须直放根（cd 模板目录 && zip -j 包.zip *.md）。`,
    );
  }
  const missing = WORKSPACE_TEMPLATE_FILES.filter((f) => !bare.includes(f));
  if (missing.length) fail(`${TEMPLATES_ZIP_NAME} 里缺少模板：${missing.join(", ")}`);
  return bare;
}

/** 打工作区模板包（内容直放根，仅 *.md）。 */
async function buildTemplatesZip(stageDir) {
  for (const f of WORKSPACE_TEMPLATE_FILES) {
    if (!fs.existsSync(path.join(templatesSourceDir, f))) {
      fail(`模板源文件不存在：${path.join(templatesSourceDir, f)}`);
    }
  }
  const zipPath = path.join(stageDir, TEMPLATES_ZIP_NAME);
  await sh("/usr/bin/zip", ["-q", "-j", zipPath, ...WORKSPACE_TEMPLATE_FILES], {
    cwd: templatesSourceDir,
  });
  return zipPath;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
// 0) --verify-only=<zip>：只体检一个已有 dist.zip 的结构，不构建不打包
if (flags["verify-only"]) {
  const target = String(flags["verify-only"]);
  if (!fs.existsSync(target)) fail(`找不到 ${target}`);
  const { bare } = await verifyDistZip(target);
  const top = [...new Set(bare.map((e) => e.split("/")[0]))];
  console.log(`✔ ${path.basename(target)} 结构正确`);
  console.log(`  顶层条目：${top.join(", ")}`);
  console.log(`  index.html / sw.js / assets 均在根 —— 解包到 /app/web/dist 布局正确`);
  process.exit(0);
}

console.log(`\n发布版本：${id}`);
console.log(`产物目录：${releaseDir}\n`);

// 1) 读模板
if (!fs.existsSync(templatePath)) fail(`找不到更新包模板 ${templatePath}`);
let template;
try {
  template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
} catch (e) {
  fail(`模板 JSON 解析失败：${e.message}`);
}
for (const k of REQUIRED_KEYS) {
  if (!(k in template)) fail(`模板缺少必需字段：${k}`);
}
if (!template.zip || typeof template.zip !== "object" || !Object.keys(template.zip).length) {
  fail("模板的 zip 映射为空，更新器没有可落地的内容");
}
console.log(`模板：${path.relative(webRoot, templatePath)}`);
console.log(`  gateway   : ${JSON.stringify(template.gateway)}`);
console.log(`  cmd       : ${JSON.stringify(template.cmd)}`);
console.log(`  zip 映射  : ${JSON.stringify(template.zip)}`);

// 2) 构建（复用发布面板同一条流水线，保证 build 行为一致）
if (shouldBuild) {
  const buildMode = readConfig().version.buildMode;
  console.log(`\n[构建] 复用 deploy-lib 的 build 步骤（vue-tsc + vite build），mode=${buildMode}`);
  // ⚠️ 发生产版却用 pre/dev 模式是很容易踩的坑（.env.prod 与 .env.pre 只差
  //    VITE_APP_ENV，而源码未引用该变量 ⇒ 实测产物字节一致，所以这里只警告不阻断）。
  if (buildMode !== "prod" && buildMode !== "none") {
    console.log(
      `  ⚠ version.buildMode = "${buildMode}"，不是 prod。\n` +
        `    当前实测：.env.prod / .env.pre 仅差 VITE_APP_ENV，源码未引用它 ⇒ 产物字节一致，\n` +
        `    所以本次不会有实际影响；但若是将来有人引用了该变量，这里就会发错环境。\n` +
        `    建议在面板里改回 prod，或 node scripts/deploy-cli.mjs --buildMode=prod 覆盖。`,
    );
  }
  await execute({
    only: ["build"],
    onEvent(e) {
      if (e.type === "log") {
        if (e.level === "err") console.error(`  ${e.line}`);
        else if (!/^\s*(transforming|rendering|computing)/.test(e.line)) console.log(`  ${e.line}`);
      }
    },
  });
} else {
  console.log("\n[构建] 已跳过（--no-build），直接使用现有 dist/");
}

if (!fs.existsSync(path.join(distDir, "index.html"))) fail(`dist/index.html 不存在，构建产物异常`);

const swVersion = (() => {
  try {
    const m = fs.readFileSync(path.join(distDir, "sw.js"), "utf8").match(/const EMBEDDED_CACHE_VERSION = "([^"]*)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
})();
console.log(`  产物 sw.js 缓存版本：${swVersion ?? "(未识别)"}`);

// 3) 准备暂存目录
const stageDir = path.join(releaseDir, id);
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

// 4) 打 dist.zip —— 内容直放根（cd dist && zip -r ../x.zip .）
const distZipPath = path.join(stageDir, "dist.zip");
await sh("/usr/bin/zip", ["-r", "-q", distZipPath, "."], { cwd: distDir });
console.log(`\n[dist.zip] ${(fs.statSync(distZipPath).size / 1024 / 1024).toFixed(2)} MB`);
const distCheck = await verifyDistZip(distZipPath);
const topCount = new Set(distCheck.bare.map((e) => e.split("/")[0])).size;
console.log(`  ✔ 顶层条目 ${topCount} 个，含 index.html / sw.js / assets —— 无 dist/ 前缀套层`);

// 4b) 可选：打工作区模板包（修复打包漏带 src/agents/templates）
let templatesZipPath = null;
if (withTemplates) {
  templatesZipPath = await buildTemplatesZip(stageDir);
  const files = await verifyTemplatesZip(templatesZipPath);
  console.log(
    `\n[${TEMPLATES_ZIP_NAME}] ${(fs.statSync(templatesZipPath).size / 1024).toFixed(1)} KB  ` +
      `-> ${templatesTarget}`,
  );
  console.log(`  ✔ ${files.length} 个模板直放根：${files.join(", ")}`);
}

// 5) 写 update-config.json（id 用本次生成的版本号）
const config = { ...template, id };
if (description !== undefined) {
  config.description = description;
}
if (templatesZipPath) {
  config.zip = { ...config.zip, [TEMPLATES_ZIP_NAME]: templatesTarget };
}
const configPath = path.join(stageDir, "update-config.json");
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`\n[update-config.json]`);
console.log(JSON.stringify(config, null, 2).split("\n").map((l) => "  " + l).join("\n"));

// 6) 组装外层包
const outName = `update-${id}.zip`;
const outPath = path.join(releaseDir, outName);
if (flags["prepare-only"]) {
  console.log(`\n（--prepare-only：只保留暂存目录，未生成外层包）`);
} else {
  fs.rmSync(outPath, { force: true });
  const members = [configPath, distZipPath, ...(templatesZipPath ? [templatesZipPath] : [])];
  await sh("/usr/bin/zip", ["-q", "-j", outPath, ...members]);
  await verifyOuterZip(outPath, templatesZipPath ? [TEMPLATES_ZIP_NAME] : []);
  console.log(`\n[更新包] release/${outName}  ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(
    `  ✔ 内含 update-config.json + dist.zip${templatesZipPath ? ` + ${TEMPLATES_ZIP_NAME}` : ""}，无多余条目`,
  );
  if (templatesZipPath) {
    // 另存一份「只含模板」的热修包：没有投递通道/更新器不支持多条目时，
    // 直接解到容器的 <packageRoot>/src/agents/templates 即可（免重启，见 memory 记录）。
    const hotfixPath = path.join(releaseDir, `templates-hotfix-${id}.zip`);
    fs.copyFileSync(templatesZipPath, hotfixPath);
    console.log(`  ✔ 另存模板热修包 release/templates-hotfix-${id}.zip（可单独投递）`);
  }
}

// 7) 结束提示
const url = `${baseUrl}/${outName}`;
console.log(`
──────────────────────────────────────────────────────────
版本    ${id}
产物    ${flags["prepare-only"] ? "(未生成，仅暂存)" : outPath}
暂存    ${stageDir}/   （update-config.json + dist.zip）
发布地址（上传到 ${baseUrl} 后生效）
        ${url}

部署后验证是否真的生效：
  curl -s <网关地址>/sw.js | grep EMBEDDED_CACHE_VERSION
  → 期望 ${swVersion ?? "<git 推导的 build id>"}
──────────────────────────────────────────────────────────

上传（需要该主机的 SSH 凭据）：
  scp "${outPath}" <user>@<host>:<nginx 站点目录>/
`);
