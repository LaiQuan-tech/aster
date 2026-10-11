"use client";

/**
 * 請假表單用的班表／行事曆按需載入：日期變更時抓涵蓋的月份班表（`GET /schedules?from&to`）
 * 與年份行事曆（`GET /calendar?year=`，跨年抓兩年），結果快取在 ref（同一頁不重抓）；
 * 任一支失敗都退化成「沒排班／沒假日」，不擋表單。
 *
 * 班表只抓本人的：一律 `scope=mine`（HR 帳號也只回自己的，不再拿全公司回來前端過濾）。
 * 算時數用的列一律比對 employee_id＝本人：本人 id 還沒載入時不採用任何一列（退回預設班別），
 * 不會拿任意一人的班別算時數。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getCalendar, getMySchedules, type ScheduleRow, type Shift } from "@/lib/ess-api";
import { addDays } from "@/lib/ess-format";
import { listDates, type DayType, type ShiftLike } from "@/lib/leave-hours";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 一次最多抓幾個月的班表（31 個工作日的請假最多橫跨 3 個月）。 */
const MAX_MONTHS = 3;

type ScheduleWithEmployee = ScheduleRow & { employee_id?: string | null };

function monthsBetween(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  let cursor = `${startDate.slice(0, 7)}-01`;
  const last = `${endDate.slice(0, 7)}-01`;
  while (cursor <= last && out.length < MAX_MONTHS) {
    out.push(cursor.slice(0, 7));
    // 下個月 1 號：往後加 32 天再取月初。
    cursor = `${addDays(cursor, 32).slice(0, 7)}-01`;
  }
  return out;
}

function monthEnd(month: string): string {
  const nextFirst = `${addDays(`${month}-01`, 32).slice(0, 7)}-01`;
  return addDays(nextFirst, -1);
}

export interface LeaveCalendar {
  shiftByDate: Record<string, ShiftLike | undefined>;
  dayTypeByDate: Record<string, DayType | undefined>;
}

export function useLeaveCalendar(
  startDate: string,
  endDate: string,
  shifts: Shift[],
  /** 本人 employee id（GET /me；還沒載入＝undefined）。 */
  selfId: string | null | undefined,
): LeaveCalendar {
  const calendarCache = useRef(new Map<number, Record<string, DayType>>());
  /** key＝月份 `YYYY-MM`。 */
  const scheduleCache = useRef(new Map<string, ScheduleWithEmployee[]>());
  const [version, setVersion] = useState(0);

  const validStart = DATE_RE.test(startDate) ? startDate : "";
  const validEnd = DATE_RE.test(endDate) && endDate >= validStart ? endDate : validStart;

  useEffect(() => {
    if (!validStart) return;
    let active = true;
    const jobs: Promise<unknown>[] = [];

    const years = Array.from(new Set([Number(validStart.slice(0, 4)), Number(validEnd.slice(0, 4))])).slice(0, 2);
    for (const year of years) {
      if (!Number.isFinite(year) || calendarCache.current.has(year)) continue;
      jobs.push(
        getCalendar(year)
          .then((res) => {
            const map: Record<string, DayType> = {};
            for (const d of res.days ?? []) if (d?.date) map[d.date] = d.day_type;
            calendarCache.current.set(year, map);
          })
          .catch(() => calendarCache.current.set(year, {})),
      );
    }

    for (const month of monthsBetween(validStart, validEnd)) {
      if (scheduleCache.current.has(month)) continue;
      jobs.push(
        // 一律 scope=mine（getMySchedules 內組 query）。
        getMySchedules(`${month}-01`, monthEnd(month))
          .then((res) => scheduleCache.current.set(month, (res.schedules ?? []) as ScheduleWithEmployee[]))
          .catch(() => scheduleCache.current.set(month, [])),
      );
    }

    if (jobs.length === 0) return;
    Promise.all(jobs).then(() => {
      if (active) setVersion((v) => v + 1);
    });
    return () => {
      active = false;
    };
  }, [validStart, validEnd]);

  const shiftById = useMemo(() => new Map(shifts.map((s) => [s.id, s] as const)), [shifts]);

  return useMemo<LeaveCalendar>(() => {
    const shiftByDate: Record<string, ShiftLike | undefined> = {};
    const dayTypeByDate: Record<string, DayType | undefined> = {};
    if (!validStart) return { shiftByDate, dayTypeByDate };
    // 本人 id 還沒載入 → null → 不採用任何班表列（退回預設班別）。
    const applicantId = selfId || null;
    for (const date of listDates(validStart, validEnd)) {
      const year = Number(date.slice(0, 4));
      const dayType = calendarCache.current.get(year)?.[date];
      if (dayType) dayTypeByDate[date] = dayType;
      if (!applicantId) continue;
      const rows = scheduleCache.current.get(date.slice(0, 7)) ?? [];
      const row = rows.find((r) => r.work_date === date && r.shift_id && r.employee_id === applicantId);
      const shift = row?.shift_id ? shiftById.get(row.shift_id) : undefined;
      if (shift) shiftByDate[date] = shift;
    }
    return { shiftByDate, dayTypeByDate };
    // version 是快取版本號：ref 更新後靠它觸發重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, validStart, validEnd, shiftById, selfId]);
}
