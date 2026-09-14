<script setup lang="ts">
/**
 * 麦克风按钮（占位，预留语音输入）。
 *
 * 当前为纯 UI 占位：点击会触发短暂的"录音中"脉冲动效并发出 `recording` 事件，
 * 但不连接实际的录音/识别管线。后续接入 Web Speech API 或自建流式语音时可继续延展。
 */
import { ref } from "vue";

const props = defineProps<{
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "recording"): void;
}>();

const recording = ref(false);

function toggle(): void {
  if (props.disabled) return;
  recording.value = !recording.value;
  if (recording.value) emit("recording");
}
</script>

<template>
  <el-button
    class="voice-button"
    :class="{ recording, disabled }"
    :disabled="disabled"
    circle
    :title="recording ? '正在采集语音（占位）' : '语音输入（即将开放）'"
    aria-label="语音输入"
    @click="toggle"
  >
    <span class="voice-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16">
        <rect x="6" y="2.5" width="4" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path d="M3.5 8.5 a4.5 4.5 0 0 0 9 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <path d="M8 13 V14.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </span>
    <span v-if="recording" class="voice-pulse" aria-hidden="true" />
  </el-button>
</template>

<style scoped>
.voice-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 1px solid var(--wb-border);
  background: var(--wb-bg-card);
  color: var(--wb-text-secondary);
  cursor: pointer;
  transition: all 0.15s var(--wb-ease);
  padding: 0;
  overflow: visible;
}
.voice-button.el-button {
  padding: 0;
  min-height: auto;
}
.voice-button.el-button > span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.voice-button:hover:not(.disabled) {
  border-color: var(--wb-accent);
  color: var(--wb-accent-strong);
  background: var(--wb-accent-softer);
}

.voice-button:active:not(.disabled) {
  transform: scale(0.96);
}

.voice-button.recording {
  border-color: var(--wb-accent-strong);
  background: var(--wb-accent-strong);
  color: #fff;
}

.voice-button.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.voice-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.voice-pulse {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  border: 2px solid var(--wb-accent-strong);
  animation: voicePulse 1.2s var(--wb-ease) infinite;
  pointer-events: none;
}

@keyframes voicePulse {
  0% {
    transform: scale(1);
    opacity: 0.6;
  }
  100% {
    transform: scale(1.7);
    opacity: 0;
  }
}
</style>