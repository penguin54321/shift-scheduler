#!/usr/bin/env node
/**
 * 在「正式環境」放入 3 位示範員工的班表，讓面試 Demo 時月曆上已經有人排班、有額滿的日子。
 *
 * 用法（在專案根目錄）：
 *   npm run seed:prod-demo                         # 開放排班月份與下一個月
 *   npm run seed:prod-demo -- --months 2027-01     # 指定月份（可用逗號分隔多個）
 *   npm run seed:prod-demo -- --remove             # 移除所有示範員工與他們的班表
 *
 * 需要服務帳戶金鑰 scripts/keys/service-account.json（已被 .gitignore 排除）。
 *
 * - 示範員工只是名單與班表資料，沒有登入帳號；資料都標記 demo: true，可用 --remove 一次清掉。
 * - 會保留真實員工的排班：人數是「真實 + 示範」合併計算，不會讓任何一天超過 3 人。
 * - 重跑會先清掉舊的示範資料再重新建立，結果固定（固定亂數種子）。
 */
const path = require("path");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const rules = require(path.join(__dirname, "../functions/lib/rules.js"));

const KEY = path.join(__dirname, "keys/service-account.json");
const DEMO = [
  { uid: "demo-xiaoming", email: "xiaoming@example.com", name: "陳小明", target: 14 },
  { uid: "demo-meiling", email: "meiling@example.com", name: "林美玲", target: 12 },
  { uid: "demo-zhihao", email: "zhihao@example.com", name: "張志豪", target: 10 },
];
const FULL_DAYS = 3; // 3 人都排 → 額滿
const LAST_SLOT_DAYS = 5; // 前 2 人排 → 剩 1 個名額

let seed = 20261125;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const monthsArg = args.includes("--months") ? args[args.indexOf("--months") + 1] : null;

let db;

/** 清掉所有示範資料（班表、名單、人數裡的示範 uid） */
async function removeDemo() {
  const uids = new Set(DEMO.map((e) => e.uid));
  const batch = db.batch();
  let n = 0;
  for (const e of DEMO) {
    const allow = await db.doc(`allowlist/${e.email}`).get();
    if (allow.exists && allow.get("demo")) (batch.delete(allow.ref), n++);
    const scheds = await db.collection("schedules").where("uid", "==", e.uid).get();
    scheds.docs.forEach((d) => (batch.delete(d.ref), n++));
  }
  const counts = await db.collection("dayCounts").get();
  for (const d of counts.docs) {
    const old = d.get("uids") ?? [];
    const kept = old.filter((u) => !uids.has(u));
    if (kept.length === old.length) continue;
    batch.set(d.ref, { uids: kept, count: kept.length }, { merge: true });
    n++;
  }
  await batch.commit();
  return n;
}

/** 依目前（真實員工的）人數，分配 3 位示範員工的日期 */
function plan(workdays, existing) {
  const count = Object.fromEntries(workdays.map((d) => [d, existing[d] ?? 0]));
  const empty = shuffle(workdays.filter((d) => count[d] === 0));
  const full = empty.slice(0, FULL_DAYS);
  const last = empty.slice(FULL_DAYS, FULL_DAYS + LAST_SLOT_DAYS);
  const result = {};
  DEMO.forEach((e, i) => {
    const days = new Set(full);
    if (i < 2) last.forEach((d) => days.add(d));
    days.forEach((d) => count[d]++);
    result[e.uid] = days;
  });
  // 其餘天數：先排沒人的日子，再排只有 1 人的日子，不額外製造額滿
  for (const e of DEMO) {
    const days = result[e.uid];
    for (const level of [0, 1]) {
      for (const d of shuffle(workdays)) {
        if (days.size >= e.target) break;
        if (days.has(d) || count[d] !== level) continue;
        days.add(d);
        count[d]++;
      }
    }
    if (days.size < rules.MIN_DAYS_PER_MONTH) throw new Error(`${e.name} 只排得到 ${days.size} 天`);
    result[e.uid] = [...days].sort();
  }
  return result;
}

async function seedMonth(month) {
  const year = month.slice(0, 4);
  const holidayDoc = await db.doc(`holidays/${year}`).get();
  if (!holidayDoc.exists) throw new Error(`正式環境還沒有 ${year} 年的國定假日快取，請先登入網站讓系統抓取`);
  const specialSnap = await db.collection("specialDays").where("month", "==", month).get();
  const specials = Object.fromEntries(specialSnap.docs.map((d) => [d.id, d.get("reason")]));
  const cal = rules.buildMonthCalendar(month, holidayDoc.get("days"), specials);
  const workdays = cal.filter((d) => !d.blocked).map((d) => d.date);

  const countSnap = await db.collection("dayCounts").where("month", "==", month).get();
  const existingUids = Object.fromEntries(countSnap.docs.map((d) => [d.id, d.get("uids") ?? []]));
  const existing = Object.fromEntries(Object.entries(existingUids).map(([d, u]) => [d, u.length]));
  const assigned = plan(workdays, existing);

  const batch = db.batch();
  const perDay = { ...existingUids };
  for (const e of DEMO) {
    const days = assigned[e.uid];
    days.forEach((d) => (perDay[d] = [...(perDay[d] ?? []), e.uid]));
    batch.set(db.doc(`schedules/${month}_${e.uid}`), {
      uid: e.uid,
      email: e.email,
      displayName: e.name,
      month,
      year,
      days,
      count: days.length,
      status: "submitted",
      notice: null,
      demo: true,
      updatedAt: FieldValue.serverTimestamp(),
      submittedAt: FieldValue.serverTimestamp(),
    });
  }
  for (const [date, uids] of Object.entries(perDay)) {
    if (uids.length > rules.MAX_STAFF_PER_DAY) throw new Error(`${date} 會超過 ${rules.MAX_STAFF_PER_DAY} 人`);
    batch.set(db.doc(`dayCounts/${date}`), { date, month, uids, count: uids.length });
  }
  await batch.commit();

  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  const full = workdays.filter((d) => (perDay[d] ?? []).length >= 3).map(md);
  const last = workdays.filter((d) => (perDay[d] ?? []).length === 2).map(md);
  console.log(`\n${month}：${DEMO.map((e) => `${e.name} ${assigned[e.uid].length} 天`).join("、")}`);
  console.log(`  已額滿：${full.join("、") || "無"}`);
  console.log(`  剩 1 個名額：${last.join("、") || "無"}`);
}

(async () => {
  initializeApp({ credential: cert(require(KEY)) });
  db = getFirestore();

  const removed = await removeDemo();
  if (remove) {
    console.log(`✅ 已移除示範員工與班表（${removed} 筆）`);
    process.exit(0);
  }

  const target = rules.nextMonthOf(rules.todayInTaipei());
  const months = monthsArg ? monthsArg.split(",") : [target, rules.nextMonthOf(`${target}-01`)];

  const batch = db.batch();
  for (const e of DEMO) {
    batch.set(db.doc(`allowlist/${e.email}`), { email: e.email, name: e.name, demo: true, createdAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();

  for (const m of months) await seedMonth(m);
  console.log(`\n✅ 正式環境示範資料建立完成。移除：npm run seed:prod-demo -- --remove`);
  process.exit(0);
})().catch((err) => {
  console.error("❌", err.message ?? err);
  process.exit(1);
});
