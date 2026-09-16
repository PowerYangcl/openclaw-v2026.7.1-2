<script setup lang="ts">
/**
 * 音频播放器（MP3 等）。
 *
 * 用于助手正文 / TTS 交出来的音频**文件引用**（例如
 * `文件路径：/root/media/outbound/cet4/2026.09.12背诵单词发音.mp3`）：
 * 识别到可播放的音频引用后，在正文下方渲染一个原生播放器，
 * 并把引用正确关联到网关的媒体路由。
 *
 * 设计要点：
 * - **只渲染一个原生 `<audio controls>`**，播放 / 进度 / 音量 / **下载**全部交给浏览器
 *   自带控件（Chrome 的三点菜单里就有「下载」）。曾经自绘过一整套控件条
 *   （播放按钮 + 时间 + 进度条 + 音量 + 自定义下载按钮），维护成本高、且覆盖不到
 *   浏览器的原生能力 —— 现在全部删除，本组件只剩下「把地址算对 + 状态同步」。
 * - **必须用 `<audio src>` 直出**：网关的 `/__openclaw__/assistant-media` 不返回 CORS
 *   头（实测 OPTIONS 404），跨源 `fetch` 拿不到字节；而媒体元素跨源加载不受限。
 *   可用性探测只是「锦上添花」，探测不到就乐观播放（交给浏览器自己的错误提示）。
 * - 状态（`isPlaying` / `currentTime` / `duration` / `volume` / `muted` / `status`）
 *   完全以**媒体元素事件**为准，不做乐观更新 —— 原生控件改变了音量 / 播放位置，
 *   相应事件照旧把状态同步回来。
 * - 同一时间只允许一个播放器出声（模块级单例）。
 * - 组件卸载 / 切换引用时停止播放并复位，避免后台继续出声。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";
import {
  buildAssistantMediaUrl,
  isLocalMediaSource,
  probeAssistantMedia,
} from "@/utils/assistantMedia";

const props = withDefaults(
  defineProps<{
    /** 音频引用：本地文件路径（绝对 / `~/` / `file://`）或 http(s) URL。 */
    source: string;
    /** 展示名；留空则用文件名。仅用于 `title` / `aria-label`。 */
    label?: string;
    /** 网关 HTTP 源覆盖（默认取全局设置）。 */
    base?: string;
    /** 鉴权 token 覆盖（默认取全局设置）。 */
    token?: string;
  }>(),
  { label: "", base: "", token: "" },
);

const settings = useSettingsStore();

const gatewayBase = computed(() => props.base || settings.gatewayHttpBase);
const authToken = computed(() => props.token || settings.token);
const displayLabel = computed(() => props.label.trim());

/** 短期媒体票据（可用性探测成功后拿到）；拿不到就退回 `?token=`。 */
const mediaTicket = ref<string>("");
const mediaUrl = computed(() =>
  buildAssistantMediaUrl({
    source: props.source,
    base: gatewayBase.value,
    ticket: mediaTicket.value,
    token: authToken.value,
  }),
);

type PlayerStatus = "ready" | "unavailable" | "error";
const status = ref<PlayerStatus>("ready");
const unavailableReason = ref("");

const audioEl = ref<HTMLAudioElement | null>(null);
const isPlaying = ref(false);
const currentTime = ref(0);
const duration = ref<number | null>(null);
const volume = ref(1);
const muted = ref(false);

/** 只作为 `title` / `aria-label` 用：原生控件已经能播能下，不需要额外 UI。 */
const playerLabel = computed(() => displayLabel.value || "音频");
const playerTitle = computed(() =>
  status.value === "ready" ? playerLabel.value : unavailableReason.value || playerLabel.value,
);

// ── 同一时间只允许一个播放器出声 ──────────────────────────────────────────
const activePlayers = new Set<() => void>();
function pauseOtherPlayers(): void {
  for (const pause of activePlayers) {
    if (pause !== pauseSelf) pause();
  }
}
function pauseSelf(): void {
  audioEl.value?.pause();
}

// ── 状态同步（以媒体元素的事件为准，不做乐观更新）──────────────────────────
function syncDuration(): void {
  const el = audioEl.value;
  if (!el) return;
  const next = el.duration;
  duration.value = Number.isFinite(next) && next > 0 ? next : null;
}
function handleTimeUpdate(): void {
  const el = audioEl.value;
  if (!el) return;
  currentTime.value = el.currentTime;
}
function handlePlay(): void {
  isPlaying.value = true;
  pauseOtherPlayers();
  status.value = "ready";
}
function handlePause(): void {
  isPlaying.value = false;
}
function handleEnded(): void {
  isPlaying.value = false;
  currentTime.value = 0;
  if (audioEl.value) audioEl.value.currentTime = 0;
}
function handleError(): void {
  isPlaying.value = false;
  // 有明确原因时保留原因文案，否则给通用提示（例如格式不支持 / 已被清理）。
  if (status.value !== "unavailable") {
    status.value = "error";
    unavailableReason.value = isLocalMediaSource(props.source)
      ? "音频加载失败，可能已过期或被移动"
      : "音频加载失败";
  }
}
/** 原生控件改音量 / 静音时把状态同步回来（以前是自绘滑块写进元素，现在反过来）。 */
function handleVolumeChange(): void {
  const el = audioEl.value;
  if (!el) return;
  volume.value = el.volume;
  muted.value = el.muted;
}

// ── 引用变化：重探可用性 + 复位 ────────────────────────────────────────────
let probeSeq = 0;
let probeController: AbortController | null = null;

function resetPlayback(): void {
  const el = audioEl.value;
  if (el) {
    el.pause();
    el.currentTime = 0;
  }
  isPlaying.value = false;
  currentTime.value = 0;
  duration.value = null;
}

async function resolveSource(): Promise<void> {
  const seq = ++probeSeq;
  probeController?.abort();
  probeController = null;
  mediaTicket.value = "";
  status.value = "ready";
  unavailableReason.value = "";
  resetPlayback();

  if (!isLocalMediaSource(props.source)) return; // 远端/data: 直接可播

  const controller = new AbortController();
  probeController = controller;
  try {
    const result = await probeAssistantMedia({
      source: props.source,
      base: gatewayBase.value,
      token: authToken.value,
      signal: controller.signal,
    });
    if (seq !== probeSeq) return; // 已被更新的引用取代
    if (result.status === "unavailable") {
      status.value = "unavailable";
      unavailableReason.value = result.reason;
      return;
    }
    // "unknown"（多为跨源 CORS 拦下）→ 乐观播放，交给 <audio> 的 error 事件兜底
    if (result.status === "ready" && result.ticket) mediaTicket.value = result.ticket;
  } catch {
    // 取消 / 异常：保持乐观可播
  }
}

watch(
  () => [props.source, gatewayBase.value, authToken.value] as const,
  () => void resolveSource(),
  { immediate: true },
);

onBeforeUnmount(() => {
  probeSeq++;
  probeController?.abort();
  activePlayers.delete(pauseSelf);
  audioEl.value?.pause();
});
activePlayers.add(pauseSelf);
</script>

<template>
  <audio
    ref="audioEl"
    class="audio-player"
    :src="mediaUrl"
    controls
    preload="metadata"
    :aria-label="playerLabel"
    :title="playerTitle"
    @loadedmetadata="syncDuration"
    @durationchange="syncDuration"
    @timeupdate="handleTimeUpdate"
    @play="handlePlay"
    @pause="handlePause"
    @ended="handleEnded"
    @error="handleError"
    @volumechange="handleVolumeChange"
  />
</template>

<style scoped>
.audio-player {
  display: block;
  width: 100%;
  max-width: 440px;
  margin-top: 10px;
  /* 白底必须配浅色控件：`color-scheme: dark` 会把原生控件画成白色字形，
     压在白底上等于隐形（实测）。这里固定 light，深浅主题都保证控件可见。 */
  color-scheme: light;
  border-radius: var(--wb-radius);
  background: var(--wb-bg-card);
  border: 1px solid var(--wb-border);
}

/* ⚠️ 灰色圆角的真正来源：Chrome 阴影面板自带一层灰底的 `enclosure`。
   只给元素 `background-color` 是盖不住它的 —— 置空后露出元素自身白底，
   整块才是纯白（否则左右两侧仍是灰色圆角，正是用户截图里的样子）。 */
.audio-player::-webkit-media-controls-enclosure {
  background: transparent;
}
</style>
