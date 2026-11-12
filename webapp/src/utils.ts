import type { MailboxStatus, ProviderKind, QuotaBuckets, Role, UserStatus } from "./types";

const pad = (value: number): string => String(value).padStart(2, "0");

/** 统一时间格式 YYYY-MM-DD HH:mm，空值/非法值显示 — */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 列表里用的短时间：今天显示 HH:mm，其余显示 MM-DD HH:mm */
export function formatShortTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
      date.getMinutes(),
    )}`;
  }
  return formatDateTime(value);
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let value = size;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function orDash(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const trimmed = value.trim();
  return trimmed === "" ? "—" : trimmed;
}

/** 复制文本：优先 clipboard API，失败回退 execCommand，再失败返回 false 由调用方提示。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走兜底方案 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}

/** 服务商下拉文案：名称里已经带了类型名时不再重复拼接括号 */
export function providerLabel(name: string, typeLabel: string): string {
  const trimmed = typeLabel.trim();
  if (trimmed === "") return name;
  if (name.includes(trimmed)) return name;
  // 类型名常带「（临时邮箱）」这类后缀，名称里只有主名时也别再拼一遍
  const bare = trimmed.replace(/（[^）]*）\s*$/u, "").trim();
  if (bare !== "" && name.includes(bare)) return name;
  return `${name}（${trimmed}）`;
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export const MAILBOX_STATUS_LABEL: Record<MailboxStatus, string> = {
  available: "可用",
  assigned: "已分配",
  disabled: "已停用",
};

export const MAILBOX_STATUS_TONE: Record<MailboxStatus, string> = {
  available: "badge-success",
  assigned: "badge-info",
  disabled: "badge-muted",
};

export const USER_STATUS_LABEL: Record<UserStatus, string> = {
  active: "正常",
  disabled: "已停用",
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: "管理员",
  user: "普通用户",
};

/* ------------------------- 三类邮箱（Outlook / 域名 / 临时） ------------------------- */

/** 展示顺序：Outlook 池 → 域名邮箱 → 临时邮箱 */
export const PROVIDER_KIND_ORDER: readonly ProviderKind[] = ["outlook", "domain", "temp"];

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  outlook: "Outlook",
  domain: "域名邮箱",
  temp: "临时邮箱",
};

export const PROVIDER_KIND_SHORT: Record<ProviderKind, string> = {
  outlook: "Outlook",
  domain: "域名",
  temp: "临时",
};

export const PROVIDER_KIND_TONE: Record<ProviderKind, string> = {
  outlook: "badge-primary",
  domain: "badge-info",
  temp: "badge-muted",
};

export function emptyQuota(): QuotaBuckets {
  return { outlook: 0, domain: 0, temp: 0 };
}

/** 配额上限：优先新的 quotas，缺失时三类都退回旧的单配额 mailboxQuota */
export function quotaLimits(quotas: QuotaBuckets | undefined, fallback: number): QuotaBuckets {
  if (quotas !== undefined) return quotas;
  const base = Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
  return { outlook: base, domain: base, temp: base };
}

/** 剩余配额，按类别分别扣减且不为负 */
export function quotaRemaining(limits: QuotaBuckets, used: QuotaBuckets): QuotaBuckets {
  return {
    outlook: Math.max(0, limits.outlook - used.outlook),
    domain: Math.max(0, limits.domain - used.domain),
    temp: Math.max(0, limits.temp - used.temp),
  };
}

/** 按类别统计数量；kindOf 用于邮箱没带 kind 时用 providerId 反查 */
export function countByKind<T>(items: T[], kindOf: (item: T) => ProviderKind | undefined): QuotaBuckets {
  const counts = emptyQuota();
  for (const item of items) {
    const kind = kindOf(item);
    if (kind !== undefined) counts[kind] += 1;
  }
  return counts;
}

/** 「Outlook 1/2」这类配额文案 */
export function quotaText(kind: ProviderKind, used: number, limit: number): string {
  return `${PROVIDER_KIND_SHORT[kind]} ${used}/${limit}`;
}

/** 邮箱地址打码展示，仅在需要弱化时使用 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return email;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
