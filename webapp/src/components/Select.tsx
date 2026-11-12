import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../utils";

export interface SelectOption {
  value: string;
  label: string;
  /** 单项禁用：仍可见但不可选 */
  disabled?: boolean;
  /** 左侧可选图标 */
  icon?: ReactNode;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** 没有匹配项时的占位文案 */
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  /** 空列表提示 */
  emptyText?: string;
}

const MENU_MAX_HEIGHT = 280;
const MENU_MIN_HEIGHT = 120;
const GAP = 6;
const MARGIN = 8;

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function firstEnabledIndex(options: SelectOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabledIndex(options: SelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index].disabled) return index;
  }
  return -1;
}

/**
 * 统一的自定义下拉框（替换所有原生 <select>）。
 * - 触发按钮与 `.input` 同高（40px）、同圆角 / 边框 / 白底；
 * - 浮层用 portal + position:fixed 渲染，避免被表格 / 弹窗 overflow 裁剪；
 * - 键盘 ↑↓ / Home / End / Enter / Esc 可达，外点关闭，role=listbox / option + aria-expanded。
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "请选择",
  disabled = false,
  ariaLabel,
  className,
  emptyText = "暂无选项",
}: SelectProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    setPosition(null);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    if (selectedIndex >= 0 && !options[selectedIndex].disabled) setActiveIndex(selectedIndex);
    else setActiveIndex(firstEnabledIndex(options));
  }, [disabled, options, selectedIndex]);

  const choose = useCallback(
    (index: number) => {
      const option = options[index];
      if (option === undefined || option.disabled) return;
      onChange(option.value);
      close(true);
    },
    [close, onChange, options],
  );

  const moveActive = useCallback(
    (direction: number): void => {
      const enabled: number[] = [];
      options.forEach((option, index) => {
        if (!option.disabled) enabled.push(index);
      });
      if (enabled.length === 0) return;
      const current = enabled.indexOf(activeIndex);
      const next =
        current === -1
          ? direction > 0
            ? enabled[0]
            : enabled[enabled.length - 1]
          : enabled[(current + direction + enabled.length) % enabled.length];
      setActiveIndex(next);
    },
    [activeIndex, options],
  );

  // 定位：优先向下展开，空间不足向上翻；随滚动 / 尺寸变化重算
  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (trigger === null || menu === null) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuHeight = menu.getBoundingClientRect().height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spaceBelow = vh - triggerRect.bottom - GAP - MARGIN;
    const spaceAbove = triggerRect.top - GAP - MARGIN;
    let top: number;
    let maxHeight = MENU_MAX_HEIGHT;
    if (menuHeight <= spaceBelow) {
      top = triggerRect.bottom + GAP;
    } else if (menuHeight <= spaceAbove) {
      top = triggerRect.top - GAP - menuHeight;
    } else if (spaceBelow >= spaceAbove) {
      top = triggerRect.bottom + GAP;
      maxHeight = Math.max(MENU_MIN_HEIGHT, spaceBelow);
    } else {
      maxHeight = Math.max(MENU_MIN_HEIGHT, spaceAbove);
      top = triggerRect.top - GAP - maxHeight;
    }
    const width = triggerRect.width;
    let left = triggerRect.left;
    if (left + width > vw - MARGIN) left = vw - width - MARGIN;
    if (left < MARGIN) left = MARGIN;
    setPosition({ top, left, width, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onReflow = (): void => updatePosition();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [close, open, updatePosition]);

  // 键盘移动时把当前项滚进可视区
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const menu = menuRef.current;
    if (menu === null) return;
    const nodes = menu.querySelectorAll<HTMLElement>('[role="option"]');
    nodes[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(firstEnabledIndex(options));
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(lastEnabledIndex(options));
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(activeIndex);
        break;
      default:
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx("select", "select-trigger", disabled && "select-trigger-disabled", className)}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
      >
        <span className={cx("select-trigger-value", selected === null && "select-placeholder")}>
          {selected?.icon ? <span className="select-icon">{selected.icon}</span> : null}
          <span className="select-trigger-label">{selected?.label ?? placeholder}</span>
        </span>
        <ChevronDown size={16} className="select-caret" aria-hidden="true" />
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              aria-activedescendant={activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
              className="select-menu"
              style={{
                top: position?.top ?? -9999,
                left: position?.left ?? -9999,
                width: position?.width ?? undefined,
                maxHeight: position?.maxHeight ?? MENU_MAX_HEIGHT,
                visibility: position === null ? "hidden" : "visible",
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {options.length === 0 ? (
                <div className="select-empty">{emptyText}</div>
              ) : (
                options.map((option, index) => {
                  const isSelected = option.value === value;
                  return (
                    <button
                      key={`${option.value}-${index}`}
                      type="button"
                      role="option"
                      id={`${listId}-opt-${index}`}
                      aria-selected={isSelected}
                      disabled={option.disabled}
                      className={cx(
                        "select-option",
                        index === activeIndex && "select-option-active",
                        isSelected && "select-option-selected",
                      )}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(index)}
                    >
                      {option.icon ? <span className="select-icon">{option.icon}</span> : null}
                      <span className="select-option-label">{option.label}</span>
                      {isSelected ? <Check size={15} className="select-check" aria-hidden="true" /> : null}
                    </button>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
