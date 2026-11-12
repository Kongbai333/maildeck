import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const webappRoot = fileURLToPath(new URL(".", import.meta.url));
const outDir = path.join(webappRoot, "dist");

/**
 * Windows 上后端（fastify-static）可能正占用 dist 里的旧资源，
 * 导致 emptyOutDir 删不掉旧 hash 文件。这里在 build 前多试几次清理。
 */
function cleanDistPlugin(): Plugin {
  return {
    name: "maildeck-clean-dist",
    apply: "build",
    async buildStart() {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.promises.rm(outDir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    },
  };
}

export default defineConfig({
  root: webappRoot,
  base: "/",
  plugins: [react(), cleanDistPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
