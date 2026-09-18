"use client";

/**
 * 後台頁面的共用元件——2026-09 後台簡化後改成 ess-ui 的 re-export＋少量後台專用 shim，
 * 讓 54 頁在遷移前後都能編譯、視覺對齊員工端：
 *   - `PageHeader`：標題／說明改由 AdminShell 依 lib/admin-nav.ts 路由表渲染，這裡永遠回 null
 *     （尚未遷移的頁不會出現雙標題）；頁面遷移時直接刪掉 import 與用法。
 *   - `DetailHeading`：detail 頁（專案／匯款單／出勤月表／獎金批次）的動態標題＋說明＋右側動作。
 *   - `Card`／`PrimaryButton`／`ErrorText`／`Empty`／`inputCls`／`labelCls`：舊名稱保留，底層換成 ess-ui。
 * 新寫的頁面直接用 ess-ui 的名稱（Button／Field／Input／Segmented／useToast…），這裡都有 re-export。
 */
import type { ReactNode } from "react";
import { Button, Card as EssCard, InlineError, inputCls as essInputCls } from "@/components/ess-ui";

export {
  Button,
  Pill,
  EmptyState,
  Field,
  Input,
  Select,
  Textarea,
  Segmented,
  BottomSheet,
  ConfirmDialog,
  ToastProvider,
  useToast,
  Icon,
  Skeleton,
  InlineError,
  SectionTitle,
} from "@/components/ess-ui";
export type { ButtonProps, ButtonSize, ButtonVariant, PillTone, IconName, ToastTone } from "@/components/ess-ui";

export const inputCls = essInputCls;

export const labelCls = "block text-sm font-medium text-gray-700 mb-1";

/** ess-ui Card 加上後台桌機版的圓角／內距；`overflow-hidden` 讓寬表格在手機橫捲不撐破卡片。 */
export function Card({
  className,
  ...props
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return <EssCard {...props} className={["overflow-hidden md:rounded-xl md:p-6", className].filter(Boolean).join(" ")} />;
}

/** 標題／說明改由 AdminShell 依路由表渲染；保留給尚未遷移的頁，永遠不畫。 */
export function PageHeader(_props: { title: string; desc?: string }) {
  return null;
}

/** detail 頁的動態標題（h2）＋說明＋右側動作鈕（children）。 */
export function DetailHeading({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-lg font-bold text-gray-900 md:text-xl">{title}</h2>
        {desc ? <p className="mt-1 text-sm text-gray-500">{desc}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function PrimaryButton({
  children,
  type = "button",
  onClick,
  disabled,
}: {
  children: ReactNode;
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button type={type} variant="primary" onClick={onClick} disabled={disabled} className="w-full sm:w-auto md:min-h-10">
      {children}
    </Button>
  );
}

export const ErrorText = InlineError;

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-gray-400">{children}</p>;
}
