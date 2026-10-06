"use client";

/**
 * 可收放的卡片——後台所有「新增 X」表單共用（業主 2026-10-07：後台中所有新增的項目都要能收放）。
 *
 * - 預設收起，只剩一列標題；點整列展開，展開後再點一下收起。
 * - 收起只是 `hidden`，不卸載：填到一半的欄位、送出後的訊息都會保留。
 * - 表單送出成功後，頁面照舊清空欄位，但**不會自動收起**（方便連續新增）。
 * - 外觀直接用 admin-ui 的 Card（圓角／邊框／陰影／內距），標題字級同 Card 的 title，
 *   所以收起時看起來就是一張只剩標題列的卡。
 * - 標題列是一顆 button（鍵盤 Tab／Enter／Space 可操作），帶 `aria-expanded`／`aria-controls`；
 *   右側的「展開／收起」與箭頭只是視覺提示（aria-hidden），讀屏讀到的是標題＋展開狀態。
 *
 * 預設自己管開合（`defaultOpen`）；頁面需要在外面知道或控制開合時（例如收起時要把錯誤顯示在卡片外）
 * 傳 `open`＋`onOpenChange` 改成受控。
 */
import { useId, useState, type ReactNode } from "react";
import { Card } from "@/components/admin-ui";

export function CollapsibleCard({
  title,
  hint,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  className,
  children,
}: {
  title: ReactNode;
  /** 標題下的一行說明；只在展開時顯示，收起時畫面保持乾淨。 */
  hint?: ReactNode;
  /** 初始是否展開（非受控時用）。預設收起。 */
  defaultOpen?: boolean;
  /** 受控：傳了就以這個為準，點標題列只會呼叫 `onOpenChange`。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const panelId = useId();
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const open = controlledOpen ?? innerOpen;

  function toggle() {
    const next = !open;
    if (controlledOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  }

  return (
    <Card className={className}>
      {/* h2 往左右各縮 0.5rem，讓整列 hover 底色比文字寬一圈，文字仍與卡片內容對齊。 */}
      <h2 className="-mx-2 text-base font-semibold text-gray-800">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="group flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2 text-left hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] md:min-h-9"
        >
          <span className="min-w-0">{title}</span>
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center gap-1 text-sm font-normal text-gray-500 group-hover:text-gray-700"
          >
            {open ? "收起" : "展開"}
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-5 w-5 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
            >
              <path
                fillRule="evenodd"
                d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                clipRule="evenodd"
              />
            </svg>
          </span>
        </button>
      </h2>
      <div id={panelId} hidden={!open} className="mt-3">
        {hint ? <p className="mb-4 text-xs leading-relaxed text-gray-500">{hint}</p> : null}
        {children}
      </div>
    </Card>
  );
}
