import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  main?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(target) : entry.name.endsWith(".ts") ? [target] : [];
  });
}

describe("web-only project boundary", () => {
  it("has no desktop runtime dependency or launch scripts", () => {
    const packages = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const name of ["electron", "electron-updater", "electron-builder", "@tauri-apps/api", "@tauri-apps/cli"]) {
      expect(packages).not.toHaveProperty(name);
    }
    expect(manifest.main).toBeUndefined();
    expect(JSON.stringify(manifest.scripts)).not.toMatch(/electron|tauri|dist:win|verify:release/i);
    expect(manifest.scripts.typecheck).toContain("typecheck:webapp");
    expect(manifest.scripts.start).toContain("dist-server/server/src/index.js");
  });

  it("serves one web frontend and retires the old desktop source roots", () => {
    expect(existsSync(path.join(root, "webapp/index.html"))).toBe(true);
    expect(readFileSync(path.join(root, "webapp/index.html"), "utf8")).toContain('/src/main.tsx');
    for (const retired of ["electron", "src-tauri", "src", "index.html", "vite.config.ts"]) {
      expect(existsSync(path.join(root, retired)), retired).toBe(false);
    }
  });

  it("keeps server and shared sources independent from desktop APIs", () => {
    for (const file of [...sources(path.join(root, "server/src")), ...sources(path.join(root, "server/mail")), ...sources(path.join(root, "shared"))]) {
      const text = readFileSync(file, "utf8");
      expect(text, path.relative(root, file)).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*["'][^"']*(?:electron|@tauri-apps|src-tauri)/);
    }
  });
});
