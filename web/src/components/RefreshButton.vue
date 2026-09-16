<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";

withDefaults(
  defineProps<{
    loading?: boolean;
    title?: string;
  }>(),
  {
    loading: false,
    title: "刷新",
  },
);

const emit = defineEmits<{
  (event: "refresh"): void;
}>();
</script>

<template>
  <el-button
    class="refresh-button"
    text
    :disabled="loading"
    :title="title"
    :aria-label="title"
    @click="emit('refresh')"
  >
    <el-icon :class="{ 'is-loading': loading }"><Refresh /></el-icon>
  </el-button>
</template>

<style scoped>
.refresh-button.el-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-height: auto;
  padding: 0;
  border: none;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text-tertiary);
  transition: all 0.15s var(--wb-ease);
}

.refresh-button:hover:not(:disabled) {
  background: var(--wb-bg-hover);
  color: var(--wb-accent-strong);
}
</style>