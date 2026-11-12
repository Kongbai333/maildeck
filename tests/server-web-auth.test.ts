import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(path.join(tmpdir(), "maildeck-web-auth-test-"));
process.env.MAILDECK_DATA_DIR = dataDir;
process.env.MAILDECK_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
process.env.MAILDECK_ADMIN_USERNAME = "admin";
process.env.MAILDECK_ADMIN_PASSWORD = "admin-pass-123";
process.env.MAILDECK_RELEASE_CLEAR_INBOX = "0";

const ADMIN_PASSWORD = "admin-pass-123";

let app: FastifyInstance;
let dbModule: typeof import("../server/src/db.js");
let domainService: typeof import("../server/src/domain-service.js");
let cryptoModule: typeof import("../server/src/crypto.js");

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? String(raw[0]) : typeof raw === "string" ? raw : "";
  const match = /md_session=([^;]+)/u.exec(value);
  if (!match?.[1]) {
    throw new Error(`登录响应缺少会话 Cookie：${value}`);
  }
  return `md_session=${match[1]}`;
}

function cookieHeader(cookie: string) {
  return { cookie };
}

beforeAll(async () => {
  dbModule = await import("../server/src/db.js");
  domainService = await import("../server/src/domain-service.js");
  cryptoModule = await import("../server/src/crypto.js");
  const { buildServer } = await import("../server/src/index.js");
  app = buildServer();
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  dbModule.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
}, 30_000);

describe("网页端多用户与邮箱池", () => {
  it("未登录访问受保护接口返回 401", async () => {
    const response = await app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });

  it("管理员登录后可访问后台接口，密码错误被拒绝", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong-password" }
    });
    expect(bad.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ADMIN", password: ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ ok: true, value: { username: "admin", role: "admin" } });
    const cookie = sessionCookie(login);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: cookieHeader(cookie) });
    expect(me.statusCode).toBe(200);

    const overview = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: cookieHeader(cookie)
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ ok: true, value: { users: { total: 1 } } });

    // 遗留账号接口对管理员仍然开放
    const legacy = await app.inject({ method: "GET", url: "/api/accounts", headers: cookieHeader(cookie) });
    expect(legacy.statusCode).toBe(200);
  });

  it("普通用户不能访问后台接口，可以领取邮箱且受配额限制", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: ADMIN_PASSWORD }
    });
    const adminCookie = sessionCookie(adminLogin);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: cookieHeader(adminCookie),
      payload: { username: "alice", password: "alice-pass-1", role: "user", mailboxQuota: 1 }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ ok: true, value: { username: "alice", mailboxCount: 0 } });

    const aliceLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "alice-pass-1" }
    });
    const aliceCookie = sessionCookie(aliceLogin);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes",
      headers: cookieHeader(aliceCookie)
    });
    expect(forbidden.statusCode).toBe(403);

    const emptyClaim = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/claim",
      headers: cookieHeader(aliceCookie),
      payload: {}
    });
    expect(emptyClaim.statusCode).toBe(409);
    expect(emptyClaim.json()).toMatchObject({ error: { code: "CONFLICT" } });

    // 造一个服务商和两个域名/临时邮箱（供后续分配测试用）
    const providers = domainService.createProvider({
      name: "测试服务商",
      type: "gptmail",
      apiKey: "test-key",
      keyMode: "personal"
    });
    const providerId = providers[0]?.id ?? "";
    expect(providerId).not.toBe("");
    domainService.upsertMailboxRow({ providerId, email: "pool-a@example.com" });
    domainService.upsertMailboxRow({ providerId, email: "pool-b@example.com" });

    // 池子只含 Outlook 账号：直接塞一条微软账号
    const timestamp = new Date().toISOString();
    dbModule.getDb()
      .prepare(`
        INSERT INTO accounts
          (id, email, client_id, encrypted_refresh_token, remark, group_name, tags_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', '', '[]', 'valid', ?, ?)
      `)
      .run("acc-outlook-1", "outlook-a@example.com", "client-id", cryptoModule.encryptSecret("M.token"), timestamp, timestamp);

    const claim = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/claim",
      headers: cookieHeader(aliceCookie),
      payload: {}
    });
    expect(claim.statusCode).toBe(200);
    const claimed = claim.json<{ value: { mailbox: { id: string; email: string; status: string; kind: string } } }>();
    expect(claimed.value.mailbox.email).toBe("outlook-a@example.com");
    expect(claimed.value.mailbox.status).toBe("assigned");
    expect(claimed.value.mailbox.kind).toBe("outlook");

    const overQuota = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/claim",
      headers: cookieHeader(aliceCookie),
      payload: {}
    });
    expect(overQuota.statusCode).toBe(409);

    const mine = await app.inject({ method: "GET", url: "/api/me/mailboxes", headers: cookieHeader(aliceCookie) });
    expect(mine.json<{ value: unknown[] }>().value).toHaveLength(1);

    // 管理员能看到领取人（默认只看 Outlook 池）
    const pool = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes?status=assigned",
      headers: cookieHeader(adminCookie)
    });
    const rows = pool.json<{ value: Array<{ email: string; assignedUsername: string }> }>().value;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "outlook-a@example.com", assignedUsername: "alice" });

    // 释放后回到池子
    const release = await app.inject({
      method: "POST",
      url: `/api/me/mailboxes/${claimed.value.mailbox.id}/release`,
      headers: cookieHeader(aliceCookie)
    });
    expect(release.statusCode).toBe(200);
    const afterRelease = await app.inject({
      method: "GET",
      url: "/api/me/mailboxes",
      headers: cookieHeader(aliceCookie)
    });
    expect(afterRelease.json<{ value: unknown[] }>().value).toHaveLength(0);
  });

  it("管理员可分配邮箱、停用用户，删除用户后邮箱回到池中", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: ADMIN_PASSWORD }
    });
    const adminCookie = sessionCookie(adminLogin);

    const users = await app.inject({ method: "GET", url: "/api/admin/users", headers: cookieHeader(adminCookie) });
    const alice = users.json<{ value: Array<{ id: string; username: string }> }>().value.find((item) => item.username === "alice");
    expect(alice).toBeTruthy();

    const pool = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes?status=available&kind=temp",
      headers: cookieHeader(adminCookie)
    });
    const mailbox = pool.json<{ value: Array<{ id: string; email: string }> }>().value[0];
    expect(mailbox).toBeTruthy();

    const assigned = await app.inject({
      method: "POST",
      url: `/api/admin/mailboxes/${mailbox.id}/assign`,
      headers: cookieHeader(adminCookie),
      payload: { userId: alice?.id }
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({ value: { assignedUsername: "alice" } });

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${alice?.id}`,
      headers: cookieHeader(adminCookie),
      payload: { status: "disabled" }
    });
    expect(disabled.statusCode).toBe(200);

    // 停用后旧会话失效
    const aliceMe = await app.inject({
      method: "GET",
      url: "/api/me/mailboxes",
      headers: cookieHeader("md_session=stale")
    });
    expect(aliceMe.statusCode).toBe(401);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${alice?.id}`,
      headers: cookieHeader(adminCookie)
    });
    expect(removed.statusCode).toBe(200);

    const poolAfter = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes?kind=temp",
      headers: cookieHeader(adminCookie)
    });
    const rows = poolAfter.json<{ value: Array<{ email: string; status: string; assignedUsername: string | null }> }>().value;
    const target = rows.find((row) => row.email === mailbox.email);
    expect(target).toMatchObject({ status: "available", assignedUsername: null });
  });

  it("管理员批量导入 Outlook 账号：跳过非法行", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: ADMIN_PASSWORD }
    });
    const adminCookie = sessionCookie(adminLogin);

    const at = String.fromCharCode(64);
    const token = "M." + "y".repeat(90);
    const line = (local: string) => `${local}${at}example.com----pw----00000000-0000-0000-0000-000000000001----${token}`;
    const imported = await app.inject({
      method: "POST",
      url: "/api/admin/outlook/import",
      headers: cookieHeader(adminCookie),
      payload: { text: ["# 注释行", line("bulk-a"), "not-an-account", line("bulk-b")].join("\n") }
    });
    expect(imported.statusCode).toBe(200);
    const result = imported.json<{ value: { imported: number; skipped: number; errors: string[] } }>().value;
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);

    const pool = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes?kind=outlook&q=bulk",
      headers: cookieHeader(adminCookie)
    });
    expect(pool.json<{ value: Array<{ email: string; kind: string }> }>().value).toHaveLength(2);
  });

  it("管理员可以删除 Outlook 账号池里的邮箱", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: ADMIN_PASSWORD }
    });
    const adminCookie = sessionCookie(adminLogin);

    const at = String.fromCharCode(64);
    const token = "M." + "w".repeat(90);
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/outlook/import",
      headers: cookieHeader(adminCookie),
      payload: { text: `${at ? "del-me" : ""}${at}outlook.test----pw----00000000-0000-0000-0000-000000000001----${token}` }
    });
    expect(created.statusCode).toBe(200);

    const pool = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes?kind=outlook&q=del-me",
      headers: cookieHeader(adminCookie)
    });
    const row = pool.json<{ value: Array<{ id: string; email: string }> }>().value[0];
    expect(row).toBeTruthy();

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/mailboxes/${row?.id}`,
      headers: cookieHeader(adminCookie)
    });
    expect(removed.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes?kind=outlook&q=del-me",
      headers: cookieHeader(adminCookie)
    });
    expect(after.json<{ value: unknown[] }>().value).toHaveLength(0);
  });
  it("停用保留归属、重新启用可恢复，回收才真正释放", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: ADMIN_PASSWORD }
    });
    const adminCookie = sessionCookie(adminLogin);

    const users = await app.inject({ method: "GET", url: "/api/admin/users", headers: cookieHeader(adminCookie) });
    const admin = users.json<{ value: Array<{ id: string; username: string }> }>().value.find((item) => item.username === "admin");
    expect(admin).toBeTruthy();

    const pool = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes?status=available&kind=temp",
      headers: cookieHeader(adminCookie)
    });
    const mailbox = pool.json<{ value: Array<{ id: string }> }>().value[0];
    expect(mailbox).toBeTruthy();

    const assigned = await app.inject({
      method: "POST",
      url: `/api/admin/mailboxes/${mailbox?.id}/assign`,
      headers: cookieHeader(adminCookie),
      payload: { userId: admin?.id }
    });
    expect(assigned.statusCode).toBe(200);

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/admin/mailboxes/${mailbox?.id}`,
      headers: cookieHeader(adminCookie),
      payload: { status: "disabled" }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      value: { status: "disabled", assignedUserId: admin?.id, assignedUsername: "admin" }
    });

    const enabled = await app.inject({
      method: "PATCH",
      url: `/api/admin/mailboxes/${mailbox?.id}`,
      headers: cookieHeader(adminCookie),
      payload: { status: "assigned" }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ value: { status: "assigned", assignedUserId: admin?.id } });

    const reclaimed = await app.inject({
      method: "PATCH",
      url: `/api/admin/mailboxes/${mailbox?.id}`,
      headers: cookieHeader(adminCookie),
      payload: { status: "available" }
    });
    expect(reclaimed.statusCode).toBe(200);
    expect(reclaimed.json()).toMatchObject({ value: { status: "available", assignedUserId: null } });

    const invalidRestore = await app.inject({
      method: "PATCH",
      url: `/api/admin/mailboxes/${mailbox?.id}`,
      headers: cookieHeader(adminCookie),
      payload: { status: "assigned" }
    });
    expect(invalidRestore.statusCode).toBe(409);
  });

  it("管理员可重置密码，旧会话随之失效", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: ADMIN_PASSWORD }
    });
    const adminCookie = sessionCookie(adminLogin);

    const users = await app.inject({ method: "GET", url: "/api/admin/users", headers: cookieHeader(adminCookie) });
    const admin = users.json<{ value: Array<{ id: string; username: string }> }>().value.find((item) => item.username === "admin");
    expect(admin).toBeTruthy();

    const reset = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${admin?.id}`,
      headers: cookieHeader(adminCookie),
      payload: { password: "new-admin-pass" }
    });
    expect(reset.statusCode).toBe(200);

    const stale = await app.inject({ method: "GET", url: "/api/admin/overview", headers: cookieHeader(adminCookie) });
    expect(stale.statusCode).toBe(401);

    const relogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "new-admin-pass" }
    });
    expect(relogin.statusCode).toBe(200);
  });
});
