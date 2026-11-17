"use client";

/**
 * 員工薪資頁下半部共用的精簡 UI 小元件（2026-11-17 業主：「UI 改簡單一點」）：
 *   • LinkButton：次要動作一律用文字連結樣式（「＋新增」「修改」），不畫框線。
 *   • InfoTip：標題旁的 ⓘ，滑過（title）或點一下展開說明，不佔版面；展開時以區塊顯示在標題下方，手機不會橫向捲動。
 *   • SectionRow：一行精簡列「標題 ⓘ　摘要　動作」，有內容才在下方展開。
 *   • Disclosure：可收合區塊（▸／▾），標題可帶筆數。
 * 只做呈現，不含任何資料邏輯。
 */
import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export const linkBtnCls = "text-sm font-medium hover:underline disabled:opacity-50 disabled:no-underline";
export const dangerLinkCls = "text-sm text-red-600 hover:underline";
/** 展開的新增／修改表單：只留左側細線，不用整塊底色與框。 */
export const formBoxCls = "my-2 border-l-2 border-gray-200 pl-3";

export function LinkButton({ className, style, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={`${linkBtnCls} ${className ?? ""}`} style={{ color: "var(--brand)", ...style }} {...rest} />;
}

export function InfoTip({ text, label = "說明" }: { text: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className="ml-1 align-middle text-xs text-gray-400 hover:text-gray-600"
        title={typeof text === "string" ? text : undefined}
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        ⓘ
      </button>
      {open && (
        <span id={id} role="note" className="mt-1 block basis-full text-xs font-normal text-gray-500">
          {text}
        </span>
      )}
    </>
  );
}

/**
 * 一行精簡列。`title`＋`tip`（ⓘ）＋`summary`（例：「無」「2 項・本月合計 3,000 元」）＋`actions`（文字連結）；
 * `children` 有東西才畫在下方（表單、清單）。
 */
export function SectionRow({
  title,
  tip,
  summary,
  actions,
  children,
  testId,
}: {
  title: ReactNode;
  tip?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <section className="py-3" data-testid={testId}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="flex flex-wrap items-baseline text-sm font-medium text-gray-700">
          {title}
          {tip && <InfoTip text={tip} />}
        </h3>
        {summary != null && <span className="min-w-0 text-sm text-gray-500">{summary}</span>}
        {actions && <span className="ml-auto flex flex-wrap items-baseline gap-x-3">{actions}</span>}
      </div>
      {children}
    </section>
  );
}

/** 可收合區塊；`defaultOpen` 預設收合。標題列可另放動作（例：＋新增）。 */
export function Disclosure({
  title,
  defaultOpen = false,
  actions,
  children,
  testId,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div data-testid={testId}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <button
          type="button"
          className="text-sm text-gray-700 hover:underline"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
        >
          {title} <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
        {open && actions && <span className="ml-auto flex flex-wrap items-baseline gap-x-3">{actions}</span>}
      </div>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

/** 精簡清單列：左邊主文字＋次要資訊（可換行），右邊動作。手機寬度自動換行，不需橫向捲動。 */
export function ListRow({ main, meta, actions, testId }: { main: ReactNode; meta?: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5" data-testid={testId}>
      <span className="min-w-0 break-words text-sm text-gray-800">
        {main}
        {meta && <span className="ml-2 text-xs text-gray-500">{meta}</span>}
      </span>
      {actions && <span className="flex shrink-0 gap-x-3">{actions}</span>}
    </li>
  );
}
