"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton, inputCls } from "@/components/admin-ui";
import { CollapsibleCard } from "@/components/CollapsibleCard";
import type { ApiError } from "@/lib/api-client";
import {
  deleteOptionItem,
  getOptionList,
  humanizeOptionListError,
  invalidateOptionList,
  listOptionLists,
  putOptionList,
  type OptionListInfo,
} from "@/lib/option-lists-api";
import {
  OPTION_LABEL_MAX,
  buildPutItems,
  moveRow,
  newOptionRow,
  rowsFromDetail,
  validateOptionRows,
  type OptionRow,
} from "@/lib/option-lists-edit";

/**
 * 選項清單（2026-10-10）：後台各處「分類」類下拉的選項，管理員可自行新增、改名、調整順序、停用。
 * 目前只有「客戶分類」（客戶名冊的分類欄位）；之後廠商分類、學歷類別、職務異動類型…掛在同一套機制上，
 * 這一頁依後端登記表（GET /option-lists）逐份清單畫一張可收放的卡片，不用再改。
 * 風格比照「公司主體」頁：整批編輯、按「儲存」一次送出（PUT）、刪除走獨立的 DELETE。
 *
 * 規則：
 *   • 改名不影響舊資料（資料上存的是代碼，畫面才翻成名稱）。
 *   • 用過的選項不能刪（後端 `usage > 0`），改成「停用」：新單據的下拉不再出現，舊資料照常顯示原名稱。
 *     「停用」跟名稱、順序一樣是本地編輯、按「儲存」才送出。
 *   • 沒被用過的選項才有「刪除」——按下先確認，成功後重新載入（使用量以後端為準）。
 *   • 還沒存檔的新列只是本地的，「移除」就沒了。
 *   • 只列呼叫者能管理的清單（canManage）；順序＝上下移的位置，存檔時依位置寫成 10、20、30…
 */

/** 後端回這些代碼代表畫面上的使用量／項目已經過期，要重新載入。 */
const STALE_CODES = new Set(["option_in_use", "not_found"]);

export default function OptionListsPage() {
  const [lists, setLists] = useState<OptionListInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listOptionLists()
      .then((res) => {
        if (active) setLists(res.lists);
      })
      .catch((err) => {
        if (active) setError(humanizeOptionListError(err, "載入失敗"));
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!lists) {
    return (
      <Card>
        <Empty>載入中…</Empty>
      </Card>
    );
  }
  const manageable = lists.filter((list) => list.canManage);
  if (manageable.length === 0) {
    return (
      <Card>
        <Empty>目前沒有你可以管理的選項清單。</Empty>
      </Card>
    );
  }
  return (
    <>
      {manageable.map((info, index) => (
        <OptionListEditor key={info.key} info={info} defaultOpen={index === 0} />
      ))}
    </>
  );
}

function OptionListEditor({ info, defaultOpen }: { info: OptionListInfo; defaultOpen: boolean }) {
  const [rows, setRows] = useState<OptionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingCode, setDeletingCode] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** 畫面上有沒有尚未儲存的修改；刪除成功後會重新載入，要提醒這些修改會被重設。 */
  const [dirty, setDirty] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await getOptionList(info.key, { manage: true });
      setRows(rowsFromDetail(detail));
      setDirty(false);
    } catch (err) {
      setError(humanizeOptionListError(err, "載入失敗"));
    } finally {
      setLoading(false);
    }
  }, [info.key]);
  useEffect(() => {
    void load();
  }, [load]);

  function patch(key: string, p: Partial<OptionRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
    setDirty(true);
    setSavedAt(null);
  }
  function move(index: number, delta: -1 | 1) {
    setRows((rs) => moveRow(rs, index, delta));
    setDirty(true);
    setSavedAt(null);
  }
  function addRow() {
    seq.current += 1;
    setRows((rs) => [...rs, newOptionRow(`new-${Date.now()}-${seq.current}`)]);
    setDirty(true);
    setSavedAt(null);
  }
  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setDirty(true);
    setSavedAt(null);
  }

  async function save() {
    setSavedAt(null);
    const problem = validateOptionRows(rows);
    if (problem) {
      setError(problem);
      return;
    }
    const items = buildPutItems(rows);
    if (items.length === 0) {
      setError("沒有可以儲存的項目，請先新增一項並填上名稱。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const detail = await putOptionList(info.key, items);
      setRows(rowsFromDetail(detail));
      setDirty(false);
      setSavedAt(Date.now());
      // 客戶名冊等用到這份清單的畫面，下次取用（或現在就掛著的）會重抓。
      invalidateOptionList(info.key);
    } catch (err) {
      setError(humanizeOptionListError(err, "儲存失敗"));
    } finally {
      setSaving(false);
    }
  }

  /** 刪除一個從沒被用過的選項：先確認，成功後重新載入（使用量以後端為準）。 */
  async function remove(row: OptionRow) {
    if (!row.code) return;
    const unsaved = dirty ? "\n（畫面上尚未儲存的修改會一併重設）" : "";
    if (!confirm(`確定刪除「${row.label.trim() || row.code}」？刪除後無法復原。${unsaved}`)) return;
    setDeletingCode(row.code);
    setError(null);
    setSavedAt(null);
    try {
      await deleteOptionItem(info.key, row.code);
      invalidateOptionList(info.key);
      await load();
    } catch (err) {
      const message = humanizeOptionListError(err, "刪除失敗");
      // 使用量在這段時間變了：重新載入，畫面才不會繼續顯示過期的「刪除」鈕。
      if (STALE_CODES.has((err as ApiError).code ?? "")) await load();
      setError(message);
    } finally {
      setDeletingCode(null);
    }
  }

  const busy = saving || deletingCode !== null;

  return (
    <CollapsibleCard title={info.title} hint={info.description} defaultOpen={defaultOpen}>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}

      {loading ? (
        <Empty>載入中…</Empty>
      ) : rows.length === 0 ? (
        <Empty>還沒有任何項目，請新增一項。</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="py-2 pr-3">順序</th>
                <th className="py-2 pr-3">名稱 *</th>
                <th className="py-2 pr-3 text-center">停用</th>
                <th className="py-2 pr-3">使用狀況</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, index) => {
                const inactive = !r.isActive;
                const dim = inactive ? " opacity-60" : "";
                const name = r.label.trim() || "未命名";
                return (
                  <tr key={r.key} className={`border-b last:border-0${inactive ? " bg-gray-50" : ""}`} data-inactive={inactive ? "true" : undefined}>
                    <td className="whitespace-nowrap py-1.5 pr-3">
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                        disabled={busy || index === 0}
                        aria-label={`「${name}」往上移`}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                        disabled={busy || index === rows.length - 1}
                        aria-label={`「${name}」往下移`}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                    </td>
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center gap-2">
                        <input
                          className={`${inputCls}${dim}`}
                          value={r.label}
                          maxLength={OPTION_LABEL_MAX}
                          placeholder="選項名稱"
                          aria-label="選項名稱"
                          onChange={(e) => patch(r.key, { label: e.target.value })}
                        />
                        {inactive && <span className="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600">已停用</span>}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 text-center">
                      {r.code ? (
                        <input
                          type="checkbox"
                          checked={inactive}
                          title={inactive ? "取消停用（儲存後生效）" : "停用這個選項（儲存後生效）"}
                          aria-label={`停用「${name}」`}
                          onChange={() => patch(r.key, { isActive: inactive })}
                        />
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-gray-500">
                      {!r.code ? "尚未儲存" : r.usage > 0 ? `${r.usage} 筆資料使用中` : "尚未使用"}
                    </td>
                    <td className="py-1.5 text-right">
                      {!r.code ? (
                        <button type="button" className="text-xs text-gray-400 hover:text-red-600" onClick={() => removeRow(r.key)}>
                          移除
                        </button>
                      ) : r.usage > 0 ? (
                        <span className="text-xs text-gray-400">已被使用，無法刪除，可改為停用</span>
                      ) : (
                        <button
                          type="button"
                          className="text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => void remove(r)}
                        >
                          {deletingCode === r.code ? "刪除中…" : "刪除"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
        <button
          type="button"
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          disabled={busy || loading}
          onClick={addRow}
        >
          ＋ 新增一項
        </button>
        <PrimaryButton type="button" onClick={() => void save()} disabled={busy || loading}>
          {saving ? "儲存中…" : "儲存"}
        </PrimaryButton>
        {savedAt && <span className="text-sm text-green-700">已儲存</span>}
        <span className="text-xs text-gray-400">
          名稱、順序與停用都按「儲存」一次送出；改名不影響舊資料。沒被用過的選項可以直接刪除；用過的不能刪，可改為停用——
          停用後新單據的下拉不再出現，舊資料照常顯示原名稱。
        </span>
      </div>
    </CollapsibleCard>
  );
}
