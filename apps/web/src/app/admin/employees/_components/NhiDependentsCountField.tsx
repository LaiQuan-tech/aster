"use client";

/**
 * 員工資料頁「健保眷屬投保資料」上方的「眷屬人數（直接輸入）」欄（2026-11-17）。
 * 填了以此為準，留空＝依下方明細投保中的筆數；健保費計費上限 3 口。規則見 lib/nhi-dependents-count.ts。
 * reloadKey：明細投保中筆數或 id 串（父元件傳字串），變了才重讀「明細筆數／計算採用」；輸入框有未存修改時不覆蓋。
 * 2026-11-17 精簡版：主畫面只一行「健保眷屬：M 人（…）　修改」，點修改才出現人數輸入；明細（children）收合在下方。
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, ErrorText } from "@/components/admin-ui";
import { nhiHeadline } from "@/lib/payroll-panel-text";
import { formBoxCls, LinkButton, SectionRow } from "./payroll-ui";
import {
  getNhiDependentsCount,
  nhiCountErrorMessage,
  nhiCountSummary,
  nhiSaveNotices,
  NHI_COUNT_MAX,
  NHI_COUNT_MIN,
  parseNhiCountInput,
  saveNhiDependentsCount,
  type NhiDependentsCount,
} from "@/lib/nhi-dependents-count";

const inputCls =
  "w-24 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";

const asInput = (d: NhiDependentsCount) => (d.override == null ? "" : String(d.override));

export function NhiDependentsCountField({
  employeeId,
  reloadKey,
  detailCount,
  children,
}: {
  employeeId: string;
  reloadKey?: string | number;
  /** 明細總筆數（還沒讀到人數時顯示用）。 */
  detailCount: number;
  /** 收合的明細區（由父元件提供：清單＋新增表單）。 */
  children?: ReactNode;
}) {
  const inputId = useId();
  const formId = useId();
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState<NhiDependentsCount | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[] | null>(null);
  // 輸入框有未存的修改？（重讀時不覆蓋使用者正在打的值）
  const dirtyRef = useRef(false);

  useEffect(() => {
    dirtyRef.current = false;
    setValue("");
    setData(null);
    setNotices(null);
    setEditing(false);
  }, [employeeId]);

  useEffect(() => {
    let alive = true;
    getNhiDependentsCount(employeeId)
      .then((d) => {
        if (!alive) return;
        setData(d);
        if (!dirtyRef.current) setValue(asInput(d));
      })
      .catch((err) => alive && setError(nhiCountErrorMessage(err, "讀取")));
    return () => {
      alive = false;
    };
  }, [employeeId, reloadKey]);

  async function onSave(event: FormEvent) {
    event.preventDefault();
    const parsed = parseNhiCountInput(value);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    setNotices(null);
    try {
      const d = await saveNhiDependentsCount(employeeId, parsed.value);
      setData(d);
      dirtyRef.current = false;
      setValue(asInput(d));
      setNotices(nhiSaveNotices(d.impacts));
      setEditing(false);
    } catch (err) {
      setError(nhiCountErrorMessage(err, "儲存"));
    } finally {
      setSaving(false);
    }
  }

  const unavailable = data != null && !data.available;

  return (
    <SectionRow
      testId="nhi-dependents"
      title={nhiHeadline(data, detailCount)}
      tip="健保眷屬人數：直接輸入了就以它為準，留空＝依明細中「投保中」的筆數。員工自付健保費＝每人金額 ×（1＋眷屬數），眷屬超過 3 人以 3 人計（第 4 口起免繳）。"
      actions={
        !unavailable && (
          <LinkButton onClick={() => setEditing((v) => !v)} aria-expanded={editing} aria-controls={formId}>
            {editing ? "收合" : "修改"}
          </LinkButton>
        )
      }
    >
      {data?.override != null && (
        <p className="text-xs text-amber-700">目前以直接輸入的人數計費，明細僅供參考。</p>
      )}
      {unavailable && <p className="text-xs text-amber-700">資料庫尚未支援直接輸入人數，目前依明細計算。</p>}
      <div id={formId} hidden={!editing}>
        {/* noValidate：不用瀏覽器內建（英文／各家不一）的數字驗證，改由 parseNhiCountInput 給中文提示。 */}
        <form onSubmit={onSave} noValidate className={formBoxCls}>
          <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-gray-500">
            眷屬人數（直接輸入，填了以此為準；留空＝依明細）
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={inputId}
              className={inputCls}
              type="number"
              inputMode="numeric"
              min={NHI_COUNT_MIN}
              max={NHI_COUNT_MAX}
              step={1}
              value={value}
              onChange={(event) => {
                dirtyRef.current = true;
                setValue(event.target.value);
                setError(null);
                setNotices(null);
              }}
              placeholder="留空"
              disabled={unavailable}
              aria-invalid={error ? true : undefined}
            />
            <Button size="sm" type="submit" loading={saving} disabled={unavailable}>
              儲存
            </Button>
          </div>
          {data && <p className="mt-1 text-xs text-gray-500">{nhiCountSummary(data)}</p>}
        </form>
      </div>
      {notices && (
        <p className="text-xs text-green-700">
          已儲存
          {notices.length > 0 && <span className="text-amber-700">：{notices.join("；")}</span>}
        </p>
      )}
      {error && <ErrorText className="mt-1">{error}</ErrorText>}
      {children}
    </SectionRow>
  );
}
