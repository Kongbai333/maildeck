import type {
  AccountView,
  AppErrorCode,
  AppErrorPayload,
  GetMessageOptions,
  ListAttachmentsOptions,
  ListMessagesOptions,
  MailAttachmentListResult,
  MailFolder,
  MailListResult,
  MailMessageDetail,
  MailMessageSummary,
  RefreshManyResult,
  TestConnectionResult,
  TestFallbackResult,
  TestManyResult
} from "../../electron/shared/ipc-contracts.js";
import {
  downloadAttachment as downloadGraphAttachment,
  getMessage as getGraphMessage,
  getWellKnownInboxFolder,
  listAttachments as listGraphAttachments,
  listMailFolders,
  listMessages as listGraphMessages
} from "../../electron/main/graph-client.js";
import {
  getImapMessage,
  listImapFolders,
  listImapMessages
} from "../../electron/main/imap-client.js";
import {
  getAccountRecord,
  listAccounts,
  updateAccountState
} from "./account-service.js";
import {
  getCachedDetail,
  getCachedMessages,
  saveDetail,
  saveMessages
} from "./cache-service.js";
import { getSettings, getRuntimeProxyUrl } from "./settings-service.js";
import { getAccessToken } from "./token-service.js";

const EMPTY_ATTACHMENTS: MailAttachmentListResult = { supported: false, attachments: [] };
const MAX_BATCH = 5_000;

function errorPayload(error: unknown): AppErrorPayload {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  let code: AppErrorCode = "UNKNOWN";
  let retryable = false;

  if (/network|fetch|connect|ENOTFOUND|ECONN|ETIMEDOUT|timeout|socket/i.test(message)) {
    code = "NETWORK_ERROR";
    retryable = true;
  } else if (/AADSTS|refresh_token|token/i.test(message)) {
    code = "TOKEN_EXPIRED";
    retryable = false;
  } else if (/IMAP|login|LOGIN|authenticate/i.test(message)) {
    code = "IMAP_AUTH_FAILED";
    retryable = false;
  } else if (/graph|HTTP 4\d\d/i.test(message)) {
    code = "GRAPH_NOT_FOUND";
    retryable = false;
  }

  return { code, message: message || "服务端处理失败", retryable };
}

async function runLimited<T, R>(items: T[], limit: number, handler: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await handler(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, () => worker())
  );
  return results;
}

async function resolveFolder(accountId: string, requestedFolderId?: string): Promise<MailFolder> {
  const account = getAccountRecord(accountId);
  if (!account) {
    throw new Error("账号不存在");
  }
  if (requestedFolderId?.trim()) {
    return {
      id: requestedFolderId.trim(),
      displayName: requestedFolderId.trim(),
      totalItemCount: 0,
      unreadItemCount: 0
    };
  }
  if (account.inbox_folder_id) {
    return {
      id: account.inbox_folder_id,
      displayName: "收件箱",
      totalItemCount: account.last_inbox_count || 0,
      unreadItemCount: 0
    };
  }

  const token = await getAccessToken(accountId);
  let folder: MailFolder | null = null;
  if (token.authMode === "imap") {
    const folders = await listImapFolders(account.email, token.accessToken, getRuntimeProxyUrl());
    folder = folders.find((item) => /^inbox$/i.test(item.id) || /inbox/i.test(item.displayName)) ?? folders[0] ?? null;
  } else {
    folder = await getWellKnownInboxFolder(token.accessToken, getRuntimeProxyUrl());
  }

  if (!folder) {
    throw new Error("找不到收件箱");
  }
  updateAccountState(accountId, { inboxFolderId: folder.id, authMode: token.authMode });
  return folder;
}

export async function listFolders(accountId: string): Promise<MailFolder[]> {
  const account = getAccountRecord(accountId);
  if (!account) {
    throw new Error("账号不存在");
  }
  const token = await getAccessToken(accountId);
  if (token.authMode === "imap") {
    return listImapFolders(account.email, token.accessToken, getRuntimeProxyUrl());
  }
  return listMailFolders(token.accessToken, getRuntimeProxyUrl());
}

export async function listMessages(options: ListMessagesOptions): Promise<MailListResult> {
  const account = getAccountRecord(options.accountId);
  if (!account) {
    throw new Error("账号不存在");
  }

  const top = Math.max(1, Math.min(options.top || 50, 100));
  const search = options.search?.trim() || "";
  const isPrimaryFolder = !options.folderId?.trim();
  const folder = await resolveFolder(options.accountId, options.folderId);

  if (!options.forceRefresh && !options.cursor && !options.skip && !search) {
    const cached = getCachedMessages(options.accountId, folder.id, search, top);
    if (cached && cached.length > 0) {
      return {
        messages: cached,
        nextCursor: null,
        totalCount: cached.length,
        stale: false
      };
    }
  }

  const token = await getAccessToken(options.accountId);
  let messages: MailMessageSummary[] = [];
  let nextCursor: string | null = null;
  let totalCount: number | undefined;

  if (token.authMode === "imap") {
    const result = await listImapMessages(
      account.email,
      token.accessToken,
      folder.id,
      top,
      search,
      options.cursor || "",
      getRuntimeProxyUrl()
    );
    messages = result.messages;
    totalCount = result.totalCount;
    nextCursor = result.messages.length >= top ? result.messages[result.messages.length - 1]?.id || null : null;
  } else {
    const skip = options.cursor ? Number(options.cursor) || 0 : options.skip || 0;
    messages = await listGraphMessages(
      token.accessToken,
      folder.id,
      top,
      skip,
      search,
      options.since ?? null,
      getRuntimeProxyUrl()
    );
    totalCount = folder.totalItemCount || undefined;
    nextCursor =
      messages.length >= top && (totalCount === undefined || skip + messages.length < totalCount)
        ? String(skip + messages.length)
        : null;
  }

  const settings = getSettings();
  if (settings.cacheMessages) {
    saveMessages(options.accountId, folder.id, messages, nextCursor);
  }

  const latest = messages
    .map((message) => message.receivedDateTime)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) || account.last_mail_at;
  if (isPrimaryFolder) {
    updateAccountState(options.accountId, {
      lastInboxCount: totalCount ?? messages.length,
      lastMailAt: latest,
      lastError: null
    });
  }

  return { messages, nextCursor, totalCount };
}

export async function getMessage(options: GetMessageOptions): Promise<MailMessageDetail> {
  const account = getAccountRecord(options.accountId);
  if (!account) {
    throw new Error("账号不存在");
  }
  const folder = await resolveFolder(options.accountId, options.folderId);
  const cached = getCachedDetail(options.accountId, folder.id, options.messageId);
  if (cached) {
    return cached;
  }

  const token = await getAccessToken(options.accountId);
  const detail =
    token.authMode === "imap"
      ? await getImapMessage(
          account.email,
          token.accessToken,
          folder.id,
          options.messageId,
          getRuntimeProxyUrl()
        )
      : await getGraphMessage(token.accessToken, options.messageId, getRuntimeProxyUrl());

  if (getSettings().cacheBodies) {
    saveDetail(options.accountId, folder.id, detail);
  }
  return detail;
}

export async function listAttachments(options: ListAttachmentsOptions): Promise<MailAttachmentListResult> {
  const token = await getAccessToken(options.accountId);
  if (token.authMode === "imap") {
    return EMPTY_ATTACHMENTS;
  }
  return {
    supported: true,
    attachments: await listGraphAttachments(
      token.accessToken,
      options.messageId,
      getRuntimeProxyUrl()
    )
  };
}

export async function downloadAttachment(
  accountId: string,
  messageId: string,
  attachmentId: string
) {
  const token = await getAccessToken(accountId);
  if (token.authMode === "imap") {
    throw new Error("IMAP 账号暂不提供附件下载");
  }
  return downloadGraphAttachment(token.accessToken, messageId, attachmentId, getRuntimeProxyUrl());
}

export async function testAccount(accountId: string): Promise<TestConnectionResult> {
  const account = getAccountRecord(accountId);
  if (!account) {
    throw new Error("账号不存在");
  }
  try {
    const token = await getAccessToken(accountId);
    if (token.authMode === "imap") {
      await listImapFolders(account.email, token.accessToken, getRuntimeProxyUrl());
    } else {
      await listMailFolders(token.accessToken, getRuntimeProxyUrl());
    }
    const view = updateAccountState(accountId, {
      status: "valid",
      lastError: null,
      lastCheckedAt: new Date().toISOString(),
      authMode: token.authMode
    });
    return { account: view, ok: true, message: "连接成功" };
  } catch (error) {
    const payload = errorPayload(error);
    const view = updateAccountState(accountId, {
      status: "invalid",
      lastError: payload.message,
      authMode: null
    });
    return { account: view, ok: false, error: payload };
  }
}

export async function testMany(accountIds: string[]): Promise<TestManyResult[]> {
  const ids = [...new Set(accountIds)].slice(0, MAX_BATCH);
  return runLimited(ids, 4, async (accountId) => {
    const result = await testAccount(accountId);
    return result.ok
      ? { accountId, account: result.account, ok: true as const, message: result.message }
      : { accountId, account: result.account, ok: false as const, error: result.error };
  });
}

export async function refreshAccount(accountId: string): Promise<RefreshManyResult> {
  const started = Date.now();
  const account = getAccountRecord(accountId);
  if (!account) {
    throw new Error("账号不存在");
  }

  try {
    const token = await getAccessToken(accountId);
    const folder = await resolveFolder(accountId);
    const imapResult =
      token.authMode === "imap"
        ? await listImapMessages(
            account.email,
            token.accessToken,
            folder.id,
            20,
            "",
            "",
            getRuntimeProxyUrl()
          )
        : null;
    const messages = imapResult
      ? imapResult.messages
      : await listGraphMessages(
          token.accessToken,
          folder.id,
          20,
          0,
          "",
          null,
          getRuntimeProxyUrl()
        );

    if (getSettings().cacheMessages) {
      saveMessages(accountId, folder.id, messages, null);
    }

    const previousLastMailAt = account.last_mail_at ? Date.parse(account.last_mail_at) : 0;
    const newCount = messages.filter((message) => {
      const received = message.receivedDateTime ? Date.parse(message.receivedDateTime) : 0;
      return received > previousLastMailAt;
    }).length;
    const latest = messages
      .map((message) => message.receivedDateTime)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) || account.last_mail_at;
    const inboxCount = imapResult?.totalCount ?? (folder.totalItemCount || messages.length);

    updateAccountState(accountId, {
      status: "valid",
      lastError: null,
      lastRefreshedAt: new Date().toISOString(),
      lastInboxCount: inboxCount,
      lastMailAt: latest,
      authMode: token.authMode
    });

    return {
      accountId,
      ok: true,
      count: messages.length,
      newCount,
      metrics: {
        tokenMs: 0,
        mailMs: Date.now() - started,
        cacheMs: 0,
        stateMs: 0,
        totalMs: Date.now() - started
      }
    };
  } catch (error) {
    const payload = errorPayload(error);
    updateAccountState(accountId, { status: "invalid", lastError: payload.message });
    return {
      accountId,
      ok: false,
      count: 0,
      error: payload,
      metrics: {
        tokenMs: 0,
        mailMs: 0,
        cacheMs: 0,
        stateMs: 0,
        totalMs: Date.now() - started
      }
    };
  }
}

export async function refreshMany(accountIds: string[]): Promise<RefreshManyResult[]> {
  const ids = [...new Set(accountIds)].slice(0, MAX_BATCH);
  return runLimited(ids, getSettings().batchConcurrency, (accountId) => refreshAccount(accountId));
}

export async function testFallback(_accountId: string): Promise<TestFallbackResult> {
  return {
    account: null,
    ok: false,
    error: {
      code: "UNKNOWN",
      message: "本地服务端暂未启用 Hotmail 兜底链路，可直接使用 Graph/IMAP 账号。",
      retryable: false
    },
    elapsedMs: 0
  };
}

export async function getAccountsForBackgroundRefresh(): Promise<AccountView[]> {
  return listAccounts().filter((account) => account.status !== "invalid");
}
