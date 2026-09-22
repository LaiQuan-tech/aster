"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ess-ui";
import { getMyOvertimeCap, type OvertimeCap } from "@/lib/overtime-api";

/**
 * 「本月加班累計」卡（M1 月加班上限，2026-09-22 業主決策 1／2）。
 *
 * 讀 `GET /my/overtime-cap`：本月已結算的加班分鐘 vs 月上限（規則
 * `overtime.monthlyCapHours`，預設 40 小時）。進度條顏色依法定警示門檻：
 * 未達第一階（36h）綠、達第一階橘、達上限紅。超過上限時加註「超過的部分將另行
 * 給付」——出勤月表與薪資單維持合規版，超額只記在「加班超額另計」帳上。
 *
 * 進度＝已結算／已核准加班單取大者（與送單時的超額判定同源）；下方一行小字分開列
 * 「已結算・已核准加班單・待簽」三個數（為 0 的段落省略），員工才看得出首頁卡與
 * 加班單上「超過月上限」標記為什麼會不一樣（待簽會被併進送單時的累計基準）。
 *
 * 載入失敗或後端還沒有這支端點（舊版 API）→ 整張卡不顯示（回 null），
 * 不干擾首頁最重要的打卡動線。
 */

function hours(minutes: number): string {
  const h = minutes / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

/** 依「已達哪一階警示門檻」決定顏色：未達 → 綠、第一階 → 橘、上限（含）→ 紅。 */
function toneOf(cap: OvertimeCap): { bar: string; text: string; ring: string } {
  const usedMinutes = Math.max(cap.settledMinutes, cap.approvedRequestMinutes);
  const usedHours = usedMinutes / 60;
  const capHours = cap.capMinutes / 60;
  const firstAlert = [...(cap.alertHours ?? [])].sort((a, b) => a - b)[0];
  if (usedHours >= capHours) return { bar: "bg-red-500", text: "text-red-700", ring: "bg-red-100" };
  if (firstAlert != null && usedHours >= firstAlert) {
    return { bar: "bg-orange-500", text: "text-orange-700", ring: "bg-orange-100" };
  }
  return { bar: "bg-emerald-500", text: "text-emerald-700", ring: "bg-emerald-100" };
}

export function OvertimeCapCard() {
  const [cap, setCap] = useState<OvertimeCap | null>(null);

  useEffect(() => {
    let active = true;
    void getMyOvertimeCap()
      .then((data) => {
        if (active) setCap(data);
      })
      .catch(() => {
        // 加分項：拿不到就不顯示（舊版 API、離線、403 皆同）。
        if (active) setCap(null);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!cap || cap.capMinutes <= 0) return null;

  const usedMinutes = Math.max(cap.settledMinutes, cap.approvedRequestMinutes);
  const pct = Math.min(100, Math.round((usedMinutes / cap.capMinutes) * 100));
  const tone = toneOf(cap);
  const remaining = cap.capMinutes - usedMinutes;
  const pendingMinutes = cap.pendingRequestMinutes ?? 0;
  const breakdown = [
    cap.settledMinutes > 0 ? `已結算 ${hours(cap.settledMinutes)} 小時` : null,
    cap.approvedRequestMinutes > 0 ? `已核准加班單 ${hours(cap.approvedRequestMinutes)} 小時` : null,
    pendingMinutes > 0 ? `待簽 ${hours(pendingMinutes)} 小時` : null,
  ].filter((s): s is string => s !== null);

  return (
    <Card title="本月加班累計">
      <p className={`text-2xl font-semibold tabular-nums ${tone.text}`}>
        {hours(usedMinutes)}
        <span className="ml-1 text-base font-normal text-gray-400">／{hours(cap.capMinutes)} 小時</span>
      </p>
      <div className={`mt-3 h-2 w-full overflow-hidden rounded-full ${tone.ring}`}>
        <div
          className={`h-full rounded-full transition-[width] ${tone.bar}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="本月加班累計佔月上限比例"
        />
      </div>
      <p className="mt-2 text-sm text-gray-500">
        {cap.beyondCapMinutes > 0
          ? `已超過月上限 ${hours(cap.beyondCapMinutes)} 小時，超過的部分將另行給付`
          : `距離月上限還有 ${hours(remaining)} 小時`}
      </p>
      {breakdown.length > 0 && <p className="mt-1 text-xs text-gray-400">{breakdown.join("・")}</p>}
    </Card>
  );
}
