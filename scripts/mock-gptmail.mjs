#!/usr/bin/env node
/**
 * 本地假服务商：同时模拟 GPTMail 与 mail.tm，给网页端做端到端联调用，不发真实网络请求。
 *
 *   node scripts/mock-gptmail.mjs            # 监听 8899
 *   MOCK_PORT=9000 node scripts/mock-gptmail.mjs
 *
 * 管理后台「服务商」里新增：
 *   - 类型 GPTMail，Base URL http://127.0.0.1:8899，Key 随意（如 mock-key），模式「个人」
 *   - 类型 mail.tm，Base URL http://127.0.0.1:8899（无需 Key）
 * 即可在无外网时跑通生成地址 / 收信 / 读信 / 删除。
 */
import { createServer } from "node:http";

const port = Number.parseInt(process.env.MOCK_PORT ?? "8899", 10);
let counter = 0;
const accounts = new Map();

const gptMessages = [
  {
    id: "m-1001",
    subject: "欢迎使用 Mock 邮箱",
    from: "noreply@mock.test",
    timestamp: Math.floor(Date.now() / 1000) - 120,
    intro: "这是一封本地假邮件，用来验证网页端收件箱链路。",
    attachment_count: 0,
    html_content:
      "<h2>欢迎</h2><p>你的验证码是 <strong>123456</strong>。</p><p><a href='https://example.com/verify'>点此验证</a></p>",
    content: "欢迎，你的验证码是 123456。"
  },
  {
    id: "m-1002",
    subject: "第二封：纯文本邮件",
    from: "team@mock.test",
    timestamp: Math.floor(Date.now() / 1000) - 3_600,
    intro: "没有 HTML 正文，只有 text。",
    attachment_count: 1,
    attachments: [{ id: "a-1", filename: "invoice.pdf", content_type: "application/pdf", size: 2048 }],
    content: "这是纯文本正文，用来测试 text/plain 渲染分支。"
  }
];

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const pathname = url.pathname;
  console.log(`${request.method} ${pathname}${url.search}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": "*" });
    response.end();
    return;
  }

  // ── GPTMail ──
  if (pathname === "/api/domains/public") {
    json(response, 200, {
      success: true,
      data: {
        domains: [{ domain_name: "mock.test", is_active: true, visibility: "public" }],
        subdomains: [{ domain: "mock.test", wildcard: true, children: [] }]
      }
    });
    return;
  }

  if (pathname === "/api/generate-email") {
    counter += 1;
    const email = `user${String(counter).padStart(3, "0")}@mock.test`;
    json(response, 200, { success: true, data: { email } });
    return;
  }

  if (pathname === "/api/emails" && request.method === "GET") {
    json(response, 200, {
      success: true,
      data: { emails: gptMessages.map(({ html_content, content, attachments, ...rest }) => rest) }
    });
    return;
  }

  if (pathname === "/api/emails/clear") {
    json(response, 200, { success: true, data: { has_more: false } });
    return;
  }

  const gptDetail = /^\/api\/email\/([^/]+)$/u.exec(pathname);
  if (gptDetail) {
    const id = decodeURIComponent(gptDetail[1] ?? "");
    if (request.method === "DELETE") {
      json(response, 200, { success: true, data: { deleted: id } });
      return;
    }
    const found = gptMessages.find((message) => message.id === id);
    if (!found) {
      json(response, 404, { success: false, error: "邮件不存在" });
      return;
    }
    json(response, 200, { success: true, data: { email: found } });
    return;
  }

  if (pathname === "/api/public-key-status") {
    json(response, 200, {
      success: true,
      data: { key: "mock-public-key", is_active: true, remaining_today: 999, daily_limit: 1000, reset_at: null }
    });
    return;
  }

  // ── mail.tm ──
  if (pathname === "/domains") {
    json(response, 200, { "hydra:member": [{ domain: "mock.tm", isActive: true, isPrivate: false }] });
    return;
  }

  if (pathname === "/accounts" && request.method === "POST") {
    const body = await readBody(request);
    const address = typeof body.address === "string" ? body.address.toLowerCase() : "";
    if (!address) {
      json(response, 422, { message: "address is required" });
      return;
    }
    accounts.set(address, typeof body.password === "string" ? body.password : "");
    json(response, 201, { id: `acc-${accounts.size}`, address });
    return;
  }

  if (pathname === "/token" && request.method === "POST") {
    const body = await readBody(request);
    const address = typeof body.address === "string" ? body.address.toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!accounts.has(address) || accounts.get(address) !== password) {
      json(response, 401, { message: "invalid credentials" });
      return;
    }
    json(response, 200, { token: `token-${address}`, id: `acc-${address}` });
    return;
  }

  if (pathname === "/messages" && request.method === "GET") {
    if (!String(request.headers.authorization ?? "").startsWith("Bearer ")) {
      json(response, 401, { message: "unauthorized" });
      return;
    }
    json(response, 200, {
      "hydra:member": [
        {
          id: "tm-1",
          subject: "mail.tm 验证码",
          intro: "你的验证码是 987654",
          from: { address: "noreply@mock.tm", name: "Mock mail.tm" },
          createdAt: new Date().toISOString(),
          seen: false,
          hasAttachments: false
        }
      ]
    });
    return;
  }

  const tmDetail = /^\/messages\/([^/]+)$/u.exec(pathname);
  if (tmDetail) {
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    json(response, 200, {
      id: decodeURIComponent(tmDetail[1] ?? ""),
      subject: "mail.tm 验证码",
      from: { address: "noreply@mock.tm", name: "Mock mail.tm" },
      to: [{ address: "demo@mock.tm", name: "" }],
      createdAt: new Date().toISOString(),
      seen: false,
      html: ["<p>你的验证码是 <strong>987654</strong></p>"],
      text: "你的验证码是 987654",
      attachments: []
    });
    return;
  }

  json(response, 404, { message: `未实现的 Mock 接口：${pathname}` });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock providers (GPTMail + mail.tm) listening on http://127.0.0.1:${port}`);
});
