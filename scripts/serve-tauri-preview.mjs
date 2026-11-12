import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 壳还没编译出来时的等价运行入口：用系统 WebView 浏览器以 --app 方式加载
// dist-tauri，并注入与 Rust `desktop_config` 同形状的连接配置。
// /api/* 同源反向代理到 upstream，默认指向已有的 dev:cloud 服务端（8787），
// 复用其中 7 个账号与临时邮箱数据；不再默认连 9399 那套新建的空库。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist-tauri");
const port = Number(process.env.MAILDECK_PREVIEW_PORT || 9398);
const upstreamBase = (process.env.MAILDECK_PREVIEW_UPSTREAM || "http://127.0.0.1:8787").replace(/\/+$/u, "");
const serverUrl = process.env.MAILDECK_PREVIEW_SERVER || `http://127.0.0.1:${port}`;
const apiToken = process.env.MAILDECK_PREVIEW_TOKEN ?? "preview-token";
const storageKey = "maildeck.connection.v1";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const bootstrap = [
  `window.localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(
    JSON.stringify({ serverUrl, apiToken })
  )});`,
  "window.__MAILDECK_TAURI__ = { openExternal: async (url) => {",
  '  window.open(url, "_blank", "noopener,noreferrer");',
  "  return { opened: true };",
  "} };"
].join("\n");

async function proxyApi(req, res, url) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  delete headers.connection;

  try {
    const upstreamResponse = await fetch(`${upstreamBase}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      redirect: "manual"
    });
    const payload = Buffer.from(await upstreamResponse.arrayBuffer());
    res.writeHead(upstreamResponse.status, {
      "content-type": upstreamResponse.headers.get("content-type") || "application/json",
      "cache-control": "no-store"
    });
    res.end(payload);
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: "NETWORK_ERROR", message: "上游服务不可用", retryable: true }
      })
    );
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/__tauri_bootstrap.js") {
      res.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" });
      res.end(bootstrap);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await proxyApi(req, res, url);
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    try {
      let body = await readFile(file);
      if (file.endsWith("index.html")) {
        body = Buffer.from(
          body.toString("utf8").replace(
            "</head>",
            '<script src="/__tauri_bootstrap.js"></script></head>'
          )
        );
      }
      res.writeHead(200, {
        "content-type": types[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`MailDeck preview: http://127.0.0.1:${port} -> ${upstreamBase}`);
  });
