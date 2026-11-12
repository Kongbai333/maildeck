import type { ReactNode } from "react";
import { cx } from "../utils";

export interface TagChipsProps {
  tags: string[];
  /** 最多显示几个，超出显示 +N */
  max?: number;
  className?: string;
}

/** 邮箱标签 chips：最多显示 max 个，其余折叠为 +N。 */
export function TagChips({ tags, max = 3, className }: TagChipsProps): ReactNode {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const extra = tags.length - shown.length;
  return (
    <span className={cx("tag-chips", className)}>
      {shown.map((tag) => (
        <span key={tag} className="tag-chip" title={tag}>
          {tag}
        </span>
      ))}
      {extra > 0 ? (
        <span className="tag-chip tag-chip-more" title={tags.slice(max).join("、")}>
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
