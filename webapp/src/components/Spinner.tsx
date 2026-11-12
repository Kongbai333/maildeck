import type { ReactNode } from "react";

export function Spinner({ size = 18, label }: { size?: number; label?: string }): ReactNode {
  return (
    <span className="spinner-wrap">
      <span
        className="spinner"
        style={{ width: size, height: size }}
        role={label ? "status" : undefined}
        aria-label={label}
      />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  );
}

export function LoadingBlock({ label = "加载中…" }: { label?: string }): ReactNode {
  return (
    <div className="loading-block">
      <Spinner size={22} />
      <span>{label}</span>
    </div>
  );
}
