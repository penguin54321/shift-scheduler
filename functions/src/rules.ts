/**
 * 排班規則核心邏輯（純函式，不依賴 Firebase，方便單元測試）。
 * 前端只負責顯示，所有規則最終都由 Cloud Functions 透過這裡驗證。
 */

export const MAX_STAFF_PER_DAY = 3;
export const MIN_DAYS_PER_MONTH = 10;
export const MAX_DAYS_PER_MONTH = 20;
export const TIME_ZONE = "Asia/Taipei";

export type DayKind = "workday" | "weekend" | "holiday" | "makeup" | "special";

export interface DayInfo {
  date: string; // YYYY-MM-DD
  weekday: number; // 0 = 週日 … 6 = 週六
  kind: DayKind;
  blocked: boolean;
  label: string | null; // 節日名稱 / 特殊休假原因
}

/** 國定假日資料：只保存「有意義」的日期（有節日名稱、或平日放假、或補行上班） */
export interface HolidayEntry {
  isHoliday: boolean;
  name: string;
}
export type HolidayMap = Record<string, HolidayEntry>;
export type SpecialDayMap = Record<string, string>; // date -> reason

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(month: unknown): month is string {
  return typeof month === "string" && MONTH_RE.test(month);
}

export function isValidDate(date: unknown): date is string {
  if (typeof date !== "string" || !DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  return d <= daysInMonth(y, m);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 以台灣時區取得「今天」(YYYY-MM-DD)，不依賴伺服器或使用者電腦的時區 */
export function todayInTaipei(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 今天是 2025-11-xx → 可排班月份為 2025-12；12 月 → 隔年 01 */
export function nextMonthOf(today: string): string {
  const [y, m] = today.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

export function monthDates(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  return Array.from(
    { length: daysInMonth(y, m) },
    (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
  );
}

/**
 * 解析政府行政機關辦公日曆（TaiwanCalendar JSON 格式）。
 * 「補假」會往前後 3 天找最近的節日，組成「國慶日補假」這類可讀名稱。
 */
export function parseTaiwanCalendar(
  raw: Array<{ date: string; isHoliday: boolean; description?: string }>,
): HolidayMap {
  const rows = raw.map((r) => ({
    date: `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`,
    isHoliday: !!r.isHoliday,
    description: (r.description ?? "").trim(),
  }));
  const named = new Map(
    rows
      .filter((r) => r.isHoliday && r.description && r.description !== "補假")
      .map((r) => [r.date, r.description]),
  );

  const result: HolidayMap = {};
  for (const r of rows) {
    const wd = weekdayOf(r.date);
    const isWeekend = wd === 0 || wd === 6;
    if (r.isHoliday) {
      if (r.description === "補假") {
        result[r.date] = { isHoliday: true, name: resolveMakeupName(r.date, named) };
      } else if (r.description) {
        result[r.date] = { isHoliday: true, name: r.description };
      } else if (!isWeekend) {
        result[r.date] = { isHoliday: true, name: "放假日" };
      }
    } else if (r.description) {
      // 例如週六「補行上班」：仍屬週末，依規定不開放排班，但顯示原因
      result[r.date] = { isHoliday: false, name: r.description };
    }
  }
  return result;
}

function resolveMakeupName(date: string, named: Map<string, string>): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  for (let dist = 1; dist <= 3; dist++) {
    for (const sign of [1, -1]) {
      const d = new Date(base + sign * dist * 86_400_000).toISOString().slice(0, 10);
      const name = named.get(d);
      if (name) return `${name}補假`;
    }
  }
  return "補假";
}

/** 產生某月份每一天的排班資訊（是否可排、原因） */
export function buildMonthCalendar(
  month: string,
  holidays: HolidayMap,
  specials: SpecialDayMap,
): DayInfo[] {
  return monthDates(month).map((date) => {
    const weekday = weekdayOf(date);
    const isWeekend = weekday === 0 || weekday === 6;
    const holiday = holidays[date];
    const special = specials[date];

    if (special !== undefined) {
      return { date, weekday, kind: "special", blocked: true, label: special };
    }
    if (holiday?.isHoliday) {
      return { date, weekday, kind: "holiday", blocked: true, label: holiday.name };
    }
    if (isWeekend) {
      return holiday
        ? { date, weekday, kind: "makeup", blocked: true, label: holiday.name }
        : { date, weekday, kind: "weekend", blocked: true, label: null };
    }
    return { date, weekday, kind: "workday", blocked: false, label: null };
  });
}

export function blockedReason(day: DayInfo): string {
  switch (day.kind) {
    case "special":
      return `特殊休假日（${day.label}）`;
    case "holiday":
      return `國定假日（${day.label}）`;
    case "makeup":
      return `週末（${day.label}，不開放排班）`;
    case "weekend":
      return day.weekday === 6 ? "週六" : "週日";
    default:
      return "";
  }
}

export interface SelectionCheck {
  ok: boolean;
  errors: string[];
}

/**
 * 驗證員工選擇的日期（不含每日人數上限，那需要在 transaction 內檢查）。
 * 每次送出都必須是 10～20 天（沒有草稿，未送出的選擇只暫存在員工的瀏覽器）。
 */
export function checkSelection(month: string, days: string[], calendar: DayInfo[]): SelectionCheck {
  const errors: string[] = [];
  const byDate = new Map(calendar.map((d) => [d.date, d]));

  if (new Set(days).size !== days.length) errors.push("日期有重複");
  for (const date of days) {
    const info = byDate.get(date);
    if (!isValidDate(date) || !date.startsWith(`${month}-`) || !info) {
      errors.push(`${date} 不在 ${month} 內`);
    } else if (info.blocked) {
      errors.push(`${date} 為${blockedReason(info)}，不可排班`);
    }
  }
  if (days.length > MAX_DAYS_PER_MONTH) {
    errors.push(`每月最多只能排 ${MAX_DAYS_PER_MONTH} 天（目前 ${days.length} 天）`);
  }
  if (days.length < MIN_DAYS_PER_MONTH) {
    errors.push(`每月至少需排 ${MIN_DAYS_PER_MONTH} 天（目前 ${days.length} 天）`);
  }
  return { ok: errors.length === 0, errors };
}

/** 排行榜：同分同名次（1, 1, 3） */
export function rankBy<T>(items: T[], score: (t: T) => number): Array<T & { rank: number }> {
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  let lastScore: number | null = null;
  let lastRank = 0;
  return sorted.map((item, i) => {
    const s = score(item);
    if (s !== lastScore) {
      lastRank = i + 1;
      lastScore = s;
    }
    return { ...item, rank: lastRank };
  });
}
