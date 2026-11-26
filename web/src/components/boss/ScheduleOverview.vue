<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { collection, onSnapshot, query, where, type Unsubscribe } from "firebase/firestore";
import { db } from "../../firebase";
import { api, errorMessages, formatDate, formatMonth, shiftMonth, WEEKDAYS, type Dashboard, type EmployeeStat } from "../../api";
import { session } from "../../session";

const month = ref(session.ctx!.targetMonth);
const data = ref<Dashboard | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const rankMode = ref<"month" | "year">("month");
const rules = computed(() => session.ctx!.rules);
/** 未達最低天數的人分成兩種：還沒送出過班表，或已送出但被特殊休假日扣到不足 */
const belowMinBreakdown = computed(() => {
  const below = (data.value?.employees ?? []).filter((e) => e.onAllowlist && e.monthCount < rules.value.minDays);
  const notSubmitted = below.filter((e) => e.status === "none").length;
  return { notSubmitted, needsFix: below.length - notSubmitted };
});

let requestSeq = 0;
async function load() {
  const seq = ++requestSeq;
  loading.value = true;
  try {
    const res = await api.getDashboard({ month: month.value });
    if (seq !== requestSeq) return;
    data.value = res;
    error.value = null;
  } catch (err) {
    if (seq === requestSeq) error.value = errorMessages(err).join("\n");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

/** 員工送出或老闆設定特殊日時自動刷新（debounce 避免連續觸發） */
let unsubs: Unsubscribe[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleReload() {
  clearTimeout(timer);
  timer = setTimeout(load, 400);
}
function subscribe() {
  unsubs.forEach((u) => u());
  const year = month.value.slice(0, 4);
  const onListenError = (err: unknown) => {
    error.value = `即時更新已中斷：${errorMessages(err).join("、")}（可按「重新整理」手動更新）`;
  };
  unsubs = [
    onSnapshot(query(collection(db, "schedules"), where("year", "==", year)), scheduleReload, onListenError),
    onSnapshot(query(collection(db, "specialDays"), where("month", "==", month.value)), scheduleReload, onListenError),
    onSnapshot(collection(db, "allowlist"), scheduleReload, onListenError),
  ];
}
function unsubscribe() {
  unsubs.forEach((u) => u());
  unsubs = [];
  clearTimeout(timer);
}
watch(month, () => {
  data.value = null;
  load();
  subscribe();
});
onActivated(() => {
  load();
  subscribe();
});
onDeactivated(unsubscribe);
onBeforeUnmount(unsubscribe);

const employees = computed(() =>
  [...(data.value?.employees ?? [])].sort((a, b) => Number(b.onAllowlist) - Number(a.onAllowlist) || a.name.localeCompare(b.name, "zh-Hant")),
);
const ranking = computed(() => {
  const list = (data.value?.employees ?? []).filter((e) => e.onAllowlist || e.yearCount > 0);
  const score = (e: EmployeeStat) => (rankMode.value === "month" ? e.monthCount : e.yearCount);
  const sorted = [...list].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name, "zh-Hant"));
  let rank = 0;
  let last = -1;
  return sorted.map((e, i) => {
    if (score(e) !== last) {
      rank = i + 1;
      last = score(e);
    }
    return { ...e, score: score(e), rank };
  });
});
const rankMax = computed(() => Math.max(rankMode.value === "month" ? rules.value.maxDays : 1, ...ranking.value.map((r) => r.score)));
const specialList = computed(() => (data.value?.calendar ?? []).filter((d) => d.kind === "holiday" || d.kind === "special"));

function onMonthInput(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  if (/^\d{4}-\d{2}$/.test(v)) month.value = v;
}

function statusInfo(e: EmployeeStat) {
  if (e.status === "submitted") return { cls: "badge-ok", text: "已送出" };
  if (e.status === "needsFix" || e.status === "draft") return { cls: "badge-warn", text: "需補排" };
  return { cls: "badge-gray", text: "未排班" };
}
const short = (date: string) => Number(date.slice(8));
</script>

<template>
  <section>
    <div class="toolbar">
      <div class="month-nav">
        <button class="btn icon-btn" aria-label="上個月" @click="month = shiftMonth(month, -1)">‹</button>
        <h1>{{ formatMonth(month) }}</h1>
        <button class="btn icon-btn" aria-label="下個月" @click="month = shiftMonth(month, 1)">›</button>
        <input class="input month-input" type="month" :value="month" aria-label="選擇月份" @change="onMonthInput" />
      </div>
      <div class="toolbar-right">
        <span v-if="month === session.ctx!.targetMonth" class="badge badge-primary">開放排班中</span>
        <button class="btn btn-sm" :disabled="loading" @click="load">{{ loading ? "更新中…" : "重新整理" }}</button>
      </div>
    </div>

    <div v-if="error" class="banner banner-warning">{{ error }}</div>
    <div v-if="!data && loading" class="center-page" style="min-height: 300px"><div class="spinner" /></div>

    <template v-if="data">
      <!-- 統計卡片 -->
      <div class="stats">
        <div class="stat card">
          <div class="label">在職員工</div>
          <div class="value">{{ data.summary.employeeCount }}<small> 人</small></div>
          <div class="sub">已送出 {{ data.summary.submitted }} 人</div>
        </div>
        <div class="stat card">
          <div class="label">可排班工作日</div>
          <div class="value">{{ data.summary.workdayCount }}<small> 天</small></div>
          <div class="sub">滿編 {{ data.summary.fullDays }} 天・無人 {{ data.summary.emptyDays }} 天</div>
        </div>
        <div class="stat card">
          <div class="label">本月總班數</div>
          <div class="value">{{ data.summary.totalShifts }}<small> / {{ data.summary.capacity }}</small></div>
          <div class="sub">
            人力使用率 {{ data.summary.capacity ? Math.round((data.summary.totalShifts / data.summary.capacity) * 100) : 0 }}%
          </div>
        </div>
        <div class="stat card" :class="{ alert: data.summary.belowMin > 0 }">
          <div class="label">未達 {{ rules.minDays }} 天</div>
          <div class="value">{{ data.summary.belowMin }}<small> 人</small></div>
          <div class="sub">尚未送出 {{ belowMinBreakdown.notSubmitted }}・需補排 {{ belowMinBreakdown.needsFix }}</div>
        </div>
      </div>

      <!-- 班表矩陣 -->
      <div class="card matrix-card">
        <div class="card-title">班表一覽</div>
        <div v-if="!employees.length" class="empty">尚無員工，請先到「員工名單」新增</div>
        <div v-else class="matrix-scroll">
          <table class="matrix">
            <thead>
              <tr>
                <th class="sticky name-col">員工</th>
                <th
                  v-for="d in data.calendar"
                  :key="d.date"
                  :class="['day', d.kind]"
                  :title="d.label ?? (d.blocked ? '週末' : '')"
                >
                  <div>{{ short(d.date) }}</div>
                  <div class="wd">{{ WEEKDAYS[d.weekday] }}</div>
                </th>
                <th class="num-col">本月</th>
                <th class="num-col">{{ month.slice(0, 4) }} 年</th>
                <th class="status-col">狀態</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in employees" :key="e.key" :class="{ removed: !e.onAllowlist }">
                <th class="sticky name-col" :title="e.email">
                  <div class="emp-name">{{ e.name }}</div>
                  <div class="emp-mail">{{ e.onAllowlist ? e.email : "已移出名單" }}</div>
                </th>
                <td v-for="d in data.calendar" :key="d.date" :class="['day', d.kind]">
                  <span v-if="e.monthDays.includes(d.date)" class="shift" :title="`${e.name} ${formatDate(d.date)} 上班`" />
                </td>
                <td class="num-col">
                  <strong :class="{ warn: e.onAllowlist && e.monthCount < rules.minDays }">{{ e.monthCount }}</strong>
                </td>
                <td class="num-col">{{ e.yearCount }}</td>
                <td class="status-col">
                  <span class="badge" :class="statusInfo(e).cls" :title="e.notice ?? ''">{{ statusInfo(e).text }}</span>
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th class="sticky name-col">當日人數</th>
                <td v-for="d in data.calendar" :key="d.date" :class="['day', d.kind]">
                  <span v-if="!d.blocked" class="per-day" :class="`n${Math.min(data.perDay[d.date], rules.maxStaffPerDay)}`">
                    {{ data.perDay[d.date] }}
                  </span>
                </td>
                <td colspan="3" />
              </tr>
            </tfoot>
          </table>
        </div>
        <div class="legend matrix-legend">
          <span><i class="swatch" style="background: var(--primary)" />上班</span>
          <span><i class="swatch" style="background: var(--weekend-soft)" />週末</span>
          <span><i class="swatch" style="background: var(--holiday-soft)" />國定假日</span>
          <span><i class="swatch" style="background: var(--special-soft)" />特殊休假日</span>
          <span>當日人數：<b class="per-day n0">0</b><b class="per-day n1">1</b><b class="per-day n2">2</b><b class="per-day n3">3</b></span>
        </div>
        <div v-if="specialList.length" class="holiday-row">
          <span v-for="d in specialList" :key="d.date" class="badge" :class="d.kind === 'special' ? 'badge-special' : 'badge-holiday'">
            {{ formatDate(d.date) }} {{ d.label }}
          </span>
        </div>
      </div>

      <!-- 排行榜 -->
      <div class="card">
        <div class="card-title rank-title">
          <span>上班天數排行榜</span>
          <div class="seg" role="radiogroup" aria-label="排行榜範圍">
            <button :class="{ on: rankMode === 'month' }" role="radio" :aria-checked="rankMode === 'month'" @click="rankMode = 'month'">
              {{ Number(month.slice(5)) }} 月
            </button>
            <button :class="{ on: rankMode === 'year' }" role="radio" :aria-checked="rankMode === 'year'" @click="rankMode = 'year'">
              {{ month.slice(0, 4) }} 全年
            </button>
          </div>
        </div>
        <div v-if="!ranking.length" class="empty">尚無資料</div>
        <ol v-else class="ranking">
          <li v-for="r in ranking" :key="r.key">
            <span class="rank" :class="`r${r.rank}`">{{ r.rank }}</span>
            <span class="r-name">{{ r.name }}</span>
            <span class="r-bar">
              <span
                class="fill"
                :class="{ warn: rankMode === 'month' && r.score < rules.minDays }"
                :style="{ width: `${(r.score / rankMax) * 100}%` }"
              />
              <span v-if="rankMode === 'month'" class="min-line" :style="{ left: `${(rules.minDays / rankMax) * 100}%` }" />
            </span>
            <span class="r-val">{{ r.score }} 天</span>
          </li>
        </ol>
        <p v-if="rankMode === 'month'" class="small muted" style="margin: 12px 0 0">直線為每月最低 {{ rules.minDays }} 天；橘色表示未達標</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
.month-nav { display: flex; align-items: center; gap: 8px; }
.month-nav h1 { font-size: 24px; min-width: 150px; text-align: center; }
.month-input { width: 150px; margin-left: 8px; }
.toolbar-right { display: flex; gap: 8px; align-items: center; }

.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
.stat { padding: 16px 18px; }
.stat .label { font-size: 13px; color: var(--text-2); }
.stat .value { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 4px 0 2px; }
.stat .value small { font-size: 14px; font-weight: 500; color: var(--text-3); }
.stat .sub { font-size: 12px; color: var(--text-3); }
.stat.alert { border-color: #f1dfb6; background: var(--warning-soft); }
.stat.alert .value { color: var(--warning); }

.matrix-card { margin-bottom: 16px; padding-bottom: 14px; }
.matrix-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.matrix { border-collapse: separate; border-spacing: 0; font-size: 13px; width: 100%; }
.matrix th, .matrix td { border-bottom: 1px solid var(--border); text-align: center; }
.matrix thead th { background: var(--surface-2); font-weight: 600; padding: 6px 0; position: sticky; top: 0; }
.matrix .day { min-width: 26px; width: 26px; padding: 0; height: 42px; }
.matrix thead .day { height: auto; }
.matrix .wd { font-size: 11px; color: var(--text-3); font-weight: 400; }
.matrix .day.weekend, .matrix .day.makeup { background: var(--weekend-soft); }
.matrix .day.holiday { background: var(--holiday-soft); }
.matrix thead .day.holiday { color: var(--holiday); }
.matrix .day.special { background: var(--special-soft); }
.matrix thead .day.special { color: var(--special); }
.sticky { position: sticky; left: 0; z-index: 2; background: var(--surface); }
.matrix thead .sticky { z-index: 3; background: var(--surface-2); }
.name-col { text-align: left !important; padding: 6px 12px !important; min-width: 130px; border-right: 1px solid var(--border); }
.emp-name { font-weight: 600; }
.emp-mail { font-size: 11px; color: var(--text-3); font-weight: 400; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.removed { opacity: .55; }
.shift { display: inline-block; width: 18px; height: 18px; border-radius: 6px; background: var(--primary); vertical-align: middle; }
.num-col { min-width: 52px; padding: 0 6px; white-space: nowrap; font-variant-numeric: tabular-nums; border-left: 1px solid var(--border); }
.num-col .warn { color: var(--warning); }
.status-col { min-width: 80px; padding: 0 8px; }
.matrix tbody tr:hover td:not(.day.weekend):not(.day.holiday):not(.day.special):not(.day.makeup), .matrix tbody tr:hover th { background: #f3f8f7; }
.matrix tfoot th, .matrix tfoot td { border-bottom: none; background: var(--surface-2); font-weight: 600; }
.per-day { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; font-size: 12px; font-weight: 700; margin: 0 2px; }
.per-day.n0 { background: #fdeceb; color: var(--holiday); }
.per-day.n1 { background: var(--warning-soft); color: var(--warning); }
.per-day.n2 { background: var(--primary-soft); color: var(--primary); }
.per-day.n3 { background: var(--success); color: #fff; }
.matrix-legend { margin-top: 14px; }
.holiday-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }

.rank-title { justify-content: space-between; }
.seg { display: inline-flex; background: var(--weekend-soft); border-radius: 8px; padding: 3px; }
.seg button { white-space: nowrap; border: none; background: none; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); font-weight: 600; }
.ranking { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.ranking li { display: grid; grid-template-columns: 32px 110px minmax(0, 1fr) 56px; align-items: center; gap: 12px; }
.rank { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 13px; background: var(--weekend-soft); color: var(--text-2); }
.rank.r1 { background: #f6c84c; color: #5c4300; }
.rank.r2 { background: #d5dbe0; color: #3d4852; }
.rank.r3 { background: #e7b48a; color: #5a3410; }
.r-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-bar { position: relative; height: 14px; background: var(--weekend-soft); border-radius: 999px; }
.r-bar .fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--primary); transition: width .3s; }
.r-bar .fill.warn { background: var(--accent); }
.min-line { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--text-2); opacity: .5; }
.r-val { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }

@media (max-width: 900px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  .month-nav h1 { font-size: 20px; min-width: 120px; }
  .month-input { display: none; }
  .ranking li { grid-template-columns: 28px 72px minmax(0, 1fr) 48px; gap: 8px; }
  .name-col { min-width: 110px; }
}
</style>
