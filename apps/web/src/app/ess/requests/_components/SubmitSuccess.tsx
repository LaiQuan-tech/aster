"use client";

/**
 * 送出後取代表單的成功畫面：大勾 ＋「已送出，等待 {approverName} 簽核」＋ 摘要一行
 * ＋「再填一張」「查看我的申請」。附件上傳失敗時多一行提醒（單已建立，可在清單補傳）。
 * 自行墊付的公出／出差（2026-10-16）：多一行報銷結果（當場填的明細送了幾筆、哪筆沒送成）
 * ＋「填報銷單」連到報銷頁（預填這張公出單）。
 */
import Link from "next/link";
import { Button, Card, Icon } from "@/components/ess-ui";

export interface SubmitSuccessProps {
  /** `steps[0]` 的候選姓名（多位用「／」串）或 `approverName`；沒有 → 「等待主管簽核」。 */
  approverName: string | null;
  summary: string;
  /** 附件沒傳成功時的提醒（null＝全部成功）。 */
  uploadWarning: string | null;
  /** 一併送出的報銷結果（null＝沒填明細）。 */
  expenseOutcome?: { tone: "success" | "warning"; text: string } | null;
  /** 「填報銷單」連結（自行墊付的公出／出差才有）。 */
  fillExpenseHref?: string | null;
  onAgain: () => void;
  onViewList: () => void;
}

export function SubmitSuccess({
  approverName,
  summary,
  uploadWarning,
  expenseOutcome,
  fillExpenseHref,
  onAgain,
  onViewList,
}: SubmitSuccessProps) {
  const name = (approverName ?? "").trim();
  return (
    <Card className="text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-50 text-green-600" aria-hidden="true">
        <Icon name="check" className="h-9 w-9" />
      </div>
      <div role="status" aria-live="polite">
        <h2 className="mt-4 text-lg font-semibold text-gray-800">{name ? `已送出，等待 ${name} 簽核` : "已送出，等待主管簽核"}</h2>
        {summary && <p className="mt-1 text-sm text-gray-500">{summary}</p>}
      </div>
      {uploadWarning && (
        <p role="alert" className="mx-auto mt-3 max-w-sm rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {uploadWarning}
        </p>
      )}
      {expenseOutcome && (
        <p
          role={expenseOutcome.tone === "warning" ? "alert" : "status"}
          className={`mx-auto mt-3 max-w-sm rounded-xl px-3 py-2 text-left text-sm ${
            expenseOutcome.tone === "warning" ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-800"
          }`}
        >
          {expenseOutcome.text}
        </p>
      )}
      {fillExpenseHref && (
        <Link
          href={fillExpenseHref}
          className="mt-4 flex min-h-12 w-full items-center justify-center rounded-xl border border-gray-200 bg-white px-5 text-base font-medium text-gray-700 hover:bg-gray-50"
        >
          {expenseOutcome?.tone === "success" ? "再填一筆報銷" : "填報銷單"}
        </Link>
      )}
      <div className={`${fillExpenseHref ? "mt-3" : "mt-5"} grid grid-cols-2 gap-3`}>
        <Button variant="secondary" size="lg" onClick={onAgain}>
          再填一張
        </Button>
        <Button size="lg" onClick={onViewList}>
          查看我的申請
        </Button>
      </div>
    </Card>
  );
}
