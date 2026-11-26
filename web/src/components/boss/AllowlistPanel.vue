<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, setDoc, type Unsubscribe } from "firebase/firestore";
import { db } from "../../firebase";
import { errorMessages } from "../../api";
import { toast } from "../../toast";
import ModalDialog from "../ModalDialog.vue";

interface Member {
  email: string;
  name: string;
}

const members = ref<Member[]>([]);
const name = ref("");
const email = ref("");
const busy = ref(false);
const confirmRemove = ref<Member | null>(null);

let unsub: Unsubscribe | undefined;
onMounted(() => {
  unsub = onSnapshot(query(collection(db, "allowlist"), orderBy("createdAt")), (snap) => {
    members.value = snap.docs.map((d) => ({ email: d.id, name: d.get("name") }));
  }, (err) => toast(`無法讀取資料：${errorMessages(err).join("、")}`, "error"));
});
onBeforeUnmount(() => unsub?.());

async function add() {
  const e = email.value.trim().toLowerCase();
  const n = name.value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
    toast("Email 格式不正確", "error");
    return;
  }
  if (!n) {
    toast("請輸入姓名", "error");
    return;
  }
  if (members.value.some((m) => m.email === e)) {
    toast("這個 Email 已在名單中", "error");
    return;
  }
  busy.value = true;
  try {
    await setDoc(doc(db, "allowlist", e), { email: e, name: n, createdAt: serverTimestamp() });
    toast(`已加入 ${n}`, "success");
    name.value = "";
    email.value = "";
  } catch (err) {
    toast(errorMessages(err).join("\n"), "error");
  } finally {
    busy.value = false;
  }
}

async function remove() {
  const m = confirmRemove.value;
  if (!m) return;
  confirmRemove.value = null;
  try {
    await deleteDoc(doc(db, "allowlist", m.email));
    toast(`已將 ${m.name} 移出名單`, "success");
  } catch (err) {
    toast(errorMessages(err).join("\n"), "error");
  }
}
</script>

<template>
  <section class="grid">
    <div class="card">
      <div class="card-title">新增員工</div>
      <p class="small muted intro">只有名單內的 Google 帳號可以登入排班。</p>
      <form class="form" @submit.prevent="add">
        <label class="field">
          姓名
          <input v-model="name" class="input" maxlength="30" placeholder="王小明" required />
        </label>
        <label class="field">
          Google 帳號 Email
          <input v-model="email" class="input" type="email" placeholder="someone@gmail.com" required />
        </label>
        <button class="btn btn-primary" type="submit" :disabled="busy">加入名單</button>
      </form>
    </div>

    <div class="card">
      <div class="card-title">員工名單（{{ members.length }}）</div>
      <div v-if="!members.length" class="empty">尚未新增員工</div>
      <ul v-else class="list">
        <li v-for="m in members" :key="m.email">
          <div class="avatar">{{ m.name.slice(0, 1) }}</div>
          <div class="info">
            <div class="name">{{ m.name }}</div>
            <div class="small muted">{{ m.email }}</div>
          </div>
          <button class="btn btn-sm btn-danger" @click="confirmRemove = m">移除</button>
        </li>
      </ul>
    </div>

    <ModalDialog :open="!!confirmRemove" title="移出名單？" tone="warning" @close="confirmRemove = null">
      <p style="margin: 0">
        {{ confirmRemove?.name }}（{{ confirmRemove?.email }}）將無法再登入排班。已排定的班表會保留，在總覽中標示為「已移出名單」。
      </p>
      <template #actions>
        <button class="btn" @click="confirmRemove = null">取消</button>
        <button class="btn btn-primary" @click="remove">確定移除</button>
      </template>
    </ModalDialog>
  </section>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: minmax(0, 380px) minmax(0, 1fr); gap: 20px; align-items: start; }
.intro { margin: -6px 0 16px; }
.form { display: grid; gap: 14px; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--border); }
.list li:last-child { border-bottom: none; }
.avatar { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); font-weight: 700; flex-shrink: 0; }
.info { flex: 1; min-width: 0; }
.info .muted { overflow: hidden; text-overflow: ellipsis; }
.name { font-weight: 600; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
</style>
