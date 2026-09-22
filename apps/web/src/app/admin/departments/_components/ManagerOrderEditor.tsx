"use client";

/**
 * 部門「主管」的有序多選編輯器（新增表單與編輯列共用）。
 * 上半是已選清單，每列「第 N 位（第 1 位＝小主管）· 姓名 · ↑ ↓ 移除」；下半是「新增主管」下拉（排除已選）。
 * 順序＝簽核順序（manager_hr 模式逐關簽核；manager 模式只取第 1 位）。
 * 純狀態邏輯在 `lib/manager-order.ts`（有單元測試），本檔只負責畫面與事件。
 */
import { inputCls } from "@/components/admin-ui";
import type { Employee } from "@/lib/admin-api";
import { add, moveDown, moveUp, positionLabel, remove } from "@/lib/manager-order";

export interface ManagerOrderEditorProps {
  /** 有序主管 id（index 0＝小主管）。 */
  value: readonly string[];
  onChange: (next: readonly string[]) => void;
  employees: readonly Employee[];
  /** 員工 id → 顯示字（「工號 · 姓名」）；查不到就顯示 id 前 8 碼。 */
  employeeName: (id: string) => string | undefined;
  /** 同頁有兩個編輯器（新增表單／編輯列）時用來區分 aria-label／data 屬性。 */
  idPrefix: string;
  disabled?: boolean;
}

const ICON_BUTTON =
  "inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-gray-200 bg-white px-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40";

export function ManagerOrderEditor({ value, onChange, employees, employeeName, idPrefix, disabled }: ManagerOrderEditorProps) {
  const selected = new Set(value);
  const available = employees.filter((employee) => !selected.has(employee.id));
  const nameOf = (id: string) => employeeName(id) ?? id.slice(0, 8);

  return (
    <div className="space-y-2" data-manager-editor={idPrefix}>
      {value.length === 0 ? (
        <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
          未指定主管——這個單位的申請會往上層單位找主管，都沒有時由備援簽核人（老闆）簽核。
        </p>
      ) : (
        <ol className="space-y-1.5" aria-label="主管順序">
          {value.map((id, index) => (
            <li key={id} className="flex flex-wrap items-center gap-2 rounded-md border border-gray-100 bg-gray-50 px-2 py-1.5 text-sm">
              <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-xs text-gray-500">{positionLabel(index)}</span>
              <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{nameOf(id)}</span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className={ICON_BUTTON}
                  aria-label={`${nameOf(id)} 往前一位`}
                  title="往前一位（變成更小的主管）"
                  disabled={disabled || index === 0}
                  onClick={() => onChange(moveUp(value, index))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={ICON_BUTTON}
                  aria-label={`${nameOf(id)} 往後一位`}
                  title="往後一位（變成更大的主管）"
                  disabled={disabled || index === value.length - 1}
                  onClick={() => onChange(moveDown(value, index))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={`${ICON_BUTTON} text-red-600`}
                  aria-label={`移除 ${nameOf(id)}`}
                  disabled={disabled}
                  onClick={() => onChange(remove(value, id))}
                >
                  移除
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <select
        className={inputCls}
        aria-label="新增主管"
        value=""
        disabled={disabled || available.length === 0}
        onChange={(event) => {
          const id = event.target.value;
          if (id) onChange(add(value, id));
        }}
      >
        <option value="">{available.length === 0 ? "沒有可新增的員工" : value.length === 0 ? "新增主管…" : "新增下一位主管…"}</option>
        {available.map((employee) => (
          <option key={employee.id} value={employee.id}>
            {nameOf(employee.id)}
          </option>
        ))}
      </select>
    </div>
  );
}
