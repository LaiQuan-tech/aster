"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Card, PageHeader, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  type Announcement,
} from "@/lib/admin-api";

export default function AnnouncementsPage() {
  const [rows, setRows] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAnnouncements();
      setRows(res.announcements);
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
    if (!title.trim() || !body.trim()) {
      setFormError("請輸入標題與內容");
      return;
    }
    setSubmitting(true);
    try {
      await createAnnouncement({ title: title.trim(), body: body.trim() });
      setTitle("");
      setBody("");
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "發佈失敗");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveEdit(id: string) {
    if (!editTitle.trim() || !editBody.trim()) return;
    try {
      await updateAnnouncement(id, { title: editTitle.trim(), body: editBody.trim() });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
    }
  }

  async function onDelete(id: string) {
    // 註銷理由必填：公告為勞資爭議證據，伺服器端為軟刪除，內容與理由都保留。
    const reason = window.prompt(
      "註銷此公告。公告不會被刪除，僅標記為已註銷並保留追溯。\n請輸入註銷理由（必填）：",
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError("註銷理由為必填");
      return;
    }
    try {
      await deleteAnnouncement(id, reason.trim());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "註銷失敗");
    }
  }

  return (
    <>
      <PageHeader title="公佈欄" desc="發佈內部公告" />

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">發佈公告</h2>
        <form onSubmit={onCreate} className="space-y-4">
          <div>
            <label className={labelCls}>標題</label>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>內容</label>
            <textarea
              rows={3}
              className={inputCls}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {formError && <ErrorText>{formError}</ErrorText>}
          <PrimaryButton type="submit" disabled={submitting}>
            {submitting ? "發佈中…" : "發佈"}
          </PrimaryButton>
        </form>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">公告列表</h2>
        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>尚無公告</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((a) => (
              <li key={a.id} className="py-4">
                {editingId === a.id ? (
                  <div className="space-y-3">
                    <input
                      className={inputCls}
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                    />
                    <textarea
                      rows={3}
                      className={inputCls}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveEdit(a.id)}
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
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-medium text-gray-800">{a.title}</h3>
                      <div className="flex shrink-0 gap-3">
                        <button
                          onClick={() => {
                            setEditingId(a.id);
                            setEditTitle(a.title);
                            setEditBody(a.body);
                          }}
                          className="text-sm text-gray-600 hover:underline"
                        >
                          編輯
                        </button>
                        <Link
                          href={`/admin/announcements/${a.id}`}
                          className="text-sm text-blue-600 hover:underline"
                        >
                          版本與簽收
                        </Link>
                        <button
                          onClick={() => onDelete(a.id)}
                          className="text-sm text-red-600 hover:underline"
                        >
                          註銷
                        </button>
                      </div>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{a.body}</p>
                    <time className="mt-1 block text-xs text-gray-400">
                      {new Date(a.created_at).toLocaleString("zh-TW")}
                    </time>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
