#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"
FRONTEND_ORIGIN="${OPENCLAW_FRONTEND_ORIGIN:-http://localhost:5273}"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-gateway-lite.XXXXXX")"
TEMP_CONFIG="$TEMP_DIR/openclaw.json"
SOURCE_CONFIG=""

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 Node.js。请先执行 nvm use 24。" >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1; then
  LISTENER_PIDS="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u)"
  if [[ -n "$LISTENER_PIDS" ]]; then
    for pid in $LISTENER_PIDS; do
      command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if [[ "$command_line" != *"openclaw.mjs gateway"* ]]; then
        echo "错误：端口 $PORT 被非 OpenClaw Gateway 进程占用（PID $pid）。" >&2
        echo "$command_line" >&2
        exit 1
      fi
    done

    echo "正在停止端口 $PORT 上已有的 OpenClaw Gateway（PID: $LISTENER_PIDS）..."
    kill -TERM $LISTENER_PIDS
    for _ in {1..50}; do
      if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "错误：已有 OpenClaw Gateway 未能及时停止，请手动处理。" >&2
      exit 1
    fi
  fi
fi

if [[ -n "${OPENCLAW_CONFIG_PATH:-}" ]]; then
  SOURCE_CONFIG="$OPENCLAW_CONFIG_PATH"
elif [[ -n "${OPENCLAW_STATE_DIR:-}" && -f "$OPENCLAW_STATE_DIR/openclaw.json" ]]; then
  SOURCE_CONFIG="$OPENCLAW_STATE_DIR/openclaw.json"
elif [[ -f "$HOME/.openclaw/openclaw.json" ]]; then
  SOURCE_CONFIG="$HOME/.openclaw/openclaw.json"
elif [[ -f "$HOME/.openclaw/clawdbot.json" ]]; then
  SOURCE_CONFIG="$HOME/.openclaw/clawdbot.json"
fi

SOURCE_CONFIG="$SOURCE_CONFIG" TEMP_CONFIG="$TEMP_CONFIG" FRONTEND_ORIGIN="$FRONTEND_ORIGIN" node --input-type=module <<'NODE'
import fs from "node:fs";
import JSON5 from "json5";

const sourcePath = process.env.SOURCE_CONFIG;
const targetPath = process.env.TEMP_CONFIG;
let config = {};

if (sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    console.error(`错误：配置文件不存在：${sourcePath}`);
    process.exit(1);
  }
  try {
    config = JSON5.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch (error) {
    console.error(`错误：无法解析配置文件 ${sourcePath}：${error.message}`);
    process.exit(1);
  }
}

config.gateway = {
  ...(config.gateway ?? {}),
  mode: "local",
  controlUi: {
    ...(config.gateway?.controlUi ?? {}),
    enabled: false,
    allowedOrigins: [
      ...new Set([
        ...(config.gateway?.controlUi?.allowedOrigins ?? []),
        process.env.FRONTEND_ORIGIN,
      ]),
    ],
  },
};
fs.writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE

if [[ ! -f dist/entry.js && ! -f dist/entry.mjs ]] || \
  [[ ! -f node_modules/@openclaw/ai/dist/internal/runtime.mjs ]]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "错误：缺少 Gateway 运行产物，且未找到 pnpm。请先执行 nvm use 24。" >&2
    exit 1
  fi
  echo "Gateway 运行产物不完整，正在执行一次构建..."
  node scripts/build-all.mjs gatewayWatch
fi

echo "启动轻量 Gateway：ws://127.0.0.1:$PORT"
echo "允许前端 Origin：$FRONTEND_ORIGIN"
echo "Control UI：已禁用；Channels：已跳过"

OPENCLAW_CONFIG_PATH="$TEMP_CONFIG" \
OPENCLAW_SKIP_CHANNELS=1 \
node openclaw.mjs gateway --port "$PORT" --bind "$BIND" "$@" &
GATEWAY_PID=$!

forward_signal() {
  kill -"$1" "$GATEWAY_PID" 2>/dev/null || true
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

set +e
wait "$GATEWAY_PID"
STATUS=$?
set -e
exit "$STATUS"
