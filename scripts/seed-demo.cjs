#!/usr/bin/env node
/**
 * 一鍵建立示範資料（只會寫入本機模擬器，不會碰正式環境）。
 *
 * 用法：先 `npm run emulators`，再開另一個終端機執行 `npm run seed:demo`
 *
 * 建立內容：
 *  - 老闆 1 位、員工 4 位（都是 Google 帳號，登入視窗直接點選即可）
 *  - 今年已過去月份的班表（讓「該年總計」與年度排行榜有資料）
 *  - 開放排班月份：3 位員工已送出、1 位尚未排班（面試時可現場示範送出）
 *    其中少數幾天已額滿、幾天只剩最後一個名額（見 planTargetMonth）
 *  - 開放排班月份 1 天特殊休假日「尾牙」
 *
 * ⚠️ 會先清空模擬器裡的所有帳號與資料。
 */
const path = require("path");

const PROJECT = "demo-shift-scheduler";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const rules = require(path.join(__dirname, "../functions/lib/rules.js"));

const BOSS = { email: "boss@example.com", name: "王老闆" };
const EMPLOYEES = [
  { email: "xiaoming@example.com", name: "陳小明", perMonth: [14, 18], fromMonth: 1, target: 14 },
  { email: "meiling@example.com", name: "林美玲", perMonth: [12, 16], fromMonth: 1, target: 12 },
  { email: "zhihao@example.com", name: "張志豪", perMonth: [10, 13], fromMonth: 3, target: 10 },
  // 尚未排班：面試時用這位現場示範送出
  { email: "yating@example.com", name: "黃雅婷", perMonth: [10, 12], fromMonth: 9, target: 0 },
];

/** 固定亂數種子：每次產生的示範資料都一樣 */
let seed = 20261121;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 開放月份的班表：刻意做出「少數幾天額滿、幾天剩最後一個名額」，方便測試額滿與搶名額。
 * 先挑 FULL_DAYS 天讓所有已排班的員工都排（額滿），再挑 LAST_SLOT_DAYS 天讓前兩位排（剩 1 個名額），
 * 其餘天數優先排到沒人的日子，且不會再多出額滿的日子。
 */
const FULL_DAYS = 3;
const LAST_SLOT_DAYS = 5;
function planTargetMonth(workdays, people) {
  const order = shuffle(workdays);
  const full = order.slice(0, FULL_DAYS);
  const last = order.slice(FULL_DAYS, FULL_DAYS + LAST_SLOT_DAYS);
  const count = Object.fromEntries(workdays.map((d) => [d, 0]));
  const plan = {};
  people.forEach((e, i) => {
    const days = new Set(full);
    if (i < 2) last.forEach((d) => days.add(d));
    days.forEach((d) => count[d]++);
    plan[e.uid] = days;
  });
  for (const e of people) {
    const days = plan[e.uid];
    for (const level of [0, 1]) {
      for (const d of shuffle(workdays)) {
        if (days.size >= e.target) break;
        if (days.has(d) || count[d] !== level) continue;
        days.add(d);
        count[d]++;
      }
    }
    plan[e.uid] = [...days].sort();
  }
  return plan;
}

async function ensureEmulators() {
  try {
    await fetch("http://127.0.0.1:8080/");
    await fetch("http://127.0.0.1:9099/");
  } catch {
    console.error("❌ 連不到模擬器。請先在另一個終端機執行：npm run emulators");
    process.exit(1);
  }
}

async function clearAll() {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
}

async function fetchHolidays(year) {
  const res = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`);
  if (!res.ok) throw new Error(`無法取得 ${year} 年國定假日（HTTP ${res.status}）`);
  return rules.parseTaiwanCalendar(await res.json());
}

(async () => {
  await ensureEmulators();
  initializeApp({ projectId: PROJECT });
  const auth = getAuth();
  const db = getFirestore();

  console.log("清空模擬器資料…");
  await clearAll();

  // 建立 Google 登入帳號（模擬器的 Google 登入視窗會列出這些帳號）
  const people = [BOSS, ...EMPLOYEES].map((p, i) => ({ ...p, uid: `demo-user-${i}` }));
  const result = await auth.importUsers(
    people.map((p) => ({
      uid: p.uid,
      email: p.email,
      displayName: p.name,
      emailVerified: true,
      customClaims: p === people[0] ? { role: "boss" } : undefined,
      providerData: [{ uid: `google-${p.uid}`, providerId: "google.com", email: p.email, displayName: p.name }],
    })),
  );
  if (result.failureCount) throw new Error(JSON.stringify(result.errors));
  const [boss, ...staff] = people;

  const today = rules.todayInTaipei();
  const targetMonth = rules.nextMonthOf(today);
  const year = targetMonth.slice(0, 4);
  const targetMonthNum = Number(targetMonth.slice(5));
  const holidays = await fetchHolidays(year);

  const batch = db.batch();
  batch.set(db.doc("settings/app"), { simulatedToday: null });
  for (const e of staff) {
    batch.set(db.doc(`allowlist/${e.email}`), { email: e.email, name: e.name, createdAt: FieldValue.serverTimestamp() });
  }

  // 開放月份的特殊休假日：挑倒數第二個工作日當「尾牙」
  const targetCal0 = rules.buildMonthCalendar(targetMonth, holidays, {});
  const workdays0 = targetCal0.filter((d) => !d.blocked).map((d) => d.date);
  const yearEnd = workdays0[workdays0.length - 2];
  const specials = { [yearEnd]: "尾牙" };
  batch.set(db.doc(`specialDays/${yearEnd}`), {
    date: yearEnd,
    month: targetMonth,
    reason: "尾牙",
    createdBy: boss.email,
    createdAt: FieldValue.serverTimestamp(),
  });

  const summary = [];
  for (let m = 1; m <= targetMonthNum; m++) {
    const month = `${year}-${String(m).padStart(2, "0")}`;
    const isTarget = month === targetMonth;
    const cal = rules.buildMonthCalendar(month, holidays, isTarget ? specials : {});
    const workdays = cal.filter((d) => !d.blocked).map((d) => d.date);
    const counts = Object.fromEntries(workdays.map((d) => [d, []]));
    const plan = isTarget ? planTargetMonth(workdays, staff.filter((e) => e.target)) : null;

    for (const e of staff) {
      if (m < e.fromMonth) continue;
      const want = Math.min(isTarget ? e.target : randInt(...e.perMonth), rules.MAX_DAYS_PER_MONTH);
      if (!want) continue;
      const days = plan
        ? plan[e.uid]
        : shuffle(workdays)
            .filter((d) => counts[d].length < rules.MAX_STAFF_PER_DAY)
            .slice(0, want)
            .sort();
      if (days.length < rules.MIN_DAYS_PER_MONTH) continue; // 人數額滿排不下就跳過
      days.forEach((d) => counts[d].push(e.uid));
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
        updatedAt: FieldValue.serverTimestamp(),
        submittedAt: FieldValue.serverTimestamp(),
      });
      if (isTarget) summary.push(`${e.name} ${days.length} 天`);
    }
    for (const [date, uids] of Object.entries(counts)) {
      if (uids.length) batch.set(db.doc(`dayCounts/${date}`), { date, month, uids, count: uids.length });
    }
  }
  await batch.commit();

  const snap = await db.collection("dayCounts").where("month", "==", targetMonth).get();
  const byCount = { 3: [], 2: [] };
  snap.docs.forEach((d) => byCount[d.get("count")]?.push(Number(d.id.slice(8))));
  const fmt = (list) => list.sort((a, b) => a - b).map((n) => `${Number(targetMonth.slice(5))}/${n}`).join("、");
  const fullSummary = `已額滿 ${fmt(byCount[3])}；剩 1 個名額 ${fmt(byCount[2])}`;

  console.log(`
✅ 示範資料建立完成（今天 ${today}，開放排班 ${targetMonth}）

登入帳號（模擬器的 Google 登入視窗直接點選）：
  老闆  ${boss.name}  ${boss.email}
${staff.map((e) => `  員工  ${e.name}  ${e.email}${e.target ? "" : "  ← 尚未排班，可現場示範送出"}`).join("\n")}

${targetMonth} 已送出：${summary.join("、")}
${targetMonth} 名額：${fullSummary}
特殊休假日：${yearEnd} 尾牙
另外已建立 ${year} 年 1～${targetMonthNum - 1} 月的歷史班表（年度統計用）

前端：npm run dev → http://localhost:5173
`);
  process.exit(0);
})().catch((err) => {
  console.error("❌", err.message ?? err);
  process.exit(1);
});
