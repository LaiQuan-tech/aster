"use client";

/**
 * 公務車頁面（員工端 /ess/vehicles*、後台 /admin/vehicles*）共用的小元件：
 *   - `CostRowsEditor`：費用行（類型、金額、員工代墊／公司支付、日期、備註）可增刪，手機一行一張卡。
 *   - `PhotoPicker`：挑車況照片（手機可直接開相機），挑檔時用 photoPickError 先擋類型／原檔大小。
 *   - `PhotoGrid`：照片縮圖（signed URL，點開原圖）。
 *   - `CostList`：唯讀費用行＋請款狀態。
 * 純邏輯在 lib/vehicle-view.ts。
 */
import { useId, useRef, type ChangeEvent } from "react";
import { Button, Input, Pill, Select } from "@/components/ess-ui";
import { fmtMoney } from "@/lib/ess-format";
import {
  CLAIM_STATE_LABEL,
  COST_TYPES,
  COST_TYPE_LABEL,
  EXPENSE_CLAIM_STATUS_LABEL,
  PAID_BY_LABEL,
  photoPickError,
} from "@/lib/vehicle-view";
import type { CostType, PaidBy, TripCost, TripPhoto, TripPhotoPhase } from "@/lib/vehicles-api";

/* ------------------------------------------------------- 費用編輯 --- */

export interface CostDraft {
  /** 既有行的 id（PUT 覆寫時帶回）；新行沒有。 */
  id?: string;
  /** React key。 */
  key: string;
  costType: CostType;
  amount: string;
  paidBy: PaidBy;
  incurredOn: string;
  note: string;
}

let draftSeq = 0;

export function newCostDraft(incurredOn: string): CostDraft {
  draftSeq += 1;
  return { key: `new-${draftSeq}`, costType: "fuel", amount: "", paidBy: "employee", incurredOn, note: "" };
}

export function costToDraft(cost: TripCost): CostDraft {
  return {
    id: cost.id,
    key: cost.id,
    costType: cost.costType,
    amount: String(cost.amount),
    paidBy: cost.paidBy,
    incurredOn: cost.incurredOn,
    note: cost.note ?? "",
  };
}

/** 草稿 → API 的費用行；金額空白的行略過，金額不是正數 → 回錯誤訊息。 */
export function draftsToCosts(
  drafts: readonly CostDraft[],
): { ok: true; costs: Array<{ id?: string; costType: CostType; amount: number; paidBy: PaidBy; incurredOn: string; note?: string }> } | { ok: false; message: string } {
  const costs = [];
  for (const d of drafts) {
    if (!d.amount.trim()) continue;
    const amount = Number(d.amount.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: `${COST_TYPE_LABEL[d.costType]}的金額請填大於 0 的數字` };
    if (Math.round(amount * 100) !== amount * 100) return { ok: false, message: "金額最多到小數點後 2 位" };
    if (!d.incurredOn) return { ok: false, message: "請填費用日期" };
    costs.push({
      ...(d.id ? { id: d.id } : {}),
      costType: d.costType,
      amount,
      paidBy: d.paidBy,
      incurredOn: d.incurredOn,
      ...(d.note.trim() ? { note: d.note.trim() } : {}),
    });
  }
  if (costs.length > 20) return { ok: false, message: "費用最多 20 行" };
  return { ok: true, costs };
}

export function CostRowsEditor({
  drafts,
  onChange,
  defaultDate,
  disabled,
}: {
  drafts: CostDraft[];
  onChange: (next: CostDraft[]) => void;
  defaultDate: string;
  disabled?: boolean;
}) {
  const update = (key: string, patch: Partial<CostDraft>) =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  return (
    <div className="space-y-2">
      {drafts.length === 0 && <p className="text-sm text-gray-400">沒有費用（油資、過路費、停車費…有的話按下方新增）。</p>}
      {drafts.map((d, index) => (
        <div key={d.key} className="rounded-xl border border-gray-200 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Select
              aria-label={`第 ${index + 1} 行費用類型`}
              value={d.costType}
              disabled={disabled}
              onChange={(e) => update(d.key, { costType: e.target.value as CostType })}
            >
              {COST_TYPES.map((t) => (
                <option key={t} value={t}>
                  {COST_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
            <Input
              aria-label={`第 ${index + 1} 行金額`}
              inputMode="decimal"
              placeholder="金額（元）"
              value={d.amount}
              disabled={disabled}
              onChange={(e) => update(d.key, { amount: e.target.value })}
            />
            <Select
              aria-label={`第 ${index + 1} 行付款方`}
              value={d.paidBy}
              disabled={disabled}
              onChange={(e) => update(d.key, { paidBy: e.target.value as PaidBy })}
            >
              <option value="employee">{PAID_BY_LABEL.employee}</option>
              <option value="company">{PAID_BY_LABEL.company}</option>
            </Select>
            <Input
              aria-label={`第 ${index + 1} 行日期`}
              type="date"
              value={d.incurredOn}
              disabled={disabled}
              onChange={(e) => update(d.key, { incurredOn: e.target.value })}
            />
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              aria-label={`第 ${index + 1} 行備註`}
              placeholder="備註（選填）"
              value={d.note}
              disabled={disabled}
              onChange={(e) => update(d.key, { note: e.target.value })}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
              aria-label={`刪除第 ${index + 1} 行費用`}
              className="shrink-0"
            >
              刪除
            </Button>
          </div>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || drafts.length >= 20}
        onClick={() => onChange([...drafts, newCostDraft(defaultDate)])}
      >
        ＋ 新增費用
      </Button>
    </div>
  );
}

/* ------------------------------------------------------- 費用唯讀 --- */

export function CostList({
  costs,
  receiptSlot,
}: {
  costs: TripCost[];
  /** 已轉報銷的行右側額外內容（例如「上傳收據」）。 */
  receiptSlot?: (cost: TripCost) => React.ReactNode;
}) {
  if (costs.length === 0) return <p className="text-sm text-gray-400">沒有費用。</p>;
  const total = costs.reduce((sum, c) => sum + (Number.isFinite(c.amount) ? c.amount : 0), 0);
  return (
    <div>
      <ul className="divide-y divide-gray-100">
        {costs.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-800">
                {COST_TYPE_LABEL[c.costType]} · {fmtMoney(c.amount)}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {c.incurredOn} · {PAID_BY_LABEL[c.paidBy]}
                {c.note ? ` · ${c.note}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {c.paidBy === "employee" && (
                <Pill tone={c.claimState === "claimed" ? "green" : c.claimState === "creating" ? "amber" : "gray"}>
                  {CLAIM_STATE_LABEL[c.claimState]}
                </Pill>
              )}
              {c.expenseClaimStatus && <Pill tone="blue">報銷{EXPENSE_CLAIM_STATUS_LABEL[c.expenseClaimStatus]}</Pill>}
              {receiptSlot?.(c)}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-right text-sm text-gray-600">合計 {fmtMoney(total)}</p>
    </div>
  );
}

/* ------------------------------------------------------- 照片挑選 --- */

export function PhotoPicker({
  files,
  onChange,
  onError,
  disabled,
  max = 12,
  label = "加照片",
}: {
  files: File[];
  onChange: (next: File[]) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  max?: number;
  label?: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    const ok: File[] = [];
    for (const file of picked) {
      const err = photoPickError(file);
      if (err) {
        onError(`${file.name}：${err}`);
        continue;
      }
      ok.push(file);
    }
    const next = [...files, ...ok];
    if (next.length > max) onError(`最多 ${max} 張照片`);
    onChange(next.slice(0, max));
  }
  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/jpeg,image/png,image/heic,image/heif,image/webp"
        multiple
        className="sr-only"
        disabled={disabled}
        onChange={onPick}
      />
      <Button variant="secondary" size="sm" disabled={disabled || files.length >= max} onClick={() => inputRef.current?.click()}>
        {label}
      </Button>
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-sm text-gray-700">
              <span className="min-w-0 truncate">{f.name}</span>
              <button
                type="button"
                className="shrink-0 text-xs text-gray-500 underline"
                disabled={disabled}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------- 照片縮圖 --- */

const PHASE_LABEL: Record<TripPhotoPhase, string> = { checkout: "取車", return: "還車" };

export function PhotoGrid({ photos }: { photos: TripPhoto[] }) {
  if (photos.length === 0) return <p className="text-sm text-gray-400">沒有照片。</p>;
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {photos.map((p) => (
        <li key={p.id} className="relative overflow-hidden rounded-lg border border-gray-100 bg-gray-50">
          {p.url ? (
            <a href={p.url} target="_blank" rel="noreferrer" className="block aspect-square">
              {/* signed URL（1 小時）；不走 next/image（外部網域、每次不同 token） */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={`${PHASE_LABEL[p.phase]}照片 ${p.fileName}`} className="h-full w-full object-cover" loading="lazy" />
            </a>
          ) : (
            <div className="flex aspect-square items-center justify-center p-1 text-center text-xs text-gray-400">{p.fileName}</div>
          )}
          <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{PHASE_LABEL[p.phase]}</span>
        </li>
      ))}
    </ul>
  );
}
