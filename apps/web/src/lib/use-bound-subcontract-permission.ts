"use client";
import { useEffect, useState } from "react";
import { getMeCached } from "@/lib/ess-state";

/**
 * 2026-11-17 S2 擴大（業主決定）：已綁定名冊廠商的副委託，解除／改綁／刪除只限老闆或平台管理員。
 * 讀 /me.canManageBoundSubcontracts（舊 API 沒有＝當作不能；後端 403 rebind_requires_boss／subcontract_delete_requires_boss 才是守門員）。
 */
export const BOUND_SUBCONTRACT_LOCKED_NOTE = "已綁定名冊廠商，解除／改綁／刪除需老闆或平台管理員";

/** 回 null＝還在載入（呼叫端顯示中性狀態、不畫鎖頭，避免老闆看到閃爍）；true／false＝已知。 */
export function useCanManageBoundSubcontracts(): boolean | null {
  const [can, setCan] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    getMeCached()
      .then((me) => alive && setCan((me as { canManageBoundSubcontracts?: boolean }).canManageBoundSubcontracts === true))
      .catch(() => alive && setCan(false));
    return () => {
      alive = false;
    };
  }, []);
  return can;
}
