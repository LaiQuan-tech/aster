"use client";

/**
 * 五種申請表單共用的小件：錯誤翻譯、事由欄、附件欄、HR 代同仁申請、送出列。
 * 表單本身各自一檔（LeaveForm／FixPunchForm／OvertimeForm／TripForm／PettyCashForm），
 * 只顯示該種類的欄位；送出一律交給頁面層的 `onSubmit(body, files, summary)`。
 */
import { useCallback, useId, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { getEmployees, type Employee } from "@/lib/admin-api";
import { friendlyError } from "@/lib/attendance-sheets-api";
import type { CreateRequestBody } from "@/lib/ess-api";
import { REASON_MAX, REQUEST_ERROR_MESSAGES, requestErrorCode } from "@/lib/request-forms";
import { Button, Field, Icon, InlineError, Select, Textarea } from "@/components/ess-ui";

/* ------------------------------------------------------------ 錯誤 --- */

/** 申請頁專屬錯誤碼優先，其餘沿用出勤月表那套 friendlyError（unauthorized／forbidden…）。 */
export function describeError(err: unknown, fallback: string): string {
  const code = requestErrorCode(err);
  if (code && REQUEST_ERROR_MESSAGES[code]) return REQUEST_ERROR_MESSAGES[code];
  return friendlyError(err, fallback);
}

/* ------------------------------------------------------------ 附件 --- */

export const MAX_FILES = 3;
export const MAX_FILE_BYTES = 3 * 1024 * 1024;

export function validateFiles(files: File[]): string | null {
  if (files.length > MAX_FILES) return `附件最多 ${MAX_FILES} 個`;
  if (files.some((f) => f.size > MAX_FILE_BYTES)) return "附件單檔限 3 MB";
  return null;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentField({
  files,
  onChange,
  required,
  error,
  hint,
  label = "附件",
}: {
  files: File[];
  onChange: (files: File[]) => void;
  required?: boolean;
  error?: string;
  hint?: string;
  label?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    // 允許分次選：合併後最多 MAX_FILES 個（超過的丟掉並由 validateFiles 提示）。
    const merged = [...files, ...picked].slice(0, MAX_FILES);
    onChange(merged);
    event.target.value = "";
  };

  return (
    <Field
      label={label}
      required={required}
      htmlFor={id}
      error={error}
      hint={hint ?? `最多 ${MAX_FILES} 個，單檔 3 MB（照片或 PDF）`}
    >
      <input
        id={id}
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,application/pdf"
        className="sr-only"
        onChange={onPick}
      />
      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center justify-between gap-3 rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-700"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon name="paperclip" className="h-4 w-4 shrink-0 text-gray-400" />
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 text-xs text-gray-400">{fmtBytes(f.size)}</span>
              </span>
              <button
                type="button"
                className="shrink-0 text-xs text-red-600 hover:underline"
                onClick={() => onChange(files.filter((_, idx) => idx !== i))}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length < MAX_FILES && (
        <Button type="button" variant="secondary" size="md" block onClick={() => inputRef.current?.click()}>
          <Icon name="paperclip" className="h-4 w-4" />
          {files.length === 0 ? "選擇檔案" : "再加一個"}
        </Button>
      )}
    </Field>
  );
}

/* ------------------------------------------------------------ 事由 --- */

export function ReasonField({
  value,
  onChange,
  required,
  label = "事由",
  placeholder,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  label?: string;
  placeholder?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <Field label={label} required={required} htmlFor={id} hint={hint}>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={REASON_MAX}
        rows={2}
        className="min-h-20"
        placeholder={placeholder ?? (required ? "必填" : "選填")}
      />
    </Field>
  );
}

/* ------------------------------------------------- HR 代同仁申請 --- */

export interface ProxyState {
  /** 是否顯示（isAdmin）。 */
  enabled: boolean;
  expanded: boolean;
  employees: Employee[];
  loading: boolean;
  error: string | null;
  /** 被代申請的員工 id；空字串＝本人。 */
  value: string;
  toggle: () => void;
  setValue: (id: string) => void;
}

/** HR 才有的「代同仁申請」：收合狀態只顯示一行開關；展開時才抓員工清單（只抓一次）。 */
export function useProxy(enabled: boolean, selfId: string | null | undefined): ProxyState {
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const fetched = useRef(false);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (!next) setValue("");
      return next;
    });
    if (fetched.current) return;
    fetched.current = true;
    setLoading(true);
    getEmployees()
      .then((res) => setRaw(res.employees ?? []))
      .catch((err) => setError(describeError(err, "載入員工清單失敗")))
      .finally(() => setLoading(false));
  }, []);

  // 自己與已離職的不列；/me 可能比員工清單晚到，所以在 render 期過濾而不是抓回來時。
  const employees = useMemo(
    () =>
      raw
        .filter((e) => e.id !== selfId && !e.terminated_at && e.status !== "terminated")
        .sort((a, b) => (a.emp_no ?? "").localeCompare(b.emp_no ?? "") || a.name.localeCompare(b.name, "zh-Hant")),
    [raw, selfId],
  );

  return { enabled, expanded, employees, loading, error, value, toggle, setValue };
}

export function ProxyPicker({ proxy }: { proxy: ProxyState }) {
  const id = useId();
  if (!proxy.enabled) return null;
  return (
    <div className="rounded-xl border border-dashed border-gray-200 px-3 py-2">
      <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={proxy.expanded} onChange={proxy.toggle} className="h-4 w-4 accent-[var(--brand)]" />
        代同仁申請（HR）
      </label>
      {proxy.expanded && (
        <div className="mt-2">
          <Field label="申請人" required htmlFor={id} error={proxy.error ?? undefined} hint="這張單會記在該同仁名下，並走他的簽核流程">
            <Select id={id} value={proxy.value} onChange={(e) => proxy.setValue(e.target.value)} disabled={proxy.loading}>
              <option value="">{proxy.loading ? "載入中…" : "請選擇同仁"}</option>
              {proxy.employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.emp_no ? `${emp.emp_no} ${emp.name}` : emp.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </div>
  );
}

/** 代申請已勾但沒選人 → 回錯誤字串；否則回 onBehalfOfEmployeeId（本人＝undefined）。 */
export function proxyTarget(proxy: ProxyState): { error: string } | { onBehalfOfEmployeeId: string | undefined } {
  if (proxy.enabled && proxy.expanded && !proxy.value) return { error: "請選擇要代為申請的同仁" };
  return { onBehalfOfEmployeeId: proxy.enabled && proxy.expanded && proxy.value ? proxy.value : undefined };
}

/* ------------------------------------------------------------ 送出 --- */

export type SubmitHandler = (body: CreateRequestBody, files: File[], summary: string) => Promise<void>;

/** 各表單的共同 props。 */
export interface FormCommonProps {
  /** `?date=` 或今天。 */
  initialDate: string;
  submitting: boolean;
  /** 頁面層（API）錯誤；表單自己的驗證錯誤放各自 state。 */
  submitError: string | null;
  onSubmit: SubmitHandler;
  proxy: ProxyState;
}

export function SubmitBar({
  submitting,
  error,
  label = "送出申請",
  children,
}: {
  submitting: boolean;
  error: string | null;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-3 pt-1">
      {children}
      <InlineError>{error}</InlineError>
      <Button type="submit" size="lg" block loading={submitting}>
        {submitting ? "送出中…" : label}
      </Button>
    </div>
  );
}

/** 表單的即時摘要列（「共 3 天 · 24 小時」那種）。 */
export function SummaryLine({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "red" | "amber" | "brand" }) {
  const cls =
    tone === "red"
      ? "text-red-600"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "brand"
          ? "font-medium text-gray-800"
          : "text-gray-500";
  return <p className={`text-sm ${cls}`}>{children}</p>;
}
