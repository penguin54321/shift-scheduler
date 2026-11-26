<script setup lang="ts">
import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppHeader from "./components/AppHeader.vue";
import ToastHost from "./components/ToastHost.vue";
import { homeFor, session } from "./session";

const router = useRouter();
const route = useRoute();

// 登入 / 登出 / 角色變更時自動導向對應頁面
watch(
  () => [session.ready, session.user?.uid, session.ctx?.role] as const,
  ([ready]) => {
    if (!ready) return;
    const home = homeFor(session.ctx);
    if (route.path !== home) router.replace(home);
  },
);
</script>

<template>
  <AppHeader v-if="session.ctx && session.ctx.role !== 'none'" />
  <div v-if="!session.ready" class="center-page"><div class="spinner" /></div>
  <RouterView v-else />
  <ToastHost />
</template>
