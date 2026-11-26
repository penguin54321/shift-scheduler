import { describe, expect, it } from "vitest";
import {
  buildMonthCalendar,
  checkSelection,
  isValidDate,
  nextMonthOf,
  parseTaiwanCalendar,
  rankBy,
  todayInTaipei,
} from "./rules";

describe("日期工具", () => {
  it("下個月：一般月份與跨年", () => {
    expect(nextMonthOf("2025-11-15")).toBe("2025-12");
    expect(nextMonthOf("2025-12-31")).toBe("2026-01");
  });

  it("以台灣時區判斷今天（UTC 16:30 已是台灣隔天）", () => {
    expect(todayInTaipei(new Date("2025-11-30T16:30:00Z"))).toBe("2025-12-01");
  });

  it("日期格式驗證含大小月與閏年", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-04-31")).toBe(false);
    expect(isValidDate("2026-4-1")).toBe(false);
  });
});

describe("國定假日解析", () => {
  const raw = [
    { date: "20261009", isHoliday: true, description: "補假" },
    { date: "20261010", isHoliday: true, description: "國慶日" },
    { date: "20261011", isHoliday: true, description: "" },
    { date: "20261012", isHoliday: false, description: "" },
    { date: "20260926", isHoliday: false, description: "補行上班" },
  ];
  const map = parseTaiwanCalendar(raw);

  it("補假自動帶出節日名稱", () => {
    expect(map["2026-10-09"]).toEqual({ isHoliday: true, name: "國慶日補假" });
    expect(map["2026-10-10"].name).toBe("國慶日");
  });

  it("一般週末與平日不存入", () => {
    expect(map["2026-10-11"]).toBeUndefined();
    expect(map["2026-10-12"]).toBeUndefined();
  });

  it("週六補行上班仍不開放，但顯示原因", () => {
    const cal = buildMonthCalendar("2026-09", map, {});
    const sat = cal.find((d) => d.date === "2026-09-26")!;
    expect(sat).toMatchObject({ kind: "makeup", blocked: true, label: "補行上班" });
  });
});

describe("月曆與排班驗證", () => {
  const holidays = { "2026-12-25": { isHoliday: true, name: "行憲紀念日" } };
  const specials = { "2026-12-10": "颱風假" };
  const cal = buildMonthCalendar("2026-12", holidays, specials);

  it("週末、國定假日、特殊日皆封鎖", () => {
    const get = (d: string) => cal.find((x) => x.date === d)!;
    expect(get("2026-12-05")).toMatchObject({ kind: "weekend", blocked: true }); // 六
    expect(get("2026-12-06")).toMatchObject({ kind: "weekend", blocked: true }); // 日
    expect(get("2026-12-25")).toMatchObject({ kind: "holiday", label: "行憲紀念日" });
    expect(get("2026-12-10")).toMatchObject({ kind: "special", label: "颱風假" });
    expect(get("2026-12-01")).toMatchObject({ kind: "workday", blocked: false });
  });

  const workdays = cal.filter((d) => !d.blocked).map((d) => d.date);

  it("送出必須 10～20 天", () => {
    expect(checkSelection("2026-12", workdays.slice(0, 9), cal).ok).toBe(false);
    expect(checkSelection("2026-12", workdays.slice(0, 10), cal).ok).toBe(true);
    expect(checkSelection("2026-12", workdays.slice(0, 20), cal).ok).toBe(true);
    expect(checkSelection("2026-12", workdays.slice(0, 21), cal).ok).toBe(false);
  });

  it("不可選封鎖日或其他月份", () => {
    const r = checkSelection("2026-12", ["2026-12-25", "2027-01-04"], cal);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("行憲紀念日");
    expect(r.errors.join()).toContain("不在 2026-12 內");
  });
});

describe("排行榜", () => {
  it("同分同名次", () => {
    const r = rankBy([{ n: "a", s: 12 }, { n: "b", s: 15 }, { n: "c", s: 12 }, { n: "d", s: 10 }], (x) => x.s);
    expect(r.map((x) => [x.n, x.rank])).toEqual([["b", 1], ["a", 2], ["c", 2], ["d", 4]]);
  });
});
