"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { adminModulesOf, isAdminPathAllowed, roleNavOf } from "@/lib/admin-nav";
import { getBossSummary, getPendingRequestsCount, type BossSummary } from "@/lib/dashboard-api";
import { getGroupOverview } from "@/lib/group-overview-api";
import {
  headlineTiles,
  homeLinkModuleEnabled,
  homeViewerOf,
  todoDataIncomplete,
  todoItems,
  type GroupOverviewLite,
  type Load,
  type SummaryLoad,
} from "@/lib/boss-dashboard";
import type { ApiError } from "@/lib/api-client";
import { useEssState } from "@/lib/ess-state";
import { HeadlineGrid, HeadlineSkeleton, TodoList } from "./_home-sections";

/* -------------------------------------------------------------- 老闆首頁 -- */
// 2026-10-25 業主：「太複雜了，簡化他」→ 首頁只剩兩塊（老闆 10 秒看懂）：
//   1. 頂部 4 個大數字（手機 2×2），每格可點進詳細頁；
//   2. 「需要你處理」清單：只列數量 > 0 的項目，最多 6 行，其餘「查看全部」。
// 各公司列表、本月／本年切換、薪資欄、人事區、舊營運看板卡、功能分區（＝側欄，不重複）都移出首頁。
// 資料只打 1–2 支：GET /dashboard/boss-summary（全部角色，後端依角色裁切）＋ GET /group-overview（僅可看集團財務者）。
// 2026-10-26 依身分分版（lib homeViewerOf）：可看集團財務（老闆等）第 1 格本年收入；一般 HR 改待簽核／出勤異常等日常數字、
// 不打 /group-overview（避免 403）；會計維持現狀。老闆另有專屬待辦（獎金批次待核准、遲到說明待決定）排在清單最前。
// 每格各自降級（讀不到顯示「—」）；boss-summary 404（API 舊版）時待簽核退回只算假單。計算在 lib/boss-dashboard.ts。

function initLoad<T>(): Load<T> {
  return { loading: true, error: null, data: null };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "載入失敗";
}

export default function AdminOverview() {
  const essState = useEssState();
  const roleNav = useMemo(() => roleNavOf(essState.me?.role, essState.features), [essState.me?.role, essState.features]);
  const modules = useMemo(() => adminModulesOf(essState.features), [essState.features]);
  // 格子／清單連到的後台頁：角色開得了、且那一頁所屬模組有啟用（tenants.features.adminModules）才給連結。
  const linkOn = useMemo(
    () => (href: string) => isAdminPathAllowed({ pathname: href, roleNav, modules }) && homeLinkModuleEnabled(href, modules),
    [roleNav, modules],
  );
  // 載入 effect 只在掛載時跑一次；用 ref 讀「當下」的 linkOn（/me 走 AdminGate 的共用快取，掛載時多半已知）。
  const linkOnRef = useRef(linkOn);
  useEffect(() => {
    linkOnRef.current = linkOn;
  }, [linkOn]);

  const role = essState.me?.role ?? null;

  const [summary, setSummary] = useState<SummaryLoad>(initLoad<BossSummary>());
  const [pendingLeave, setPendingLeave] = useState<Load<number>>(initLoad<number>());
  const [overview, setOverview] = useState<Load<GroupOverviewLite>>(initLoad<GroupOverviewLite>());

  useEffect(() => {
    let active = true;
    getBossSummary()
      .then((data) => active && setSummary({ loading: false, error: null, data }))
      .catch((err) => {
        if (!active) return;
        const outdated = (err as ApiError | null)?.status === 404;
        setSummary({ loading: false, error: outdated ? null : errMsg(err), data: null, outdated });
        if (outdated && linkOnRef.current("/admin/approvals")) {
          getPendingRequestsCount()
            .then((count) => active && setPendingLeave({ loading: false, error: null, data: count }))
            .catch((e) => active && setPendingLeave({ loading: false, error: errMsg(e), data: null }));
        } else {
          setPendingLeave({ loading: false, error: null, data: null });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  // 首頁版本：/me.canSeeGroupFinancials 優先，沒有再看 boss-summary 的 scope.groupFinancials；還不知道 → null（骨架）。
  const canSeeGroupFinancials = (essState.me as unknown as { canSeeGroupFinancials?: boolean } | null)?.canSeeGroupFinancials;
  const viewer = useMemo(
    () => (essState.loaded ? homeViewerOf({ role, canSeeGroupFinancials, summary }) : null),
    [essState.loaded, role, canSeeGroupFinancials, summary],
  );
  const isGroupViewer = viewer === "group";

  // 本年收入：確定可看集團財務才打（看不到的人打 /group-overview 會 403，也不顯示這格）。
  useEffect(() => {
    if (!isGroupViewer) return;
    let active = true;
    getGroupOverview()
      .then((data) => active && setOverview({ loading: false, error: null, data }))
      .catch((err) => active && setOverview({ loading: false, error: errMsg(err), data: null }));
    return () => {
      active = false;
    };
  }, [isGroupViewer]);

  const tiles = useMemo(
    () => (viewer ? headlineTiles({ viewer, summary, overview, pendingLeave, linkOn }) : []),
    [viewer, summary, overview, pendingLeave, linkOn],
  );
  const items = useMemo(() => todoItems({ summary, pendingLeave, linkOn }), [summary, pendingLeave, linkOn]);
  const listState = summary.outdated ? pendingLeave : summary;
  const incomplete = useMemo(() => todoDataIncomplete({ summary, pendingLeave }), [summary, pendingLeave]);

  return (
    <>
      {viewer ? <HeadlineGrid tiles={tiles} /> : <HeadlineSkeleton />}
      <TodoList items={items} state={listState} incomplete={incomplete} />
    </>
  );
}
