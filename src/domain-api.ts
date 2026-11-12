import { getCurrentConnectionConfig } from "./connection-config";
import type { MailMessageDetail, MailMessageSummary } from "./types";

export interface DomainProviderType {
  type: string;
  label: string;
  defaultBaseUrl: string;
}

export interface DomainProviderView {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  hasKey: boolean;
  enabled: boolean;
  mailboxCount: number;
  keyMode: "public" | "personal";
}

export interface DomainMailboxView {
  id: string;
  providerId: string;
  providerName: string;
  email: string;
  prefix: string;
  domain: string;
  remark: string;
  createdAt: string;
}

export interface DomainCatalogEntry {
  domain: string;
  wildcard: boolean;
}

export interface DomainPublicKeyInfo {
  key: string;
  isActive: boolean;
  remainingToday: number;
  dailyLimit: number;
  resetAt: string | null;
}

export interface DomainAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface DomainMessageDetail extends MailMessageDetail {
  attachments: DomainAttachment[];
}

function baseUrl() {
  const config = getCurrentConnectionConfig();
  if (!config) {
    throw new Error("当前不是服务端模式，请先连接 MailDeck 服务端");
  }
  return { root: `${config.serverUrl.replace(/\/+$/u, "")}/api`, token: config.apiToken };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = baseUrl();
  const headers = new Headers(init.headers);
  if (base.token) {
    headers.set("authorization", `Bearer ${base.token}`);
  }
  if (init.body) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${base.root}${path}`, { ...init, headers });
  const payload = (await response.json()) as { ok?: boolean; value?: T; error?: { message?: string } };
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error?.message || `请求失败（HTTP ${response.status}）`);
  }
  return payload.value as T;
}

export const domainApi = {
  providerTypes: () => request<DomainProviderType[]>("/domain-provider-types"),
  fetchPublicKey: (type: string, baseUrl?: string) => {
    const query = new URLSearchParams({ type });
    if (baseUrl) {
      query.set("baseUrl", baseUrl);
    }
    return request<DomainPublicKeyInfo>(`/domain-public-key?${query.toString()}`);
  },
  providers: () => request<DomainProviderView[]>("/domain-providers"),
  createProvider: (input: {
    name: string;
    type: string;
    baseUrl?: string;
    apiKey: string;
    keyMode?: "public" | "personal";
  }) => request<DomainProviderView[]>("/domain-providers", { method: "POST", body: JSON.stringify(input) }),
  refreshKeys: () =>
    request<{ refreshed: number }>("/domain-providers/refresh-keys", {
      method: "POST",
      body: "{}"
    }),
  deleteProvider: (id: string) =>
    request<DomainProviderView[]>(`/domain-providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  providerDomains: (id: string) =>
    request<DomainCatalogEntry[]>(`/domain-providers/${encodeURIComponent(id)}/domains`),
  mailboxes: () => request<DomainMailboxView[]>("/domain-mailboxes"),
  generateMailbox: (input: { providerId: string; prefix?: string; domain?: string; remark?: string }) =>
    request<DomainMailboxView[]>("/domain-mailboxes", { method: "POST", body: JSON.stringify(input) }),
  deleteMailbox: (id: string) =>
    request<DomainMailboxView[]>(`/domain-mailboxes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  messages: (mailboxId: string) =>
    request<MailMessageSummary[]>(`/domain-mailboxes/${encodeURIComponent(mailboxId)}/messages`),
  message: (mailboxId: string, messageId: string) =>
    request<DomainMessageDetail>(
      `/domain-mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`
    ),
  deleteMessage: (mailboxId: string, messageId: string) =>
    request<{ deleted: boolean }>(
      `/domain-mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" }
    ),
  clearMailbox: (mailboxId: string) =>
    request<{ cleared: boolean }>(`/domain-mailboxes/${encodeURIComponent(mailboxId)}/messages`, {
      method: "DELETE"
    })
};
