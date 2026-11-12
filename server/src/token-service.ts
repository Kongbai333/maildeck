import type { AccessTokenResult } from "../../electron/main/types.js";
import { refreshAccessToken } from "../../electron/main/graph-client.js";
import { getAccountRecord, updateAccountState } from "./account-service.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { getDb, type AccountRow } from "./db.js";
import { getRuntimeProxyUrl } from "./settings-service.js";

interface CachedToken {
  value: AccessTokenResult;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const pendingRefresh = new Map<string, Promise<AccessTokenResult>>();

function saveRotatedToken(accountId: string, refreshToken: string) {
  getDb()
    .prepare("UPDATE accounts SET encrypted_refresh_token = ?, updated_at = ? WHERE id = ?")
    .run(encryptSecret(refreshToken), new Date().toISOString(), accountId);
}

export async function getAccessToken(accountId: string): Promise<AccessTokenResult> {
  const cached = tokenCache.get(accountId);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.value;
  }

  const existing = pendingRefresh.get(accountId);
  if (existing) {
    return existing;
  }

  const account = getAccountRecord(accountId);
  if (!account) {
    throw new Error("账号不存在");
  }

  const promise = refreshAccountToken(account).finally(() => {
    pendingRefresh.delete(accountId);
  });
  pendingRefresh.set(accountId, promise);
  return promise;
}

async function refreshAccountToken(account: AccountRow): Promise<AccessTokenResult> {
  const refreshToken = decryptSecret(account.encrypted_refresh_token);
  const result = await refreshAccessToken(
    account.client_id,
    refreshToken,
    getRuntimeProxyUrl()
  );

  if (result.refreshToken) {
    saveRotatedToken(account.id, result.refreshToken);
  }
  updateAccountState(account.id, { authMode: result.authMode });

  const expiresAt = Date.now() + Math.max((result.expiresIn || 300) - 60, 60) * 1_000;
  tokenCache.set(account.id, { value: result, expiresAt });
  return result;
}

export function invalidateAccessToken(accountId?: string) {
  if (accountId) {
    tokenCache.delete(accountId);
    return;
  }
  tokenCache.clear();
}
