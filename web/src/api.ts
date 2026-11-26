import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

export type Role = "boss" | "employee" | "none";
export type DayKind = "workday" | "weekend" | "holiday" | "makeup" | "special";
/** draft 為舊版資料，視同 needsFix */
export type ScheduleStatus = "none" | "submitted" | "needsFix" | "draft";

export interface DayInfo {
  date: string;
  weekday: number;
  kind: DayKind;
  blocked: boolean;
  label: string | null;
}

export interface AppContext {
  role: Role;
  name: string;
  email: string;
  today: string;
  simulated: boolean;
  targetMonth: string;
  rules: { maxStaffPerDay: number; minDays: number; maxDays: number };
}

export interface EmployeeStat {
  key: string;
  name: string;
  email: string;
  onAllowlist: boolean;
  monthDays: string[];
  monthCount: number;
  yearCount: number;
  status: ScheduleStatus;
  notice: string | null;
  rank: number;
}

export interface Dashboard {
  month: string;
  calendar: DayInfo[];
  employees: EmployeeStat[];
  perDay: Record<string, number>;
  summary: {
    employeeCount: number;
    workdayCount: number;
    totalShifts: number;
    capacity: number;
    fullDays: number;
    emptyDays: number;
    submitted: number;
    belowMin: number;
  };
}

function call<Req, Res>(name: string) {
  const fn = httpsCallable<Req, Res>(functions, name);
  return async (data: Req): Promise<Res> => (await fn(data)).data;
}

export const api = {
  getAppContext: call<void, AppContext>("getAppContext"),
  getCalendar: call<{ month: string }, { month: string; days: DayInfo[]; holidayFetchedAt: string }>("getCalendar"),
  saveSchedule: call<{ month: string; days: string[] }, { status: ScheduleStatus; days: string[] }>(
    "saveSchedule",
  ),
  addSpecialDay: call<{ date: string; reason: string }, { date: string; reason: string; affected: string[] }>(
    "addSpecialDay",
  ),
  removeSpecialDay: call<{ date: string }, { date: string }>("removeSpecialDay"),
  setSimulatedToday: call<{ date: string | null }, { today: string; simulated: boolean }>("setSimulatedToday"),
  getDashboard: call<{ month: string }, Dashboard>("getDashboard"),
};

/** 把 Cloud Functions 的錯誤轉成可顯示的訊息清單 */
export function errorMessages(err: unknown): string[] {
  if (err instanceof FirebaseError) {
    const details = (err as FirebaseError & { details?: { errors?: string[] } }).details;
    if (details?.errors?.length) return details.errors;
    return [err.message.replace(/^Firebase: /, "")];
  }
  return [err instanceof Error ? err.message : String(err)];
}

/* ---------- 日期顯示工具 ---------- */

export const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function formatMonth(month: string): string {
  const [y, m] = month.split("-");
  return `${y} 年 ${Number(m)} 月`;
}

export function formatDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  const wd = new Date(`${date}T00:00:00`).getDay();
  return `${m}/${d}（${WEEKDAYS[wd]}）`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function dayLabel(day: DayInfo): string {
  switch (day.kind) {
    case "holiday":
    case "special":
    case "makeup":
      return day.label ?? "";
    case "weekend":
      return "週末";
    default:
      return "";
  }
}
