<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { collection, onSnapshot, orderBy, query, type Unsubscribe } from "firebase/firestore";
import { db } from "../../firebase";
import { api, errorMessages, formatDate } from "../../api";
import { session } from "../../session";
import { toast } from "../../toast";
import ModalDialog from "../ModalDialog.vue";

interface SpecialDay {
  date: string;
  reason: string;
  createdBy: string;
}

const items = ref<SpecialDay[]>([]);
const date = ref("");
const reason = ref("");
const busy = ref(false);
const confirmDelete = ref<SpecialDay | null>(null);
const presets = ["颱風假", "尾牙","公司旅遊", "員工教育訓練", "盤點休息"];

const today = computed(() => session.ctx!.today);
const upcoming = computed(() => items.value.filter((i) => i.date > today.value));
const past = computed(() => items.value.filter((i) => i.date <= today.value).reverse());

let unsub: Unsubscribe | undefined;
onMounted(() => {
  unsub = onSnapshot(query(collection(db, "specialDays"), orderBy("date")), (snap) => {
    items.value = snap.docs.map((d) => d.data() as SpecialDay);
  }, (err) => toast(`無法讀取資料：${errorMessages(err).join("、")}`, "error"));
});
onBeforeUnmount(() => unsub?.());

async function add() {
  if (!date.value || !reason.value.trim()) {
    toast("請選擇日期並輸入原因", "error");
    return;
  }
  busy.value = true;
  try {
    const res = await api.addSpecialDay({ date: date.value, reason: reason.value.trim() });
    toast(
      res.affected.length
        ? `已設定 ${formatDate(res.date)}「${res.reason}」，並移除 ${res.affected.join("、")} 當天的排班`
        : `已設定 ${formatDate(res.date)}「${res.reason}」`,
      "success",
    );
    date.value = "";
    reason.value = "";
  } catch (err) {
    toast(errorMessages(err).join("\n"), "error");
  } finally {
    busy.value = false;
  }
}

async function remove() {
  const target = confirmDelete.value;
  if (!target) return;
  confirmDelete.value = null;
  try {
    await api.removeSpecialDay({ date: target.date });
    toast(`已取消 ${formatDate(target.date)} 的特殊休假`, "success");
  } catch (err) {
    toast(errorMessages(err).join("\n"), "error");
  }
}

const minDate = computed(() => {
  const d = new Date(`${today.value}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
});
</script>

<template>
  <section class="grid">
    <div class="card">
      <div class="card-title">新增特殊休假日</div>
      <p class="small muted intro">
        設定後當天不開放排班。若已有員工排在當天，系統會自動移除並通知他們；若因此低於 10 天，會標示為「需補排」請員工補足後重新送出。
      </p>
      <form class="form" @submit.prevent="add">
        <label class="field">
          日期
          <input v-model="date" class="input" type="date" :min="minDate" required />
        </label>
        <label class="field">
          原因
          <input v-model="reason" class="input" maxlength="30" placeholder="例如：颱風假" required />
        </label>
        <div class="presets">
          <button v-for="p in presets" :key="p" type="button" class="chip-btn" @click="reason = p">{{ p }}</button>
        </div>
        <button class="btn btn-primary" type="submit" :disabled="busy">{{ busy ? "設定中…" : "新增休假日" }}</button>
      </form>
    </div>

    <div class="card">
      <div class="card-title">即將到來（{{ upcoming.length }}）</div>
      <div v-if="!upcoming.length" class="empty">目前沒有特殊休假日</div>
      <ul v-else class="list">
        <li v-for="i in upcoming" :key="i.date">
          <div>
            <div class="date">{{ i.date.slice(0, 4) }}/{{ formatDate(i.date) }}</div>
            <span class="badge badge-special">{{ i.reason }}</span>
          </div>
          <button class="btn btn-sm btn-danger" @click="confirmDelete = i">取消</button>
        </li>
      </ul>
      <template v-if="past.length">
        <div class="card-title past-title">已過去</div>
        <ul class="list past">
          <li v-for="i in past" :key="i.date">
            <div>
              <div class="date">{{ i.date.slice(0, 4) }}/{{ formatDate(i.date) }}</div>
              <span class="badge badge-gray">{{ i.reason }}</span>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <ModalDialog :open="!!confirmDelete" title="取消特殊休假日？" tone="warning" @close="confirmDelete = null">
      <p style="margin: 0">
        {{ confirmDelete && formatDate(confirmDelete.date) }}「{{ confirmDelete?.reason }}」將恢復為可排班日。先前被移除的員工排班不會自動恢復。
      </p>
      <template #actions>
        <button class="btn" @click="confirmDelete = null">保留</button>
        <button class="btn btn-primary" @click="remove">確定取消</button>
      </template>
    </ModalDialog>
  </section>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: minmax(0, 380px) minmax(0, 1fr); gap: 20px; align-items: start; }
.intro { margin: -6px 0 16px; }
.form { display: grid; gap: 14px; }
.presets { display: flex; flex-wrap: wrap; gap: 6px; margin-top: -4px; }
.chip-btn { border: 1px dashed var(--border); background: var(--surface-2); border-radius: 999px; padding: 3px 10px; font-size: 12px; cursor: pointer; color: var(--text-2); }
.chip-btn:hover { border-color: var(--special); color: var(--special); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.list li { display: flex; justify-content: space-between; align-items: center; padding: 10px 4px; border-bottom: 1px solid var(--border); }
.list li:last-child { border-bottom: none; }
.date { font-weight: 600; margin-bottom: 4px; font-variant-numeric: tabular-nums; }
.past { opacity: .6; }
.past-title { margin-top: 20px; font-size: 14px; color: var(--text-2); }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
</style>
