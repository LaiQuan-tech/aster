"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, ErrorText, inputCls, labelCls } from "@/components/admin-ui";
import {
  deleteProject,
  humanizeProjectDeleteError,
  type ProjectDeleteBlocker,
  type ProjectDetail,
} from "@/lib/projects-ext-api";

/**
 * 刪除打錯（key 錯）的專案（2026-11-12）。放在專案頁最底下的「危險操作」區，只給老闆／platform_admin
 * （access.deleteProject；後端 DELETE /projects/:id 自己再驗一次權限與擋刪條件）。
 * 確認框要輸入該專案序號（沒有序號的案輸入專案名稱）才能按刪除；有實際資料時後端回 409，
 * 這裡列出原因並建議改用封存。成功後由 page.tsx 回列表。
 */
export function DeleteProjectCard({ project, onDeleted }: { project: ProjectDetail; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<ProjectDeleteBlocker[]>([]);

  const expected = (project.code ?? project.name).trim();
  const matches = typed.trim().toLowerCase() === expected.toLowerCase() && expected !== "";

  function close() {
    if (busy) return;
    setOpen(false);
    setTyped("");
    setError(null);
    setBlockers([]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    setBlockers([]);
    try {
      await deleteProject(project.id, typed.trim());
      setOpen(false);
      onDeleted();
    } catch (err) {
      const h = humanizeProjectDeleteError(err);
      setError(h.message);
      setBlockers(h.blockers);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3" data-testid="delete-project-card">
        <div>
          <h2 className="text-sm font-semibold text-red-700">危險操作：刪除專案</h2>
          <p className="mt-1 text-xs text-gray-500">
            只用於打錯（key 錯）、還沒有任何資料的空殼專案。刪除後列表與報表都不再出現，序號可重新使用。
            已有請款、入帳、工時、獎金等資料的專案不能刪，請改用「封存」。
          </p>
        </div>
        <Button variant="danger" size="sm" onClick={() => setOpen(true)} data-testid="delete-project-button">
          刪除專案
        </Button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-project-title"
          onClick={close}
        >
          <form
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            data-testid="delete-project-dialog"
          >
            <h2 id="delete-project-title" className="text-lg font-semibold text-red-700">
              刪除專案
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              即將刪除 <span className="font-medium text-gray-900">{project.code ?? "（無序號）"}</span>{" "}
              {project.name}。沒有收款、工時、獎金等資料的空期程、未簽約合約與副委託列會一併刪除。
            </p>
            <div className="mt-4">
              <label className={labelCls} htmlFor="delete-project-confirm">
                請輸入{project.code ? "專案序號" : "專案名稱"}「{expected}」以確認
              </label>
              <input
                id="delete-project-confirm"
                className={inputCls}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoFocus
                data-testid="delete-project-confirm-input"
              />
            </div>

            {error && (
              <div className="mt-3" role="alert">
                <ErrorText>{error}</ErrorText>
                {blockers.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs text-red-700" data-testid="delete-project-blockers">
                    {blockers.map((b) => (
                      <li key={b.key}>
                        {b.label}：{b.count} 筆
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={close} disabled={busy}>
                取消
              </Button>
              <Button type="submit" variant="danger" disabled={!matches || busy} loading={busy} data-testid="delete-project-submit">
                確認刪除
              </Button>
            </div>
          </form>
        </div>
      )}
    </Card>
  );
}
