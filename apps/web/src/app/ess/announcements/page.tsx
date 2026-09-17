"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAnnouncements, recordAnnouncementView, type Announcement } from "@/lib/ess-api";
import { localDateKey } from "@/lib/ess-format";
import { Button, Card, EmptyState, InlineError, Pill, Skeleton } from "@/components/ess-ui";

/**
 * 公告頁 `/ess/announcements`（從舊首頁的「最新公告」區獨立出來；標題由 EssShell 路由表提供）。
 * 列表：標題、日期、需簽收 Pill、內文預設收合 3 行、點一下展開。
 *
 * 被動查閱紀錄（從舊首頁搬來）：mount 時只對**需簽收且尚未查閱**的現行版呼叫
 * `recordAnnouncementView`——伺服器只保留第一次，所以已查閱（viewed_at 有值）的不重打；
 * 舊 API 沒有 viewed_at（undefined）時視為未查閱照打。這是 log 不是「勾選同意」，失敗不影響畫面。
 */

function isUnviewed(a: Announcement): boolean {
  return a.viewed_at === null || a.viewed_at === undefined;
}

/** 內文夠長才顯示展開／收合提示（短內文本來就不會被夾到 3 行）。 */
function isLongBody(body: string): boolean {
  return body.length > 80 || (body.match(/\n/g)?.length ?? 0) >= 3;
}

function fmtDate(iso: string): string {
  const key = localDateKey(iso);
  return key ? key.replace(/-/g, "/") : "—";
}

function AnnouncementItem({ a }: { a: Announcement }) {
  const [open, setOpen] = useState(false);
  const long = isLongBody(a.body);
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="block w-full rounded-lg text-left active:bg-gray-50"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 text-base font-semibold text-gray-900">{a.title}</h3>
          {a.requires_signature && <Pill tone="amber">需簽收</Pill>}
        </div>
        <p className="mt-0.5 text-xs text-gray-400">{fmtDate(a.created_at)}</p>
        <p className={`mt-2 whitespace-pre-wrap text-sm text-gray-700 ${open ? "" : "line-clamp-3"}`}>{a.body}</p>
        {long && <span className="mt-1 inline-block text-xs text-gray-400">{open ? "收合" : "展開全文"}</span>}
      </button>
    </li>
  );
}

export default function AnnouncementsPage() {
  const [list, setList] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getAnnouncements();
      if (!activeRef.current) return;
      setList(res.announcements);
      for (const a of res.announcements) {
        if (a.requires_signature && a.current_version_id && isUnviewed(a)) {
          void recordAnnouncementView(a.current_version_id).catch(() => null);
        }
      }
    } catch (err) {
      if (!activeRef.current) return;
      setList((prev) => prev ?? []);
      setError(err instanceof Error && err.message ? err.message : "載入公告失敗");
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
    };
  }, [load]);

  return (
    <Card>
      {list === null ? (
        <Skeleton lines={4} />
      ) : error ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <InlineError>{error}</InlineError>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            重試
          </Button>
        </div>
      ) : list.length === 0 ? (
        <EmptyState title="目前沒有公告" hint="公司發布公告後會顯示在這裡" />
      ) : (
        <ul className="divide-y divide-gray-100">
          {list.map((a) => (
            <AnnouncementItem key={a.id} a={a} />
          ))}
        </ul>
      )}
    </Card>
  );
}
