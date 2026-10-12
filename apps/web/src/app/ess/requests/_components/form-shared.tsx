"use client";

/**
 * 六種申請表單共用的小件：錯誤翻譯、事由欄、附件欄、送出列。
 * 表單本身各自一檔（LeaveForm／FixPunchForm／OvertimeForm／TripForm），
 * 只顯示該種類的欄位；送出一律交給頁面層的 `onSubmit(body, files, summary)`。
 */
import { useId, useRef, type ChangeEvent, type ReactNode } from "react";
import { friendlyError } from "@/lib/attendance-sheets-api";
import type { CreateRequestBody } from "@/lib/ess-api";
import {
  EXPENSE_METHOD_FIELD_LABEL,
  REASON_MAX,
  attachmentTooLargeText,
  requestErrorText,
  type ExpenseMethod,
} from "@/lib/request-forms";
import {
  NETWORK_FAILURE_MESSAGE,
  UPLOAD_MAX_BYTES,
  isNetworkFailure,
  pickedFileError,
  pickedFilesError,
  uploadKindOf,
} from "@/lib/upload-prep";
import { Button, Field, Icon, InlineError, Textarea } from "@/components/ess-ui";

/* ------------------------------------------------------------ 錯誤 --- */

/** 認不得的錯誤給人看的說法：單獨顯示、或放在「附件「a.jpg」上傳失敗（…）」的括號裡都通順。 */
export const UNKNOWN_ERROR_MESSAGE = "系統暫時無法處理，請稍後再試";

/** 中文字、CJK 符號（、。「」）與全形標點（，：）：有任何一個，就當這句本來就是中文說明。 */
const HAS_CJK_RE = /[\u3000-\u9fff\uff00-\uffef]/;

/**
 * 申請頁的錯誤 → 中文（送出、撤回、上傳附件、「我的申請」補傳與載入都走這裡）：
 *   1. 連線本身失敗（Chrome「Failed to fetch」、Safari「Load failed」、Firefox「NetworkError…」）→ 中文，不露出英文；
 *   2. 附件太大（413）→ 照回應帶的上限寫「單檔限 N MB」（上限依租戶設定，不一定是 3 MB）；
 *   3. 申請頁專屬錯誤碼（含 409 period_closed →「YYYY-MM 已結算，請洽管理者」）；
 *   4. 其餘沿用出勤月表那套 friendlyError（unauthorized／forbidden…）；
 *   5. 以上都對不上（例如 `[500] internal_server_error`、英文的例外訊息）→ {@link UNKNOWN_ERROR_MESSAGE}，畫面不露出英文代碼，
 *      原始錯誤改記在 console。前端自己擋下的（UploadPrepError）等本來就是中文的訊息照舊原樣顯示。
 * `fallback` 只在丟出來的不是 Error（字串之類）或沒有訊息時用，各呼叫點（請假送出、附件補傳與撤回、載入申請）傳自己的中文說法。
 */
export function describeError(err: unknown, fallback: string): string {
  if (isNetworkFailure(err)) return NETWORK_FAILURE_MESSAGE;
  const text = attachmentTooLargeText(err) ?? requestErrorText(err) ?? friendlyError(err, fallback);
  // friendlyError 查不到對照時會把 Error.message 原樣丟回來；原樣又沒有半個中文字＝英文代碼，不上畫面。
  if (err instanceof Error && text === err.message && !HAS_CJK_RE.test(text)) {
    console.warn("[申請] 無法辨識的錯誤，畫面只顯示通用說法", err);
    return UNKNOWN_ERROR_MESSAGE;
  }
  return text;
}

/* ------------------------------------------------------------ 附件 --- */

export const MAX_FILES = 3;
/**
 * 不壓縮的附件（PDF、GIF…）單檔上限＝經 API 上傳的上限 3 MB（Vercel 請求上限，見 lib/upload-prep.ts）。
 * 照片不看原始大小：上傳前會先壓縮（ess-api uploadAttachment），選檔時只擋原檔超過 25 MB 的。
 */
export const MAX_FILE_BYTES = UPLOAD_MAX_BYTES;

export function validateFiles(files: File[]): string | null {
  if (files.length > MAX_FILES) return `附件最多 ${MAX_FILES} 個`;
  return pickedFilesError(files);
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
      hint={hint ?? `最多 ${MAX_FILES} 個；照片會自動壓縮，PDF 單檔 3 MB`}
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
          {files.map((f, i) => {
            // 選檔當下就標出過不了的檔（PDF 超過 3 MB、照片超過 25 MB、空檔）；送出時 validateFiles 會擋。
            const problem = pickedFileError(f);
            // 超過 3 MB 的照片會在上傳前壓縮，標註一下免得員工以為會被擋。
            const willShrink = !problem && uploadKindOf(f) === "compress" && f.size > MAX_FILE_BYTES;
            return (
              <li
                key={`${f.name}-${i}`}
                className={`rounded-xl px-3 py-2 text-sm text-gray-700 ${problem ? "bg-red-50" : "bg-gray-50"}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon name="paperclip" className="h-4 w-4 shrink-0 text-gray-400" />
                    <span className="truncate">{f.name}</span>
                    <span className="shrink-0 text-xs text-gray-400">
                      {fmtBytes(f.size)}
                      {willShrink ? "・上傳時自動壓縮" : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-red-600 hover:underline"
                    onClick={() => onChange(files.filter((_, idx) => idx !== i))}
                  >
                    移除
                  </button>
                </div>
                {problem && <p className="mt-1 text-xs text-red-600">{problem}</p>}
              </li>
            );
          })}
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

/* -------------------------------------------------------- 費用方式 --- */

/**
 * 費用方式二選一（2026-10-11，出差／公出／零用金共用）：
 *   ○ 先預支（核准後公司先撥款，回來核銷）　○ 自行墊付，回來報銷
 * 一組 radio（fieldset＋legend「費用方式」，每列觸控高度 44px）；選項下方的內容由 `children`
 * 放（例如「先預支」才出現的金額欄）。選項文字由表單傳入（出差說「出發前撥款」，零用金沒有出發）。
 */
export function ExpenseMethodField({
  value,
  onChange,
  labels,
  children,
}: {
  value: ExpenseMethod;
  onChange: (value: ExpenseMethod) => void;
  labels: Record<ExpenseMethod, string>;
  children?: ReactNode;
}) {
  const name = useId();
  const options: ExpenseMethod[] = ["advance", "self_paid"];
  return (
    <fieldset className="rounded-xl border border-gray-200 px-3 pb-3 pt-1">
      <legend className="px-1 text-sm font-medium text-gray-700">{EXPENSE_METHOD_FIELD_LABEL}</legend>
      <div className="space-y-0.5">
        {options.map((option) => (
          <label key={option} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-gray-700">
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="h-4 w-4 shrink-0 accent-[var(--brand)]"
            />
            <span>{labels[option]}</span>
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  );
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

/** 表單的即時摘要列（「共 1 天 7 時」那種）。 */
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
