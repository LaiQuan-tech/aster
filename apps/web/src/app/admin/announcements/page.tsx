"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Card, PrimaryButton, ErrorText, Empty, Pill, Segmented, inputCls, labelCls } from "@/components/admin-ui";
import { updateAnnouncement, deleteAnnouncement } from "@/lib/admin-api";
import {
  getAnnouncementYears,
  listAnnouncementsBy,
  publishAnnouncement,
  type AnnouncementListItem,
} from "@/lib/people-extras-api";

/**
 * 公告後台。
 *
 * M10：依**年度**分區查詢（租戶時區），年度內再依月份分組——規章與佈告放久了
 * 是一長串平鋪清單，客戶要的是「今年的」「去年的」分開看。
 *
 * W5：發佈時可勾「需簽收」，勾了就在發佈當下對全體在職員工建待簽列，
 * 「20 個人 5 個沒簽」的分母才成立（詳情頁看得到已簽／在職）。
 */

const ALL = "all";

function monthOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function groupByMonth(rows: AnnouncementListItem[]): Array<{ month: string; items: AnnouncementListItem[] }> {
  const map = new Map<string, AnnouncementListItem[]>();
  for (const row of rows) {
    const key = monthOf(row.created_at);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, items]) => ({ month, items }));
}

export default function AnnouncementsPage() {
  const [rows, setRows] = useState<AnnouncementListItem[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [requiresSignature, setRequiresSignature] = useState(false);
  const [isAdverseChange, setIsAdverseChange] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAnnouncementsBy(year === ALL ? {} : { year: Number(year) });
      setRows(res.announcements);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    getAnnouncementYears()
      .then((r) => setYears(r.years))
      .catch(() => setYears([]));
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setNotice(null);
    if (!title.trim() || !body.trim()) {
      setFormError("請輸入標題與內容");
      return;
    }
    setSubmitting(true);
    try {
      const res = await publishAnnouncement({
        title: title.trim(),
        body: body.trim(),
        requiresSignature,
        isAdverseChange: requiresSignature ? isAdverseChange : false,
      });
      setTitle("");
      setBody("");
      setRequiresSignature(false);
      setIsAdverseChange(false);
      if (res.seeded > 0) setNotice(`已發佈，並為 ${res.seeded} 位在職同仁建立待簽名單。`);
      await load();
      getAnnouncementYears().then((r) => setYears(r.years)).catch(() => null);
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

  const yearOptions = [
    { value: ALL, label: "全部" },
    ...years.map((y) => ({ value: String(y), label: `${y}` })),
  ];
  const groups = groupByMonth(rows);

  return (
    <>
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
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={requiresSignature}
                onChange={(e) => setRequiresSignature(e.target.checked)}
                className="mt-1"
              />
              <span>
                需簽收（規章類）
                <span className="block text-xs text-gray-400">
                  勾選後立刻為全體在職同仁建立待簽名單，詳情頁就看得出「誰還沒簽」。
                </span>
              </span>
            </label>
            {requiresSignature && (
              <label className="flex items-start gap-2 pl-6 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={isAdverseChange}
                  onChange={(e) => setIsAdverseChange(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  涉及勞動條件不利益變更
                  <span className="block text-xs text-gray-400">
                    原則上需勞工個別同意，詳情頁會顯示同意率。
                  </span>
                </span>
              </label>
            )}
          </div>
          {formError && <ErrorText>{formError}</ErrorText>}
          {notice && <p className="text-sm text-green-700">{notice}</p>}
          <PrimaryButton type="submit" disabled={submitting}>
            {submitting ? "發佈中…" : "發佈"}
          </PrimaryButton>
        </form>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-gray-500">公告列表</h2>
          {yearOptions.length > 1 && (
            <Segmented
              aria-label="年度"
              size="sm"
              className="w-auto"
              options={yearOptions}
              value={year}
              onChange={setYear}
            />
          )}
        </div>
        {error && (
          <div className="mb-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>{year === ALL ? "尚無公告" : `${year} 年沒有公告`}</Empty>
        ) : (
          groups.map((group) => (
            <section key={group.month} className="mb-4 last:mb-0">
              <h3 className="mb-1 text-xs font-medium text-gray-400">{group.month.replace("-", " 年 ")} 月</h3>
              <ul className="divide-y divide-gray-100">
                {group.items.map((a) => (
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
                          <h3 className="flex items-center gap-2 font-medium text-gray-800">
                            {a.title}
                            {a.requires_signature && <Pill tone="amber">需簽收</Pill>}
                          </h3>
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
            </section>
          ))
        )}
      </Card>
    </>
  );
}
