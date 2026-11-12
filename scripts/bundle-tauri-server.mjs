import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist-server", "server", "src", "index.js");
const outfile = path.join(root, "src-tauri", "resources", "maildeck-server.mjs");

mkdirSync(path.dirname(outfile), { recursive: true });

// server 用 node:sqlite、Fastify、mailparser 等；打成单文件 ESM 后 sidecar 只需要
// 一个 node.exe，不再依赖 node_modules 目录。CJS 依赖里的动态 require 由
// createRequire shim 兜住。
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:*"],
  banner: {
    js: "import { createRequire as __maildeckCreateRequire } from 'node:module'; const require = __maildeckCreateRequire(import.meta.url);"
  },
  legalComments: "none",
  sourcemap: false,
  logLevel: "info"
});

console.log(`sidecar bundle written: ${outfile}`);
