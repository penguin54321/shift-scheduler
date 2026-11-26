<script setup lang="ts">
import { ref } from "vue";
import { isEmulator } from "../firebase";
import ScheduleOverview from "../components/boss/ScheduleOverview.vue";
import SpecialDaysPanel from "../components/boss/SpecialDaysPanel.vue";
import AllowlistPanel from "../components/boss/AllowlistPanel.vue";
import DemoPanel from "../components/boss/DemoPanel.vue";

const allTabs = [
  { id: "overview", label: "班表總覽" },
  { id: "special", label: "特殊休假日" },
  { id: "staff", label: "員工名單" },
  { id: "demo", label: "示範模式" },
] as const;
type TabId = (typeof allTabs)[number]["id"];
// 示範模式只在本機模擬器提供，正式網站不顯示
const tabs = allTabs.filter((t) => t.id !== "demo" || isEmulator);

function initialTab(): TabId {
  try {
    const saved = localStorage.getItem("boss-tab");
    if (tabs.some((t) => t.id === saved)) return saved as TabId;
  } catch {
    /* 無痕模式等情況讀不到 localStorage，使用預設分頁 */
  }
  return "overview";
}
const active = ref<TabId>(initialTab());
function select(id: TabId) {
  active.value = id;
  try {
    localStorage.setItem("boss-tab", id);
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <main class="container">
    <nav class="tabs" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.id"
        role="tab"
        class="tab"
        :class="{ active: active === t.id }"
        :aria-selected="active === t.id"
        @click="select(t.id)"
      >
        {{ t.label }}
      </button>
    </nav>
    <KeepAlive>
      <ScheduleOverview v-if="active === 'overview'" />
      <SpecialDaysPanel v-else-if="active === 'special'" />
      <AllowlistPanel v-else-if="active === 'staff'" />
      <DemoPanel v-else-if="active === 'demo'" />
    </KeepAlive>
  </main>
</template>

<style scoped>
.tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.tab {
  border: none; background: none; padding: 10px 16px; cursor: pointer; font-weight: 600; color: var(--text-2);
  border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--primary); border-bottom-color: var(--primary); }
</style>
