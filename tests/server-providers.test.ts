import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(path.join(tmpdir(), "maildeck-providers-test-"));
process.env.MAILDECK_DATA_DIR = dataDir;
process.env.MAILDECK_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.MAILDECK_ADMIN_USERNAME = "admin";
process.env.MAILDECK_ADMIN_PASSWORD = "providers-admin-pass";
process.env.MAILDECK_RELEASE_CLEAR_INBOX = "0";

let app: FastifyInstance;
let dbModule: typeof import("../server/src/db.js");
let adapters: typeof import("../server/src/domain-adapters.js");
let mock: Server;
let mockBase = "";

const ADMIN_PASSWORD = "providers-admin-pass";

const AT = String.fromCharCode(64);
const mail = (local: string, domain: string): string => `${local}${AT}${domain}`;
const DEMO_MAIL = mail("demo", "mock.tm");

function json(response: import("node:http").ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

function startMockMailtm(): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const auth = String(request.headers.authorization ?? "");

    if (url.pathname === "/domains") {
      json(response, 200, { "hydra:member": [{ domain: "mock.tm", isActive: true, isPrivate: false }] });
      return;
    }
    if (url.pathname === "/accounts" && request.method === "POST") {
      json(response, 201, { id: "acc-1", address: DEMO_MAIL });
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      json(response, 200, { token: "token-ok", id: "acc-1" });
      return;
    }
    if (!auth.startsWith("Bearer ")) {
      json(response, 401, { message: "unauthorized" });
      return;
    }
    if (url.pathname === "/messages") {
      json(response, 200, {
        "hydra:member": [
          {
            id: "m-1",
            subject: "验证码",
            intro: "你的验证码是 246810",
            from: { address: "noreply@mock.tm", name: "Mock" },
            createdAt: new Date("2026-11-11T10:00:00Z").toISOString(),
            seen: false,
            hasAttachments: false
          }
        ]
      });
      return;
    }
    if (url.pathname === "/messages/m-1") {
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      json(response, 200, {
        id: "m-1",
        subject: "验证码",
        from: { address: "noreply@mock.tm", name: "Mock" },
        to: [{ address: DEMO_MAIL, name: "" }],
        createdAt: new Date("2026-11-11T10:00:00Z").toISOString(),
        seen: false,
        html: ["<p>你的验证码是 <b>246810</b></p>"],
        text: "你的验证码是 246810",
        attachments: [{ id: "a1", filename: "code.txt", contentType: "text/plain", size: 12 }]
      });
      return;
    }
    json(response, 404, { message: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? String(raw[0]) : typeof raw === "string" ? raw : "";
  const match = /md_session=([^;]+)/u.exec(value);
  if (!match?.[1]) {
    throw new Error(`登录响应缺少会话 Cookie：${value}`);
  }
  return `md_session=${match[1]}`;
}

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return cookieHeader(response);
}

beforeAll(async () => {
  mock = await startMockMailtm();
  const address = mock.address();
  const port = typeof address === "object" && address ? address.port : 0;
  mockBase = `http://127.0.0.1:${port}`;
  dbModule = await import("../server/src/db.js");
  adapters = await import("../server/src/domain-adapters.js");
  const { buildServer } = await import("../server/src/index.js");
  app = buildServer();
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  dbModule.closeDb();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}, 30_000);

describe("服务商适配器与用户自助导入/生成", () => {
  it("imapMessageMatches 只认收件人/抄送/密送命中的邮件", () => {
    const envelope = {
      to: [{ address: "Alpha@Example.com" }],
      cc: [{ address: "other@example.com" }],
      bcc: []
    };
    expect(adapters.imapMessageMatches(envelope, "alpha@example.com")).toBe(true);
    expect(adapters.imapMessageMatches(envelope, "other@example.com")).toBe(true);
    expect(adapters.imapMessageMatches(envelope, "nobody@example.com")).toBe(false);
    expect(adapters.imapMessageMatches({}, "alpha@example.com")).toBe(false);
  });

  it("mail.tm 适配器：生成地址带口令，读信/详情/删除走 Bearer", async () => {
    const adapter = adapters.getAdapter("mailtm");
    const config = { baseUrl: mockBase, apiKey: "", meta: {} };
    const generated = await adapter.generateEmail(config, { prefix: "demo" });
    expect(generated.email).toBe(DEMO_MAIL);
    expect(generated.secret).toBeTruthy();

    const credentials = { email: generated.email, secret: generated.secret ?? "" };
    const messages = await adapter.listMessages(config, generated.email, credentials);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "m-1", subject: "验证码", isRead: false });

    const detail = await adapter.getMessage(config, generated.email, "m-1", credentials);
    expect(detail.body.contentType).toBe("html");
    expect(detail.body.content).toContain("246810");
    expect(detail.attachments[0]).toMatchObject({ filename: "code.txt", size: 12 });

    await expect(adapter.deleteMessage(config, generated.email, "m-1", credentials)).resolves.toBeUndefined();
    await expect(
      adapter.listMessages(config, generated.email, { email: generated.email, secret: "" })
    ).rejects.toThrow("登录口令");
  });

  it("管理员可创建 mail.tm / imap 服务商，类型信息带 kind 与 meta", async () => {
    const adminCookie = await login("admin", ADMIN_PASSWORD);

    const types = await app.inject({
      method: "GET",
      url: "/api/admin/provider-types",
      headers: { cookie: adminCookie }
    });
    const typeRows = types.json<{ value: Array<{ type: string; kind: string; configFields: string[] }> }>().value;
    expect(typeRows.map((row) => row.type)).toEqual(expect.arrayContaining(["gptmail", "mailtm", "imap"]));
    const imapType = typeRows.find((row) => row.type === "imap");
    expect(imapType?.kind).toBe("domain");
    expect(imapType?.configFields).toEqual(expect.arrayContaining(["host", "user", "domain"]));

    const mailtm = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: adminCookie },
      payload: { name: "Mock mail.tm", type: "mailtm", baseUrl: mockBase }
    });
    expect(mailtm.statusCode).toBe(200);
    const mailtmRow = mailtm
      .json<{ value: Array<{ id: string; type: string; kind: string; typeLabel: string }> }>()
      .value.find((row) => row.type === "mailtm");
    expect(mailtmRow).toMatchObject({ kind: "temp" });

    const missingDomain = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: adminCookie },
      payload: { type: "imap", apiKey: "pass", meta: { host: "imap.example.com", user: "me@example.com" } }
    });
    expect(missingDomain.statusCode).toBe(400);

    const imap = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie: adminCookie },
      payload: {
        type: "imap",
        apiKey: "imap-pass",
        meta: { host: "imap.example.com", port: "993", secure: "1", user: "me@example.com", domain: "example.com" }
      }
    });
    expect(imap.statusCode).toBe(200);
    const imapRow = imap
      .json<{ value: Array<{ id: string; kind: string; baseUrl: string; meta: Record<string, string> }> }>()
      .value.find((row) => row.kind === "domain");
    expect(imapRow).toMatchObject({
      baseUrl: "imaps://imap.example.com:993",
      meta: { host: "imap.example.com", domain: "example.com" }
    });

    const domains = await app.inject({
      method: "GET",
      url: `/api/admin/providers/${imapRow?.id}/domains`,
      headers: { cookie: adminCookie }
    });
    expect(domains.json()).toMatchObject({ value: [{ domain: "example.com", wildcard: true }] });
  });

  it("用户可自助生成并读取 mail.tm 邮箱", async () => {
    const adminCookie = await login("admin", ADMIN_PASSWORD);
    const providers = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      headers: { cookie: adminCookie }
    });
    const mailtmId = providers
      .json<{ value: Array<{ id: string; type: string }> }>()
      .value.find((row) => row.type === "mailtm")?.id;
    expect(mailtmId).toBeTruthy();

    await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie },
      payload: { username: "selfgen", password: "selfgen-pass", mailboxQuota: 2 }
    });
    const userCookie = await login("selfgen", "selfgen-pass");

    const options = await app.inject({ method: "GET", url: "/api/me/providers", headers: { cookie: userCookie } });
    expect(options.statusCode).toBe(200);
    const mailtmOption = options
      .json<{ value: Array<{ id: string; type: string; supportsImport: boolean; supportsGenerate: boolean }> }>()
      .value.find((row) => row.type === "mailtm");
    expect(mailtmOption).toMatchObject({ supportsImport: false, supportsGenerate: true });

    const generated = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/generate",
      headers: { cookie: userCookie },
      payload: { providerId: mailtmId, prefix: "demo", count: 1 }
    });
    expect(generated.statusCode).toBe(200);
    const mailbox = generated.json<{ value: { mailboxes: Array<{ id: string; email: string }> } }>().value
      .mailboxes[0];
    expect(mailbox?.email).toBe(DEMO_MAIL);

    const messages = await app.inject({
      method: "GET",
      url: `/api/me/mailboxes/${mailbox?.id}/messages`,
      headers: { cookie: userCookie }
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json<{ value: Array<{ subject: string }> }>().value[0]).toMatchObject({ subject: "验证码" });

    // 配额 2：再生成 3 个只会成功 1 个
    const second = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/generate",
      headers: { cookie: userCookie },
      payload: { providerId: mailtmId, prefix: "demo", count: 3 }
    });
    expect(second.json<{ value: { mailboxes: unknown[] } }>().value.mailboxes).toHaveLength(1);
  });

  it("用户只能导入 Outlook 账号，且自助导入不占配额", async () => {
    const adminCookie = await login("admin", ADMIN_PASSWORD);
    const providers = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      headers: { cookie: adminCookie }
    });
    const rows = providers.json<{ value: Array<{ id: string; type: string; supportsImport?: boolean }> }>().value;
    expect(rows.length).toBeGreaterThan(0);

    await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie },
      payload: { username: "importer", password: "importer-pass", mailboxQuota: 1 }
    });
    const userCookie = await login("importer", "importer-pass");

    const options = await app.inject({ method: "GET", url: "/api/me/providers", headers: { cookie: userCookie } });
    const optionRows = options.json<{ value: Array<{ supportsImport: boolean; kind: string }> }>().value;
    expect(optionRows.length).toBeGreaterThan(0);
    // 域名/临时服务商都不能导入，只能生成
    expect(optionRows.every((row) => row.supportsImport === false)).toBe(true);

    const token = "M." + "z".repeat(90);
    const line = (local: string) => `${local}${AT}outlook.test----pw----00000000-0000-0000-0000-000000000001----${token}`;
    const imported = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/import",
      headers: { cookie: userCookie },
      payload: { text: [line("imp-one"), line("imp-two"), line("imp-three")].join("\n") }
    });
    expect(imported.statusCode).toBe(200);
    // 自助导入不占配额：配额只有 1 个，三条全部导入成功
    expect(imported.json()).toMatchObject({ value: { imported: 3, quotaSkipped: 0 } });

    const mine = await app.inject({ method: "GET", url: "/api/me/mailboxes", headers: { cookie: userCookie } });
    const mineRows = mine.json<{ value: Array<{ kind: string; quotaExempt: boolean }> }>().value;
    expect(mineRows).toHaveLength(3);
    expect(mineRows.every((row) => row.kind === "outlook")).toBe(true);
    expect(mineRows.every((row) => row.quotaExempt === true)).toBe(true);

    // 再导入一条也不受配额限制
    const again = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/import",
      headers: { cookie: userCookie },
      payload: { text: line("imp-four") }
    });
    expect(again.json()).toMatchObject({ value: { imported: 1, quotaSkipped: 0 } });

    // 服务商维度的导入接口对域名/临时邮箱一律拒绝
    const gptmailId = rows.find((row) => row.type === "gptmail")?.id;
    const providerImport = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/import",
      headers: { cookie: userCookie },
      payload: { providerId: gptmailId, text: DEMO_MAIL }
    });
    expect(providerImport.statusCode).toBe(200);
    expect(providerImport.json<{ value: { imported: number } }>().value.imported).toBe(0);
  });
});
