"use client";

import { useState } from "react";
import { PROJECT_CODE_MAX, humanizeProjectCodeError, updateProjectCode } from "@/lib/projects-ext-api";

/** 前端先擋明顯不合法的輸入（後端仍會再驗；重複只有後端知道）。null＝可以送。 */
export function projectCodeInputError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "序號不可空白";
  if ([...v].length > PROJECT_CODE_MAX) return `序號最多 ${PROJECT_CODE_MAX} 字`;
  return null;
}

/**
 * 申請單抬頭的「專案序號」（2026-11-12 可手動調整）：
 * canEdit（＝專案基本資料編輯權限 access.finance，且不是列印／舊版檢視）時序號旁有鉛筆鈕，
 * 點了變輸入框＋儲存／取消；存成功後呼叫 onSaved（整頁重抓）。重複序號顯示「此序號已被其他專案使用」。
 */
export function ProjectCodeField({
  projectId,
  code,
  canEdit,
  onSaved,
}: {
  projectId: string;
  code: string | null;
  canEdit: boolean;
  onSaved?: (code: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(code ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setValue(code ?? "");
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
  };
  const save = async () => {
    const localErr = projectCodeInputError(value);
    if (localErr) {
      setError(localErr);
      return;
    }
    const next = value.trim();
    if (next === code) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await updateProjectCode(projectId, next);
      setEditing(false);
      await onSaved?.(res.code);
    } catch (err) {
      setError(humanizeProjectCodeError(err));
    } finally {
      setSaving(false);
    }
  };

  if (canEdit && editing) {
    return (
      <span className="flex shrink-0 flex-col items-end gap-1 no-print print:hidden" data-testid="project-code-editor">
        <span className="flex items-center gap-1">
          <span className="shrink-0 text-gray-600">專案序號：</span>
          <input
            aria-label="專案序號"
            autoFocus
            maxLength={PROJECT_CODE_MAX + 10}
            className={`w-44 rounded-md border px-2 py-0.5 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--brand)] ${error ? "border-red-400 bg-red-50" : "border-gray-300"}`}
            value={value}
            disabled={saving}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
          />
          <button
            type="button"
            className="rounded-md bg-[var(--brand)] px-2 py-0.5 text-xs font-medium text-white disabled:opacity-50"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "儲存中…" : "儲存"}
          </button>
          <button
            type="button"
            className="rounded-md border border-gray-300 px-2 py-0.5 text-xs text-gray-700 disabled:opacity-50"
            disabled={saving}
            onClick={cancel}
          >
            取消
          </button>
        </span>
        {error && (
          <span role="alert" className="text-xs text-red-600" data-testid="project-code-error">
            {error}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1 text-gray-600" data-testid="project-code">
      專案序號：<span className="font-mono text-gray-900">{code ?? "—"}</span>
      {canEdit && (
        <button
          type="button"
          aria-label="編輯專案序號"
          title="編輯專案序號"
          className="no-print rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 print:hidden"
          onClick={start}
          data-testid="project-code-edit"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793ZM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" />
          </svg>
        </button>
      )}
    </span>
  );
}
