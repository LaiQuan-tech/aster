"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/admin-ui";
import type { ApplicationVersionMeta } from "@/lib/projects-ext-api";
import { oldVersionBanner, versionOptions } from "@/lib/project-application-versions";

/**
 * 申請單標題旁的版本控制（2026-11-10）：版本下拉（最新＝目前＝即時資料；其他＝舊版快照，唯讀）＋「另存新版本」。
 * 合約金額（未稅）改了會自動建版（後端），這裡不用做什麼；舊版不能還原。
 */
export function ApplicationVersionControls({
  versions,
  selected,
  onSelect,
  onCreate,
  canCreate,
  dirty,
}: {
  versions: ApplicationVersionMeta[];
  /** 正在看的舊版號；null＝目前版。 */
  selected: number | null;
  onSelect: (versionNo: number | null) => void;
  /** 手動另存新版本（note 可空）。丟錯＝失敗，由這裡顯示。 */
  onCreate: (note: string | null) => Promise<void>;
  canCreate: boolean;
  /** 申請單有未儲存的修改（另存的是已儲存的內容，提醒一下）。 */
  dirty: boolean;
}) {
  const options = versionOptions(versions);
  const current = options.find((o) => o.current);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await onCreate(note.trim() || null);
      setAsking(false);
      setNote("");
    } catch (err) {
      setError(err instanceof Error && /\[403\]/.test(err.message) ? "沒有權限" : "另存失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs" data-testid="application-version-controls">
      <select
        aria-label="申請單版本"
        className="max-w-[22rem] rounded-md border border-gray-300 bg-white px-1.5 py-0.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
        value={selected ?? current?.value ?? 0}
        onChange={(e) => {
          const no = Number(e.target.value);
          const opt = options.find((o) => o.value === no);
          onSelect(!opt || opt.current ? null : no);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {selected === null && canCreate && !asking && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(true)} title="把目前已儲存的申請單內容存成新的一版（之後的修改都算新版）">
          另存新版本
        </Button>
      )}
      {asking && (
        <span className="flex flex-wrap items-center gap-1">
          <input
            aria-label="新版本備註"
            className="w-48 rounded-md border border-gray-300 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
            maxLength={500}
            placeholder="備註（選填，例：送業主前）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button type="button" variant="primary" size="sm" disabled={busy} onClick={create}>{busy ? "另存中…" : "確定另存"}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>取消</Button>
          {dirty && <span className="text-amber-700">尚未儲存的修改不會存進新版本</span>}
        </span>
      )}
      {error && <span className="text-red-600">{error}</span>}
    </span>
  );
}

/** 檢視舊版時申請單上方的黃色橫幅：「正在檢視第 2 版（2026-03-01 建立），非目前內容」＋列印此版＋回到目前版本。 */
export function OldVersionBanner({
  projectId,
  version,
  onBack,
}: {
  projectId: string;
  version: Pick<ApplicationVersionMeta, "versionNo" | "createdAt">;
  onBack: () => void;
}) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="application-old-version-banner">
      <span className="mr-auto">{oldVersionBanner(version)}（唯讀，不能修改或還原）</span>
      <Link href={`/admin/projects/${projectId}/application?version=${version.versionNo}`} className="underline">列印此版</Link>
      <Button type="button" variant="secondary" size="sm" onClick={onBack}>回到目前版本</Button>
    </div>
  );
}
