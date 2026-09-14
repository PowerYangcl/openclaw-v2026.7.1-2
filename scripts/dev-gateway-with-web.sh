#!/usr/bin/env bash
# scripts/dev-gateway-with-web.sh
# 一键拉起「gateway 直接服务 web/dist」联调模式：
#   1. pnpm web:build 构建 web/dist
#   2. 把 gateway.controlUi.root 写进 ~/.openclaw/openclaw.json，强制 candidates 命中 web/dist
#   3. launchctl kickstart gateway（macOS launchd），或兜底 pnpm gateway:dev
#   4. 验证 gateway HTML 标题与 basePath 注入
#
# 用法：
#   ./scripts/dev-gateway-with-web.sh                # 默认：build + 写 root + 重启 launchd
#   ./scripts/dev-gateway-with-web.sh --no-build     # 跳过构建（用现有 web/dist）
#   ./scripts/dev-gateway-with-web.sh --no-override  # 不动 ~/.openclaw/openclaw.json
#   ./scripts/dev-gateway-with-web.sh --fg           # 不重启 launchd，直接前台跑 gateway:dev
#   ./scripts/dev-gateway-with-web.sh --port 18790   # 用别的端口（自动同步 config）
#
# 解除（恢复默认 candidates 顺序）：
#   ./scripts/dev-gateway-with-web.sh --reset
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
WEB_DIST="$WEB_DIR/dist"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
LAUNCHD_LABEL="${OPENCLAW_GATEWAY_LAUNCHD_LABEL:-ai.openclaw.gateway}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"

DO_BUILD=true
DO_OVERRIDE=true
DO_FG=false
DO_RESET=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)    DO_BUILD=false; shift ;;
    --no-override) DO_OVERRIDE=false; shift ;;
    --fg)          DO_FG=true; shift ;;
    --reset)       DO_RESET=true; shift ;;
    --port)        GATEWAY_PORT="$2"; shift 2 ;;
    --label)       LAUNCHD_LABEL="$2"; shift 2 ;;
    -h|--help)
      sed -n '/^# 用法：/,/^set -euo/p' "$0" | sed 's/^# \?//' | sed '$d'
      exit 0
      ;;
    *) echo "未知选项：$1" >&2; exit 2 ;;
  esac
done

cd "$ROOT_DIR"

log() { printf '\033[1;34m[dev-gateway]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[dev-gateway]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[dev-gateway]\033[0m %s\n' "$*" >&2; }

# ─── reset 模式：清掉 override，恢复 candidates 顺序 ──────────────────────
if $DO_RESET; then
  log "清除 gateway.controlUi.root override"
  /usr/bin/env node -e "
    const fs = require('fs');
    const path = '$OPENCLAW_CONFIG';
    if (!fs.existsSync(path)) { console.log('no config: ' + path); process.exit(0); }
    const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (cfg.gateway?.controlUi?.root) {
      delete cfg.gateway.controlUi.root;
      fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
      console.log('removed controlUi.root from ' + path);
    } else {
      console.log('no override present in ' + path);
    }
  "
  if [[ "$(uname)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
  fi
  log "已恢复默认顺序；老 dist/control-ui（如果存在）会被优先探测"
  exit 0
fi

# ─── 1. 构建 web/dist ──────────────────────────────────────────────
if $DO_BUILD; then
  log "构建 web/dist（pnpm web:build）..."
  pnpm web:build
elif [[ ! -f "$WEB_DIST/index.html" ]]; then
  err "web/dist/index.html 不存在；请先用 --no-build=false 或手动跑 pnpm web:build"
  exit 1
else
  log "跳过构建；使用现有 web/dist（mtime: $(stat -f %Sm "$WEB_DIST/index.html" 2>/dev/null || stat -c %y "$WEB_DIST/index.html" 2>/dev/null))"
fi

# ─── 2. 把 root 写进 ~/.openclaw/openclaw.json ──────────────────────
if $DO_OVERRIDE; then
  log "写入 gateway.controlUi.root → $WEB_DIST"
  mkdir -p "$(dirname "$OPENCLAW_CONFIG")"
  /usr/bin/env node -e "
    const fs = require('fs');
    const cfgPath = '$OPENCLAW_CONFIG';
    const root    = '$WEB_DIST';
    const port    = Number('$GATEWAY_PORT');
    let cfg = {};
    if (fs.existsSync(cfgPath)) {
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
      catch (e) { console.error('openclaw.json 解析失败：' + e.message); process.exit(1); }
    }
    cfg.gateway = cfg.gateway || {};
    cfg.gateway.mode = cfg.gateway.mode || 'local';
    cfg.gateway.controlUi = cfg.gateway.controlUi || {};
    cfg.gateway.controlUi.root = root;
    cfg.gateway.port = port;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('written:', cfgPath);
  "
else
  log "跳过 ~/.openclaw/openclaw.json 改动"
fi

# ─── 3. 启动 / 重启 gateway ────────────────────────────────────────
if $DO_FG; then
  log "前台启动 gateway:dev（端口 $GATEWAY_PORT）"
  exec pnpm gateway:dev
fi

if [[ "$(uname)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
  log "重启 launchd 服务（label: $LAUNCHD_LABEL）"
  if launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" 2>&1 | tee /tmp/launchctl-kickstart.log; then
    log "launchd kickstart 已发送；老客户端会自动重连"
  else
    warn "launchctl kickstart 失败；fallback 到 pnpm gateway:dev（请手动 Ctrl+C 后台启动）"
    exec pnpm gateway:dev
  fi
else
  warn "非 macOS 或无 launchctl；走前台 pnpm gateway:dev"
  exec pnpm gateway:dev
fi

# ─── 4. 等 gateway 起来 ────────────────────────────────────────────
log "等待 gateway 监听 :$GATEWAY_PORT ..."
for i in {1..50}; do
  if lsof -nP -iTCP:"$GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    log "gateway 已起"
    break
  fi
  sleep 0.2
done

if ! lsof -nP -iTCP:"$GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  err "30 秒内未监听到 :$GATEWAY_PORT；launchd 服务可能未注册或 web/dist 不存在"
  err "检查：launchctl list | grep openclaw；或 ./scripts/dev-gateway-with-web.sh --fg 排错"
  exit 1
fi

# ─── 5. 验证 gateway 服务的就是 web/dist ───────────────────────────
log "验证 gateway 实际服务的 HTML..."
HTML=$(curl -sf "http://127.0.0.1:$GATEWAY_PORT/" 2>/dev/null || true)
if [[ -z "$HTML" ]]; then
  err "curl http://127.0.0.1:$GATEWAY_PORT/ 失败；检查网关日志"
  exit 1
fi

TITLE=$(printf '%s' "$HTML" | grep -oE '<title>[^<]+</title>' | head -1 || true)
BASE_ATTR=$(printf '%s' "$HTML" | grep -oE 'data-openclaw-control-ui-base-path="[^"]+"' | head -1 || true)
echo
printf '\033[1;32m✓ gateway 联调模式已就绪\033[0m\n'
printf '  URL:        http://127.0.0.1:%s/\n' "$GATEWAY_PORT"
printf '  Title:      %s\n' "${TITLE:-<未找到>}"
printf '  basePath:   %s\n' "${BASE_ATTR:-data-openclaw-control-ui-base-path=\"/\"}"
echo
log "解除联调（恢复默认 candidates 顺序）："
log "  ./scripts/dev-gateway-with-web.sh --reset"