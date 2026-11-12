import { afterEach, describe, expect, it, vi } from "vitest";
import { DOMAIN_ADAPTERS } from "../server/src/domain-adapters.js";

const adapter = DOMAIN_ADAPTERS.gptmail;
const config = { baseUrl: "https://mail.chatgpt.org.uk", apiKey: "test-key" };

function mockJson(data: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ success: ok, data }), {
        status: ok ? 200 : 400,
        headers: { "content-type": "application/json" }
      })
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GPTMail domain adapter", () => {
  it("generates an email and lowercases the address", async () => {
    mockJson({ email: "Demo@Example.com" });
    const result = await adapter.generateEmail(config, { prefix: "demo" });
    expect(result.email).toBe("demo@example.com");
    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("/api/generate-email");
    expect((init as RequestInit).method).toBe("POST");
    expect(new Headers((init as RequestInit).headers).get("X-API-Key")).toBe("test-key");
  });

  it("normalizes the inbox list under data.emails", async () => {
    mockJson({
      emails: [
        {
          id: "m1",
          subject: "验证码",
          from_address: "noreply@service.com",
          from_name: "Service",
          timestamp: "2026-08-15T10:00:00Z",
          attachment_count: 1
        }
      ],
      has_more: false
    });
    const messages = await adapter.listMessages(config, "demo@example.com");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "m1",
      subject: "验证码",
      from: { name: "Service", address: "noreply@service.com" },
      hasAttachments: true
    });
    expect(messages[0].receivedDateTime).toBe("2026-08-15T10:00:00.000Z");
  });

  it("normalizes a single message with HTML body and attachments", async () => {
    mockJson({
      id: "m1",
      subject: "Hello",
      from_address: "sender@example.com",
      html_content: "<p>Hi</p>",
      content: "Hi",
      attachments: [{ id: "a1", filename: "code.txt", content_type: "text/plain", size: 12 }]
    });
    const detail = await adapter.getMessage(config, "demo@example.com", "m1");
    expect(detail.body.contentType).toBe("html");
    expect(detail.body.content).toBe("<p>Hi</p>");
    expect(detail.attachments).toEqual([
      { id: "a1", filename: "code.txt", contentType: "text/plain", size: 12 }
    ]);
  });

  it("surfaces a GPTMail error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: "invalid api key" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        })
      )
    );
    await expect(adapter.listMessages(config, "demo@example.com")).rejects.toThrow("invalid api key");
  });

  it("auto-fetches the daily public key with the reveal header", async () => {
    mockJson({
      is_active: true,
      daily_limit: 200000,
      remaining_today: 199000,
      reset_at: "2026-11-09T00:00:00.000Z",
      key: "sk-public-test"
    });
    const info = await adapter.fetchPublicKey!(config);
    expect(info.key).toBe("sk-public-test");
    expect(info.isActive).toBe(true);
    expect(info.remainingToday).toBe(199000);
    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("/api/public-key-status?reveal=1");
    expect(new Headers((init as RequestInit).headers).get("X-Public-Key-Reveal")).toBe("click");
  });

  it("rejects non-JSON Cloudflare responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html>blocked</html>", {
          status: 429,
          headers: { "content-type": "text/html" }
        })
      )
    );
    await expect(adapter.listMessages(config, "demo@example.com")).rejects.toThrow(/限速|429/u);
  });
});
