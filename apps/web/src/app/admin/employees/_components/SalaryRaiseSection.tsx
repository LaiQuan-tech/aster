"use client";

/**
 * 員工內頁「薪資」分頁的「調薪中」區塊（2026-11-17）。只給 HR／平台管理員（員工內頁 canManage；API requireHrAdmin）。
 *   • 沒有調薪中：「標記調薪中」→ 填生效日、新本薪（新投保可先填可後填）。
 *   • 調薪中：顯示「原本薪 → 新本薪」、起始月份；「調薪完成」（填完成月份＋新勞健保投保）／「取消調薪中」。
 * 調薪中期間：薪資照新本薪發，勞保／健保（與勞退）照舊級距扣；出勤統計表「薪資」欄顯示原本薪＋差額行。
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MoneyInput } from "@/components/MoneyInput";
import { BottomSheet, Button, ConfirmDialog, ErrorText } from "@/components/admin-ui";
import { apiErrorMessage } from "@/lib/api-client";
import { formatMoney } from "@/lib/money";
import { todayDateKey } from "@/lib/salary-history";
import {
  RAISE_STATUS_LABEL,
  buildCompleteBody,
  buildRaiseBody,
  cancelSalaryRaise,
  completeSalaryRaise,
  createSalaryRaise,
  getSalaryRaises,
  periodText,
  raisePeriodText,
  raiseSummary,
  type SalaryRaisesResponse,
} from "@/lib/salary-raises";
import { Disclosure, LinkButton, ListRow } from "./payroll-ui";

const inputCls =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

const EMPTY_START = { effectiveDate: "", newBase: "", labor: "", health: "", pension: "", note: "" };
const EMPTY_DONE = { completedPeriod: "", labor: "", health: "", pension: "" };

export function SalaryRaiseSection({
  employeeId,
  method,
  currentBase,
  onChanged,
}: {
  employeeId: string;
  method: string;
  /** 目前存檔的本薪（字串，可能空）。 */
  currentBase: string;
  /** 調薪完成／取消後通知上層重載薪資資料與歷程。 */
  onChanged: () => void;
}) {
  const [data, setData] = useState<SalaryRaisesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [startForm, setStartForm] = useState(EMPTY_START);
  const [doneForm, setDoneForm] = useState(EMPTY_DONE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!employeeId) return;
    try {
      setData(await getSalaryRaises(employeeId));
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, "讀取調薪中狀態失敗"));
    }
  }, [employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data && !data.available) return null;
  const pending = data?.pending ?? null;
  const past = (data?.raises ?? []).filter((r) => r.status !== "pending");
  const baseNum = currentBase.trim() ? Number(currentBase.replace(/,/g, "")) : null;

  function openStart() {
    setStartForm({ ...EMPTY_START, effectiveDate: todayDateKey() });
    setError(null);
    setStartOpen(true);
  }

  function openDone() {
    if (!pending) return;
    const now = todayDateKey().slice(0, 7);
    setDoneForm({
      completedPeriod: now < pending.startPeriod ? pending.startPeriod : now,
      labor: pending.newLaborInsuredSalary != null ? String(pending.newLaborInsuredSalary) : "",
      health: pending.newHealthInsuredSalary != null ? String(pending.newHealthInsuredSalary) : "",
      pension: pending.newPensionWage != null ? String(pending.newPensionWage) : "",
    });
    setError(null);
    setDoneOpen(true);
  }

  async function onStart(e: FormEvent) {
    e.preventDefault();
    const built = buildRaiseBody(startForm, baseNum);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    try {
      await createSalaryRaise(employeeId, built.body);
      setStartOpen(false);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, "標記調薪中失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function onDone(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    const built = buildCompleteBody(doneForm);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    try {
      await completeSalaryRaise(employeeId, pending.id, built.body);
      setDoneOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, "調薪完成失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function onCancelRaise() {
    if (!pending) return;
    setBusy(true);
    try {
      await cancelSalaryRaise(employeeId, pending.id);
      setCancelOpen(false);
      await load();
      onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, "取消調薪中失敗"));
      setCancelOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="salary-raise-section">
      {loadError && <ErrorText>{loadError}</ErrorText>}
      {pending ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="salary-raise-pending">
          <p className="font-medium">
            調薪中（{periodText(pending.startPeriod)}起，生效日 {pending.effectiveOn}）：{raiseSummary(pending)}
          </p>
          <p className="mt-1 text-xs">
            薪資照新本薪發（請假、加班、加給以新時薪計），勞保／健保仍照舊投保級距扣；出勤統計表「薪資」欄顯示原本薪，另列調薪差額。
            政府端投保調整辦完後按「調薪完成」。
            {pending.newLaborInsuredSalary != null || pending.newHealthInsuredSalary != null
              ? ` 預定新投保：勞保 ${formatMoney(pending.newLaborInsuredSalary)}、健保 ${formatMoney(pending.newHealthInsuredSalary)}。`
              : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="primary" onClick={openDone} disabled={busy} data-testid="salary-raise-complete">
              調薪完成
            </Button>
            <Button variant="secondary" onClick={() => { setError(null); setCancelOpen(true); }} disabled={busy} data-testid="salary-raise-cancel">
              取消調薪中
            </Button>
          </div>
          {error && !doneOpen && <ErrorText>{error}</ErrorText>}
        </div>
      ) : (
        method === "monthly" &&
        data && (
          <div className="flex flex-wrap items-baseline gap-3">
            <LinkButton onClick={openStart} data-testid="salary-raise-start">
              ＋ 標記調薪中（新本薪先發、勞健保待政府調整）
            </LinkButton>
          </div>
        )
      )}

      {past.length > 0 && (
        <Disclosure title={`調薪中紀錄（${past.length}）`} testId="salary-raise-history">
          <ul className="divide-y divide-gray-100">
            {past.map((r) => (
              <ListRow key={r.id} main={`${RAISE_STATUS_LABEL[r.status]}：${raiseSummary(r)}`} meta={raisePeriodText(r)} />
            ))}
          </ul>
        </Disclosure>
      )}

      <BottomSheet open={startOpen} onClose={() => (busy ? undefined : setStartOpen(false))} title="標記調薪中">
        <form className="space-y-3" onSubmit={onStart} data-testid="salary-raise-start-form">
          <p className="text-sm text-gray-600">
            目前本薪 {formatMoney(baseNum)}。生效日所在月份起，薪資照新本薪發，勞保／健保照舊級距扣，直到按「調薪完成」。
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>調薪生效日</label>
              <input type="date" className={inputCls} value={startForm.effectiveDate} onChange={(e) => setStartForm({ ...startForm, effectiveDate: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>新本薪（月）</label>
              <MoneyInput className={inputCls} value={startForm.newBase} onValueChange={(v) => setStartForm({ ...startForm, newBase: v })} data-testid="salary-raise-new-base" />
            </div>
            <div>
              <label className={labelCls}>新勞保投保薪資（選填，完成時可再改）</label>
              <MoneyInput className={inputCls} value={startForm.labor} onValueChange={(v) => setStartForm({ ...startForm, labor: v })} />
            </div>
            <div>
              <label className={labelCls}>新健保投保金額（選填）</label>
              <MoneyInput className={inputCls} value={startForm.health} onValueChange={(v) => setStartForm({ ...startForm, health: v })} />
            </div>
            <div>
              <label className={labelCls}>新勞退月提繳工資（選填）</label>
              <MoneyInput className={inputCls} value={startForm.pension} onValueChange={(v) => setStartForm({ ...startForm, pension: v })} />
            </div>
            <div>
              <label className={labelCls}>原因／備註</label>
              <input className={inputCls} maxLength={500} value={startForm.note} onChange={(e) => setStartForm({ ...startForm, note: e.target.value })} />
            </div>
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => setStartOpen(false)} disabled={busy}>取消</Button>
            <Button variant="primary" type="submit" loading={busy}>標記調薪中</Button>
          </div>
        </form>
      </BottomSheet>

      <BottomSheet open={doneOpen} onClose={() => (busy ? undefined : setDoneOpen(false))} title="調薪完成">
        <form className="space-y-3" onSubmit={onDone} data-testid="salary-raise-complete-form">
          <p className="text-sm text-gray-600">
            完成月份起，薪資資料改成新本薪 {formatMoney(pending?.newBaseSalary)} 與下列新投保；之前的月份（調薪中期間）重算仍照舊投保。已定案的薪資單不會變。
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>調薪完成月份</label>
              <input type="month" className={inputCls} value={doneForm.completedPeriod} onChange={(e) => setDoneForm({ ...doneForm, completedPeriod: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>新勞保投保薪資</label>
              <MoneyInput className={inputCls} value={doneForm.labor} onValueChange={(v) => setDoneForm({ ...doneForm, labor: v })} />
            </div>
            <div>
              <label className={labelCls}>新健保投保金額</label>
              <MoneyInput className={inputCls} value={doneForm.health} onValueChange={(v) => setDoneForm({ ...doneForm, health: v })} />
            </div>
            <div>
              <label className={labelCls}>新勞退月提繳工資（留空＝不改）</label>
              <MoneyInput className={inputCls} value={doneForm.pension} onValueChange={(v) => setDoneForm({ ...doneForm, pension: v })} />
            </div>
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          <div className="grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => setDoneOpen(false)} disabled={busy}>取消</Button>
            <Button variant="primary" type="submit" loading={busy}>調薪完成</Button>
          </div>
        </form>
      </BottomSheet>

      <ConfirmDialog
        open={cancelOpen}
        title="取消調薪中"
        message={pending ? `${raiseSummary(pending)}\n取消後回到舊薪資（未定案的月份重算即恢復舊本薪）。` : ""}
        confirmLabel="取消調薪中"
        danger
        busy={busy}
        onConfirm={() => void onCancelRaise()}
        onCancel={() => setCancelOpen(false)}
      />
    </div>
  );
}
