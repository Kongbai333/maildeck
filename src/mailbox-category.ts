import type { AccountView } from "./types";

export type MailboxCategory = "all" | "outlook" | "domain" | "temp";

const OUTLOOK_DOMAINS = new Set([
  "outlook.com",
  "outlook.cn",
  "hotmail.com",
  "hotmail.cn",
  "live.com",
  "live.cn",
  "msn.com"
]);

// 常见临时邮箱服务域名；自定义临时邮箱可以用分组/标签里带「临时」来归类。
const TEMP_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "temp-mail.org",
  "yopmail.com",
  "sharklasers.com",
  "dispostable.com",
  "getnada.com",
  "maildrop.cc",
  "trashmail.com",
  "fakeinbox.com",
  "throwawaymail.com"
]);

function domainOf(email: string) {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

export function mailboxCategoryOf(account: AccountView): Exclude<MailboxCategory, "all"> {
  const hint = `${account.group} ${(account.tags ?? []).join(" ")}`.toLowerCase();
  if (hint.includes("临时") || hint.includes("temporary") || hint.includes("temp")) {
    return "temp";
  }
  if (hint.includes("域名") || hint.includes("domain") || hint.includes("custom")) {
    return "domain";
  }
  if (hint.includes("outlook") || hint.includes("hotmail")) {
    return "outlook";
  }

  const domain = domainOf(account.email);
  if (OUTLOOK_DOMAINS.has(domain)) {
    return "outlook";
  }
  if (TEMP_DOMAINS.has(domain)) {
    return "temp";
  }
  return "domain";
}

export const MAILBOX_CATEGORY_LABELS: Record<Exclude<MailboxCategory, "all">, string> = {
  outlook: "Outlook 邮箱",
  domain: "域名邮箱",
  temp: "临时邮箱"
};
