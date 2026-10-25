"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/admin-ui";
import { TODO_LIMIT, type HeadlineTile, type Load, type TodoIcon, type TodoItem, type Tone } from "@/lib/boss-dashboard";

/* 後台首頁的兩塊（頂部大數字／需要你處理）。資料由 page.tsx 讀好、lib/boss-dashboard.ts 算好傳進來，這裡只負責畫。 */

function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={["block animate-pulse rounded bg-slate-200/80", className].filter(Boolean).join(" ")} />;
}

const VALUE_TONE: Record<Tone, string> = {
  normal: "text-gray-900",
  attention: "text-amber-600",
  danger: "text-red-600",
};

/* ------------------------------------------------------- 頂部大數字 --- */

function Tile({ tile }: { tile: HeadlineTile }) {
  const body = (
    <>
      <p className="text-xs font-medium text-gray-500 sm:text-sm">{tile.label}</p>
      {tile.loading ? (
        <>
          <Skeleton className="mt-2 h-8 w-20" />
          <Skeleton className="mt-2 h-3 w-24" />
        </>
      ) : (
        <>
          <p className={`mt-1 truncate text-2xl font-semibold tabular-nums sm:text-3xl ${VALUE_TONE[tile.tone]}`}>{tile.value}</p>
          {tile.sub ? <p className="mt-1 truncate text-xs text-gray-500">{tile.sub}</p> : null}
          {tile.note ? <p className="mt-0.5 truncate text-xs text-gray-400">{tile.note}</p> : null}
        </>
      )}
    </>
  );
  const cls = "block min-w-0 rounded-xl border border-gray-100 bg-white p-4 shadow-sm";
  return tile.href && !tile.loading ? (
    <Link href={tile.href} className={`${cls} transition hover:border-gray-300 hover:shadow`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** 4 格（手機 2×2）；角色／scope 沒有的格子 lib 已經拿掉。 */
export function HeadlineGrid({ tiles }: { tiles: HeadlineTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <Tile key={t.key} tile={t} />
      ))}
    </div>
  );
}

/** 角色（/me）還不知道時的骨架：先佔 4 格，不閃版。 */
export function HeadlineSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-3 h-8 w-20" />
          <Skeleton className="mt-2 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------ 需要你處理 --- */

const ICON_PATHS: Record<TodoIcon, ReactNode> = {
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  approval: (
    <>
      <path d="M9 11l3 3 8-8" />
      <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  money: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  project: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v3M12 16.5h.01" />
    </>
  ),
};

function TodoRow({ item }: { item: TodoItem }) {
  const danger = item.tone === "danger";
  return (
    <li>
      <Link href={item.href} className="flex items-center gap-3 px-1 py-3 transition hover:bg-slate-50 sm:px-2">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${danger ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true" focusable="false">
            {ICON_PATHS[item.icon]}
          </svg>
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{item.text}</span>
        <span className={`shrink-0 text-sm font-semibold tabular-nums ${danger ? "text-red-600" : "text-gray-900"}`}>{item.count}</span>
        <span aria-hidden className="shrink-0 text-gray-300">
          →
        </span>
      </Link>
    </li>
  );
}

export function TodoList({
  items,
  state,
  incomplete,
}: {
  items: TodoItem[];
  state: Pick<Load<unknown>, "loading" | "error">;
  /** 有權限的欄位讀不到（lib todoDataIncomplete）：清單空時不能說「沒有待處理」。 */
  incomplete: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, TODO_LIMIT);
  const hidden = items.length - shown.length;
  return (
    <Card>
      <h2 className="text-base font-semibold text-gray-900">需要你處理</h2>
      {state.loading ? (
        <div className="mt-3 space-y-3">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      ) : items.length === 0 ? (
        state.error ? (
          <p className="mt-3 text-sm text-gray-400" title={state.error}>
            待處理事項暫時讀不到 —
          </p>
        ) : incomplete ? (
          <p className="mt-3 text-sm text-amber-700">部分資料讀不到，請稍後重新整理</p>
        ) : (
          <p className="mt-3 text-sm text-emerald-700">目前沒有待處理事項 ✓</p>
        )
      ) : (
        <>
          <ul className="mt-1 divide-y divide-gray-100">
            {shown.map((item) => (
              <TodoRow key={item.key} item={item} />
            ))}
          </ul>
          {hidden > 0 || expanded ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 text-xs font-medium hover:underline"
              style={{ color: "var(--brand)" }}
            >
              {expanded ? "收合" : `查看全部（還有 ${hidden} 項）`}
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}
