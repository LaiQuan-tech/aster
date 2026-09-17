"use client";

/**
 * ESS（員工前台）共用 UI 元件。所有 ESS 頁面只從這裡拿元件，不再各自寫 class 字串。
 *
 * 契約（名稱與 props 是其他工作包的依賴，改了要一起改）：
 *   Card、Button、Pill、EmptyState、Field、Input／Select／Textarea＋inputCls、
 *   Segmented、BottomSheet、ConfirmDialog、ToastProvider＋useToast、Icon、
 *   Skeleton、InlineError、SectionTitle。
 * 主色一律 `var(--brand)`（租戶品牌色，由 root layout／TenantBranding 注入）。
 * 手機優先：觸控目標 ≥ 44px、輸入框 16px 字避免 iOS 自動縮放。
 */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const noop = () => {};

/* ------------------------------------------------------------- Card --- */

export function Card({
  title,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  /** 右上角的動作（連結／小按鈕）。 */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx("rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-5", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title ? <h2 className="text-base font-semibold text-gray-800">{title}</h2> : <span />}
          {action && <div className="shrink-0 text-sm">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/* ----------------------------------------------------------- Button --- */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 撐滿寬度（手機主要動作）。 */
  block?: boolean;
  /** 顯示轉圈並 disabled。 */
  loading?: boolean;
}

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "text-white shadow-sm hover:brightness-95",
  secondary: "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
  danger: "bg-red-600 text-white hover:bg-red-700",
  ghost: "text-gray-600 hover:bg-gray-100",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-sm",
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-5 text-base",
};

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", block, loading, className, disabled, children, type = "button", style, ...rest },
  ref,
) {
  const brand: CSSProperties | undefined = variant === "primary" ? { backgroundColor: "var(--brand)", ...style } : style;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60",
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        block && "w-full",
        className,
      )}
      style={brand}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

/* ------------------------------------------------------------- Pill --- */

export type PillTone = "gray" | "green" | "amber" | "red" | "blue" | "brand";

const PILL_TONE: Record<PillTone, string> = {
  gray: "bg-gray-100 text-gray-600",
  green: "bg-green-50 text-green-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
  blue: "bg-blue-50 text-blue-700",
  brand: "",
};

const BRAND_PILL_STYLE: CSSProperties = {
  color: "var(--brand)",
  backgroundColor: "color-mix(in srgb, var(--brand) 12%, white)",
};

export function Pill({ tone, children, className }: { tone: PillTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium",
        PILL_TONE[tone],
        className,
      )}
      style={tone === "brand" ? BRAND_PILL_STYLE : undefined}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------- EmptyState --- */

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center">
      <p className="text-base font-medium text-gray-700">{title}</p>
      {hint && <p className="text-sm text-gray-400">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ Field --- */

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  /** 有值就顯示紅字（role=alert）並取代 hint。 */
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
        {label}
        {required && (
          <span className="ml-0.5 text-red-500" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-gray-400">{hint}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------- Input / Select … --- */

/** 表單控制項共用 class（focus ring 用品牌色；`aria-invalid="true"` 變紅框）。 */
export const inputCls =
  "block w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--brand)] disabled:bg-gray-50 disabled:text-gray-500 aria-[invalid=true]:border-red-400 aria-[invalid=true]:ring-red-300 sm:text-sm";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(inputCls, className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(inputCls, "min-h-11 sm:min-h-10", className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx(inputCls, "min-h-24 resize-y", className)} {...rest} />;
});

/* -------------------------------------------------------- Segmented --- */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const idx = options.findIndex((o) => o.value === value);
    if (idx < 0 || options.length === 0) return;
    let next = idx;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (idx + 1) % options.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (idx - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    const target = options[next];
    if (!target) return;
    onChange(target.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cx("inline-flex w-full rounded-xl bg-gray-100 p-1", className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt.value)}
            className={cx(
              "flex-1 rounded-lg font-medium transition",
              size === "sm" ? "min-h-8 px-2 text-xs" : "min-h-10 px-3 text-sm",
              active ? "bg-white shadow-sm" : "text-gray-500 hover:text-gray-700",
            )}
            style={active ? { color: "var(--brand)" } : undefined}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------ BottomSheet --- */

/**
 * 手機（<lg）從底部滑出、桌機置中的 modal。Esc／點遮罩關閉、開著時鎖 body 捲動、
 * 開啟時把焦點移進面板、關閉還原。用 portal 掛在 body 上，避免被
 * sticky header 的 backdrop-filter 建立的 containing block 夾住。
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center lg:items-center lg:p-6" role="presentation">
      <div className="ess-fade-in absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className="ess-sheet-in safe-b relative flex max-h-[85dvh] w-full flex-col rounded-t-2xl bg-white shadow-2xl outline-none lg:max-h-[80vh] lg:max-w-lg lg:rounded-2xl"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-gray-300 lg:hidden" aria-hidden="true" />
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
          {title ? (
            <h2 id={titleId} className="text-base font-semibold text-gray-800">
              {title}
            </h2>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉"
            className="-mr-2 flex h-10 w-10 items-center justify-center rounded-full text-2xl leading-none text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-4 pb-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------- ConfirmDialog --- */

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "確定",
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  /** 破壞性動作（撤回、刪除）：確認鈕紅色。 */
  danger?: boolean;
  /** 送出中：確認鈕轉圈、取消與遮罩暫時無效。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <BottomSheet open={open} onClose={busy ? noop : onCancel} title={title}>
      {message && <div className="whitespace-pre-wrap text-sm leading-6 text-gray-600">{message}</div>}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button variant="secondary" size="lg" onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button variant={danger ? "danger" : "primary"} size="lg" onClick={onConfirm} loading={busy}>
          {confirmLabel}
        </Button>
      </div>
    </BottomSheet>
  );
}

/* ------------------------------------------------------------ Toast --- */

export type ToastTone = "success" | "error" | "info";

export interface ToastApi {
  show(message: string, tone?: ToastTone): void;
}

const TOAST_MS = 2_500;

const ToastContext = createContext<ToastApi | null>(null);

/** 沒有 ToastProvider 時的退化：只 console.warn，不 throw（測試／單獨渲染時不炸）。 */
const FALLBACK_TOAST: ToastApi = {
  show(message, tone = "info") {
    if (typeof console !== "undefined") console.warn(`[useToast] 沒有 ToastProvider（${tone}）：${message}`);
  },
};

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? FALLBACK_TOAST;
}

const TOAST_TONE: Record<ToastTone, string> = {
  success: "bg-green-600",
  error: "bg-red-600",
  info: "bg-gray-900",
};

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const show = useCallback((message: string, tone: ToastTone = "info") => {
    const id = ++seq.current;
    // 最多同時三則，舊的先掉。
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((list) => list.filter((t) => t.id !== id));
    }, TOAST_MS);
    timers.current.add(timer);
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="ess-toast-stack pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cx(
              "ess-fade-in pointer-events-auto max-w-full rounded-full px-4 py-2.5 text-sm font-medium text-white shadow-lg",
              TOAST_TONE[toast.tone],
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------- Icon --- */

export type IconName =
  | "clock"
  | "leave"
  | "stamp"
  | "bell"
  | "more"
  | "back"
  | "check"
  | "paperclip"
  | "chevron"
  | "logout";

const ICON_PATHS: Record<IconName, ReactNode> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  leave: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
      <path d="M9 15.5l2 2 4-4" />
    </>
  ),
  stamp: (
    <>
      <path d="M9 10V6a3 3 0 1 1 6 0v4" />
      <path d="M6 14a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3H6v-3z" />
      <path d="M5 21h14" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  more: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  back: <path d="M15 18l-6-6 6-6" />,
  check: <path d="M20 6L9 17l-5-5" />,
  paperclip: (
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
  chevron: <path d="M9 18l6-6-6-6" />,
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
};

/** inline SVG 圖示（stroke＝currentColor）。傳 className 時請自帶尺寸（預設 h-6 w-6）。 */
export function Icon({ name, className = "h-6 w-6" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/* --------------------------------------------------------- Skeleton --- */

export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cx("animate-pulse space-y-2.5", className)} aria-hidden="true">
      {Array.from({ length: Math.max(1, lines) }, (_, i) => (
        <div
          key={i}
          className={cx("h-4 rounded bg-gray-200", lines > 1 && i === lines - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------ InlineError --- */

export function InlineError({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className={cx("text-sm text-red-600", className)}>
      {children}
    </p>
  );
}

/* ----------------------------------------------------- SectionTitle --- */

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cx("text-base font-semibold text-gray-800", className)}>{children}</h2>;
}
