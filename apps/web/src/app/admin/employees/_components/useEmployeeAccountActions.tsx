"use client";

/**
 * 員工帳號動作（寄重設密碼信／設定密碼／暫時密碼／寄邀請信／停用／異動紀錄）——員工列表的「⋯」選單與員工內頁的
 * 「帳號」卡共用。原本整段寫在 admin/employees/page.tsx，2026-10-26 員工內頁上線後抽出來，兩邊行為一致。
 *
 * 顯示／disabled 規則仍在 lib/employee-actions.ts（employeeActionsFor）；這裡只負責「按了做什麼」與結果面板：
 *   - 邀請信／重設密碼信的結果（寄出，或 dryRun 時給連結複製）、暫時密碼（只顯示一次）→ `panels`（放在頁面上方）
 *   - 設定密碼的 BottomSheet、異動紀錄的 AuditDrawer → 也在 `panels` 裡（固定定位，放哪都一樣）
 * 成功／失敗訊息走 toast。"profile"（My Data）由呼叫端自己處理（列表就地展開、內頁連回列表），所以用 onOpenProfile 傳進來。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BottomSheet, Button, Card, Field, Input, inputCls, useToast } from "@/components/admin-ui";
import AuditDrawer from "@/components/AuditDrawer";
import { deactivateEmployee, resetEmployeePassword } from "@/lib/admin-api";
import { accountErrorMessage, sendEmployeeInvite, sendEmployeeReset, type AccountLinkResult } from "@/lib/auth-api";
import { generateRandomPassword, type EmployeeActionKey } from "@/lib/employee-actions";
import { describeEmployeeError } from "@/lib/employee-errors";

export interface AccountActionTarget {
  id: string;
  name: string;
}

export interface UseEmployeeAccountActionsOptions {
  /** 動作改到員工資料後（寄邀請信可能綁定帳號、停用改狀態）要重新載入。 */
  onChanged: () => Promise<void> | void;
  /** 「My Data」項目。沒給就不處理。 */
  onOpenProfile?: (target: AccountActionTarget) => void;
}

export function useEmployeeAccountActions({ onChanged, onOpenProfile }: UseEmployeeAccountActionsOptions) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  // 帳號信件結果（單筆）：寄出／dryRun 連結／備援暫時密碼，取代原本的 window.alert 明碼。
  const [linkResult, setLinkResult] = useState<{ empName: string; result: AccountLinkResult } | null>(null);
  const [tempPassword, setTempPassword] = useState<{ empName: string; password: string } | null>(null);
  // 「設定密碼」面板：HR 直接指定一組密碼（API 帶 password 的 reset-password）。
  // done 有值＝已成功，面板改顯示那組密碼讓 HR 抄給同仁（比照「暫時密碼」結果卡）。
  const [setPwTarget, setSetPwTarget] = useState<AccountActionTarget | null>(null);
  const [setPwValue, setSetPwValue] = useState("");
  const [setPwShow, setSetPwShow] = useState(false);
  const [setPwError, setSetPwError] = useState<string | null>(null);
  const [setPwBusy, setSetPwBusy] = useState(false);
  const [setPwDone, setSetPwDone] = useState<{ empName: string; password: string } | null>(null);
  const setPwInputRef = useRef<HTMLInputElement>(null);
  // 面板開啟時把焦點放進密碼框。不能用 autoFocus：BottomSheet 開啟時會在自己的 effect 裡 focus 面板
  // （比 autoFocus 晚），這裡的 effect 屬於父層、跑在它之後，才搶得回來。
  useEffect(() => {
    if (setPwTarget && !setPwDone) setPwInputRef.current?.focus();
  }, [setPwTarget, setPwDone]);
  // C1 稽核：右側抽屜顯示該員工 employees 列的異動時間線
  const [auditTarget, setAuditTarget] = useState<AccountActionTarget | null>(null);

  async function reload() {
    try {
      await onChanged();
    } catch {
      // 重載失敗由呼叫端自己的載入流程顯示；動作本身已成功
    }
  }

  async function onDeactivate(target: AccountActionTarget) {
    if (!window.confirm(`確定停用「${target.name}」？`)) return;
    setBusyId(target.id);
    try {
      await deactivateEmployee(target.id);
      toast.show(`已停用 ${target.name}`, "success");
      await reload();
    } catch (err) {
      toast.show(describeEmployeeError(err, "停用失敗"), "error");
    } finally {
      setBusyId(null);
    }
  }

  async function onSendInvite(target: AccountActionTarget) {
    const { id, name: empName } = target;
    setBusyId(id);
    try {
      let res: AccountLinkResult;
      try {
        res = await sendEmployeeInvite(id);
      } catch (err) {
        // 員工沒 Email（My Data 未填）→ 讓 HR 直接輸入要寄的信箱再試一次。
        // email_required：老闆／HR 管理員／平台管理員／老闆指定的人，邀請信的收件信箱一律要明確輸入（My Data 的信箱 HR 改得動，
        // 照那個信箱寄，連結會落到改信箱的人手上）。
        const message = err instanceof Error ? err.message : "";
        const missing = message.includes("no_email") ? "no_email" : message.includes("email_required") ? "email_required" : null;
        if (!missing) throw err;
        const typed = window.prompt(
          missing === "email_required"
            ? `「${empName}」是老闆、HR、平台管理員或老闆指定的人，寄邀請信前請明確輸入收件信箱（不使用 My Data 裡的信箱）：`
            : `「${empName}」尚未有 Email，請輸入要寄送邀請信的信箱：`,
          "",
        );
        if (!typed || !typed.trim()) return;
        res = await sendEmployeeInvite(id, { email: typed.trim() });
      }
      setTempPassword(null);
      setLinkResult({ empName, result: res });
      toast.show(
        res.dryRun
          ? `未寄信（API 尚未設定寄信金鑰），請複製連結轉交 ${empName}`
          : `已寄出${res.type === "recovery" ? "重設密碼信" : "邀請信"}給 ${empName}（${res.email}）`,
        "success",
      );
      await reload();
    } catch (err) {
      toast.show(accountErrorMessage(err, "寄送邀請信失敗"), "error");
    } finally {
      setBusyId(null);
    }
  }

  async function onSendReset(target: AccountActionTarget) {
    const { id, name: empName } = target;
    setBusyId(id);
    try {
      const res = await sendEmployeeReset(id);
      setTempPassword(null);
      setLinkResult({ empName, result: res });
      toast.show(
        res.dryRun ? `未寄信（API 尚未設定寄信金鑰），請複製連結轉交 ${empName}` : `已寄出重設密碼信給 ${empName}（${res.email}）`,
        "success",
      );
    } catch (err) {
      toast.show(describeEmployeeError(err, "寄送重設密碼信失敗"), "error");
    } finally {
      setBusyId(null);
    }
  }

  /** 備援：寄不了信時由系統產生暫時密碼（員工首次登入會被強制改密碼）。 */
  async function onTempPassword(target: AccountActionTarget) {
    const { id, name: empName } = target;
    if (!window.confirm(`為「${empName}」產生一組暫時密碼？\n（正常情況請用「寄重設密碼信」；此為寄不了信時的備援）`)) return;
    setBusyId(id);
    try {
      const res = await resetEmployeePassword(id);
      setLinkResult(null);
      if (res.password) {
        setTempPassword({ empName, password: res.password });
        toast.show(`已為 ${empName} 產生暫時密碼（只顯示這一次）`, "success");
      }
    } catch (err) {
      toast.show(describeEmployeeError(err, "產生暫時密碼失敗"), "error");
    } finally {
      setBusyId(null);
    }
  }

  /** 開「設定密碼」面板（選單只在有 user_id 時顯示這個動作；沒帳號的員工走寄邀請信）。 */
  function openSetPassword(target: AccountActionTarget) {
    setSetPwTarget({ id: target.id, name: target.name });
    setSetPwValue("");
    setSetPwShow(false);
    setSetPwError(null);
    setSetPwDone(null);
  }

  function closeSetPassword() {
    if (setPwBusy) return;
    setSetPwTarget(null);
    setSetPwValue("");
    setSetPwDone(null);
    setSetPwError(null);
  }

  /** 送出：API 依租戶開關決定走 GoTrue（太常見的密碼會 422）或直接寫 auth.users；成功後同仁下次登入須改密碼。 */
  async function confirmSetPassword() {
    if (!setPwTarget || setPwBusy) return;
    const password = setPwValue;
    if (password.length < 8) {
      setSetPwError("密碼至少 8 碼");
      return;
    }
    setSetPwBusy(true);
    setBusyId(setPwTarget.id);
    setSetPwError(null);
    try {
      await resetEmployeePassword(setPwTarget.id, password);
      setSetPwDone({ empName: setPwTarget.name, password });
      setSetPwValue("");
      toast.show(`已設定 ${setPwTarget.name} 的密碼`, "success");
    } catch (err) {
      setSetPwError(describeEmployeeError(err, "設定密碼失敗"));
    } finally {
      setSetPwBusy(false);
      setBusyId(null);
    }
  }

  async function copyText(text: string, what = "連結") {
    try {
      await navigator.clipboard.writeText(text);
      toast.show(`已複製${what}`, "success");
    } catch {
      toast.show(`無法自動複製，請手動選取${what}`, "error");
    }
  }

  /** 「⋯」選單／帳號卡的項目 → 各自的 handler（顯示規則在 lib/employee-actions.ts）。 */
  function run(key: EmployeeActionKey, target: AccountActionTarget) {
    switch (key) {
      case "profile":
        onOpenProfile?.(target);
        break;
      case "send-reset":
        void onSendReset(target);
        break;
      case "set-password":
        openSetPassword(target);
        break;
      case "temp-password":
        void onTempPassword(target);
        break;
      case "send-invite":
        void onSendInvite(target);
        break;
      case "deactivate":
        void onDeactivate(target);
        break;
      case "audit":
        setAuditTarget({ id: target.id, name: target.name });
        break;
    }
  }

  const panels: ReactNode = (
    <>
      {linkResult && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium text-gray-500">
                {linkResult.result.type === "recovery" ? "重設密碼信" : "邀請信"} — {linkResult.empName}（{linkResult.result.email}）
              </h2>
              {linkResult.result.dryRun && linkResult.result.link ? (
                <>
                  <p className="mt-1 text-sm text-amber-700">
                    API 尚未設定寄信金鑰（RESEND_API_KEY），信件沒有寄出。請複製下方連結用 LINE／口頭轉交給同仁，連結 24 小時內有效、只能用一次。
                  </p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input readOnly className={`${inputCls} font-mono text-xs`} value={linkResult.result.link} onFocus={(event) => event.currentTarget.select()} />
                    <Button variant="secondary" className="shrink-0" onClick={() => void copyText(linkResult.result.link ?? "")}>
                      複製連結
                    </Button>
                  </div>
                </>
              ) : (
                <p className="mt-1 text-sm text-gray-600">已寄出，請同仁收信後點連結設定密碼（連結 24 小時內有效）。</p>
              )}
            </div>
            <button type="button" onClick={() => setLinkResult(null)} className="text-sm text-gray-400 hover:underline">關閉</button>
          </div>
        </Card>
      )}

      {tempPassword && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium text-gray-500">暫時密碼 — {tempPassword.empName}</h2>
              <p className="mt-1 text-sm text-amber-700">只顯示這一次。請複製後轉交同仁；同仁首次登入會被要求改成自己的密碼。</p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input readOnly className={`${inputCls} font-mono`} value={tempPassword.password} onFocus={(event) => event.currentTarget.select()} />
                <Button variant="secondary" className="shrink-0" onClick={() => void copyText(tempPassword.password, "密碼")}>
                  複製密碼
                </Button>
              </div>
            </div>
            <button type="button" onClick={() => setTempPassword(null)} className="text-sm text-gray-400 hover:underline">關閉</button>
          </div>
        </Card>
      )}

      {auditTarget && (
        <AuditDrawer
          table="employees"
          recordId={auditTarget.id}
          title={`${auditTarget.name} 的異動紀錄`}
          onClose={() => setAuditTarget(null)}
        />
      )}

      <BottomSheet open={setPwTarget !== null} onClose={closeSetPassword} title="設定密碼">
        {setPwTarget && setPwDone && (
          <div className="space-y-4" data-testid="set-password-done">
            <p className="text-sm leading-6 text-gray-600">
              已設定 <span className="font-medium text-gray-800">{setPwDone.empName}</span> 的密碼。只顯示這一次，請複製後轉交同仁；
              同仁下次登入會被要求改成自己的密碼，舊裝置的登入已失效。
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                readOnly
                aria-label="已設定的密碼"
                className={`${inputCls} font-mono`}
                value={setPwDone.password}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button variant="secondary" size="md" className="shrink-0" onClick={() => void copyText(setPwDone.password, "密碼")}>
                複製密碼
              </Button>
            </div>
            <Button variant="primary" size="lg" block onClick={closeSetPassword}>
              關閉
            </Button>
          </div>
        )}
        {setPwTarget && !setPwDone && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmSetPassword();
            }}
          >
            <p className="text-sm leading-6 text-gray-600">
              請輸入要配發給 <span className="font-medium text-gray-800">{setPwTarget.name}</span> 的密碼（至少 8 碼）。
              同仁下次登入會被要求自設新密碼；舊裝置的登入會失效。
            </p>
            <Field label="密碼" required htmlFor="employees-set-password-input" error={setPwError ?? undefined} hint="至少 8 碼。">
              <div className="flex gap-2">
                <Input
                  ref={setPwInputRef}
                  id="employees-set-password-input"
                  type={setPwShow ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={8}
                  className="font-mono"
                  value={setPwValue}
                  aria-invalid={setPwError ? "true" : undefined}
                  disabled={setPwBusy}
                  onChange={(event) => {
                    setSetPwValue(event.target.value);
                    if (setPwError) setSetPwError(null);
                  }}
                />
                <Button
                  variant="secondary"
                  size="md"
                  className="shrink-0"
                  aria-pressed={setPwShow}
                  onClick={() => setSetPwShow((show) => !show)}
                >
                  {setPwShow ? "隱藏" : "顯示"}
                </Button>
              </div>
            </Field>
            <Button
              variant="ghost"
              size="sm"
              disabled={setPwBusy}
              onClick={() => {
                // 產生後直接切成明碼，HR 才看得到要抄給同仁的是什麼。
                setSetPwValue(generateRandomPassword());
                setSetPwShow(true);
                setSetPwError(null);
              }}
            >
              產生隨機密碼
            </Button>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" size="lg" onClick={closeSetPassword} disabled={setPwBusy}>
                取消
              </Button>
              <Button type="submit" variant="primary" size="lg" loading={setPwBusy} disabled={setPwValue.length < 8}>
                設定密碼
              </Button>
            </div>
          </form>
        )}
      </BottomSheet>
    </>
  );

  /** 其他流程（列表的「新增員工帳號」不填密碼＝寄邀請信）也用同一張結果卡。 */
  function showLinkResult(empName: string, result: AccountLinkResult) {
    setTempPassword(null);
    setLinkResult({ empName, result });
  }

  return { busyId, run, panels, showLinkResult };
}
