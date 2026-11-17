"use client";

/**
 * 請假表單：申請日期碰到自己適用的特殊假日（颱風假等，2026-11-17）時提示「此日為颱風假（無薪），請確認是否仍需請假」。
 * 只提示、不擋。按月快取（`GET /special-leave-days/mine`）；失敗＝沒有特殊假日，不擋表單。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getMySpecialDays } from "@/lib/special-leave-days-api";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** 純函式：日期清單 → 提示句（多天合併成一句）；沒有命中 → null。 */
export function specialDayHint(dates: readonly string[], labelByDate: Readonly<Record<string, string>>): string | null {
  const hits = [...new Set(dates)].filter((d) => labelByDate[d]).sort();
  if (hits.length === 0) return null;
  const parts = hits.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} 為${labelByDate[d]}`);
  return `${parts.join("、")}，請確認是否仍需請假`;
}

/** 這些日期中，命中特殊假日的 date → 「颱風假（無薪）」。 */
export function useMySpecialDays(dates: readonly string[]): Record<string, string> {
  const cache = useRef(new Map<string, Record<string, string>>());
  const [version, setVersion] = useState(0);
  const months = useMemo(
    () => [...new Set(dates.filter((d) => DATE_RE.test(d)).map((d) => d.slice(0, 7)))].sort().slice(0, 6),
    [dates],
  );
  const monthsKey = months.join(",");

  useEffect(() => {
    let active = true;
    const todo = monthsKey ? monthsKey.split(",").filter((m) => !cache.current.has(m)) : [];
    if (todo.length === 0) return;
    Promise.all(
      todo.map((m) => {
        const { from, to } = monthBounds(m);
        return getMySpecialDays(from, to)
          .then((res) => {
            const map: Record<string, string> = {};
            for (const d of res?.days ?? []) if (d?.date && d.label) map[d.date] = d.label;
            cache.current.set(m, map);
          })
          .catch(() => cache.current.set(m, {}));
      }),
    ).then(() => {
      if (active) setVersion((v) => v + 1);
    });
    return () => {
      active = false;
    };
  }, [monthsKey]);

  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of monthsKey ? monthsKey.split(",") : []) Object.assign(out, cache.current.get(m) ?? {});
    return out;
    // version：快取更新後觸發重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthsKey, version]);
}
