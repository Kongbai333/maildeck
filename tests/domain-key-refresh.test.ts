import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "maildeck-domain-refresh-"));
process.env.MAILDECK_DATA_DIR = dataDir;
process.env.MAILDECK_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");

const REFRESHED_KEY = "pk-refreshed-day-2";
let dbModule: typeof import("../server/src/db.js");
let domainService: typeof import("../server/src/domain-service.js");
let cryptoModule: typeof import("../server/src/crypto.js");

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return handler(url, init);
    })
  );
}

beforeAll(async () => {
  dbModule = await import("../server/src/db.js");
  domainService = await import("../server/src/domain-service.js");
  cryptoModule = await import("../server/src/crypto.js");
  dbModule.getDb();
});

afterAll(() => {
  vi.unstubAllGlobals();
  dbModule.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GPTMail public key lifecycle", () => {
  it("creates a public provider automatically when none exists", async () => {
    stubFetch(async () =>
      jsonResponse({ success: true, data: { key: "public-key-day-1", is_active: true } })
    );
    await domainService.ensureDefaultPublicProvider();
    const providers = domainService.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].keyMode).toBe("public");
    expect(providers[0].hasKey).toBe(true);
  });

  it("refreshes the stored public key on startup", async () => {
    stubFetch(async () =>
      jsonResponse({ success: true, data: { key: REFRESHED_KEY, is_active: true } })
    );
    await domainService.refreshPublicProviderKeys();
    const row = dbModule
      .getDb()
      .prepare("SELECT encrypted_api_key FROM domain_providers LIMIT 1")
      .get() as { encrypted_api_key: string };
    expect(cryptoModule.decryptSecret(row.encrypted_api_key)).toBe(REFRESHED_KEY);
  });

  it("leaves a personal key untouched during refresh", async () => {
    const personal = domainService.createProvider({
      name: "个人 Key",
      type: "gptmail",
      apiKey: "personal-secret",
      keyMode: "personal"
    });
    const personalId = personal.find((item) => item.name === "个人 Key")!.id;
    const fetchMock = vi.fn(async () =>
      jsonResponse({ success: true, data: { key: "public-key-day-3", is_active: true } })
    );
    vi.stubGlobal("fetch", fetchMock);
    await domainService.refreshPublicProviderKeys();
    const row = dbModule
      .getDb()
      .prepare("SELECT encrypted_api_key FROM domain_providers WHERE id = ?")
      .get(personalId) as { encrypted_api_key: string };
    expect(cryptoModule.decryptSecret(row.encrypted_api_key)).toBe("personal-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries the inbox with a refreshed key after an invalid-key error", async () => {
    const provider = domainService.listProviders().find((item) => item.keyMode === "public")!;
    dbModule
      .getDb()
      .prepare(
        "INSERT INTO domain_mailboxes (id, provider_id, email, prefix, domain, remark, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        "mailbox-1",
        provider.id,
        "demo@example.com",
        "demo",
        "example.com",
        "",
        "2026-11-09T00:00:00.000Z",
        "2026-11-09T00:00:00.000Z"
      );

    let inboxCalls = 0;
    stubFetch(async (url) => {
      if (url.includes("/api/emails?")) {
        inboxCalls += 1;
        if (inboxCalls === 1) {
          return jsonResponse({ success: false, error: "Invalid API key" }, 400);
        }
        return jsonResponse({
          success: true,
          data: { emails: [{ id: "m1", subject: "验证码", from_address: "no-reply@example.com" }] }
        });
      }
      if (url.includes("/api/public-key-status")) {
        return jsonResponse({ success: true, data: { key: "public-key-day-4", is_active: true } });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const messages = await domainService.listMailboxMessages("mailbox-1");
    expect(inboxCalls).toBe(2);
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe("验证码");
  });
});
