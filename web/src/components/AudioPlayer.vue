<script setup lang="ts">
/**
 * 音频播放器（MP3 等）。
 *
 * 用于助手正文里出现的音频**文件引用**（例如
 * `文件路径：/root/media/outbound/cet4/2026.09.12背诵单词发音.mp3`）：
 * 识别到可播放的音频引用后，在正文下方渲染一个可播放/暂停的控件，
 * 并把引用正确关联到网关的媒体路由。
 *
 * 设计要点：
 * - **引擎用原生 `<audio>`**（隐藏），只自绘控件条：加载/解码/seek 行为都交给浏览器，
 *   我们只做 UI 与状态同步；控件外观参考目标页（播放按钮 + 时间 + 进度 + 音量）。
 * - **必须用 `<audio src>` 直出**：网关的 `/__openclaw__/assistant-media` 不返回 CORS
 *   头（实测 OPTIONS 404），跨源 `fetch` 拿不到字节；而媒体元素跨源加载不受限。
 *   可用性探测只是「锦上添花」，探测不到就乐观播放。
 * - 同一时间只允许一个播放器出声（模块级单例）。
 * - 组件卸载 / 切换引用时停止播放并复位，避免后台继续出声。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useSettingsStore } from "@/stores/settings";
import {
  buildAssistantMediaUrl,
  formatAudioTime,
  isLocalMediaSource,
  probeAssistantMedia,
} from "@/utils/assistantMedia";

const props = withDefaults(
  defineProps<{
    /** 音频引用：本地文件路径（绝对 / `~/` / `file://`）或 http(s) URL。 */
    source: string;
    /** 展示名；留空则用文件名。 */
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
const isSeeking = ref(false);
const seekValue = ref(0);
const currentTime = ref(0);
const duration = ref<number | null>(null);
const volume = ref(1);
const muted = ref(false);

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
  if (!el || isSeeking.value) return;
  currentTime.value = el.currentTime;
  seekValue.value = el.currentTime;
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
  seekValue.value = 0;
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

function togglePlay(): void {
  const el = audioEl.value;
  if (!el || status.value === "unavailable") return;
  if (el.paused) {
    void el.play().catch(() => handleError());
  } else {
    el.pause();
  }
}

function seekTo(value: number): void {
  const el = audioEl.value;
  if (!el || !duration.value) return;
  const next = Math.min(Math.max(value, 0), duration.value);
  el.currentTime = next;
  currentTime.value = next;
  seekValue.value = next;
}
function handleSeekInput(event: Event): void {
  isSeeking.value = true;
  seekValue.value = Number((event.target as HTMLInputElement).value) || 0;
}
function handleSeekCommit(event: Event): void {
  isSeeking.value = false;
  seekTo(Number((event.target as HTMLInputElement).value) || 0);
}

function handleVolumeInput(event: Event): void {
  const next = Number((event.target as HTMLInputElement).value);
  volume.value = Number.isFinite(next) ? next : 1;
  const el = audioEl.value;
  if (el) {
    el.volume = volume.value;
    el.muted = volume.value === 0;
  }
  muted.value = volume.value === 0;
}
function toggleMute(): void {
  const el = audioEl.value;
  if (!el) return;
  muted.value = !muted.value;
  el.muted = muted.value;
  if (!muted.value && volume.value === 0) {
    volume.value = 0.8;
    el.volume = volume.value;
  }
}

const progressPercent = computed(() => {
  const total = duration.value;
  if (!total) return 0;
  const value = isSeeking.value ? seekValue.value : currentTime.value;
  return Math.min(100, Math.max(0, (value / total) * 100));
});

const shownTime = computed(() => (isSeeking.value ? seekValue.value : currentTime.value));

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
  seekValue.value = 0;
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
  <div class="audio-player" :class="{ 'audio-player--muted-state': status !== 'ready' }">
    <audio
      ref="audioEl"
      :src="mediaUrl"
      preload="metadata"
      @loadedmetadata="syncDuration"
      @durationchange="syncDuration"
      @timeupdate="handleTimeUpdate"
      @play="handlePlay"
      @pause="handlePause"
      @ended="handleEnded"
      @error="handleError"
    />

    <!-- 不可用 / 加载失败：不展示控件条，换成「图标 + 文件名 + 原因」，
         否则用户只会看到一个永远停在 `--:--` 的播放器，不知道发生了什么 -->
    <template v-if="status !== 'ready'">
      <span class="audio-player__badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M12 9v4M12 17h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </span>
      <span class="audio-player__label">{{ displayLabel || '音频' }}</span>
      <span class="audio-player__reason">{{ unavailableReason }}</span>
    </template>

    <template v-else>
      <button
        type="button"
        class="audio-player__toggle"
        :aria-label="isPlaying ? '暂停' : '播放'"
        :title="isPlaying ? '暂停' : '播放'"
        @click="togglePlay"
      >
        <svg v-if="isPlaying" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
        </svg>
      </button>

      <span class="audio-player__time mono">{{ formatAudioTime(shownTime) }}</span>

      <div class="audio-player__track">
        <div class="audio-player__progress" :style="{ width: `${progressPercent}%` }" />
        <input
          class="audio-player__range"
          type="range"
          min="0"
          :max="duration ?? 0"
          step="0.01"
          :value="shownTime"
          :disabled="!duration"
          aria-label="播放进度"
          @input="handleSeekInput"
          @change="handleSeekCommit"
        />
      </div>

      <span class="audio-player__time mono">{{ formatAudioTime(duration) }}</span>

      <div class="audio-player__volume">
        <button
          type="button"
          class="audio-player__icon-btn"
          :aria-label="muted ? '取消静音' : '静音'"
          :title="muted ? '取消静音' : '静音'"
          @click="toggleMute"
        >
          <svg v-if="muted" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" />
            <path d="M17 9l4 6M21 9l-4 6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" />
            <path d="M16 8.5a5 5 0 0 1 0 7" />
            <path d="M19 6a9 9 0 0 1 0 12" />
          </svg>
        </button>
        <input
          class="audio-player__range audio-player__range--volume"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="muted ? 0 : volume"
          aria-label="音量"
          @input="handleVolumeInput"
        />
      </div>

      <span v-if="displayLabel" class="audio-player__label" :title="displayLabel">{{ displayLabel }}</span>
    </template>
  </div>
</template>

<style scoped>
.audio-player {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 6px 12px;
  max-width: 440px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-bg-inset);
  color: var(--wb-text-primary);
}

/* 原生 <audio> 只当引擎用，不出 UI */
.audio-player > audio {
  display: none;
}

.audio-player__toggle,
.audio-player__icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--wb-accent);
  color: var(--wb-text-on-accent);
  cursor: pointer;
  transition: background var(--wb-ease) ease, opacity var(--wb-ease) ease;
}

.audio-player__icon-btn {
  width: 24px;
  height: 24px;
  background: transparent;
  color: var(--wb-text-secondary);
}

.audio-player__toggle:hover {
  background: var(--wb-accent-hover);
}

.audio-player__icon-btn:hover {
  color: var(--wb-text-primary);
}

.audio-player__toggle:focus-visible,
.audio-player__icon-btn:focus-visible {
  outline: 2px solid var(--wb-accent-strong);
  outline-offset: 2px;
}

.audio-player__time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--wb-text-secondary);
  font-variant-numeric: tabular-nums;
}

.audio-player__track {
  position: relative;
  flex: 1 1 auto;
  min-width: 60px;
  height: 4px;
  border-radius: 999px;
  background: var(--wb-bg-hover);
}

.audio-player__progress {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: var(--wb-accent);
  pointer-events: none;
}

/* 滑块铺满轨道：透明轨道 + 只留可拖拽的拇指 */
.audio-player__range {
  position: absolute;
  inset: -8px 0;
  width: 100%;
  margin: 0;
  padding: 0;
  background: transparent;
  appearance: none;
  cursor: pointer;
}

.audio-player__range:disabled {
  cursor: default;
}

.audio-player__range::-webkit-slider-thumb {
  appearance: none;
  width: 11px;
  height: 11px;
  border: none;
  border-radius: 50%;
  background: var(--wb-accent);
  box-shadow: 0 0 0 2px var(--wb-bg-content);
}

.audio-player__range:disabled::-webkit-slider-thumb {
  opacity: 0;
}

.audio-player__volume {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
}

.audio-player__range--volume {
  position: static;
  inset: auto;
  width: 52px;
  height: 4px;
  border-radius: 999px;
  background: var(--wb-bg-hover);
}

.audio-player__range--volume::-webkit-slider-thumb {
  background: var(--wb-text-secondary);
  box-shadow: none;
}

.audio-player__label {
  flex: 0 1 auto;
  max-width: 140px;
  overflow: hidden;
  font-size: 11px;
  color: var(--wb-text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 不可用态：换成一条静态说明，不展示控件 */
.audio-player--muted-state {
  gap: 8px;
  color: var(--wb-text-secondary);
}

.audio-player__badge {
  display: inline-flex;
  color: var(--wb-text-tertiary);
}

.audio-player__reason {
  font-size: 11px;
  color: var(--wb-text-tertiary);
}
</style>
