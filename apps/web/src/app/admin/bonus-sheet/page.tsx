"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/admin-ui";
import type { Me } from "@/lib/admin-api";
import { readBonusSheetView, writeBonusSheetView, type BonusSheetSelection, type BonusSheetView } from "@/lib/bonus-sheet-api";
import { bonusSheetAccess } from "@/lib/bonus-page-access";
import { getMeCached, peekMeCached } from "@/lib/ess-state";
import { BonusRunsSection } from "./_runs";
import { BonusSheetPanel } from "./_sheet";

/**
 * 「獎金分潤」分頁（2026-10-27 業主：「把季獎金發放融合到獎金分潤裡面。季獎金裡面的儀表板不錯，可以繼續沿用，重複的功能就移除。」）
 *
 *   上：季發放儀表板＋發放批次（_runs.tsx，原 /admin/bonus-runs；舊網址轉到這裡，批次明細仍是 /admin/bonus-runs/[id]）。
 *   下：專案獎金總表（_sheet.tsx：管理檢視／公司格式）。公司格式的「本次（獎金批次）」與上方清單連動：
 *       清單按「在總表看」＝切到那一批；總表正在顯示的那一批在清單上標「總表顯示中」。
 *       `?run=<批次 id>` 直接開公司格式的那一批（批次明細頁的「在總表看」連結用）。
 *
 * 兩個區塊沿用各自原本的權限（lib/bonus-page-access.ts），不因合併放寬：
 *   • 儀表板＋發放批次：HR／平台管理員（API requireHrAdmin）；毛利類欄位由 API 依「可看集團財務」遮罩。
 *   • 專案獎金總表：可看集團財務的 HR／平台管理員（原分頁 hrOnly＋groupFinancials；API requireGroupFinancials）。
 *     看不到的 HR 照樣做批次作業，總表整塊不畫（也不打 API）。
 */
export default function BonusPage() {
  const [me, setMe] = useState<Me | null>(() => peekMeCached());
  useEffect(() => {
    if (me) return;
    let active = true;
    getMeCached()
      .then((m) => active && setMe(m))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [me]);

  const [sel, setSel] = useState<BonusSheetSelection>({ mode: "run", runId: null });
  const [view, setView] = useState<BonusSheetView>("manage");
  const [shownRunId, setShownRunId] = useState<string | null>(null);

  useEffect(() => {
    // ?run=<id>：直接看公司格式的那一批（不寫進記住的檢視）；否則用記住的檢視。
    const run = new URLSearchParams(window.location.search).get("run");
    if (run) {
      setSel({ mode: "run", runId: run });
      setView("company");
    } else {
      setView(readBonusSheetView());
    }
  }, []);

  const changeView = useCallback((v: BonusSheetView) => {
    setView(v);
    writeBonusSheetView(v);
  }, []);

  const showInSheet = useCallback((runId: string) => {
    setSel({ mode: "run", runId });
    setView("company");
    window.requestAnimationFrame(() => document.getElementById("bonus-sheet")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  if (!me) return <p className="text-sm text-gray-500">載入中…</p>;
  const access = bonusSheetAccess(me);

  return (
    <div className="space-y-6">
      {access.runs ? (
        <BonusRunsSection shownRunId={access.sheet ? shownRunId : null} onShowInSheet={access.sheet ? showInSheet : undefined} />
      ) : (
        <Card className="no-print">
          <p className="text-sm text-gray-600">季發放儀表板與發放批次（試算、送審、發放）只開放給 HR 與平台管理員。</p>
        </Card>
      )}

      <section id="bonus-sheet" aria-labelledby="bonus-sheet-heading" className="scroll-mt-4 space-y-3">
        <h2 id="bonus-sheet-heading" className="no-print text-base font-semibold text-gray-800">
          專案獎金總表
        </h2>
        {access.sheet ? (
          <BonusSheetPanel sel={sel} onSelChange={setSel} view={view} onViewChange={changeView} onShownRun={setShownRunId} />
        ) : (
          <Card className="no-print">
            <p className="text-sm text-gray-600">
              專案獎金總表含各案獎金比例與總獎金，只開放給老闆與經老闆授權的人員；需要的話請老闆到員工資料開啟「可看集團財務」。批次作業不受影響。
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
