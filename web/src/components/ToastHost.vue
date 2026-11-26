<script setup lang="ts">
import { toasts } from "../toast";
</script>

<template>
  <div class="toasts" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type">{{ t.text }}</div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 8px; z-index: 100; pointer-events: none;
  width: max-content; max-width: calc(100vw - 32px);
}
.toast {
  padding: 10px 18px; border-radius: 10px; background: #1d2826; color: #fff;
  box-shadow: var(--shadow-lg); font-size: 14px; white-space: pre-line;
}
.toast.success { background: var(--success); }
.toast.error { background: var(--holiday); }
.toast-enter-active, .toast-leave-active { transition: all .25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(10px); }
</style>
