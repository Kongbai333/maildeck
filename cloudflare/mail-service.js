// MailDeck 域名邮箱 —— Cloudflare 收信 Worker（Email Routing + Worker + D1）
// 参考 TGBOT 工作区 cloudflare/mail-service.js：
//   Telegram/任意站点 → CF Email Routing → 本 Worker 收信入库(D1) → MailDeck 服务端按 Bearer 轮询 /inbox。
// 部署步骤见同目录 README.md。

import PostalMime from "postal-mime";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

function tokenOf(request) {
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return bearer || request.headers.get("x-api-token") || "";
}
function authorized(request, env) {
  if (!env.API_TOKEN) return false; // 没配 token 一律拒绝
  return tokenOf(request) === env.API_TOKEN;
}

async function storeMail(env, row) {
  if (!env.DB) return null;
  const info = await env.DB.prepare(
    "INSERT INTO mails(to_addr, from_addr, subject, body, ts, created_at) VALUES(?,?,?,?,?,?)"
  ).bind(row.to, row.from, row.subject, row.body, row.ts, Math.floor(Date.now() / 1000)).run();
  return info.meta?.last_row_id ?? null;
}

const CODE_RX = /(?:login\s+code|code|verification\s+code)\D{0,20}(\d{5,6})|(\d{5,6})/i;
function extractCode(text, pattern) {
  if (!text) return null;
  let rx;
  try { rx = pattern ? new RegExp(pattern, "i") : CODE_RX; } catch { rx = CODE_RX; }
  const m = rx.exec(text);
  return m ? m[1] || m[2] || null : null;
}

async function handleEmail(message, env, ctx) {
  const parsed = await PostalMime.parse(new Response(message.raw));
  const row = {
    to: (message.to || "").toLowerCase(),
    from: parsed.from?.address || "",
    subject: parsed.subject || "",
    body: (parsed.text || "").slice(0, 20000),
    ts: Math.floor(Date.now() / 1000)
  };
  ctx.waitUntil(storeMail(env, row));
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") {
    const row = env.DB ? await env.DB.prepare("SELECT COUNT(*) AS n FROM mails").first() : null;
    return json({ ok: true, service: "maildeck-mail", mails: row?.n ?? 0, d1: Boolean(env.DB) });
  }

  if (!authorized(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  if (path === "/inbox") {
    const alias = (url.searchParams.get("alias") || "").toLowerCase();
    const since = Number(url.searchParams.get("since") || 0);
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
    if (!env.DB) return json({ ok: false, error: "no_d1" }, 500);
    const rows = await env.DB.prepare(
      "SELECT id, to_addr, from_addr, subject, body, ts FROM mails " +
        "WHERE (? = '' OR to_addr = ?) AND ts >= ? ORDER BY id DESC LIMIT ?"
    ).bind(alias, alias, since, limit).all();
    return json({ ok: true, items: rows.results || [] });
  }

  if (path === "/message" && request.method === "DELETE") {
    const id = Number(url.searchParams.get("id") || 0);
    if (!id) return json({ ok: false, error: "id_required" }, 400);
    if (!env.DB) return json({ ok: false, error: "no_d1" }, 500);
    await env.DB.prepare("DELETE FROM mails WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  if (path === "/code") {
    const alias = (url.searchParams.get("alias") || "").toLowerCase();
    const since = Number(url.searchParams.get("since") || 0);
    const pattern = url.searchParams.get("pattern") || "";
    if (!alias) return json({ ok: false, error: "alias_required" }, 400);
    if (!env.DB) return json({ ok: false, error: "no_d1" }, 500);
    const rows = await env.DB.prepare(
      "SELECT id, to_addr, subject, body, ts FROM mails WHERE to_addr = ? AND ts >= ? ORDER BY id DESC LIMIT 20"
    ).bind(alias, since).all();
    for (const row of rows.results || []) {
      const code = extractCode(`${row.subject}\n${row.body}`, pattern);
      if (code) return json({ ok: true, code, id: row.id, ts: row.ts, alias: row.to_addr });
    }
    return json({ ok: true, code: null });
  }

  if (path === "/test" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const to = (body.to || "").toLowerCase();
    if (!to) return json({ ok: false, error: "to_required" }, 400);
    const row = {
      to,
      from: body.from || "noreply@example.com",
      subject: body.subject || "MailDeck test",
      body: body.body || `Login code: ${body.code || "483920"}`,
      ts: Math.floor(Date.now() / 1000)
    };
    const id = await storeMail(env, row);
    return json({ ok: true, id, row });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  async email(message, env, ctx) { return handleEmail(message, env, ctx); },
  async fetch(request, env, ctx) { return handleFetch(request, env, ctx); }
};
