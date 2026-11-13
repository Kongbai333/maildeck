import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { MailMessageDetail } from "../shared/mail-contracts.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "maildeck-message-routing-"));
process.env.MAILDECK_DATA_DIR = dataDir;
process.env.MAILDECK_MASTER_KEY = Buffer.alloc(32, 6).toString("base64");
process.env.MAILDECK_ADMIN_USERNAME = "route-admin";
process.env.MAILDECK_ADMIN_PASSWORD = "route-fixture-password";
process.env.MAILDECK_RELEASE_CLEAR_INBOX = "0";

const accountId = "outlook-route-fixture";
const password = "route-fixture-password";
const messageIds = [
  "short-message-id",
  `AAMk${"a".repeat(180)}==`,
  `AAMk${"a+/=".repeat(75)}`,
  "A".repeat(4096),
];
let app: FastifyInstance;
let database: typeof import("../server/src/db.js");
let adminCookie = "";
let ownerCookie = "";
let otherCookie = "";
const upstream = vi.fn(() => { throw new Error("These cached-message routing tests must not call upstream services"); });

async function login(username: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0];
  if (!cookie) throw new Error("Fixture login did not return a session cookie");
  return cookie;
}

beforeAll(async () => {
  vi.stubGlobal("fetch", upstream);
  database = await import("../server/src/db.js");
  const { buildServer } = await import("../server/src/index.js");
  const { createUser } = await import("../server/src/auth-service.js");
  const { saveDetail } = await import("../server/src/cache-service.js");
  app = buildServer();
  await app.ready();
  const owner = createUser({ username: "route-owner", password });
  createUser({ username: "route-other", password });
  const stamp = new Date().toISOString();
  database.getDb().prepare(`
    INSERT INTO accounts (id, email, client_id, encrypted_refresh_token, status, inbox_folder_id, assigned_user_id, created_at, updated_at)
    VALUES (?, ?, 'fixture-client', 'unused-cached-fixture', 'valid', 'inbox', ?, ?, ?)
  `).run(accountId, "route-mail@example.invalid", owner.id, stamp, stamp);
  for (const id of messageIds) {
    const message: MailMessageDetail = {
      id, subject: "Cached Outlook message", from: null, receivedDateTime: stamp, sentDateTime: null,
      isRead: false, importance: "normal", hasAttachments: false, bodyPreview: "cached body", webLink: null,
      toRecipients: [], ccRecipients: [], body: { contentType: "text", content: "The route reached the correct cached message." },
    };
    saveDetail(accountId, "inbox", message);
  }
  adminCookie = await login("route-admin");
  ownerCookie = await login("route-owner");
  otherCookie = await login("route-other");
}, 30000);

afterAll(async () => {
  if (app) await app.close();
  if (database) database.closeDb();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

function messagePath(prefix: string, id: string): string {
  return `${prefix}/${accountId}/messages/${encodeURIComponent(id)}`;
}

describe("Outlook message detail route parameter lengths", () => {
  for (const [index, id] of messageIds.entries()) {
    it(`opens owner message fixture ${index + 1} (${id.length} characters)`, async () => {
      const response = await app.inject({ method: "GET", url: messagePath("/api/me/mailboxes", id), headers: { cookie: ownerCookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, value: { id, body: { content: "The route reached the correct cached message." } } });
      expect(upstream).not.toHaveBeenCalled();
    });
    it(`opens admin message fixture ${index + 1} (${id.length} characters)`, async () => {
      const response = await app.inject({ method: "GET", url: messagePath("/api/admin/mailboxes", id), headers: { cookie: adminCookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, value: { id } });
      expect(upstream).not.toHaveBeenCalled();
    });
  }

  it("still checks mailbox ownership for long message IDs", async () => {
    const response = await app.inject({ method: "GET", url: messagePath("/api/me/mailboxes", messageIds[1]), headers: { cookie: otherCookie } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND", message: "邮箱不存在" } });
  });

  it("still rejects ordinary users on admin message routes", async () => {
    const response = await app.inject({ method: "GET", url: messagePath("/api/admin/mailboxes", messageIds[1]), headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(403);
  });

  it("still requires a session for long message IDs", async () => {
    const response = await app.inject({ method: "GET", url: messagePath("/api/me/mailboxes", messageIds[1]) });
    expect(response.statusCode).toBe(401);
  });

  it("retains a finite bound for excessively long route parameters", async () => {
    const response = await app.inject({ method: "GET", url: messagePath("/api/me/mailboxes", "A".repeat(4097)), headers: { cookie: ownerCookie } });
    // The default router uses 414; the built webapp's custom not-found handler uses 404.
    expect([404, 414]).toContain(response.statusCode);
    expect(upstream).not.toHaveBeenCalled();
  });
});
