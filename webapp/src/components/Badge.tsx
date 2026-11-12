import type { ReactNode } from "react";
import { cx } from "../utils";

export function Badge({
  children,
  tone = "badge-muted",
}: {
  children: ReactNode;
  tone?: string;
}): ReactNode {
  return <span className={cx("badge", tone)}>{children}</span>;
}
