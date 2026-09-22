"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ess-ui";
import { getDutyToday, type DutyToday } from "@/lib/people-extras-api";

/**
 * 「今日值日／總機」卡（M8 輪播排班）——掛在 /ess 首頁「今日」卡之後。
 *
 * 今天兩種職務都沒排（或端點還沒上線）就**整張不顯示**：首頁是每天都會看的地方，
 * 一張永遠寫著「—」的卡只是噪音。載入中也不顯示骨架，避免首頁多一次版面跳動。
 */
export function DutyTodayCard() {
  const [data, setData] = useState<DutyToday | null>(null);

  useEffect(() => {
    let active = true;
    getDutyToday()
      .then((res) => {
        if (active) setData(res);
      })
      .catch(() => null); // 值日排班不是關鍵路徑，失敗就當作沒排
    return () => {
      active = false;
    };
  }, []);

  if (!data || (!data.duty && !data.reception)) return null;

  return (
    <Card title="今日輪值">
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        {data.duty && (
          <div className="flex items-baseline gap-2">
            <dt className="text-gray-500">值日</dt>
            <dd className="font-medium text-gray-900">{data.duty.name ?? "—"}</dd>
          </div>
        )}
        {data.reception && (
          <div className="flex items-baseline gap-2">
            <dt className="text-gray-500">總機</dt>
            <dd className="font-medium text-gray-900">{data.reception.name ?? "—"}</dd>
          </div>
        )}
      </dl>
    </Card>
  );
}
