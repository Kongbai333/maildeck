import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface AppSelectOption {
  value: string;
  label: string;
}

/**
 * 自定义下拉框：原生 <select> 的展开列表由操作系统渲染（Windows 蓝色列表），
 * 无法用 CSS 美化。这里用按钮 + portal 浮层列表实现，视觉与应用整体保持一致，
 * 且不被弹窗/面板的 overflow 裁剪。
 */
export function AppSelect({
  value,
  onChange,
  options,
  placeholder = "请选择",
  disabled = false,
  ariaLabel,
  className = ""
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly AppSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  const positionMenu = () => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const maxHeight = Math.max(120, Math.min(260, spaceBelow));
    setMenuStyle({
      position: "fixed",
      top: rect.bottom + 4,
      left: rect.left,
      minWidth: rect.width,
      maxWidth: Math.max(rect.width, 240),
      maxHeight
    });
  };

  useLayoutEffect(() => {
    if (open) {
      positionMenu();
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 捕获阶段拦截，避免同时触发外层弹窗的 Esc 关闭。
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onScrollResize = () => positionMenu();
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onScrollResize);
    window.addEventListener("scroll", onScrollResize, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onScrollResize);
      window.removeEventListener("scroll", onScrollResize, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`app-select ${open ? "open" : ""} ${disabled ? "disabled" : ""} ${className}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="app-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`app-select-value ${selected ? "" : "placeholder"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={14} className="app-select-chevron" />
      </button>
      {open
        ? createPortal(
            <div ref={menuRef} className="app-select-menu" role="listbox" aria-label={ariaLabel} style={menuStyle}>
              {options.length === 0 ? (
                <div className="app-select-empty">暂无选项</div>
              ) : (
                options.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    role="option"
                    aria-selected={option.value === value}
                    className={`app-select-option ${option.value === value ? "selected" : ""}`}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {option.value === value ? <Check size={14} /> : null}
                  </button>
                ))
              )}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
