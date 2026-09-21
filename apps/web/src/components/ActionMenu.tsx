"use client";

/**
 * 「⋯」更多操作選單——把一列上原本並排的一堆文字連結收成一顆按鈕。
 *
 * - 桌機（md 以上，48rem）：下拉選單（`role="menu"`／`role="menuitem"`）。開啟時焦點進第一個
 *   可按的項目、↑↓／Home／End 移動、Escape 或點外面關閉並把焦點還給觸發鈕、Tab 關閉並從觸發鈕續走。
 *   選單用 portal 掛在 body 上並以視窗座標定位：列表外層是 `overflow-x-auto`、Card 又是
 *   `overflow-hidden`，普通的 absolute 下拉會被夾住看不到；下方放不下時自動翻到觸發鈕上方。
 * - 手機（md 以下）：改用 ess-ui 的 BottomSheet 列出同一組項目（大字、整行可按）。
 *
 * 項目只描述「顯示什麼、能不能按、按了做什麼」，各動作的 confirm／modal 邏輯留在呼叫端。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { BottomSheet } from "@/components/ess-ui";

export type ActionMenuTone = "default" | "danger" | "muted";

export interface ActionMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** danger＝紅字（停用、刪除）；muted＝灰字（備援性質的動作）。 */
  tone?: ActionMenuTone;
  disabled?: boolean;
  /** 給了就渲染成 `<a href>`（同時仍會呼叫 onSelect）。 */
  href?: string;
  /** 滑鼠停留的補充說明。 */
  title?: string;
}

export interface ActionMenuProps {
  /** 觸發鈕的 aria-label 與手機版面板標題。 */
  label?: string;
  items: ActionMenuItem[];
  /** 下拉選單對齊觸發鈕的哪一邊（預設右對齊，適合放在表格最右欄）。 */
  align?: "left" | "right";
  className?: string;
}

const DESKTOP_QUERY = "(min-width: 48rem)";
/** 先藏著等 useLayoutEffect 量完座標再顯示，避免閃一下在錯的位置。 */
const INITIAL_MENU_STYLE: CSSProperties = { position: "fixed", visibility: "hidden" };
const GAP = 4;
const VIEWPORT_PADDING = 8;

const TONE_CLASS: Record<ActionMenuTone, string> = {
  default: "text-gray-700",
  danger: "text-red-600",
  muted: "text-gray-400",
};

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** 三個點的「更多」圖示（ess-ui 的 `more` 是九宮格，語意不同，這裡自畫）。 */
function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

/** 是否為桌機寬度；SSR 與首次 render 先當桌機，effect 後依 matchMedia 修正。 */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const sync = () => setIsDesktop(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);
  return isDesktop;
}

export function ActionMenu({ label = "更多操作", items, align = "right", className }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const select = useCallback(
    (item: ActionMenuItem) => {
      if (item.disabled) return;
      setOpen(false);
      // 選單收起後焦點還給觸發鈕（鍵盤使用者不會掉到 body）；動作若自己開面板會再接手焦點。
      triggerRef.current?.focus();
      item.onSelect();
    },
    [],
  );

  return (
    <div className={cx("relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open && isDesktop ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
          open && "bg-gray-100 text-gray-700",
        )}
      >
        <DotsIcon />
      </button>

      {isDesktop ? (
        <DesktopMenu
          open={open}
          menuId={menuId}
          label={label}
          items={items}
          align={align}
          triggerRef={triggerRef}
          onSelect={select}
          onClose={close}
        />
      ) : (
        <BottomSheet open={open} onClose={() => close(false)} title={label}>
          <ul className="-mx-1 divide-y divide-gray-100">
            {items.map((item) => (
              <li key={item.key}>
                <MenuEntry item={item} onSelect={select} className="min-h-12 px-3 text-base" />
              </li>
            ))}
          </ul>
        </BottomSheet>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ desktop --- */

function DesktopMenu({
  open,
  menuId,
  label,
  items,
  align,
  triggerRef,
  onSelect,
  onClose,
}: {
  open: boolean;
  menuId: string;
  label: string;
  items: ActionMenuItem[];
  align: "left" | "right";
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSelect: (item: ActionMenuItem) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // 依觸發鈕的視窗座標定位；捲動／改視窗大小時重算。下方放不下就翻到上方。
  // 座標直接寫進 DOM style（不走 state）：先定位、把 visibility 打開，再把焦點移進第一個
  // 可按的項目——`focus()` 對 visibility:hidden 的元素無效，所以順序不能反。
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const menuHeight = menu.offsetHeight;
      const fitsBelow = rect.bottom + GAP + menuHeight <= window.innerHeight - VIEWPORT_PADDING;
      const top = fitsBelow ? rect.bottom + GAP : Math.max(VIEWPORT_PADDING, rect.top - GAP - menuHeight);
      menu.style.top = `${top}px`;
      if (align === "right") {
        menu.style.right = `${Math.max(VIEWPORT_PADDING, window.innerWidth - rect.right)}px`;
        menu.style.left = "auto";
      } else {
        menu.style.left = `${Math.max(VIEWPORT_PADDING, rect.left)}px`;
        menu.style.right = "auto";
      }
      menu.style.visibility = "visible";
    };
    place();
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, triggerRef]);

  // 點外面或 Escape 關閉。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, triggerRef]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;
    const focusable = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'));
    if (focusable.length === 0) return;
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => focusable[(i + focusable.length) % focusable.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(focusable.length - 1);
        break;
      case "Tab":
        // 不攔 Tab：先把焦點還給觸發鈕再放行預設行為，Tab／Shift+Tab 就會從觸發鈕的位置
        // 往下／往上走（選單掛在 body 尾端，不還焦點會跳到頁面最後）。
        onClose(true);
        break;
      default:
        break;
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label={label}
      style={INITIAL_MENU_STYLE}
      onKeyDown={onMenuKeyDown}
      className="z-[55] min-w-40 rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
    >
      {items.map((item) => (
        <MenuEntry key={item.key} item={item} onSelect={onSelect} className="min-h-9 px-3 text-sm" />
      ))}
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------- entry --- */

function MenuEntry({
  item,
  onSelect,
  className,
}: {
  item: ActionMenuItem;
  onSelect: (item: ActionMenuItem) => void;
  className?: string;
}): ReactNode {
  const base = cx(
    "flex w-full items-center text-left",
    TONE_CLASS[item.tone ?? "default"],
    item.disabled ? "cursor-not-allowed opacity-50" : "hover:bg-gray-50 focus:bg-gray-50",
    "focus:outline-none",
    className,
  );
  if (item.href && !item.disabled) {
    return (
      <a
        role="menuitem"
        href={item.href}
        title={item.title}
        className={base}
        onClick={() => onSelect(item)}
      >
        {item.label}
      </a>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      title={item.title}
      disabled={item.disabled}
      aria-disabled={item.disabled ? "true" : undefined}
      className={base}
      onClick={() => onSelect(item)}
    >
      {item.label}
    </button>
  );
}
