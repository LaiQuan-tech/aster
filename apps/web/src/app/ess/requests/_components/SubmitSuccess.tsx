"use client";

/**
 * 送出後取代表單的成功畫面：大勾 ＋「已送出，等待 {approverName} 簽核」＋ 摘要一行
 * ＋「再填一張」「查看我的申請」。附件上傳失敗時多一行提醒（單已建立，可在清單補傳）。
 */
import { Button, Card, Icon } from "@/components/ess-ui";

export interface SubmitSuccessProps {
  /** `steps[0].approverName`；沒有 → 「等待主管簽核」。 */
  approverName: string | null;
  summary: string;
  /** 附件沒傳成功時的提醒（null＝全部成功）。 */
  uploadWarning: string | null;
  onAgain: () => void;
  onViewList: () => void;
}

export function SubmitSuccess({ approverName, summary, uploadWarning, onAgain, onViewList }: SubmitSuccessProps) {
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
      <div className="mt-5 grid grid-cols-2 gap-3">
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
