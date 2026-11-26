/**
 * 排班系統 Cloud Functions（2nd gen, Callable）。
 *
 * 所有會改變班表的操作都只能透過這些函式進行：Firestore Security Rules 禁止
 * 前端直接寫入 schedules / dayCounts / specialDays，確保規則無法被繞過。
 */
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { CallableRequest, HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import {
  DayInfo,
  HolidayMap,
  MAX_DAYS_PER_MONTH,
  MAX_STAFF_PER_DAY,
  MIN_DAYS_PER_MONTH,
  SpecialDayMap,
  blockedReason,
  buildMonthCalendar,
  checkSelection,
  isValidDate,
  isValidMonth,
  monthDates,
  nextMonthOf,
  parseTaiwanCalendar,
  rankBy,
  todayInTaipei,
} from "./rules";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "asia-east1", maxInstances: 10 });

/* ------------------------------------------------------------------ */
/* 共用：身分、日期、假日資料                                            */
/* ------------------------------------------------------------------ */

type Role = "boss" | "employee" | "none";

interface Caller {
  uid: string;
  email: string;
  name: string;
  role: Role;
}

async function getCaller(req: CallableRequest): Promise<Caller> {
  const auth = req.auth;
  if (!auth) throw new HttpsError("unauthenticated", "請先登入");
  const email = String(auth.token.email ?? "").toLowerCase();
  const name = String(auth.token.name ?? email);
  if (auth.token.role === "boss") return { uid: auth.uid, email, name, role: "boss" };
  if (email && auth.token.email_verified !== false) {
    const allow = await db.doc(`allowlist/${email}`).get();
    if (allow.exists) {
      return { uid: auth.uid, email, name: allow.get("name") || name, role: "employee" };
    }
  }
  return { uid: auth.uid, email, name, role: "none" };
}

async function requireRole(req: CallableRequest, ...roles: Role[]): Promise<Caller> {
  const caller = await getCaller(req);
  if (!roles.includes(caller.role)) {
    throw new HttpsError(
      "permission-denied",
      caller.role === "none" ? "您的帳號不在員工名單中，請聯絡老闆" : "權限不足",
    );
  }
  return caller;
}

/** 示範模式只在本機模擬器啟用；正式環境一律使用真實日期 */
const DEMO_MODE_ENABLED = process.env.FUNCTIONS_EMULATOR === "true";

/** 「今天」：正式環境為台灣時間；本機模擬器開啟示範模式時改用模擬日期 */
async function getToday(): Promise<{ today: string; simulated: boolean }> {
  if (!DEMO_MODE_ENABLED) return { today: todayInTaipei(), simulated: false };
  const settings = await db.doc("settings/app").get();
  const simulated = settings.get("simulatedToday");
  if (typeof simulated === "string" && isValidDate(simulated)) {
    return { today: simulated, simulated: true };
  }
  return { today: todayInTaipei(), simulated: false };
}

const HOLIDAY_SOURCE = (year: string) =>
  `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`;
const HOLIDAY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 取得某年度國定假日：先讀 Firestore 快取，過期才向政府辦公日曆資料抓取。
 * 抓取失敗時沿用舊快取；完全沒有資料則回報錯誤（寧可不讓排班，也不能排到假日）。
 */
async function getHolidays(year: string): Promise<{ map: HolidayMap; fetchedAt: string }> {
  const ref = db.doc(`holidays/${year}`);
  const cached = await ref.get();
  const fetchedAt = cached.get("fetchedAt") as Timestamp | undefined;
  if (cached.exists && fetchedAt && Date.now() - fetchedAt.toMillis() < HOLIDAY_CACHE_TTL_MS) {
    return { map: cached.get("days"), fetchedAt: fetchedAt.toDate().toISOString() };
  }
  try {
    const res = await fetch(HOLIDAY_SOURCE(year), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as Parameters<typeof parseTaiwanCalendar>[0];
    if (!Array.isArray(raw) || raw.length < 365) throw new Error("資料不完整");
    const map = parseTaiwanCalendar(raw);
    await ref.set({ days: map, fetchedAt: FieldValue.serverTimestamp(), source: HOLIDAY_SOURCE(year) });
    return { map, fetchedAt: new Date().toISOString() };
  } catch (err) {
    logger.warn(`無法取得 ${year} 年國定假日資料`, err);
    if (cached.exists) {
      return { map: cached.get("days"), fetchedAt: fetchedAt?.toDate().toISOString() ?? "" };
    }
    throw new HttpsError("unavailable", `暫時無法取得 ${year} 年國定假日資料，請稍後再試`);
  }
}

async function getSpecialDays(month: string): Promise<SpecialDayMap> {
  const snap = await db.collection("specialDays").where("month", "==", month).get();
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.get("reason") as string]));
}

async function getMonthCalendar(month: string): Promise<{ days: DayInfo[]; holidayFetchedAt: string }> {
  const [holidays, specials] = await Promise.all([
    getHolidays(month.slice(0, 4)),
    getSpecialDays(month),
  ]);
  return { days: buildMonthCalendar(month, holidays.map, specials), holidayFetchedAt: holidays.fetchedAt };
}

function requireMonth(month: unknown): string {
  if (!isValidMonth(month)) throw new HttpsError("invalid-argument", "月份格式錯誤（YYYY-MM）");
  return month;
}

const scheduleId = (month: string, uid: string) => `${month}_${uid}`;

/* ------------------------------------------------------------------ */
/* 共用 API                                                            */
/* ------------------------------------------------------------------ */

/** 登入後取得角色、今天日期、可排班月份 */
export const getAppContext = onCall(async (req) => {
  const caller = await getCaller(req);
  const { today, simulated } = await getToday();
  return {
    role: caller.role,
    name: caller.name,
    email: caller.email,
    today,
    simulated,
    targetMonth: nextMonthOf(today),
    rules: {
      maxStaffPerDay: MAX_STAFF_PER_DAY,
      minDays: MIN_DAYS_PER_MONTH,
      maxDays: MAX_DAYS_PER_MONTH,
    },
  };
});

/** 取得某月份月曆（含週末、國定假日名稱、特殊休假日） */
export const getCalendar = onCall(async (req) => {
  await requireRole(req, "employee", "boss");
  const month = requireMonth(req.data?.month);
  const cal = await getMonthCalendar(month);
  return { month, ...cal };
});

/* ------------------------------------------------------------------ */
/* 員工 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 送出班表（未送出的選擇只暫存在員工瀏覽器，不佔名額）。
 * - 只能排「下個月」
 * - 封鎖日不可排；每次送出都必須 10～20 天
 * - 每日最多 3 人：在 Firestore transaction 內讀寫 dayCounts，避免同時搶最後一個名額
 */
export const saveSchedule = onCall(async (req) => {
  const caller = await requireRole(req, "employee");
  const month = requireMonth(req.data?.month);
  const rawDays: unknown = req.data?.days;
  if (!Array.isArray(rawDays) || !rawDays.every((d) => typeof d === "string")) {
    throw new HttpsError("invalid-argument", "days 必須是日期字串陣列");
  }
  const days = [...rawDays].sort();

  const { today } = await getToday();
  const targetMonth = nextMonthOf(today);
  if (month !== targetMonth) {
    throw new HttpsError("failed-precondition", `目前只開放排 ${targetMonth} 的班表`);
  }

  const { days: calendar } = await getMonthCalendar(month);
  const check = checkSelection(month, days, calendar);
  if (!check.ok) {
    throw new HttpsError("failed-precondition", check.errors.join("\n"), { errors: check.errors });
  }

  const scheduleRef = db.doc(`schedules/${scheduleId(month, caller.uid)}`);
  const result = await db.runTransaction(async (tx) => {
    const current = await tx.get(scheduleRef);
    const prevDays: string[] = current.exists ? current.get("days") : [];
    const added = days.filter((d) => !prevDays.includes(d));
    const removed = prevDays.filter((d) => !days.includes(d));

    const countRefs = [...added, ...removed].map((d) => db.doc(`dayCounts/${d}`));
    const specialRefs = added.map((d) => db.doc(`specialDays/${d}`));
    const [countSnaps, specialSnaps] = await Promise.all([
      countRefs.length ? tx.getAll(...countRefs) : Promise.resolve([]),
      specialRefs.length ? tx.getAll(...specialRefs) : Promise.resolve([]),
    ]);

    // 老闆可能剛好在這段時間新增了特殊休假日
    const newlyBlocked = specialSnaps.filter((s) => s.exists).map((s) => s.id);
    if (newlyBlocked.length) {
      throw new HttpsError("failed-precondition", `${newlyBlocked.join("、")} 剛被設為特殊休假日，請重新選擇`, {
        errors: newlyBlocked.map((d) => `${d} 為特殊休假日`),
      });
    }

    const counts = new Map(
      countSnaps.map((s) => [s.id, { uids: (s.get("uids") as string[] | undefined) ?? [] }]),
    );
    const full = added.filter((d) => (counts.get(d)?.uids.length ?? 0) >= MAX_STAFF_PER_DAY);
    if (full.length) {
      throw new HttpsError(
        "failed-precondition",
        `${full.join("、")} 已額滿（每日最多 ${MAX_STAFF_PER_DAY} 人），請改選其他日期`,
        { fullDays: full, errors: full.map((d) => `${d} 已額滿`) },
      );
    }

    for (const d of added) {
      const uids = [...(counts.get(d)?.uids ?? []), caller.uid];
      tx.set(db.doc(`dayCounts/${d}`), { date: d, month, uids, count: uids.length });
    }
    for (const d of removed) {
      const uids = (counts.get(d)?.uids ?? []).filter((u) => u !== caller.uid);
      tx.set(db.doc(`dayCounts/${d}`), { date: d, month, uids, count: uids.length });
    }

    const status = "submitted";
    tx.set(scheduleRef, {
      uid: caller.uid,
      email: caller.email,
      displayName: caller.name,
      month,
      year: month.slice(0, 4),
      days,
      count: days.length,
      status,
      notice: null,
      updatedAt: FieldValue.serverTimestamp(),
      submittedAt: FieldValue.serverTimestamp(),
    });
    return { status, days };
  });

  logger.info(`${caller.email} 送出 ${month} 班表 ${days.length} 天`);
  return result;
});

/* ------------------------------------------------------------------ */
/* 老闆 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 新增特殊休假日（如颱風假）。已排在當天的員工會自動被移除，
 * 並在其班表留下通知；若因此低於 10 天，狀態改為「需補排」請員工補足後重新送出。
 */
export const addSpecialDay = onCall(async (req) => {
  const caller = await requireRole(req, "boss");
  const date = req.data?.date;
  const reason = String(req.data?.reason ?? "").trim();
  if (!isValidDate(date)) throw new HttpsError("invalid-argument", "日期格式錯誤");
  if (!reason || reason.length > 30) throw new HttpsError("invalid-argument", "請輸入 1～30 字的原因");

  const { today } = await getToday();
  if (date <= today) throw new HttpsError("failed-precondition", "只能設定今天之後的日期");

  const { days } = await getMonthCalendar(date.slice(0, 7));
  const info = days.find((d) => d.date === date)!;
  if (info.blocked) {
    throw new HttpsError("failed-precondition", `${date} 已是${blockedReason(info)}，無需再設定`);
  }

  const affected = await db.runTransaction(async (tx) => {
    const countRef = db.doc(`dayCounts/${date}`);
    const countSnap = await tx.get(countRef);
    const uids: string[] = countSnap.get("uids") ?? [];
    const scheduleRefs = uids.map((uid) => db.doc(`schedules/${scheduleId(date.slice(0, 7), uid)}`));
    const schedules = scheduleRefs.length ? await tx.getAll(...scheduleRefs) : [];

    tx.set(db.doc(`specialDays/${date}`), {
      date,
      month: date.slice(0, 7),
      reason,
      createdBy: caller.email,
      createdAt: FieldValue.serverTimestamp(),
    });
    if (countSnap.exists) tx.delete(countRef);

    const names: string[] = [];
    for (const s of schedules) {
      if (!s.exists) continue;
      const remaining = (s.get("days") as string[]).filter((d) => d !== date);
      const belowMin = remaining.length < MIN_DAYS_PER_MONTH;
      tx.update(s.ref, {
        days: remaining,
        count: remaining.length,
        status: belowMin ? "needsFix" : s.get("status"),
        notice: `老闆將 ${date} 設為「${reason}」，已自動移除您當天的排班${
          belowMin ? `；目前僅 ${remaining.length} 天，請補排後重新送出` : ""
        }`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      names.push(s.get("displayName"));
    }
    return names;
  });

  return { date, reason, affected };
});

export const removeSpecialDay = onCall(async (req) => {
  await requireRole(req, "boss");
  const date = req.data?.date;
  if (!isValidDate(date)) throw new HttpsError("invalid-argument", "日期格式錯誤");
  await db.doc(`specialDays/${date}`).delete();
  return { date };
});

/** 示範模式：模擬「今天」的日期，方便展示其他月份（null 代表恢復真實日期） */
export const setSimulatedToday = onCall(async (req) => {
  await requireRole(req, "boss");
  if (!DEMO_MODE_ENABLED) throw new HttpsError("failed-precondition", "正式環境不提供示範模式");
  const date = req.data?.date ?? null;
  if (date !== null && !isValidDate(date)) throw new HttpsError("invalid-argument", "日期格式錯誤");
  await db.doc("settings/app").set({ simulatedToday: date, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return getToday();
});

/** 老闆總覽：指定月份班表矩陣 + 每人月/年統計 + 排行榜 */
export const getDashboard = onCall(async (req) => {
  await requireRole(req, "boss");
  const month = requireMonth(req.data?.month);
  const year = month.slice(0, 4);

  const [calendar, allowSnap, yearSnap] = await Promise.all([
    getMonthCalendar(month),
    db.collection("allowlist").get(),
    db.collection("schedules").where("year", "==", year).get(),
  ]);

  interface Row {
    key: string;
    name: string;
    email: string;
    onAllowlist: boolean;
    monthDays: string[];
    status: "none" | "needsFix" | "submitted";
    notice: string | null;
    yearCount: number;
  }
  const rows = new Map<string, Row>();
  const rowFor = (email: string, name: string): Row => {
    let row = rows.get(email);
    if (!row) {
      row = { key: email, name, email, onAllowlist: false, monthDays: [], status: "none", notice: null, yearCount: 0 };
      rows.set(email, row);
    }
    return row;
  };

  for (const doc of allowSnap.docs) {
    const row = rowFor(doc.id, doc.get("name") || doc.id);
    row.name = doc.get("name") || row.name;
    row.onAllowlist = true;
  }
  for (const doc of yearSnap.docs) {
    const s = doc.data();
    const row = rowFor(s.email, s.displayName);
    row.yearCount += s.days.length;
    if (s.month === month) {
      row.monthDays = s.days;
      row.status = s.status === "submitted" ? "submitted" : "needsFix"; // 舊版草稿資料視為需補排
      row.notice = s.notice ?? null;
    }
  }

  const employees = rankBy(
    [...rows.values()].map((r) => ({ ...r, monthCount: r.monthDays.length })),
    (r) => r.monthCount,
  );

  const workdays = calendar.days.filter((d) => !d.blocked).map((d) => d.date);
  const perDay = Object.fromEntries(monthDates(month).map((d) => [d, 0]));
  for (const e of employees) for (const d of e.monthDays) perDay[d] = (perDay[d] ?? 0) + 1;
  const totalShifts = employees.reduce((sum, e) => sum + e.monthCount, 0);
  const active = employees.filter((e) => e.onAllowlist);

  return {
    month,
    calendar: calendar.days,
    employees,
    perDay,
    summary: {
      employeeCount: active.length,
      workdayCount: workdays.length,
      totalShifts,
      capacity: workdays.length * MAX_STAFF_PER_DAY,
      fullDays: workdays.filter((d) => perDay[d] >= MAX_STAFF_PER_DAY).length,
      emptyDays: workdays.filter((d) => perDay[d] === 0).length,
      submitted: active.filter((e) => e.status === "submitted").length,
      belowMin: active.filter((e) => e.monthCount < MIN_DAYS_PER_MONTH).length,
    },
  };
});
