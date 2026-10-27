"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { isLeavingLinkClick } from "@/lib/unsaved-changes";

/**
 * 有未儲存的變更時，離開頁面前先確認（業主 2026-10-27：申請單表格）。
 *
 * - 關閉分頁／重新整理／打網址：beforeunload（瀏覽器自己的提示框，文字不能自訂）。
 * - 站內連結（側欄、頁首按鈕、任何 <a>）：document 捕獲階段攔下點擊，在 Next 的 Link 處理之前；
 *   確認後才用 router.push（站外網址改 location.assign）。開新分頁（中鍵、⌘／Ctrl＋點）、只換 #錨點不攔。
 * - 上一頁：髒了就在目前位置多推一筆同網址的歷史紀錄（Next 會把自己的 state 複製過去），按上一頁時
 *   先回到這筆的前一筆＝同一頁，這時問要不要離開；取消就再推回去，確定就真的再退一頁。
 *   變乾淨（存好了）時把多推的那筆退掉，免得之後要按兩次上一頁。
 */
export function useUnsavedChangesGuard(dirty: boolean, message: string): { leave: (href: string) => void } {
  const router = useRouter();
  const dirtyRef = useRef(dirty);
  const messageRef = useRef(message);
  dirtyRef.current = dirty;
  messageRef.current = message;
  /** 目前歷史紀錄最上面是不是我們多推的那筆。 */
  const guardPushed = useRef(false);
  /** 自己呼叫 history.back() 引起的 popstate 要略過。 */
  const ignoreNextPop = useRef(false);
  /** leave() 先退掉多推的那筆，等 popstate 回來再導到這個網址（避免導走後又被 history.back() 拉回來）。 */
  const pendingLeave = useRef<string | null>(null);
  /** 已呼叫 leave()：之後不再多推歷史紀錄、不再攔點擊。 */
  const leavingRef = useRef(false);

  // 關閉分頁／重新整理
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // 站內連結
  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || leavingRef.current) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const leaving = isLeavingLinkClick({
        href: anchor.href,
        target: anchor.getAttribute("target"),
        download: anchor.hasAttribute("download"),
        button: event.button,
        modifier: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        currentHref: window.location.href,
      });
      if (!leaving) return;
      event.preventDefault();
      event.stopPropagation();
      if (!window.confirm(messageRef.current)) return;
      dirtyRef.current = false;
      const url = new URL(anchor.href);
      if (url.origin === window.location.origin) router.push(`${url.pathname}${url.search}${url.hash}`);
      else window.location.assign(anchor.href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, router]);

  // 上一頁
  useEffect(() => {
    if (leavingRef.current) return;
    if (dirty && !guardPushed.current) {
      window.history.pushState({ asterUnsavedGuard: true }, "", window.location.href);
      guardPushed.current = true;
    } else if (!dirty && guardPushed.current) {
      guardPushed.current = false;
      if (window.history.state?.asterUnsavedGuard) {
        ignoreNextPop.current = true;
        window.history.back();
      }
    }
  }, [dirty]);

  useEffect(() => {
    const onPopState = () => {
      if (ignoreNextPop.current) {
        ignoreNextPop.current = false;
        const target = pendingLeave.current;
        pendingLeave.current = null;
        if (target) router.replace(target);
        return;
      }
      if (!guardPushed.current) return;
      // 已經退到多推那筆的前一筆（同一頁）。
      guardPushed.current = false;
      if (!dirtyRef.current) return;
      if (window.confirm(messageRef.current)) {
        dirtyRef.current = false;
        window.history.back();
      } else {
        window.history.pushState({ asterUnsavedGuard: true }, "", window.location.href);
        guardPushed.current = true;
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [router]);

  // 離開這一頁（元件卸載，例如確認後導走）時不要留著多推的那筆狀態旗標。
  useEffect(() => () => {
    guardPushed.current = false;
  }, []);

  /**
   * 程式導走（例如新增存檔後換到內頁、刪除後回列表）：不再詢問，以「取代目前這筆歷史紀錄」的方式導過去。
   * 若最上面是多推的那筆，先退掉再導，免得歷史裡留一筆舊頁、或 dirty 變乾淨時的 history.back() 把人拉回來。
   */
  const leave = useCallback(
    (href: string) => {
      dirtyRef.current = false;
      leavingRef.current = true;
      if (guardPushed.current && window.history.state?.asterUnsavedGuard) {
        guardPushed.current = false;
        ignoreNextPop.current = true;
        pendingLeave.current = href;
        window.history.back();
        return;
      }
      guardPushed.current = false;
      router.replace(href);
    },
    [router],
  );

  return { leave };
}
