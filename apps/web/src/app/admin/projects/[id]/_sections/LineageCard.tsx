"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Card, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { statusLabel } from "@/lib/projects-api";
import {
  duplicateProject,
  getProjectLineage,
  humanizeDuplicateError,
  DUPLICATE_KIND_LABELS,
  PROJECT_KIND_LABELS,
  type DuplicateKind,
  type DuplicateProjectResponse,
  type LineageResponse,
  type ProjectDetail,
} from "@/lib/projects-ext-api";
import { fmtMoney } from "./shared";

/**
 * C2 變更歷史（同源案時間線）＋「複製為追加減／加做」對話框。
 *
 * 客戶的邏輯：合約變更不改原案，複製成新案 `{根案 code}-{n}`、原案封存但保留。
 * 這張卡讓人在任何一案上都看得到整條鏈：根案 → -1 → -2……，本案高亮，
 * 封存案灰字＋理由。資料自己抓（GET /projects/:id/lineage），不進 page.tsx 的
 * 大 load()——複製後導到新案時，卡片用 projectId 重抓即可。
 */

interface LineageCardProps {
  projectId: string;
}

export function LineageCard({ projectId }: LineageCardProps) {
  const [lineage, setLineage] = useState<LineageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLineage(null);
    setError(null);
    getProjectLineage(projectId)
      .then((res) => {
        if (active) setLineage(res);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "載入變更歷史失敗");
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const projects = lineage?.projects ?? [];
  const chainLength = projects.length;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700">變更歷史（同源案）</h2>
        <span className="text-xs text-gray-400">
          合約變更不改原案：複製成新案「根案編號-n」，原案封存但保留供查。
        </span>
      </div>

      {error && <ErrorText>{error}</ErrorText>}
      {!error && !lineage && <p className="text-sm text-gray-400">載入中…</p>}
      {lineage && chainLength <= 1 && (
        <p className="text-sm text-gray-400">本案尚無追加減／加做的複製案。要變更合約金額請用右上角「複製為追加減／加做」。</p>
      )}

      {lineage && chainLength > 1 && (
        <ol className="relative ml-2 border-l border-gray-200 pl-5" data-testid="lineage-timeline">
          {projects.map((p) => {
            const current = p.id === projectId;
            const archived = !!p.archivedAt;
            return (
              <li key={p.id} className="relative mb-4 last:mb-0" data-testid={`lineage-${p.code ?? p.id}`}>
                <span
                  className={`absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 ${
                    current ? "border-[var(--brand)] bg-[var(--brand)]" : archived ? "border-gray-300 bg-gray-100" : "border-gray-400 bg-white"
                  }`}
                />
                <div
                  className={`rounded-lg border px-3 py-2 ${
                    current ? "border-[var(--brand)] bg-amber-50/40" : "border-gray-100"
                  } ${archived ? "text-gray-400" : "text-gray-800"}`}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    {current ? (
                      <span className="font-semibold">{p.code ?? "（無編號）"}</span>
                    ) : (
                      <Link href={`/admin/projects/${p.id}`} className="font-semibold hover:underline">
                        {p.code ?? "（無編號）"}
                      </Link>
                    )}
                    <span className={`rounded-full px-2 py-0.5 text-xs ${archived ? "bg-gray-100 text-gray-400" : "bg-gray-100 text-gray-600"}`}>
                      {PROJECT_KIND_LABELS[p.kind] ?? p.kind}
                    </span>
                    {current && (
                      <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: "var(--brand)" }}>
                        本案
                      </span>
                    )}
                    {archived && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">已封存</span>}
                    <span className="truncate">{p.name}</span>
                  </div>
                  <div className={`mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs ${archived ? "text-gray-400" : "text-gray-500"}`}>
                    <span>狀態：{statusLabel(p.status)}</span>
                    {p.openedOn && <span>開案 {p.openedOn}</span>}
                    {lineage.finance && <span>合約總額 {p.contractTotal === null ? "—" : fmtMoney(p.contractTotal)}</span>}
                  </div>
                  {archived && p.archiveReason && (
                    <p className="mt-1 text-xs text-gray-400">封存理由：{p.archiveReason}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * 複製對話框
 * ──────────────────────────────────────────────────────────────────── */

interface DuplicateProjectDialogProps {
  open: boolean;
  project: ProjectDetail;
  onClose: () => void;
  /** 成功後由 page.tsx 導到新案。 */
  onDone: (res: DuplicateProjectResponse) => void;
}

export function DuplicateProjectDialog({ open, project, onClose, onDone }: DuplicateProjectDialogProps) {
  const [kind, setKind] = useState<DuplicateKind>("change");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [archiveOriginal, setArchiveOriginal] = useState(true);
  const [copyEngineers, setCopyEngineers] = useState(true);
  const [copySubcontracts, setCopySubcontracts] = useState(true);
  const [copyBillings, setCopyBillings] = useState(true);
  const [copyMembers, setCopyMembers] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const amountNum = Number(amount.replace(/,/g, ""));
  const canSubmit = amount.trim() !== "" && Number.isFinite(amountNum) && amountNum >= 0 && reason.trim() !== "" && !saving;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await duplicateProject(project.id, {
        kind,
        amount: amountNum,
        reason: reason.trim(),
        archiveOriginal,
        copy: { engineers: copyEngineers, subcontracts: copySubcontracts, billings: copyBillings, members: copyMembers },
      });
      onDone(res);
    } catch (err) {
      setError(humanizeDuplicateError(err, "複製失敗"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="duplicate-dialog-title"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
        data-testid="duplicate-dialog"
      >
        <h2 id="duplicate-dialog-title" className="text-lg font-semibold text-gray-900">
          複製為追加減／加做
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          原案 <span className="font-medium text-gray-700">{project.code ?? project.name}</span> 不會被修改：系統複製成新案
          「根案編號-n」，依下方金額新建一筆合約；勾選封存時原案會收進封存（年度總表不再採計，仍可查）。
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="dup-kind">類型</label>
            <select id="dup-kind" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as DuplicateKind)}>
              {(Object.keys(DUPLICATE_KIND_LABELS) as DuplicateKind[]).map((k) => (
                <option key={k} value={k}>{DUPLICATE_KIND_LABELS[k]}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">追加減 → 新案掛「追加減帳」；加做 → 新案掛「合約」。</p>
          </div>
          <div>
            <label className={labelCls} htmlFor="dup-amount">新合約金額（未稅）*</label>
            <input
              id="dup-amount"
              className={inputCls}
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="例如 2000000"
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="dup-reason">變更理由 *</label>
            <input
              id="dup-reason"
              className={inputCls}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：合約由 1000 萬變更為 2000 萬（業主追加二期）"
            />
          </div>
        </div>

        <div className="mt-4 space-y-2 text-sm text-gray-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={archiveOriginal} onChange={(e) => setArchiveOriginal(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
            封存原案（年度總帳不再採計，保留供查）
          </label>
          <p className="text-xs text-gray-400">複製項目（合約不複製，一律依上方金額新建；請款／開票／入帳與付款紀錄不會帶過去）：</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={copyBillings} onChange={(e) => setCopyBillings(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
              請款期程（期別＋百分比）
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={copySubcontracts} onChange={(e) => setCopySubcontracts(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
              副委託／技師（結構）
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={copyEngineers} onChange={(e) => setCopyEngineers(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
              工程師指派
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={copyMembers} onChange={(e) => setCopyMembers(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
              成員與分潤比例
            </label>
          </div>
        </div>

        <ErrorText>{error}</ErrorText>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50" disabled={saving}>
            取消
          </button>
          <PrimaryButton type="submit" disabled={!canSubmit}>{saving ? "複製中…" : "建立新案"}</PrimaryButton>
        </div>
      </form>
    </div>
  );
}
