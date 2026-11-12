import type { CSSProperties, ReactNode } from "react";
import { cx } from "../utils";

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** 骨架屏占位块：配合 styles.css 里的 shimmer 动画使用。 */
export function Skeleton({ width, height, radius, className, style }: SkeletonProps): ReactNode {
  return (
    <span
      className={cx("skeleton", className)}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

/** 表格骨架：用于列表/表格首次加载，替代整块 spinner。 */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }): ReactNode {
  return (
    <div className="table-skeleton" role="status" aria-label="加载中">
      <div
        className="table-skeleton-head"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: columns }).map((_, index) => (
          <Skeleton key={`h-${index}`} height={14} width="70%" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          className="table-skeleton-row"
          key={`r-${rowIndex}`}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }).map((_, colIndex) => (
            <Skeleton
              key={`c-${rowIndex}-${colIndex}`}
              height={14}
              width={colIndex === 0 ? "85%" : "60%"}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
