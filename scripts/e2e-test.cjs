// 整合測試：需先執行 npm run emulators（會清空模擬器資料）。用法：npm run test:e2e
const { createRequire } = require("module");
const root = require("path").resolve(__dirname, "..") + "/";
const rq = createRequire(root + "web/package.json");
const rqa = createRequire(root + "package.json");
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = rqa("firebase-admin/app");
const { getAuth: adminAuth } = rqa("firebase-admin/auth");
const { getFirestore: adminDb } = rqa("firebase-admin/firestore");
const { initializeApp, deleteApp } = rq("firebase/app");
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = rq("firebase/auth");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = rq("firebase/functions");
const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc } = rq("firebase/firestore");

const PROJECT = "demo-shift-scheduler";
admin.initializeApp({ projectId: PROJECT });
const aauth = adminAuth();
const adb = adminDb();

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, extra); }
}

async function user(email, name, claims) {
  let u;
  try { u = await aauth.getUserByEmail(email); } catch { u = await aauth.createUser({ email, password: "test1234", displayName: name, emailVerified: true }); }
  if (claims) await aauth.setCustomUserClaims(u.uid, claims);
  return u;
}

let n = 0;
async function client(email) {
  const app = initializeApp({ apiKey: "demo-key", projectId: PROJECT, appId: "x" }, `c${n++}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const fn = getFunctions(app, "asia-east1");
  connectFunctionsEmulator(fn, "127.0.0.1", 5001);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  await signInWithEmailAndPassword(auth, email, "test1234");
  const call = (name, data) => httpsCallable(fn, name)(data).then((r) => r.data);
  return { app, auth, db, call };
}
async function expectErr(p) {
  try { await p; return null; } catch (e) { return e; }
}

(async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await user("boss@example.com", "老闆", { role: "boss" });
  const emps = ["amy", "ben", "cat", "dan"];
  for (const e of emps) await user(`${e}@example.com`, e.toUpperCase());
  await user("stranger@example.com", "Stranger");

  const boss = await client("boss@example.com");
  console.log("\n[角色與白名單]");
  const bctx = await boss.call("getAppContext");
  check("老闆角色", bctx.role === "boss", JSON.stringify(bctx));
  check("下個月 = 2026-12（真實日期）", bctx.targetMonth === "2026-12", bctx.targetMonth);
  for (const e of emps) await setDoc(doc(boss.db, "allowlist", `${e}@example.com`), { email: `${e}@example.com`, name: e.toUpperCase() });
  const stranger = await client("stranger@example.com");
  check("陌生人角色 none", (await stranger.call("getAppContext")).role === "none");
  check("陌生人不能排班", (await expectErr(stranger.call("saveSchedule", { month: "2026-12", days: [] })))?.code === "functions/permission-denied");
  check("陌生人不能寫白名單", !!(await expectErr(setDoc(doc(stranger.db, "allowlist", "stranger@example.com"), { email: "stranger@example.com", name: "x" }))));

  const [amy, ben, cat, dan] = await Promise.all(emps.map((e) => client(`${e}@example.com`)));
  check("員工角色", (await amy.call("getAppContext")).role === "employee");
  check("員工不能直接寫班表", !!(await expectErr(setDoc(doc(amy.db, "schedules", "x"), { days: [] }))));
  check("員工不能呼叫老闆 API", (await expectErr(amy.call("getDashboard", { month: "2026-12" })))?.code === "functions/permission-denied");

  console.log("\n[尚未排班的新員工]");
  const amyUid0 = (await aauth.getUserByEmail("amy@example.com")).uid;
  const benUid0 = (await aauth.getUserByEmail("ben@example.com")).uid;
  const none = await getDoc(doc(amy.db, "schedules", `2026-12_${amyUid0}`)).catch((e) => e);
  check("可讀取自己尚不存在的班表（不會卡在載入中）", none && typeof none.exists === "function" && !none.exists(), String(none));
  check("不可讀取別人尚不存在的班表", !!(await expectErr(getDoc(doc(amy.db, "schedules", `2026-12_${benUid0}`)))));
  check("不可用相似 ID 繞過", !!(await expectErr(getDoc(doc(amy.db, "schedules", `2026-12_${benUid0}x${amyUid0}`)))));

  console.log("\n[月曆]");
  const cal = await amy.call("getCalendar", { month: "2026-12" });
  const d25 = cal.days.find((d) => d.date === "2026-12-25");
  check("12/25 行憲紀念日", d25.kind === "holiday" && d25.label === "行憲紀念日", JSON.stringify(d25));
  const work = cal.days.filter((d) => !d.blocked).map((d) => d.date);
  check("12 月工作日 22 天", work.length === 22, work.length);

  console.log("\n[排班規則]");
  let e = await expectErr(amy.call("saveSchedule", { month: "2027-01", days: [] }));
  check("不能排非下個月", e?.message.includes("只開放排 2026-12"), e?.message);
  e = await expectErr(amy.call("saveSchedule", { month: "2026-12", days: ["2026-12-05"] }));
  check("不能排週六", e?.message.includes("週六"), e?.message);
  e = await expectErr(amy.call("saveSchedule", { month: "2026-12", days: ["2026-12-25"] }));
  check("不能排國定假日", e?.message.includes("行憲紀念日"), e?.message);
  e = await expectErr(amy.call("saveSchedule", { month: "2026-12", days: work.slice(0, 9) }));
  check("送出少於 10 天被擋", e?.details?.errors?.[0]?.includes("至少需排 10 天"), e?.message);
  check("沒有草稿：9 天不會寫入、不佔名額", !(await adb.doc(`dayCounts/${work[0]}`).get()).exists);
  e = await expectErr(amy.call("saveSchedule", { month: "2026-12", days: work.slice(0, 21) }));
  check("超過 20 天被擋", e?.message.includes("最多只能排 20 天"), e?.message);
  check("送出 12 天", (await amy.call("saveSchedule", { month: "2026-12", days: work.slice(0, 12) })).status === "submitted");

  console.log("\n[每日 3 人上限 + 併發]");
  await ben.call("saveSchedule", { month: "2026-12", days: work.slice(0, 10) });
  // cat 與 dan 同時搶 work[0] 的最後一個名額
  const results = await Promise.allSettled([
    cat.call("saveSchedule", { month: "2026-12", days: work.slice(0, 10) }),
    dan.call("saveSchedule", { month: "2026-12", days: work.slice(0, 10) }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  check("同時搶最後名額只有 1 人成功", ok === 1, results.map((r) => r.status + (r.reason ? ":" + r.reason.message : "")).join(" | "));
  const dc = (await adb.doc(`dayCounts/${work[0]}`).get()).data();
  check("dayCounts 恰好 3 人", dc.count === 3 && dc.uids.length === 3, JSON.stringify(dc));
  const loser = results[0].status === "rejected" ? cat : dan;
  check("額滿錯誤附 fullDays", (results.find((r) => r.status === "rejected")?.reason?.details?.fullDays ?? []).length > 0);
  await loser.call("saveSchedule", { month: "2026-12", days: work.slice(10, 20) });
  check("落敗者改選其他日成功", true);
  // amy 修改：移除 work[0]，人數應減少
  await amy.call("saveSchedule", { month: "2026-12", days: work.slice(1, 13) });
  check("移除日期後人數 -1", (await adb.doc(`dayCounts/${work[0]}`).get()).data().count === 2);

  console.log("\n[員工只能讀自己的班表]");
  const amyUid = (await aauth.getUserByEmail("amy@example.com")).uid;
  check("ben 讀 amy 班表被拒", !!(await expectErr(getDoc(doc(ben.db, "schedules", `2026-12_${amyUid}`)))));
  check("amy 讀自己班表 OK", (await getDoc(doc(amy.db, "schedules", `2026-12_${amyUid}`))).exists());

  console.log("\n[特殊休假日]");
  const target = work[5]; // amy、ben、cat/dan 之一都有排
  const res = await boss.call("addSpecialDay", { date: target, reason: "颱風假" });
  check("移除當天已排員工", res.affected.length >= 2, JSON.stringify(res));
  const amyS = (await adb.doc(`schedules/2026-12_${amyUid}`).get()).data();
  check("amy 班表移除該日並收到通知", !amyS.days.includes(target) && amyS.notice?.includes("颱風假"), JSON.stringify(amyS));
  const benUid = (await aauth.getUserByEmail("ben@example.com")).uid;
  const benS = (await adb.doc(`schedules/2026-12_${benUid}`).get()).data();
  check("ben 剩 9 天標示為需補排", benS.count === 9 && benS.status === "needsFix", JSON.stringify(benS));
  e = await expectErr(ben.call("saveSchedule", { month: "2026-12", days: benS.days }));
  check("需補排者仍須補足 10 天才能送出", e?.message.includes("至少需排 10 天"), e?.message);
  e = await expectErr(dan.call("saveSchedule", { month: "2026-12", days: [target, ...work.filter((d) => d !== target).slice(11, 20)] }));
  check("特殊日不能排", e?.message.includes("颱風假"), e?.message);
  e = await expectErr(boss.call("addSpecialDay", { date: "2026-12-25", reason: "x" }));
  check("國定假日不能重複設定", e?.message.includes("已是"), e?.message);

  console.log("\n[老闆總覽]");
  const dash = await boss.call("getDashboard", { month: "2026-12" });
  check("員工 4 人", dash.summary.employeeCount === 4, JSON.stringify(dash.summary));
  check("排行榜第 1 名是 amy（11 天）", dash.employees[0].name === "AMY" && dash.employees[0].monthCount === 11, JSON.stringify(dash.employees.map((x) => [x.name, x.monthCount, x.rank])));
  check("未達 10 天 2 人（ben 與颱風假當天的另一人）", dash.summary.belowMin === 2, dash.summary.belowMin);
  check("年度天數 = 月份天數（尚無其他月）", dash.employees.every((x) => x.yearCount === x.monthCount));

  console.log("\n[示範模式]");
  const sim = await boss.call("setSimulatedToday", { date: "2026-05-15" });
  check("模擬日期", sim.today === "2026-05-15" && sim.simulated);
  const actx = await amy.call("getAppContext");
  check("員工可排月份變成 2026-06", actx.targetMonth === "2026-06");
  const jun = await amy.call("getCalendar", { month: "2026-06" });
  check("6/19 端午節", jun.days.find((d) => d.date === "2026-06-19").label === "端午節");
  const junWork = jun.days.filter((d) => !d.blocked).map((d) => d.date);
  await amy.call("saveSchedule", { month: "2026-06", days: junWork.slice(0, 15) });
  const dash2 = await boss.call("getDashboard", { month: "2026-12" });
  check("amy 年度 = 11 + 15 = 26", dash2.employees.find((x) => x.name === "AMY").yearCount === 26);
  const oct = await amy.call("getCalendar", { month: "2026-10" });
  check("10/9 國慶日補假", oct.days.find((d) => d.date === "2026-10-09").label === "國慶日補假");
  await boss.call("setSimulatedToday", { date: null });
  check("恢復真實日期", (await amy.call("getAppContext")).targetMonth === "2026-12");

  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  for (const c of [boss, stranger, amy, ben, cat, dan]) await deleteApp(c.app);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
