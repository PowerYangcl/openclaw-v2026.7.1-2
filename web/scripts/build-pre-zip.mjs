#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(webRoot, "dist");
const deployDir = path.join(webRoot, "deploy");
const configPath = path.join(deployDir, "update-config.json");
const downloadBaseUrl = "http://116.198.29.26:8080";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} 执行失败，退出码：${code}`));
      }
    });
  });
}

function createTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

async function main() {
  await run("npm", ["run", "build:pre"], { cwd: webRoot });

  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    throw new Error("构建完成后未找到 dist/index.html");
  }
  if (!fs.existsSync(configPath)) {
    throw new Error("未找到 deploy/update-config.json");
  }

  const version = `v${createTimestamp()}`;
  const distArchive = path.join(deployDir, "dist.zip");
  const archiveName = `update-${version}.zip`;
  const outputArchive = path.join(deployDir, archiveName);
  const stageDir = path.join(deployDir, `.update-stage-${version}`);

  fs.rmSync(distArchive, { force: true });
  await run("/usr/bin/zip", ["-r", "-q", distArchive, "."], { cwd: distDir });

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.id = version;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  fs.mkdirSync(stageDir, { recursive: true });
  try {
    fs.copyFileSync(distArchive, path.join(stageDir, "dist.zip"));
    fs.copyFileSync(configPath, path.join(stageDir, "update-config.json"));
    await run("/usr/bin/zip", ["-r", "-q", outputArchive, "dist.zip", "update-config.json"], {
      cwd: stageDir,
    });
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  console.log(`版本号：${version}`);
  console.log(`下载链接：${downloadBaseUrl}/${archiveName}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});