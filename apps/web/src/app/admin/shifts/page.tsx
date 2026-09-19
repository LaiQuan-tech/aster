"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Card, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  getShifts,
  createShift,
  updateShift,
  deleteShift,
  type Shift,
} from "@/lib/admin-api";

// shifts store start_time/end_time as "HH:MM:SS"; trim to HH:MM for the inputs.
function hhmm(t: string): string {
  return t.slice(0, 5);
}

interface Draft {
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: string;
  isNightShift: boolean;
}

const EMPTY: Draft = {
  name: "",
  startTime: "09:00",
  endTime: "18:00",
  breakMinutes: "60",
  isNightShift: false,
};

export default function ShiftsPage() {
  const [rows, setRows] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getShifts();
      setRows(res.shifts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!draft.name.trim()) {
      setFormError("請輸入班別名稱");
      return;
    }
    setSubmitting(true);
    try {
      await createShift({
        name: draft.name.trim(),
        startTime: draft.startTime,
        endTime: draft.endTime,
        breakMinutes: draft.breakMinutes ? Number(draft.breakMinutes) : 0,
        isNightShift: draft.isNightShift,
      });
      setDraft(EMPTY);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "新增失敗");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveEdit(id: string) {
    try {
      await updateShift(id, {
        name: editDraft.name.trim(),
        startTime: editDraft.startTime,
        endTime: editDraft.endTime,
        breakMinutes: editDraft.breakMinutes ? Number(editDraft.breakMinutes) : 0,
        isNightShift: editDraft.isNightShift,
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
    }
  }

  async function onDelete(id: string) {
    if (!confirm("確定刪除此班別？")) return;
    try {
      await deleteShift(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  const fields = (d: Draft, set: (next: Draft) => void) => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label className={labelCls}>名稱</label>
        <input className={inputCls} value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} />
      </div>
      <div className="flex items-end gap-2">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={d.isNightShift}
            onChange={(e) => set({ ...d, isNightShift: e.target.checked })}
          />
          夜班
        </label>
      </div>
      <div>
        <label className={labelCls}>上班時間</label>
        <input
          type="time"
          className={inputCls}
          value={d.startTime}
          onChange={(e) => set({ ...d, startTime: e.target.value })}
        />
      </div>
      <div>
        <label className={labelCls}>下班時間</label>
        <input
          type="time"
          className={inputCls}
          value={d.endTime}
          onChange={(e) => set({ ...d, endTime: e.target.value })}
        />
      </div>
      <div>
        <label className={labelCls}>休息（分鐘）</label>
        <input
          type="number"
          min="0"
          className={inputCls}
          value={d.breakMinutes}
          onChange={(e) => set({ ...d, breakMinutes: e.target.value })}
        />
      </div>
    </div>
  );

  return (
    <>
      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">新增班別</h2>
        <form onSubmit={onCreate} className="space-y-4">
          {fields(draft, setDraft)}
          {formError && <ErrorText>{formError}</ErrorText>}
          <PrimaryButton type="submit" disabled={submitting}>
            {submitting ? "新增中…" : "新增班別"}
          </PrimaryButton>
        </form>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">班別列表</h2>
        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>尚無班別</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((s) => (
              <li key={s.id} className="py-3">
                {editingId === s.id ? (
                  <div className="space-y-3">
                    {fields(editDraft, setEditDraft)}
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveEdit(s.id)}
                        className="text-sm font-medium"
                        style={{ color: "var(--brand)" }}
                      >
                        儲存
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="text-sm text-gray-500 hover:underline"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-800">{s.name}</span>
                        {s.is_night_shift && (
                          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700">
                            夜班
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-sm text-gray-500 tabular-nums">
                        {hhmm(s.start_time)} – {hhmm(s.end_time)} · 休 {s.break_minutes} 分
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-3">
                      <button
                        onClick={() => {
                          setEditingId(s.id);
                          setEditDraft({
                            name: s.name,
                            startTime: hhmm(s.start_time),
                            endTime: hhmm(s.end_time),
                            breakMinutes: String(s.break_minutes),
                            isNightShift: s.is_night_shift,
                          });
                        }}
                        className="text-sm text-gray-600 hover:underline"
                      >
                        編輯
                      </button>
                      <button
                        onClick={() => onDelete(s.id)}
                        className="text-sm text-red-600 hover:underline"
                      >
                        刪除
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
