import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../utils";

export interface ActionMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** 危险操作（删除等）用红色 */
  danger?: boolean;
  disabled?: boolean;
  /** 禁用时的原因，作为 title 展示 */
  disabledReason?: string;
  onSelect: () => void;
}

export interface ActionMenuProps {
  items: ActionMenuItem[];
  /** 无障碍名称，例如「邮箱池更多操作」 */
  label?: string;
  disabled?: boolean;
  /** 触发按钮尺寸，表格内用 sm */
  size?: "sm" | "md";
}

interface MenuPosition {
  top: number;
  left: number;
}

const GAP = 6;
const MARGIN = 8;

/**
 * 行内「⋯」下拉菜单。
 * - 菜单通过 Portal 渲染成 fixed 定位，避免被表格 overflow 容器裁切；
 * - 点击外部关闭、Esc 关闭并把焦点还给触发按钮；
 * - aria-haspopup / aria-expanded / aria-controls，方向键与 Home/End 可达。
 */
export function ActionMenu({ items, label = "更多操作", disabled = false, size = "sm" }: ActionMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const focusItem = useCallback((index: number): void => {
    const menu = menuRef.current;
    if (menu === null) return;
    const nodes = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    if (nodes.length === 0) return;
    const wrapped = ((index % nodes.length) + nodes.length) % nodes.length;
    nodes[wrapped].focus();
  }, []);

  // 打开时计算位置：默认右对齐触发按钮，空间不足时向上翻转
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (trigger === null || menu === null) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = triggerRect.right - menuRect.width;
    if (left + menuRect.width > viewportWidth - MARGIN) left = viewportWidth - menuRect.width - MARGIN;
    if (left < MARGIN) left = MARGIN;

    let top = triggerRect.bottom + GAP;
    if (top + menuRect.height > viewportHeight - MARGIN) {
      const above = triggerRect.top - menuRect.height - GAP;
      top = above >= MARGIN ? above : Math.max(MARGIN, viewportHeight - menuRect.height - MARGIN);
    }

    setPosition({ top, left });
    const first = menu.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    first?.focus();
  }, [open]);

  // 外部点击 / Esc / 滚动与尺寸变化
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };
    const onReflow = (): void => close(false);

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [close, open]);

  const onTriggerClick = (): void => {
    if (disabled) return;
    if (open) close(false);
    else setOpen(true);
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const menu = menuRef.current;
    if (menu === null) return;
    const nodes = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    const current = nodes.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(current - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(nodes.length - 1);
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx("icon-btn", size === "sm" && "icon-btn-xs", "action-menu-trigger", open && "is-open")}
        onClick={onTriggerClick}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={label}
              className="action-menu"
              style={{
                top: position?.top ?? -9999,
                left: position?.left ?? -9999,
                visibility: position === null ? "hidden" : "visible",
              }}
              onKeyDown={onMenuKeyDown}
            >
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  className={cx("action-menu-item", item.danger && "action-menu-item-danger")}
                  disabled={item.disabled}
                  title={item.disabled ? item.disabledReason : undefined}
                  onClick={() => {
                    close(true);
                    item.onSelect();
                  }}
                >
                  {item.icon ? <span className="action-menu-icon">{item.icon}</span> : null}
                  <span className="action-menu-label">{item.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
