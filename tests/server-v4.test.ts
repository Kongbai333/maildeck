import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(path.join(tmpdir(), "maildeck-v4-test-"));
process.env.MAILDECK_DATA_DIR = dataDir;
process.env.MAILDECK_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.MAILDECK_ADMIN_USERNAME = "admin";
process.env.MAILDECK_ADMIN_PASSWORD = "v4-admin-pass";
process.env.MAILDECK_RELEASE_CLEAR_INBOX = "0";

const AT = String.fromCharCode(64);
const mail = (local: string, domain: string): string => `${local}${AT}${domain}`;

let app: FastifyInstance;
let dbModule: typeof import("../server/src/db.js");
let adapters: typeof import("../server/src/domain-adapters.js");
let mock: Server;
let mockBase = "";
let yydsCalls: { key: string; path: string; method: string }[] = [];
let failNextList = 0;

function json(response: import("node:http").ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}

/** 假 YYDS Mail：第一把 Key 永远 401，第二把才通过，用来验证多 Key 轮换。 */
function startMockYyds(): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = String(request.headers["x-api-key"] ?? "");
    yydsCalls.push({ key, path: url.pathname, method: String(request.method) });
    if (key === "AC-bad") {
      json(response, 401, { success: false, message: "invalid key" });
      return;
    }
    if (url.pathname === "/v1/domains") {
      json(response, 200, { success: true, data: { domains: [{ domain: "yyds.test" }] } });
      return;
    }
    if (url.pathname === "/v1/accounts" && request.method === "POST") {
      json(response, 201, { success: true, data: { id: "acc-1", address: mail("yyds-demo", "yyds.test"), token: "temp-token" } });
      return;
    }
    if (url.pathname === "/v1/messages" && request.method === "GET") {
      if (failNextList > 0) {
        failNextList -= 1;
        json(response, 500, { success: false, message: "upstream exploded" });
        return;
      }
      json(response, 200, {
        success: true,
        data: {
          messages: [
            {
              id: "msg-1",
              from: { name: "YYDS", address: mail("noreply", "yyds.test") },
              to: [{ address: url.searchParams.get("address") ?? "" }],
              subject: "你的验证码",
              seen: false,
              hasAttachments: false,
              createdAt: new Date("2026-11-12T01:00:00Z").toISOString()
            }
          ]
        }
      });
      return;
    }
    if (/^\/v1\/messages\/[^/]+$/u.test(url.pathname) && request.method === "GET") {
      json(response, 200, {
        success: true,
        data: {
          id: "msg-1",
          from: { name: "YYDS", address: mail("noreply", "yyds.test") },
          to: [{ address: mail("yyds-demo", "yyds.test") }],
          subject: "你的验证码",
          text: "你的验证码是 112233",
          html: ["<p>你的验证码是 <b>112233</b></p>"],
          seen: true,
          hasAttachments: false,
          createdAt: new Date("2026-11-12T01:00:00Z").toISOString()
        }
      });
      return;
    }
    if (/^\/v1\/messages\/[^/]+$/u.test(url.pathname) && request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    json(response, 404, { success: false, message: "not found" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? String(raw[0]) : typeof raw === "string" ? raw : "";
  const match = /md_session=([^;]+)/u.exec(value);
  if (!match?.[1]) {
    throw new Error(`缺少会话 Cookie：${value}`);
  }
  return `md_session=${match[1]}`;
}

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return cookieOf(response);
}

beforeAll(async () => {
  mock = await startMockYyds();
  const address = mock.address();
  mockBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
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

describe("v4：YYDS 多 Key、邮件缓存、批量操作、统一获取", () => {
  it("YYDS 适配器在多 Key 下自动跳过失效 Key", async () => {
    yydsCalls = [];
    const adapter = adapters.getAdapter("yyds");
    const config = {
      baseUrl: mockBase,
      apiKey: "AC-bad",
      apiKeys: ["AC-bad", "AC-good"],
      meta: {}
    };
    const generated = await adapter.generateEmail(config, { prefix: "demo" });
    expect(generated.email).toBe(mail("yyds-demo", "yyds.test"));
    expect(generated.secret).toBe("temp-token");
    expect(yydsCalls.some((call) => call.key === "AC-good")).toBe(true);

    const messages = await adapter.listMessages(config, generated.email, { email: generated.email, secret: "temp-token" });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "msg-1", subject: "你的验证码", isRead: false });
  });

  it("管理员可用多 Key 创建 YYDS 服务商，keyCount 反映 Key 数量", async () => {
    const cookie = await login("admin", "v4-admin-pass");
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      headers: { cookie },
      payload: {
        name: "YYDS 测试",
        type: "yyds",
        baseUrl: mockBase,
        apiKey: "AC-good",
        apiKeys: ["AC-second", "AC-third"]
      }
    });
    expect(created.statusCode).toBe(200);
    const row = created
      .json<{ value: Array<{ type: string; kind: string; keyCount: number; hasKey: boolean }> }>()
      .value.find((item) => item.type === "yyds");
    expect(row).toMatchObject({ kind: "temp", keyCount: 3, hasKey: true });
  });

  it("邮件列表与详情写入缓存，上游失败时回退缓存", async () => {
    const cookie = await login("admin", "v4-admin-pass");
    const providers = await app.inject({ method: "GET", url: "/api/admin/providers", headers: { cookie } });
    const yydsId = providers
      .json<{ value: Array<{ id: string; type: string }> }>()
      .value.find((item) => item.type === "yyds")?.id;

    await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie },
      payload: { username: "cacheuser", password: "cache-pass", quotas: { outlook: 0, domain: 0, temp: 5 } }
    });
    const userCookie = await login("cacheuser", "cache-pass");

    const acquired = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/acquire",
      headers: { cookie: userCookie },
      payload: { kind: "temp", providerId: yydsId }
    });
    expect(acquired.statusCode).toBe(200);
    const box = acquired.json<{ value: { mailbox: { id: string; kind: string }; kind: string } }>().value;
    expect(box.kind).toBe("temp");

    const first = await app.inject({
      method: "GET",
      url: `/api/me/mailboxes/${box.mailbox.id}/messages`,
      headers: { cookie: userCookie }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ value: unknown[] }>().value).toHaveLength(1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/me/mailboxes/${box.mailbox.id}/messages/msg-1`,
      headers: { cookie: userCookie }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ value: { body: { content: string } } }>().value.body.content).toContain("112233");

    // 让上游连续失败，仍应从缓存拿到列表与详情
    failNextList = 5;
    const cachedList = await app.inject({
      method: "GET",
      url: `/api/me/mailboxes/${box.mailbox.id}/messages`,
      headers: { cookie: userCookie }
    });
    expect(cachedList.statusCode).toBe(200);
    expect(cachedList.json<{ value: unknown[] }>().value).toHaveLength(1);

    const cachedDetail = await app.inject({
      method: "GET",
      url: `/api/me/mailboxes/${box.mailbox.id}/messages/msg-1`,
      headers: { cookie: userCookie }
    });
    expect(cachedDetail.statusCode).toBe(200);
    failNextList = 0;
  });

  it("邮箱池批量停用 / 启用 / 分配 / 删除", async () => {
    const cookie = await login("admin", "v4-admin-pass");
    const providers = await app.inject({ method: "GET", url: "/api/admin/providers", headers: { cookie } });
    const yydsId = providers
      .json<{ value: Array<{ id: string; type: string }> }>()
      .value.find((item) => item.type === "yyds")?.id;

    const generated = await app.inject({
      method: "POST",
      url: "/api/admin/mailboxes/generate",
      headers: { cookie },
      payload: { providerId: yydsId, count: 2 }
    });
    const ids = generated
      .json<{ value: { created: Array<{ id: string }> } }>()
      .value.created.map((item) => item.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);

    const disabled = await app.inject({
      method: "POST",
      url: "/api/admin/mailboxes/bulk",
      headers: { cookie },
      payload: { action: "disable", ids }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<{ value: { affected: number } }>().value.affected).toBe(ids.length);

    const tempRows = await app.inject({ method: "GET", url: "/api/admin/mailboxes?kind=temp", headers: { cookie } });
    const disabledRows = tempRows
      .json<{ value: Array<{ id: string; status: string }> }>()
      .value.filter((row) => ids.includes(row.id));
    expect(disabledRows.every((row) => row.status === "disabled")).toBe(true);

    const removed = await app.inject({
      method: "POST",
      url: "/api/admin/mailboxes/bulk",
      headers: { cookie },
      payload: { action: "delete", ids }
    });
    expect(removed.json<{ value: { affected: number } }>().value.affected).toBe(ids.length);
    const after = await app.inject({ method: "GET", url: "/api/admin/mailboxes?kind=temp", headers: { cookie } });
    expect(after.json<{ value: Array<{ id: string }> }>().value.filter((row) => ids.includes(row.id))).toHaveLength(0);
  });

  it("统一获取：outlook 领取、temp 生成并受对应配额限制", async () => {
    const cookie = await login("admin", "v4-admin-pass");
    // Outlook 池
    const token = "M." + "u".repeat(80);
    await app.inject({
      method: "POST",
      url: "/api/admin/outlook/import",
      headers: { cookie },
      payload: { text: `${mail("acquire", "outlook.test")}----pw----00000000-0000-0000-0000-000000000001----${token}` }
    });
    await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie },
      payload: { username: "acquser", password: "acq-pass", quotas: { outlook: 1, domain: 0, temp: 0 } }
    });
    const userCookie = await login("acquser", "acq-pass");

    const gotOutlook = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/acquire",
      headers: { cookie: userCookie },
      payload: { kind: "outlook" }
    });
    expect(gotOutlook.statusCode).toBe(200);
    expect(gotOutlook.json<{ value: { kind: string; mailbox: { kind: string } } }>().value.mailbox.kind).toBe("outlook");

    const noTemp = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/acquire",
      headers: { cookie: userCookie },
      payload: { kind: "temp" }
    });
    expect(noTemp.statusCode).toBe(409);
  });

  it("释放邮箱不退还额度，管理员可重置用量", async () => {
    const cookie = await login("admin", "v4-admin-pass");
    await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie },
      payload: { username: "quota-user", password: "quota-pass", quotas: { outlook: 1, domain: 0, temp: 1 } }
    });
    const userCookie = await login("quota-user", "quota-pass");
    const token = "M." + "q".repeat(80);
    await app.inject({
      method: "POST",
      url: "/api/admin/outlook/import",
      headers: { cookie },
      payload: {
        text: [
          mail("q-one", "outlook.test") + "----pw----00000000-0000-0000-0000-000000000001----" + token,
          mail("q-two", "outlook.test") + "----pw----00000000-0000-0000-0000-000000000001----" + token
        ].join("\n")
      }
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/acquire",
      headers: { cookie: userCookie },
      payload: { kind: "outlook" }
    });
    expect(first.statusCode).toBe(200);
    const box = first.json<{ value: { mailbox: { id: string } } }>().value.mailbox;

    const released = await app.inject({
      method: "POST",
      url: `/api/me/mailboxes/${box.id}/release`,
      headers: { cookie: userCookie }
    });
    expect(released.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/acquire",
      headers: { cookie: userCookie },
      payload: { kind: "outlook" }
    });
    expect(again.statusCode).toBe(409);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: userCookie } });
    expect(me.json<{ value: { quotaUsage: { outlook: number } } }>().value.quotaUsage.outlook).toBe(1);

    const users = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } });
    const target = users
      .json<{ value: Array<{ id: string; username: string }> }>()
      .value.find((item) => item.username === "quota-user");
    const reset = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${target?.id}`,
      headers: { cookie },
      payload: { resetUsage: true }
    });
    expect(reset.statusCode).toBe(200);
    const afterReset = await app.inject({
      method: "POST",
      url: "/api/me/mailboxes/acquire",
      headers: { cookie: userCookie },
      payload: { kind: "outlook" }
    });
    expect(afterReset.statusCode).toBe(200);
  });

  it("管理员导入 Outlook 可指定分配用户（默认不分配）", async () => {
    const cookie = await login("admin", "v4-admin-pass");
    await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie },
      payload: { username: "assignee", password: "assignee-pass", quotas: { outlook: 5, domain: 0, temp: 0 } }
    });
    const users = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } });
    const assignee = users
      .json<{ value: Array<{ id: string; username: string }> }>()
      .value.find((item) => item.username === "assignee");

    const token = "M." + "a".repeat(80);
    const line = (local: string) => `${mail(local, "outlook.test")}----pw----00000000-0000-0000-0000-000000000001----${token}`;
    const imported = await app.inject({
      method: "POST",
      url: "/api/admin/outlook/import",
      headers: { cookie },
      payload: { text: [line("imp-assign-1"), line("imp-assign-2")].join("\n"), userId: assignee?.id }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json<{ value: { imported: number; assigned: number } }>().value).toMatchObject({
      imported: 2,
      assigned: 2
    });

    const pool = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes?kind=outlook&q=imp-assign",
      headers: { cookie }
    });
    const rows = pool.json<{ value: Array<{ assignedUsername: string | null }> }>().value;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.assignedUsername === "assignee")).toBe(true);

    // 不传 userId 时保持未分配
    const noAssign = await app.inject({
      method: "POST",
      url: "/api/admin/outlook/import",
      headers: { cookie },
      payload: { text: line("imp-free-1") }
    });
    expect(noAssign.json<{ value: { assigned: number } }>().value.assigned).toBe(0);
    const freeRows = await app.inject({
      method: "GET",
      url: "/api/admin/mailboxes?kind=outlook&q=imp-free",
      headers: { cookie }
    });
    expect(freeRows.json<{ value: Array<{ assignedUsername: string | null }> }>().value[0]?.assignedUsername).toBeNull();
  });

  it("统计接口返回邮箱数与邮件接收量", async () => {
    const cookie = await login("admin", "v4-admin-pass");
    const stats = await app.inject({ method: "GET", url: "/api/admin/stats", headers: { cookie } });
    expect(stats.statusCode).toBe(200);
    const value = stats.json<{
      value: {
        mailboxes: { outlook: number; domain: number; temp: number; total: number };
        messages: { total: number; today: number; last7d: number; byKind: Record<string, number> };
        daily: unknown[];
        topMailboxes: unknown[];
      };
    }>().value;
    expect(value.mailboxes.total).toBe(value.mailboxes.outlook + value.mailboxes.domain + value.mailboxes.temp);
    expect(value.daily).toHaveLength(7);
    expect(Array.isArray(value.topMailboxes)).toBe(true);
    expect(value.messages.total).toBeGreaterThanOrEqual(0);
  });
  it("邮箱标签：管理员可设置并在列表中读回", async () => {
    const cookie = await login("admin", "v4-admin-pass");
    const providers = await app.inject({ method: "GET", url: "/api/admin/providers", headers: { cookie } });
    const yydsId = providers
      .json<{ value: Array<{ id: string; type: string }> }>()
      .value.find((item) => item.type === "yyds")?.id;
    const generated = await app.inject({
      method: "POST",
      url: "/api/admin/mailboxes/generate",
      headers: { cookie },
      payload: { providerId: yydsId, count: 1 }
    });
    const created = generated.json<{ value: { created: Array<{ id: string }> } }>().value.created[0];

    const tagged = await app.inject({
      method: "PATCH",
      url: `/api/admin/mailboxes/${created?.id}/tags`,
      headers: { cookie },
      payload: { tags: ["已注册 GPT", " 已注册 GPT ", "备用"] }
    });
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json<{ value: { tags: string[] } }>().value.tags).toEqual(["已注册 GPT", "备用"]);

    const rows = await app.inject({ method: "GET", url: "/api/admin/mailboxes?kind=temp", headers: { cookie } });
    const row = rows
      .json<{ value: Array<{ id: string; tags: string[] }> }>()
      .value.find((item) => item.id === created?.id);
    expect(row?.tags).toEqual(["已注册 GPT", "备用"]);
  });
});
