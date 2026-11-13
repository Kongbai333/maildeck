import { getRuntimeStreamMode } from "./stream-player";

type Release = () => void;
interface Waiter {
  host: string;
  signal: AbortSignal;
  resolve: (release: Release | null) => void;
  onAbort: () => void;
}
interface Preview { host: string; stop: () => void; running: boolean }
let playerCount = 0;
let active = 0;
const byHost = new Map<string, number>();
const waiters: Waiter[] = [];
const previews = new Map<symbol, Preview>();

export function previewLimits(): { max: number; perHost: number } {
  const proxy = getRuntimeStreamMode() === "proxy";
  return { max: Math.max(0, Math.min(proxy ? 9 : 4, (proxy ? 12 : 6) - playerCount)), perHost: proxy ? 99 : 1 };
}
export function setPreviewPlayerCount(count: number): void {
  playerCount = count;
  flush();
}
export function streamHost(url: string): string {
  try { return new URL(url, window.location.href).host.toLowerCase(); } catch { return url; }
}
export function registerPreview(key: symbol, host: string, stop: () => void): void {
  previews.set(key, { host, stop, running: false });
}
export function markPreviewRunning(key: symbol): void {
  const entry = previews.get(key);
  if (entry) entry.running = true;
}
export function unregisterPreview(key: symbol): void { previews.delete(key); }
export function stopAllPreviews(): void {
  for (const entry of [...previews.values()]) entry.stop();
}
function take(host: string): Release | null {
  const limits = previewLimits();
  if (active >= limits.max || (byHost.get(host) ?? 0) >= limits.perHost) return null;
  active++;
  byHost.set(host, (byHost.get(host) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    const count = (byHost.get(host) ?? 1) - 1;
    if (count > 0) byHost.set(host, count); else byHost.delete(host);
    flush();
  };
}
function flush(): void {
  for (let index = 0; index < waiters.length;) {
    const waiter = waiters[index];
    if (waiter.signal.aborted) {
      waiters.splice(index, 1);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(null);
      continue;
    }
    const release = take(waiter.host);
    if (!release) { index++; continue; }
    waiters.splice(index, 1);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(release);
  }
}
export function acquirePreview(key: symbol, host: string, signal: AbortSignal, urgent: boolean): Promise<Release | null> {
  if (signal.aborted) return Promise.resolve(null);
  const release = take(host);
  if (release) return Promise.resolve(release);
  return new Promise((resolve) => {
    const waiter: Waiter = { host, signal, resolve, onAbort: () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      resolve(null);
    } };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (urgent) waiters.unshift(waiter); else waiters.push(waiter);
    if (urgent && previewLimits().max > 0) {
      const candidates = [...previews.entries()].filter(([id, entry]) => id !== key && entry.running);
      const victim = candidates.find(([, entry]) => entry.host === host) ?? candidates[0];
      victim?.[1].stop();
    }
    flush();
  });
}
