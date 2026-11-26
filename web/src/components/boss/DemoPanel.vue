<script setup lang="ts">
import { ref } from "vue";
import { api, errorMessages, formatMonth } from "../../api";
import { refreshContext, session } from "../../session";
import { toast } from "../../toast";

const date = ref(session.ctx!.simulated ? session.ctx!.today : "");
const busy = ref(false);

const presets = [
  { label: "排 6 月（端午節）", date: "2026-05-15" },
  { label: "排 10 月（國慶日補假）", date: "2026-09-15" },
  { label: "排 2027 年 2 月（春節）", date: "2027-01-15" },
];

async function apply(value: string | null) {
  busy.value = true;
  try {
    await api.setSimulatedToday({ date: value });
    await refreshContext();
    date.value = value ?? "";
    toast(value ? `已模擬今天為 ${value}，開放排 ${formatMonth(session.ctx!.targetMonth)}` : "已恢復真實日期", "success");
  } catch (err) {
    toast(errorMessages(err).join("\n"), "error");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card panel">
    <div class="card-title">示範模式（模擬今天日期）</div>
    <p class="muted">
      系統預設使用<strong>台灣時間的今天</strong>判斷可排班月份。展示時可模擬其他日期，
      讓員工排其他月份，方便展示國定假日名稱與年度統計。所有使用者畫面上方都會顯示「示範模式」提示。
    </p>

    <div class="current" :class="{ on: session.ctx!.simulated }">
      <div>
        <div class="small muted">目前系統日期</div>
        <div class="big">{{ session.ctx!.today.replace(/-/g, "/") }}</div>
      </div>
      <div>
        <div class="small muted">開放排班月份</div>
        <div class="big">{{ formatMonth(session.ctx!.targetMonth) }}</div>
      </div>
      <span class="badge" :class="session.ctx!.simulated ? 'badge-warn' : 'badge-ok'">
        {{ session.ctx!.simulated ? "模擬中" : "真實日期" }}
      </span>
    </div>

    <form class="row" @submit.prevent="apply(date || null)">
      <label class="field">
        模擬今天為
        <input v-model="date" class="input" type="date" required />
      </label>
      <button class="btn btn-primary" type="submit" :disabled="busy || !date">套用</button>
      <button class="btn" type="button" :disabled="busy || !session.ctx!.simulated" @click="apply(null)">恢復真實日期</button>
    </form>

    <div class="presets">
      <span class="small muted">快速選擇：</span>
      <button v-for="p in presets" :key="p.date" class="chip-btn" :disabled="busy" @click="apply(p.date)">{{ p.label }}</button>
    </div>
  </section>
</template>

<style scoped>
.panel { max-width: 720px; }
.panel > p { margin: -4px 0 18px; font-size: 14px; }
.current { display: flex; align-items: center; gap: 32px; padding: 16px 18px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border); margin-bottom: 18px; flex-wrap: wrap; }
.current.on { background: var(--warning-soft); border-color: #f1dfb6; }
.big { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.current .badge { margin-left: auto; }
.row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.presets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 16px; }
.chip-btn { border: 1px dashed var(--border); background: var(--surface-2); border-radius: 999px; padding: 4px 12px; font-size: 13px; cursor: pointer; color: var(--text-2); }
.chip-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
</style>
