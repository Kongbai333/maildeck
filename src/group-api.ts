import { getCurrentConnectionConfig } from "./connection-config";
import type { MailboxCategory } from "./mailbox-category";

export interface AccountGroupView {
  id: string;
  name: string;
  category: string;
  accountCount: number;
}

function groupBaseUrl() {
  const config = getCurrentConnectionConfig();
  if (!config) {
    return null;
  }
  return {
    url: `${config.serverUrl.replace(/\/+$/u, "")}/api/groups`,
    token: config.apiToken
  };
}

async function groupRequest<T>(init: RequestInit = {}): Promise<T> {
  const base = groupBaseUrl();
  if (!base) {
    throw new Error("当前不是服务端模式");
  }
  const headers = new Headers(init.headers);
  if (base.token) {
    headers.set("authorization", `Bearer ${base.token}`);
  }
  if (init.body) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(base.url, { ...init, headers });
  const payload = (await response.json()) as { ok?: boolean; value?: T; error?: { message?: string } };
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error?.message || `分组请求失败（HTTP ${response.status}）`);
  }
  return payload.value as T;
}

export function listAccountGroups(): Promise<AccountGroupView[]> {
  return groupRequest<AccountGroupView[]>();
}

export function createAccountGroup(name: string, category: MailboxCategory): Promise<AccountGroupView[]> {
  return groupRequest<AccountGroupView[]>({
    method: "POST",
    body: JSON.stringify({ name, category })
  });
}
