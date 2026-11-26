<script setup lang="ts">
import { computed } from "vue";
import { logout, session } from "../session";

const ctx = computed(() => session.ctx!);
const roleLabel = computed(() => (ctx.value.role === "boss" ? "老闆" : "員工"));
const today = computed(() => ctx.value.today.replace(/-/g, "/"));
</script>

<template>
  <header class="header">
    <div class="inner">
      <div class="brand">
        <img src="/favicon.svg" alt="" width="28" height="28" />
        <span>排班系統</span>
      </div>
      <div class="right">
        <span v-if="ctx.simulated" class="badge badge-warn" title="老闆已開啟示範模式">
          示範模式・今天 {{ today }}
        </span>
        <span v-else class="today muted small">今天 {{ today }}</span>
        <div class="user">
          <img v-if="session.user?.photoURL" :src="session.user.photoURL" alt="" class="avatar" referrerpolicy="no-referrer" />
          <div class="avatar fallback" v-else>{{ ctx.name.slice(0, 1) }}</div>
          <div class="who">
            <div class="name">{{ ctx.name }}</div>
            <div class="role">{{ roleLabel }}</div>
          </div>
        </div>
        <button class="btn btn-sm" @click="logout">登出</button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.header { background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20; }
.inner { max-width: 1240px; margin: 0 auto; padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; }
.right { display: flex; align-items: center; gap: 14px; }
.user { display: flex; align-items: center; gap: 8px; }
.avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
.avatar.fallback { display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); font-weight: 700; }
.name { font-size: 14px; font-weight: 600; line-height: 1.2; }
.role { font-size: 12px; color: var(--text-3); }
@media (max-width: 640px) {
  .inner { padding: 10px 12px; }
  .who, .today { display: none; }
  .brand span { display: none; }
}
</style>
