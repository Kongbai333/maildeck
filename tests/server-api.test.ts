import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(path.join(tmpdir(), "maildeck-server-test-"));
process.env.MAILDECK_DATA_DIR = dataDir;
process.env.MAILDECK_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MAILDECK_API_TOKEN = "test-legacy-token";
process.env.MAILDECK_ADMIN_PASSWORD = "legacy-admin-pass";
process.env.MAILDECK_RELEASE_CLEAR_INBOX = "0";

let app: FastifyInstance;
let accountService: typeof import("../server/src/account-service.js");
let dbModule: typeof import("../server/src/db.js");
let cryptoModule: typeof import("../server/src/crypto.js");

beforeAll(async () => {
  accountService = await import("../server/src/account-service.js");
  dbModule = await import("../server/src/db.js");
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

describe("maildeck server foundation", () => {
  it("encrypts and decrypts refresh tokens", () => {
    const encrypted = cryptoModule.encryptSecret("M.demo-refresh-token");
    expect(encrypted).not.toContain("demo-refresh-token");
    expect(cryptoModule.decryptSecret(encrypted)).toBe("M.demo-refresh-token");
  });

  it("previews and imports account records into the server database", () => {
    const input = {
      email: "server-test@example.com",
      clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
      refreshToken: `M.${"x".repeat(120)}`,
      remark: "server test",
      group: "test",
      tags: ["vip", "customer"]
    };
    const preview = accountService.previewAccounts([input]);
    expect(preview.valid).toBe(1);
    expect(preview.invalid).toBe(0);

    const result = accountService.upsertAccounts([input]);
    expect(result.imported).toBe(1);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].status).toBe("untested");
    expect(result.accounts[0].tags).toEqual(["vip", "customer"]);
  });

  it("serves the health and accounts endpoints through Fastify", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, value: { service: "maildeck-server" } });

    const accounts = await app.inject({
      method: "GET",
      url: "/api/accounts",
      headers: { authorization: "Bearer test-legacy-token" }
    });
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json()).toMatchObject({ ok: true });
    const accountsBody = accounts.json<{ value: unknown[] }>();
    expect(Array.isArray(accountsBody.value)).toBe(true);

    const anonymous = await app.inject({ method: "GET", url: "/api/accounts" });
    expect(anonymous.statusCode).toBe(401);
  });
});
