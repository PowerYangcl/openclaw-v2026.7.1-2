<script setup lang="ts">
/**
 * Terminal 视图 — xterm.js 富终端版本，对齐 ui/src/components/terminal/terminal-panel.ts。
 *
 * RPC: terminal.open / terminal.list / terminal.attach / terminal.input / terminal.resize / terminal.close
 * Events: terminal.data (payload: { sessionId, data }) / terminal.exit (payload: { sessionId, ... })
 *
 * xterm 输入直接走 onData → terminal.input；尺寸变化通过 addon-fit + ResizeObserver 自动 resize。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useGatewayStore } from "@/stores/gateway";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalSessionInfo {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  confined: boolean;
  attached: boolean;
  createdAtMs: number;
}

interface TerminalOpenResult {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  confined: boolean;
}

const gateway = useGatewayStore();
const sessions = ref<TerminalSessionInfo[]>([]);
const activeId = ref<string | null>(null);
const activeInfo = ref<TerminalSessionInfo | null>(null);
const opening = ref(false);
const closing = ref(false);

const containerRef = useTemplateRef<HTMLDivElement>("containerRef");

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let unsubscribe: (() => void) | null = null;

function fitTerminal(): void {
  if (!term || !fit) return;
  try {
    fit.fit();
    if (activeId.value) {
      const { cols, rows } = term;
      void gateway.request("terminal.resize", { sessionId: activeId.value, cols, rows });
    }
  } catch {
    // 容器未挂载时忽略
  }
}

async function loadList(): Promise<void> {
  try {
    const res = await gateway.request<{ sessions?: TerminalSessionInfo[] }>("terminal.list");
    sessions.value = res?.sessions ?? [];
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function openSession(): Promise<void> {
  if (!term) return;
  opening.value = true;
  try {
    const cols = term.cols;
    const rows = term.rows;
    const res = await gateway.request<TerminalOpenResult>("terminal.open", { cols, rows });
    activeId.value = res.sessionId;
    activeInfo.value = {
      sessionId: res.sessionId,
      agentId: res.agentId,
      shell: res.shell,
      cwd: res.cwd,
      confined: res.confined,
      attached: true,
      createdAtMs: Date.now(),
    };
    term.clear();
    term.writeln(`\x1b[2m[已打开 session ${res.sessionId}]\x1b[0m`);
    term.writeln(`\x1b[2m[shell=${res.shell}  cwd=${res.cwd}]\x1b[0m`);
    await loadList();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    opening.value = false;
  }
}

async function closeSession(): Promise<void> {
  if (!activeId.value) return;
  closing.value = true;
  try {
    await gateway.request("terminal.close", { sessionId: activeId.value });
    term?.writeln("\x1b[2m[会话已关闭]\x1b[0m");
    activeId.value = null;
    activeInfo.value = null;
    await loadList();
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    closing.value = false;
  }
}

async function switchSession(s: TerminalSessionInfo): Promise<void> {
  if (!term || activeId.value === s.sessionId) return;
  activeId.value = s.sessionId;
  activeInfo.value = s;
  term.clear();
  term.writeln(`\x1b[2m[已切换 session ${s.sessionId}]\x1b[0m`);
  try {
    const res = await gateway.request<{ buffer?: string }>("terminal.attach", { sessionId: s.sessionId });
    if (res?.buffer) term.write(res.buffer);
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function killActive(): Promise<void> {
  if (!activeId.value) return;
  try {
    await ElMessageBox.confirm("发送 SIGINT (Ctrl+C) 到当前会话？", "中断", { type: "warning" });
    await gateway.request("terminal.input", { sessionId: activeId.value, data: "\x03" });
  } catch (e) {
    if ((e as { type?: string }).type !== "cancel") {
      ElMessage.error((e as Error).message);
    }
  }
}

onMounted(async () => {
  await gateway.waitForConnection();
  if (!containerRef.value) return;

  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: "#0d1117",
      foreground: "#d1d5db",
      cursor: "#d1d5db",
      selectionBackground: "#3b4252",
    },
    scrollback: 5000,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(containerRef.value);
  fit.fit();

  term.writeln("\x1b[2m点击「新建」打开一个 PTY 会话；左侧可切换已有会话。\x1b[0m");

  term.onData((data) => {
    if (activeId.value) {
      void gateway.request("terminal.input", { sessionId: activeId.value, data });
    }
  });

  // ResizeObserver 监控容器尺寸变化 → fit + 通知网关
  resizeObserver = new ResizeObserver(() => {
    fitTerminal();
  });
  resizeObserver.observe(containerRef.value);

  // 订阅事件流
  unsubscribe = gateway.onEvent((evt) => {
    if (evt.event === "terminal.data") {
      const payload = evt.payload as { sessionId?: string; data?: string } | undefined;
      if (payload?.sessionId === activeId.value && typeof payload.data === "string" && term) {
        term.write(payload.data);
      }
    } else if (evt.event === "terminal.exit") {
      const payload = evt.payload as { sessionId?: string; exitCode?: number | null; signal?: number | null; reason?: string } | undefined;
      if (payload?.sessionId === activeId.value && term) {
        term.writeln(`\r\n\x1b[2m[exit code=${payload.exitCode ?? "?"} signal=${payload.signal ?? "?"}${payload.reason ? ` reason=${payload.reason}` : ""}]\x1b[0m`);
        activeId.value = null;
        activeInfo.value = null;
        void loadList();
      }
    }
  });

  await loadList();
  await nextTick();
  fitTerminal();
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (activeId.value) {
    void gateway.request("terminal.close", { sessionId: activeId.value }).catch(() => undefined);
  }
  term?.dispose();
  term = null;
  fit = null;
});
</script>

<template>
  <div class="terminal-page">
    <aside class="terminal-side">
      <header class="side-head">
        <span>会话</span>
        <el-button size="small" type="primary" :loading="opening" @click="openSession">新建</el-button>
      </header>
      <ul class="session-list">
        <li
          v-for="s in sessions"
          :key="s.sessionId"
          class="session-item"
          :class="{ active: s.sessionId === activeId }"
          @click="switchSession(s)"
        >
          <div class="session-id mono">{{ s.sessionId.slice(0, 8) }}</div>
          <div class="session-meta">
            <span>{{ s.shell }}</span>
            <span class="dim">{{ s.cwd }}</span>
          </div>
        </li>
        <li v-if="sessions.length === 0" class="empty-hint">暂无会话</li>
      </ul>
    </aside>

    <main class="terminal-main">
      <header class="terminal-bar">
        <span v-if="activeInfo">
          session <code class="mono">{{ activeInfo.sessionId }}</code> · {{ activeInfo.shell }} · {{ activeInfo.cwd }}
        </span>
        <span v-else class="dim">未选中会话</span>
        <div class="bar-actions">
          <el-button v-if="activeId" size="small" plain @click="killActive">Ctrl+C</el-button>
          <el-button v-if="activeId" size="small" type="danger" plain :loading="closing" @click="closeSession">
            关闭
          </el-button>
        </div>
      </header>
      <div ref="containerRef" class="terminal-container" />
    </main>
  </div>
</template>

<style scoped>
.terminal-page {
  display: grid;
  grid-template-columns: 220px 1fr;
  height: 100vh;
  background: var(--wb-bg-page);
  color: var(--wb-text-primary);
}
.terminal-side {
  border-right: 1px solid var(--wb-border);
  background: var(--wb-bg-card);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--wb-border);
  font-size: 13px;
  font-weight: 500;
}
.session-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  flex: 1;
}
.session-item {
  padding: 8px 10px;
  border-radius: var(--wb-radius);
  cursor: pointer;
  margin-bottom: 4px;
}
.session-item:hover {
  background: var(--wb-bg-inset);
}
.session-item.active {
  background: var(--wb-accent-soft);
}
.session-id {
  font-size: 11px;
  color: var(--wb-text-secondary);
}
.session-meta {
  display: flex;
  gap: 6px;
  font-size: 11px;
  margin-top: 2px;
  color: var(--wb-text-tertiary);
}
.dim {
  color: var(--wb-text-tertiary);
}
.empty-hint {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--wb-text-tertiary);
}
.terminal-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.terminal-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-bg-card);
  font-size: 12px;
}
.bar-actions {
  display: flex;
  gap: 8px;
}
.terminal-container {
  flex: 1;
  min-height: 0;
  background: #0d1117;
  padding: 8px;
  overflow: hidden;
}
.terminal-container :deep(.xterm) {
  height: 100%;
}
.terminal-container :deep(.xterm-viewport) {
  background-color: transparent !important;
}
</style>