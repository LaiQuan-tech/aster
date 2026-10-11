"use client";

/**
 * 請假表單用的行事曆按需載入：日期變更時抓涵蓋年份的行事曆（`GET /calendar?year=`，跨年抓兩年），
 * 結果快取在 ref（同一頁不重抓）；失敗就退化成「沒假日」，不擋表單。
 *
 * 班表功能已移除（2026-10-11，業主：不需要）：不再抓 `GET /schedules`，每天都用預設班別
 * （請假頁的 defaultShift＝租戶最早建立的班別，即日班）算時數，見 LeaveForm。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getCalendar } from "@/lib/ess-api";
import { listDates, type DayType } from "@/lib/leave-hours";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 日期範圍內每天的 day_type（行事曆沒有的日子不放，由 leave-hours 依週六日判斷）。 */
export function useLeaveCalendar(startDate: string, endDate: string): Record<string, DayType | undefined> {
  const calendarCache = useRef(new Map<number, Record<string, DayType>>());
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

    if (jobs.length === 0) return;
    Promise.all(jobs).then(() => {
      if (active) setVersion((v) => v + 1);
    });
    return () => {
      active = false;
    };
  }, [validStart, validEnd]);

  return useMemo<Record<string, DayType | undefined>>(() => {
    const dayTypeByDate: Record<string, DayType | undefined> = {};
    if (!validStart) return dayTypeByDate;
    for (const date of listDates(validStart, validEnd)) {
      const dayType = calendarCache.current.get(Number(date.slice(0, 4)))?.[date];
      if (dayType) dayTypeByDate[date] = dayType;
    }
    return dayTypeByDate;
    // version 是快取版本號：ref 更新後靠它觸發重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, validStart, validEnd]);
}
