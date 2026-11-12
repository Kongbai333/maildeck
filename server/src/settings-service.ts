import type { AppSettings, AppSettingsUpdate } from "../../electron/shared/ipc-contracts.js";
import { serverConfig } from "./config.js";
import { getDb } from "./db.js";

const DEFAULT_SETTINGS: AppSettings = {
  cacheMessages: true,
  cacheBodies: true,
  proxyUrl: serverConfig.proxyUrl,
  proxyUsername: "",
  proxyHasPassword: false,
  proxySupported: true,
  batchConcurrency: 4,
  hotmailFallbackEnabled: false,
  autoRefreshEnabled: false,
  autoRefreshIntervalMinutes: 10,
  refreshScope: "all",
  autoUpdateCheckEnabled: false,
  closeToTray: false,
  launchAtStartup: false
};

function readStoredSettings(): Partial<AppSettings> {
  const row = getDb()
    .prepare("SELECT payload FROM settings WHERE id = 1")
    .get() as { payload: string } | undefined;
  if (!row) {
    return {};
  }
  try {
    return JSON.parse(row.payload) as Partial<AppSettings>;
  } catch {
    return {};
  }
}

function writeStoredSettings(settings: AppSettings) {
  getDb()
    .prepare(`
      INSERT INTO settings (id, payload, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `)
    .run(JSON.stringify(settings), new Date().toISOString());
}

export function getSettings(): AppSettings {
  const stored = readStoredSettings();
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    proxyUrl: stored.proxyUrl?.trim() || serverConfig.proxyUrl,
    proxySupported: true
  };
}

export function getRuntimeProxyUrl() {
  return getSettings().proxyUrl;
}

export function updateSettings(update: AppSettingsUpdate): AppSettings {
  const current = getSettings();
  const next: AppSettings = {
    ...current,
    cacheMessages: update.cacheMessages ?? current.cacheMessages,
    cacheBodies: update.cacheBodies ?? current.cacheBodies,
    proxyUrl: update.proxyUrl !== undefined ? update.proxyUrl.trim() : current.proxyUrl,
    proxyUsername: update.proxyUsername !== undefined ? update.proxyUsername.trim() : current.proxyUsername,
    batchConcurrency: update.batchConcurrency ?? current.batchConcurrency,
    hotmailFallbackEnabled: update.hotmailFallbackEnabled ?? current.hotmailFallbackEnabled,
    autoRefreshEnabled: update.autoRefreshEnabled ?? current.autoRefreshEnabled,
    autoRefreshIntervalMinutes:
      update.autoRefreshIntervalMinutes ?? current.autoRefreshIntervalMinutes,
    refreshScope: update.refreshScope ?? current.refreshScope,
    autoUpdateCheckEnabled: update.autoUpdateCheckEnabled ?? current.autoUpdateCheckEnabled,
    closeToTray: update.closeToTray ?? current.closeToTray,
    launchAtStartup: update.launchAtStartup ?? current.launchAtStartup
  };

  if (update.proxyPassword) {
    next.proxyHasPassword = true;
  }
  if (update.clearProxyPassword) {
    next.proxyHasPassword = false;
  }

  writeStoredSettings(next);
  return next;
}
