import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "serve-tauri-preview.mjs");

let upstream: Server;
let child: ChildProcess;
let previewPort = 0;

async function waitForHttp(url: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`preview server did not start: ${url}`);
}

beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        value: Array.from({ length: 7 }, (_, index) => ({
          id: String(index),
          email: `user${index}@example.com`
        }))
      })
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  previewPort = 19400 + Math.floor(Math.random() * 400);
  child = spawn(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      MAILDECK_PREVIEW_PORT: String(previewPort),
      MAILDECK_PREVIEW_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      MAILDECK_PREVIEW_TOKEN: ""
    },
    stdio: "ignore"
  });
  await waitForHttp(`http://127.0.0.1:${previewPort}/`);
}, 20000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("Tauri preview /api proxy", () => {
  it("forwards /api/accounts to the configured upstream and returns all 7 accounts", async () => {
    const response = await fetch(`http://127.0.0.1:${previewPort}/api/accounts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; value: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.value).toHaveLength(7);
  });
});
