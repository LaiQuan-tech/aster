"use client";

/**
 * 後台「批次匯入」共用元件：列表卡片右上一顆小按鈕，點開底部面板走三步驟——
 *   ① 下載 Excel 範本 → ② 選擇填好的 .xlsx（立刻 dryRun 預檢，逐列列出錯誤）→ ③ 確認匯入。
 * 六個入口（打卡補登／排班／調薪／報到／建立帳號／假日清單）只差 kind 與文案；
 * 端點形狀在 lib/import-api.ts，顯示字串在 lib/import-view.ts，範本欄位一覽在 lib/import-kinds.ts。
 *
 * 業主指示：所有批次功能都改成「下載範本 → 填完上傳」，而且後台不要被大 textarea 佔版面。
 */
import { useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { BottomSheet, Button, InlineError, useToast, type ButtonSize } from "@/components/admin-ui";
import { apiDownload } from "@/lib/api-client";
import { fileToBase64 } from "@/lib/files";
import { importTemplateUrl, runImport, type ImportResponse } from "@/lib/import-api";
import { IMPORT_KINDS, type ImportKind } from "@/lib/import-kinds";
import {
  confirmImportLabel,
  errorLinesToShow,
  importDoneMessage,
  importErrorMessage,
  summarizeImport,
  templateFileName,
  validateImportFile,
} from "@/lib/import-view";

export interface BatchImportButtonProps {
  kind: ImportKind;
  /** 按鈕文字；也是範本檔名（匯入範本-{label}.xlsx）與面板預設標題。 */
  label: string;
  title?: string;
  /** 面板最上方的一段說明（選填）。 */
  description?: ReactNode;
  /** 每次呼叫 API 都一起送的 kind 專屬選項（例如 employees 的 dryRunInvite）；讀的是按下當下的值。 */
  options?: Record<string, unknown>;
  /** 匯入成功後呼叫（通常是重載列表）。 */
  onDone?: (res: ImportResponse) => void | Promise<void>;
  size?: ButtonSize;
  /** 放在「確認匯入」上方的額外控制項（例如 employees 的「只建帳號、不寄信」）。 */
  extra?: ReactNode;
  /** 匯入完成後若回傳內容，面板不關閉、改顯示該內容（例如 employees 的邀請結果表）。 */
  renderResult?: (res: ImportResponse) => ReactNode;
  className?: string;
}

type Phase = "pick" | "previewing" | "previewed" | "importing" | "done";

interface PickedFile {
  name: string;
  dataBase64: string;
}

export function BatchImportButton({
  kind,
  label,
  title,
  description,
  options,
  onDone,
  size = "sm",
  extra,
  renderResult,
  className,
}: BatchImportButtonProps) {
  const toast = useToast();
  const meta = IMPORT_KINDS[kind];
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("pick");
  const [downloading, setDownloading] = useState(false);
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setPhase("pick");
    setPicked(null);
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function openSheet() {
    reset();
    setOpen(true);
  }

  function close() {
    if (phase === "previewing" || phase === "importing") return;
    setOpen(false);
    reset();
  }

  async function onDownloadTemplate() {
    setError(null);
    setDownloading(true);
    try {
      await apiDownload(importTemplateUrl(kind), templateFileName(label));
    } catch (err) {
      setError(importErrorMessage(err, "下載範本失敗"));
    } finally {
      setDownloading(false);
    }
  }

  async function onPickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // 清掉 value，讓同一個檔案改完再選一次也會觸發 onChange。
    event.target.value = "";
    if (!file) return;
    setError(null);
    setPreview(null);
    const invalid = validateImportFile(file);
    if (invalid) {
      setPicked(null);
      setPhase("pick");
      setError(invalid);
      return;
    }
    setPhase("previewing");
    try {
      const dataBase64 = await fileToBase64(file);
      const next = { name: file.name, dataBase64 };
      setPicked(next);
      const res = await runImport(kind, { fileName: next.name, dataBase64, dryRun: true, options });
      setPreview(res);
      setPhase("previewed");
    } catch (err) {
      setPicked(null);
      setPhase("pick");
      setError(importErrorMessage(err, "預檢失敗"));
    }
  }

  async function onConfirm() {
    if (!picked || !preview || preview.valid === 0) return;
    setError(null);
    setPhase("importing");
    try {
      const res = await runImport(kind, { fileName: picked.name, dataBase64: picked.dataBase64, dryRun: false, options });
      toast.show(importDoneMessage(res), "success");
      await onDone?.(res);
      const node = renderResult?.(res);
      if (node) {
        setResult(res);
        setPhase("done");
        return;
      }
      setOpen(false);
      reset();
    } catch (err) {
      setPhase("previewed");
      setError(importErrorMessage(err));
    }
  }

  const busy = phase === "previewing" || phase === "importing";
  const shownErrors = preview ? errorLinesToShow(preview.errors) : null;

  return (
    <>
      <Button type="button" variant="secondary" size={size} className={className} onClick={openSheet}>
        {label}
      </Button>

      <BottomSheet open={open} onClose={close} title={title ?? label}>
        {phase === "done" && result ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-700">{importDoneMessage(result)}</p>
            {renderResult?.(result)}
            <Button type="button" variant="primary" size="lg" block onClick={close}>
              關閉
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            {description ? <p className="text-sm leading-6 text-gray-500">{description}</p> : null}

            <ol className="space-y-5">
              {/* ① 下載範本 */}
              <li className="flex gap-3">
                <StepBadge n={1} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm font-medium text-gray-800">下載 Excel 範本</p>
                  <p className="text-xs leading-5 text-gray-500">用 Excel 填好後回到這裡上傳；表頭與範例列請勿改動欄位順序，範例列請刪除。</p>
                  <Button type="button" variant="secondary" size="sm" loading={downloading} onClick={() => void onDownloadTemplate()}>
                    下載範本
                  </Button>
                </div>
              </li>

              {/* ② 選檔＋預檢 */}
              <li className="flex gap-3">
                <StepBadge n={2} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm font-medium text-gray-800">上傳填好的檔案</p>
                  <input
                    ref={fileRef}
                    id={inputId}
                    type="file"
                    accept=".xlsx"
                    className="hidden"
                    onChange={(event) => void onPickFile(event)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      loading={phase === "previewing"}
                      disabled={busy}
                      onClick={() => fileRef.current?.click()}
                    >
                      {phase === "previewing" ? "檢查中…" : picked ? "重新選擇檔案" : "選擇檔案"}
                    </Button>
                    {picked ? <span className="truncate text-xs text-gray-500">{picked.name}</span> : null}
                  </div>

                  {preview && shownErrors ? (
                    <div className="rounded-lg border border-gray-100 bg-gray-50 p-3" data-testid="import-preview">
                      <p className="text-sm font-medium text-gray-800">{summarizeImport(preview)}</p>
                      {shownErrors.lines.length > 0 ? (
                        <ul className="mt-2 max-h-56 space-y-1 overflow-auto text-xs leading-5 text-red-700">
                          {shownErrors.lines.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                          {shownErrors.remaining > 0 ? (
                            <li className="text-gray-500">還有 {shownErrors.remaining} 條</li>
                          ) : null}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>

              {/* ③ 確認匯入 */}
              <li className="flex gap-3">
                <StepBadge n={3} />
                <div className="min-w-0 flex-1 space-y-3">
                  <p className="text-sm font-medium text-gray-800">確認匯入</p>
                  {extra}
                  <Button
                    type="button"
                    variant="primary"
                    size="lg"
                    block
                    loading={phase === "importing"}
                    disabled={!preview || preview.valid === 0 || busy}
                    onClick={() => void onConfirm()}
                  >
                    {preview ? confirmImportLabel(preview) : "確認匯入"}
                  </Button>
                </div>
              </li>
            </ol>

            <InlineError>{error}</InlineError>

            <p className="border-t border-gray-100 pt-3 text-xs leading-5 text-gray-400">
              範本欄位：{meta.columns.join("、")}。{meta.note}
            </p>
          </div>
        )}
      </BottomSheet>
    </>
  );
}

function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ backgroundColor: "var(--brand)" }}
    >
      {n}
    </span>
  );
}
