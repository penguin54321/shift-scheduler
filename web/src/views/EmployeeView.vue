<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { collection, doc, onSnapshot, query, where, type Unsubscribe } from "firebase/firestore";
import { db } from "../firebase";
import { api, dayLabel, errorMessages, formatDate, formatMonth, WEEKDAYS, type DayInfo, type ScheduleStatus } from "../api";
import { session } from "../session";
import { toast } from "../toast";
import ModalDialog from "../components/ModalDialog.vue";

const ctx = computed(() => session.ctx!);
const month = computed(() => ctx.value.targetMonth);
const rules = computed(() => ctx.value.rules);

const calendar = ref<DayInfo[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

/** 伺服器上已儲存的班表 */
const savedDays = ref<string[]>([]);
const status = ref<ScheduleStatus>("none");
const notice = ref<string | null>(null);
/** 畫面上正在編輯的選擇（送出失敗也不清除） */
const selected = ref<Set<string>>(new Set());
/** 各日已排人數（即時） */
const dayCounts = ref<Record<string, string[]>>({});

const saving = ref(false);
/** 是否從瀏覽器暫存恢復了上次未送出的選擇 */
const restoredLocal = ref(false);
/** 第一次讀到班表之前，不寫入瀏覽器暫存（避免把空選擇蓋掉暫存） */
let localReady = false;
const modal = ref<{ title: string; tone: "warning" | "success"; lines: string[] } | null>(null);

const dirty = computed(() => {
  if (selected.value.size !== savedDays.value.length) return true;
  return savedDays.value.some((d) => !selected.value.has(d));
});
const count = computed(() => selected.value.size);
const inRange = computed(() => count.value >= rules.value.minDays && count.value <= rules.value.maxDays);

/** 不含自己的已排人數 */
function othersOn(date: string): number {
  const uids = dayCounts.value[date] ?? [];
  return uids.filter((u) => u !== session.user?.uid).length;
}
function staffOn(date: string): number {
  return othersOn(date) + (selected.value.has(date) ? 1 : 0);
}
function isFull(date: string): boolean {
  return othersOn(date) >= rules.value.maxStaffPerDay;
}

/** 月曆格（前面補空白讓 1 號對齊星期） */
const cells = computed(() => {
  if (!calendar.value.length) return [];
  const pad = Array.from({ length: calendar.value[0].weekday }, () => null);
  return [...pad, ...calendar.value];
});

const availableCount = computed(
  () => calendar.value.filter((d) => !d.blocked && (!isFull(d.date) || selected.value.has(d.date))).length,
);
const blockedHolidays = computed(() => calendar.value.filter((d) => d.kind === "holiday" || d.kind === "special" || d.kind === "makeup"));

function toggle(day: DayInfo) {
  if (day.blocked) return;
  const next = new Set(selected.value);
  if (next.has(day.date)) {
    next.delete(day.date);
  } else {
    if (isFull(day.date)) {
      toast(`${formatDate(day.date)} 已額滿（${rules.value.maxStaffPerDay} 人）`, "error");
      return;
    }
    if (next.size >= rules.value.maxDays) {
      toast(`每月最多只能排 ${rules.value.maxDays} 天`, "error");
      return;
    }
    next.add(day.date);
  }
  selected.value = next;
}

function resetToSaved() {
  selected.value = new Set(savedDays.value);
  restoredLocal.value = false;
}

/* ---------- 未送出的選擇暫存在瀏覽器（不佔名額、老闆看不到） ---------- */
const storageKey = computed(() => `schedule-selection:${session.user?.uid}:${month.value}`);

function readLocal(): string[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey.value) ?? "null");
    if (Array.isArray(value) && value.every((d) => typeof d === "string" && d.startsWith(`${month.value}-`))) {
      return value as string[];
    }
  } catch {
    /* 讀不到暫存（無痕模式等）就當作沒有 */
  }
  return null;
}

function writeLocal() {
  if (!localReady) return;
  try {
    if (dirty.value) localStorage.setItem(storageKey.value, JSON.stringify([...selected.value].sort()));
    else localStorage.removeItem(storageKey.value);
  } catch {
    /* 暫存失敗不影響排班，只是關掉頁面後選擇不會保留 */
  }
}
watch([selected, savedDays], writeLocal);

/** 第一次讀到伺服器班表後，若瀏覽器有未送出的選擇就恢復它 */
function restoreLocal() {
  const local = readLocal();
  if (local) {
    const blocked = new Set(calendar.value.filter((d) => d.blocked).map((d) => d.date));
    const usable = local.filter((d) => !blocked.has(d)).slice(0, rules.value.maxDays);
    const same = usable.length === savedDays.value.length && usable.every((d) => savedDays.value.includes(d));
    if (!same) {
      selected.value = new Set(usable);
      restoredLocal.value = true;
    }
  }
  localReady = true;
  writeLocal();
}

async function submit() {
  const days = [...selected.value].sort();
  if (!inRange.value) {
    const { minDays, maxDays } = rules.value;
    modal.value = {
      title: "排班天數不符合規定",
      tone: "warning",
      lines: [
        `每位員工每月需排 ${minDays}～${maxDays} 天，您目前選了 ${days.length} 天。`,
        days.length < minDays ? `請再增加 ${minDays - days.length} 天後再送出。` : `請減少 ${days.length - maxDays} 天後再送出。`,
        "已選的日期都會保留，您可以直接調整。",
      ],
    };
    return;
  }
  saving.value = true;
  try {
    const res = await api.saveSchedule({ month: month.value, days });
    savedDays.value = res.days;
    status.value = res.status;
    restoredLocal.value = false;
    modal.value = {
      title: "班表已送出",
      tone: "success",
      lines: [`${formatMonth(month.value)}共 ${res.days.length} 天。`, "月份開始前仍可修改並重新送出。"],
    };
  } catch (err) {
    modal.value = { title: "送出失敗", tone: "warning", lines: [...errorMessages(err), "已選的日期都會保留，請調整後再試。"] };
  } finally {
    saving.value = false;
  }
}

async function loadCalendar() {
  try {
    const res = await api.getCalendar({ month: month.value });
    calendar.value = res.days;
    loadError.value = null;
    // 若有已選日期剛被設為特殊休假日，從選擇中移除
    const blocked = new Set(res.days.filter((d) => d.blocked).map((d) => d.date));
    if ([...selected.value].some((d) => blocked.has(d))) {
      selected.value = new Set([...selected.value].filter((d) => !blocked.has(d)));
    }
  } catch (err) {
    loadError.value = errorMessages(err).join("\n");
  }
}

let unsubs: Unsubscribe[] = [];
function subscribe() {
  unsubs.forEach((u) => u());
  const m = month.value;
  const uid = session.user!.uid;
  let firstSchedule = true;
  localReady = false;
  // 即時監聽失敗（例如被移出員工名單、網路中斷）時停止轉圈並顯示原因
  const onListenError = (err: unknown) => {
    loading.value = false;
    loadError.value = `無法即時讀取排班資料：${errorMessages(err).join("、")}。請重新整理頁面，若持續發生請聯絡老闆。`;
  };
  unsubs = [
    onSnapshot(
      query(collection(db, "dayCounts"), where("month", "==", m)),
      (snap) => {
        dayCounts.value = Object.fromEntries(snap.docs.map((d) => [d.id, (d.get("uids") as string[]) ?? []]));
      },
      onListenError,
    ),
    onSnapshot(
      doc(db, "schedules", `${m}_${uid}`),
      (snap) => {
        const wasDirty = dirty.value;
        savedDays.value = snap.exists() ? (snap.get("days") as string[]) : [];
        status.value = snap.exists() ? snap.get("status") : "none";
        notice.value = snap.exists() ? snap.get("notice") : null;
        if (firstSchedule) {
          resetToSaved();
          restoreLocal();
        } else if (!wasDirty) {
          resetToSaved();
        }
        firstSchedule = false;
        loading.value = false;
      },
      onListenError,
    ),
    onSnapshot(query(collection(db, "specialDays"), where("month", "==", m)), () => loadCalendar(), onListenError),
  ];
}

onMounted(async () => {
  await loadCalendar();
  subscribe();
});
watch(month, async () => {
  loading.value = true;
  await loadCalendar();
  subscribe();
});
onBeforeUnmount(() => unsubs.forEach((u) => u()));

const statusBadge = computed(() => {
  if (dirty.value) return { cls: "badge-primary", text: status.value === "none" ? "尚未送出" : "有未送出的變更" };
  if (status.value === "submitted") return { cls: "badge-ok", text: "已送出" };
  if (status.value === "needsFix" || status.value === "draft") return { cls: "badge-warn", text: "需補排" };
  return { cls: "badge-gray", text: "尚未排班" };
});

const progressPct = computed(() => Math.min(100, (count.value / rules.value.maxDays) * 100));
const minPct = computed(() => (rules.value.minDays / rules.value.maxDays) * 100);
</script>

<template>
  <main class="container">
    <div class="page-head">
      <div>
        <p class="muted small eyebrow">開放排班月份</p>
        <h1>{{ formatMonth(month) }}</h1>
      </div>
      <span class="badge" :class="statusBadge.cls">{{ statusBadge.text }}</span>
    </div>

    <div v-if="notice" class="banner banner-warning">
      <span>⚠</span>
      <div>{{ notice }}</div>
    </div>
    <div v-if="loadError" class="banner banner-warning">{{ loadError }}</div>
    <div v-if="restoredLocal && dirty" class="banner banner-info restored">
      <span>↺</span>
      <div>已恢復您上次<strong>尚未送出</strong>的選擇。送出前不會佔用名額，請記得按「送出班表」。</div>
      <button class="btn btn-sm" @click="resetToSaved">捨棄</button>
    </div>

    <div class="layout">
      <!-- 月曆 -->
      <section class="card cal-card">
        <div v-if="loading" class="center-page" style="min-height: 360px"><div class="spinner" /></div>
        <template v-else>
          <div class="cal-grid head">
            <div v-for="(w, i) in WEEKDAYS" :key="w" :class="{ wk: i === 0 || i === 6 }">{{ w }}</div>
          </div>
          <div class="cal-grid">
            <template v-for="(day, i) in cells" :key="day?.date ?? `pad-${i}`">
              <div v-if="!day" class="cell pad" />
              <button
                v-else
                type="button"
                class="cell"
                :class="[
                  day.kind,
                  {
                    selected: selected.has(day.date),
                    full: !day.blocked && isFull(day.date) && !selected.has(day.date),
                  },
                ]"
                :disabled="day.blocked"
                :aria-pressed="selected.has(day.date)"
                :title="day.blocked ? dayLabel(day) || '不開放排班' : `${staffOn(day.date)}/${rules.maxStaffPerDay} 人`"
                @click="toggle(day)"
              >
                <span class="num">{{ Number(day.date.slice(8)) }}</span>
                <span v-if="selected.has(day.date)" class="check">✓</span>
                <span v-if="day.blocked" class="tag">{{ dayLabel(day) }}</span>
                <span v-else class="staff">
                  <span class="dots">
                    <i v-for="n in rules.maxStaffPerDay" :key="n" :class="{ on: n <= staffOn(day.date) }" />
                  </span>
                  <span class="staff-text">{{ isFull(day.date) && !selected.has(day.date) ? "額滿" : `${staffOn(day.date)}/${rules.maxStaffPerDay}` }}</span>
                </span>
              </button>
            </template>
          </div>
          <div class="legend cal-legend">
            <span><i class="swatch" style="background: var(--primary)" />我的排班</span>
            <span><i class="swatch" style="background: var(--surface)" />可排班</span>
            <span><i class="swatch" style="background: var(--weekend-soft)" />週末</span>
            <span><i class="swatch" style="background: var(--holiday-soft)" />國定假日</span>
            <span><i class="swatch" style="background: var(--special-soft)" />特殊休假日</span>
            <span><i class="swatch" style="background: repeating-linear-gradient(45deg,#eee 0 3px,#fff 3px 6px)" />額滿</span>
          </div>
        </template>
      </section>

      <!-- 側欄 -->
      <aside class="side">
        <section class="card">
          <div class="card-title">本月進度</div>
          <div class="count">
            <strong :class="{ ok: inRange }">{{ count }}</strong>
            <span class="muted">/ {{ rules.minDays }}～{{ rules.maxDays }} 天</span>
          </div>
          <div class="progress" :style="{ '--min': `${minPct}%` }">
            <div class="bar" :class="{ ok: inRange }" :style="{ width: `${progressPct}%` }" />
            <span class="min-mark" :title="`至少 ${rules.minDays} 天`" />
          </div>
          <p class="small muted hint">
            <template v-if="count < rules.minDays">還需至少 {{ rules.minDays - count }} 天才能送出</template>
            <template v-else-if="count < rules.maxDays">已達最低天數，最多還可再排 {{ rules.maxDays - count }} 天</template>
            <template v-else>已達每月上限 {{ rules.maxDays }} 天</template>
          </p>
          <p class="small muted">本月尚有 {{ availableCount }} 個工作日可選</p>

          <div class="actions">
            <button class="btn btn-primary" :disabled="saving || loading || (!dirty && status === 'submitted')" @click="submit">
              {{ saving ? "送出中…" : status === "none" ? "送出班表" : "更新班表" }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="saving || !dirty" @click="resetToSaved">
              {{ status === "none" ? "清除選擇" : "復原為已送出的班表" }}
            </button>
            <p class="small muted autosave">送出前不會佔用名額；未送出的選擇會暫存在這台裝置的瀏覽器。</p>
          </div>
        </section>

        <section class="card">
          <div class="card-title">我的排班（{{ count }} 天）</div>
          <div v-if="count" class="chips">
            <span v-for="d in [...selected].sort()" :key="d" class="chip">{{ formatDate(d) }}</span>
          </div>
          <p v-else class="small muted">點選左側月曆的日期即可排班</p>
        </section>

        <section v-if="blockedHolidays.length" class="card">
          <div class="card-title">本月休假日</div>
          <ul class="holiday-list">
            <li v-for="d in blockedHolidays" :key="d.date">
              <span>{{ formatDate(d.date) }}</span>
              <span class="badge" :class="d.kind === 'special' ? 'badge-special' : d.kind === 'makeup' ? 'badge-gray' : 'badge-holiday'">{{ d.label }}</span>
            </li>
          </ul>
        </section>
      </aside>
    </div>

    <ModalDialog :open="!!modal" :title="modal?.title ?? ''" :tone="modal?.tone" @close="modal = null">
      <p v-for="(l, i) in modal?.lines" :key="i" style="margin: 0 0 6px">{{ l }}</p>
      <template #actions>
        <button class="btn btn-primary" @click="modal = null">{{ modal?.tone === "warning" ? "返回調整" : "好的" }}</button>
      </template>
    </ModalDialog>
  </main>
</template>

<style scoped>
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.eyebrow { margin: 0 0 2px; }
h1 { font-size: 28px; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
.side { display: grid; gap: 16px; position: sticky; top: 76px; }

.cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; }
.cal-grid.head { margin-bottom: 8px; text-align: center; font-size: 13px; font-weight: 600; color: var(--text-2); }
.cal-grid.head .wk { color: var(--holiday); }

.cell {
  position: relative; min-height: 92px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface); padding: 8px; text-align: left; cursor: pointer;
  display: flex; flex-direction: column; justify-content: space-between; gap: 4px;
  transition: transform .1s, box-shadow .15s, border-color .15s, background .15s;
}
.cell.pad { border: none; background: transparent; cursor: default; }
.cell.workday:hover:not(.full) { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.cell.workday:active { transform: scale(.97); }
.cell:disabled { cursor: not-allowed; }
.cell.weekend, .cell.makeup { background: var(--weekend-soft); color: var(--text-3); }
.cell.holiday { background: var(--holiday-soft); border-color: #f2d3cf; }
.cell.holiday .num, .cell.holiday .tag { color: var(--holiday); }
.cell.special { background: var(--special-soft); border-color: #ddd0f0; }
.cell.special .num, .cell.special .tag { color: var(--special); }
.cell.full { background: repeating-linear-gradient(45deg, #f6f6f6 0 6px, #fff 6px 12px); cursor: not-allowed; }
.cell.full .num { color: var(--text-3); }
.cell.selected { background: var(--primary); border-color: var(--primary); color: #fff; box-shadow: 0 4px 12px rgba(47, 111, 115, .3); }
.cell.selected .staff-text { color: rgba(255, 255, 255, .85); }
.cell.selected .dots i { background: rgba(255, 255, 255, .35); }
.cell.selected .dots i.on { background: #fff; }

.num { font-weight: 700; font-size: 16px; }
.check { position: absolute; top: 8px; right: 10px; font-weight: 800; }
.tag { font-size: 12px; line-height: 1.3; font-weight: 600; word-break: break-all; }
.staff { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.dots { display: flex; gap: 3px; }
.dots i { width: 8px; height: 8px; border-radius: 50%; background: #dfe6e4; }
.dots i.on { background: var(--accent); }
.staff-text { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.cal-legend { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }

.count { display: flex; align-items: baseline; gap: 8px; }
.count strong { font-size: 40px; line-height: 1; color: var(--warning); font-variant-numeric: tabular-nums; }
.count strong.ok { color: var(--success); }
.progress { position: relative; height: 10px; border-radius: 999px; background: var(--weekend-soft); margin: 12px 0 8px; }
.progress .bar { height: 100%; border-radius: 999px; background: var(--warning); transition: width .25s; }
.progress .bar.ok { background: var(--success); }
.min-mark { position: absolute; left: var(--min); top: -3px; width: 2px; height: 16px; background: var(--text-2); border-radius: 2px; }
.hint { margin: 0 0 4px; }
.actions { display: grid; gap: 8px; margin-top: 16px; }
.autosave { margin: 4px 0 0; text-align: center; }
.restored { align-items: center; }
.restored > div { flex: 1; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 12px; padding: 3px 8px; border-radius: 6px; background: var(--primary-soft); color: var(--primary-hover); font-variant-numeric: tabular-nums; }
.holiday-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 14px; }
.holiday-list li { display: flex; justify-content: space-between; align-items: center; gap: 8px; }

@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .side { position: static; }
}
@media (max-width: 640px) {
  .cal-grid { gap: 4px; }
  .cell { min-height: 64px; padding: 5px; border-radius: 8px; }
  .num { font-size: 14px; }
  .tag { font-size: 10px; }
  .staff-text { display: none; }
  .dots i { width: 6px; height: 6px; }
  .check { top: 4px; right: 6px; font-size: 12px; }
}
</style>
