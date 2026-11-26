<script setup lang="ts">
defineProps<{ open: boolean; title: string; tone?: "warning" | "info" | "success" }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="backdrop" @click.self="emit('close')" @keydown.esc="emit('close')">
        <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
          <div class="head" :class="tone ?? 'info'">
            <span class="icon">{{ tone === "warning" ? "!" : tone === "success" ? "✓" : "i" }}</span>
            <h3>{{ title }}</h3>
          </div>
          <div class="body"><slot /></div>
          <div class="foot"><slot name="actions" /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; background: rgba(20, 30, 28, .45); display: grid; place-items: center; z-index: 50; padding: 16px; }
.dialog { background: var(--surface); border-radius: 16px; box-shadow: var(--shadow-lg); width: min(460px, 100%); overflow: hidden; }
.head { display: flex; align-items: center; gap: 12px; padding: 20px 22px 8px; }
.head h3 { font-size: 18px; }
.icon { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; flex-shrink: 0; }
.warning .icon { background: var(--warning-soft); color: var(--warning); }
.info .icon { background: var(--primary-soft); color: var(--primary); }
.success .icon { background: var(--success-soft); color: var(--success); }
.body { padding: 4px 22px 8px 66px; color: var(--text-2); font-size: 15px; }
.foot { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 22px 20px; }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
