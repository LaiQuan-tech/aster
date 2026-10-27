"use client";

/**
 * 設定 → 進階功能 →「重新開放已結算月份的人」（發薪鎖定，2026-10-11 業主拍板）。
 *
 * 月結（完成發薪並鎖定）後，只有**老闆**（tenants.features.approval.fallbackApproverEmpId）與**老闆指定的人**
 * （tenants.features.payroll.periodUnlockEmpIds）可以重新開放該月；HR 不在名單上就不能重新開放。
 * 老闆本人永遠可以，不必勾選；這裡是本租戶在職員工的勾選清單（含搜尋），**勾選即存**——與這頁其他卡同一套：
 * 先樂觀更新，再 PUT /api/tenant/settings，成功 invalidateBranding()＋toast，失敗回滾＋toast。
 *
 * **只有老闆（員工 id 等於 fallbackApproverEmpId）或 platform_admin 能改這份名單**（後端另外擋：名單有變更而呼叫者
 * 不是老闆 → 403 not_boss）；其他人看到唯讀清單與「只有老闆可以指定…」一句，後端回 403 not_boss 時也顯示同一句。
 * 讀名單、判斷誰能改的純函式與測試在 lib/payroll-periods-api.ts。
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, InlineError, Input, Pill, Skeleton, useToast } from "@/components/admin-ui";
import { getEmployees, saveTenantSettings, type Employee } from "@/lib/admin-api";
import { getBrandingCached, getMeCached, invalidateBranding } from "@/lib/ess-state";
import {
  UNLOCK_LIST_BOSS_ONLY_NOTE,
  UNLOCK_LIST_MAX,
  approvalBossEmpIdOf,
  canEditUnlockList,
  filterUnlockCandidates,
  periodUnlockEmpIdsOf,
  toggleUnlockEmpId,
  unlockCandidates,
  unlockListSaveErrorMessage,
} from "@/lib/payroll-periods-api";

interface Loaded {
  /** 老闆指定的人（小寫員工 id）。 */
  designated: string[];
  /** 老闆（找不到主管時的最後簽核人）；沒設定＝null。 */
  bossEmpId: string | null;
  employees: Employee[];
  /** 目前登入者。 */
  me: { id: string; role: string };
}

export function PeriodUnlockCard() {
  const toast = useToast();
  /** null＝尚未載入（載入中或失敗）；載入失敗時不開放勾選，免得拿不完整的名單去覆蓋。 */
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    // getBrandingCached 與同頁其他卡共用同一次請求（模組層快取＋in-flight 去重）。
    Promise.all([getBrandingCached(), getEmployees(), getMeCached()])
      .then(([brand, emps, me]) => {
        if (!active) return;
        setLoaded({
          designated: periodUnlockEmpIdsOf(brand.features),
          bossEmpId: approvalBossEmpIdOf(brand.features),
          employees: emps.employees,
          me: { id: me.id, role: me.role },
        });
      })
      .catch((err) => {
        if (active) setLoadError(err instanceof Error && err.message ? err.message : "載入失敗");
      });
    return () => {
      active = false;
    };
  }, []);

  const canEdit = loaded ? canEditUnlockList(loaded.me, loaded.bossEmpId) : false;
  const candidates = useMemo(
    () => (loaded ? unlockCandidates(loaded.employees, loaded.designated, loaded.bossEmpId) : []),
    [loaded],
  );
  const visible = useMemo(() => filterUnlockCandidates(candidates, keyword), [candidates, keyword]);
  const bossName = useMemo(() => {
    if (!loaded?.bossEmpId) return null;
    const boss = loaded.bossEmpId.toLowerCase();
    return loaded.employees.find((e) => e.id.toLowerCase() === boss)?.name ?? null;
  }, [loaded]);

  async function toggle(empId: string, enabled: boolean) {
    if (!loaded || saving || !canEdit) return;
    const prev = loaded.designated;
    const next = toggleUnlockEmpId(prev, empId, enabled);
    if (enabled && next.length > UNLOCK_LIST_MAX) {
      toast.show(`最多只能指定 ${UNLOCK_LIST_MAX} 人`, "error");
      return;
    }
    setLoaded({ ...loaded, designated: next }); // optimistic
    setSaving(true);
    try {
      await saveTenantSettings({ features: { payroll: { periodUnlockEmpIds: next } } });
      invalidateBranding();
      toast.show("已更新", "success");
    } catch (err) {
      setLoaded((cur) => (cur ? { ...cur, designated: prev } : cur)); // 回滾
      toast.show(unlockListSaveErrorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  }

  const loading = loaded === null && !loadError;

  return (
    <Card title="重新開放已結算月份的人">
      <p className="-mt-1 mb-3 text-sm text-gray-500">
        月結（完成發薪並鎖定）之後，只有老闆、平台管理員與老闆指定的人可以重新開放該月。老闆本人與平台管理員永遠可以；老闆可以在這裡額外指定幾位同仁；
        HR 不在名單上就不能重新開放。
      </p>

      {loadError && <InlineError className="mt-3">載入設定失敗：{loadError}（請重新整理後再試）</InlineError>}

      {loading ? (
        <Skeleton lines={5} />
      ) : loaded ? (
        <>
          {loaded.bossEmpId ? (
            <p className="mb-3 text-sm text-gray-600">
              老闆：<span className="font-medium text-gray-800">{bossName ?? "（找不到這位員工）"}</span>
            </p>
          ) : (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="note">
              尚未設定老闆：請先到
              <Link href="/admin/leave-types" className="mx-1 font-medium underline">
                假別與簽核流程
              </Link>
              設定「找不到主管時的簽核者」。沒有設定老闆時，只有平台管理員能調整這份名單。
            </p>
          )}

          {!canEdit && (
            <p className="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600" role="note" data-testid="unlock-boss-only-note">
              {UNLOCK_LIST_BOSS_ONLY_NOTE}
            </p>
          )}

          <Input
            type="search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜尋姓名或工號"
            aria-label="搜尋員工"
            className="mb-3"
          />

          {visible.length === 0 ? (
            <p className="py-3 text-sm text-gray-400">沒有符合的員工</p>
          ) : (
            <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-100" data-testid="unlock-candidates">
              {visible.map((c) => {
                const id = `period-unlock-${c.id}`;
                return (
                  <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                    <input
                      id={id}
                      type="checkbox"
                      checked={c.checked || c.isBoss}
                      disabled={!canEdit || saving || c.isBoss}
                      onChange={(e) => void toggle(c.id, e.target.checked)}
                      className="h-4 w-4 shrink-0 rounded border-gray-300 accent-[var(--brand)] disabled:opacity-60"
                    />
                    <label htmlFor={id} className={`min-w-0 flex-1 text-sm text-gray-800 ${canEdit && !c.isBoss ? "cursor-pointer" : ""}`}>
                      {c.name}
                      {c.empNo ? <span className="ml-1.5 text-xs text-gray-400">{c.empNo}</span> : null}
                    </label>
                    {c.isBoss && <Pill tone="brand">老闆（永遠可以）</Pill>}
                    {!c.active && <Pill tone="gray">已離職／停用</Pill>}
                  </li>
                );
              })}
            </ul>
          )}

          {saving && <p className="mt-2 text-xs text-gray-400">儲存中…</p>}
        </>
      ) : null}
    </Card>
  );
}
