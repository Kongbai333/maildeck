// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeStreamCount, attachStream, setRuntimeStreamMode } from "../webapp/src/stream-player";
import type { StreamHandle, StreamMode } from "../webapp/src/stream-player";

type Listener = (type: unknown, detail: unknown) => void;
type FlvConfig = Parameters<NonNullable<Window["flvjs"]>["createPlayer"]>[1];
type HlsConfig = ConstructorParameters<NonNullable<Window["Hls"]>>[0];
const handles: StreamHandle[] = [];

function installFlv() {
  const listeners = new Map<string, Listener>();
  const player = {
    on: vi.fn((event: string, listener: Listener) => { listeners.set(event, listener); }),
    off: vi.fn((event: string) => { listeners.delete(event); }),
    attachMediaElement: vi.fn(),
    load: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    unload: vi.fn(),
    detachMediaElement: vi.fn(),
    destroy: vi.fn()
  };
  const createPlayer = vi.fn((_source: unknown, _config?: FlvConfig) => player);
  window.flvjs = { isSupported: () => true, createPlayer, Events: { ERROR: "error" } };
  return { player, createPlayer, listeners };
}

beforeEach(() => {
  setRuntimeStreamMode("direct");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy();
  delete window.flvjs;
  delete window.Hls;
  document.body.replaceChildren();
  expect(activeStreamCount()).toBe(0);
  if (vi.isFakeTimers()) {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});

describe("live stream memory budget", () => {
  it.each<StreamMode>(["direct", "proxy"])("limits FLV history to tens of seconds in %s mode", async (mode) => {
    const { createPlayer } = installFlv();
    const video = document.createElement("video");
    const url = "https://media.example.invalid/live/test.flv";
    handles.push(await attachStream(video, url, { mode, stallTimeoutMs: 0 }));

    expect(createPlayer).toHaveBeenCalledOnce();
    const [source, config] = createPlayer.mock.calls[0];
    expect(source).toMatchObject({ type: "flv", isLive: true, url: mode === "direct" ? url : `/api/me/online-play/stream?url=${encodeURIComponent(url)}` });
    expect(config?.autoCleanupSourceBuffer).toBe(true);
    expect(config?.autoCleanupMaxBackwardDuration).toBeGreaterThan(0);
    expect(config?.autoCleanupMaxBackwardDuration).toBeLessThanOrEqual(30);
    expect(config?.autoCleanupMinBackwardDuration).toBeGreaterThan(0);
    expect(config?.autoCleanupMinBackwardDuration).toBeLessThan(config?.autoCleanupMaxBackwardDuration as number);
  });

  it("sets finite HLS history, forward duration and byte budgets", async () => {
    const configs: HlsConfig[] = [];
    class Hls {
      static isSupported = () => true;
      static Events = { ERROR: "error", MANIFEST_PARSED: "manifest" };
      constructor(config?: HlsConfig) { configs.push(config); }
      on = vi.fn();
      off = vi.fn();
      loadSource = vi.fn();
      attachMedia = vi.fn();
      destroy = vi.fn();
    }
    window.Hls = Hls;
    const video = document.createElement("video");
    handles.push(await attachStream(video, "https://media.example.invalid/live/test.m3u8", { stallTimeoutMs: 0 }));

    expect(configs).toHaveLength(1);
    const config = configs[0];
    expect(config?.backBufferLength).toBeGreaterThan(0);
    expect(config?.backBufferLength).toBeLessThanOrEqual(30);
    expect(config?.maxBufferLength).toBeGreaterThan(0);
    expect(config?.maxMaxBufferLength).toBeLessThanOrEqual(30);
    expect(config?.maxBufferLength).toBeLessThanOrEqual(config?.maxMaxBufferLength as number);
    expect(config?.maxBufferSize).toBeGreaterThan(0);
    expect(config?.maxBufferSize).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it("stops FLV downloading on pause and reloads the live feed on resume", async () => {
    const { player } = installFlv();
    const video = document.createElement("video");
    handles.push(await attachStream(video, "https://media.example.invalid/live/test.flv", { stallTimeoutMs: 0 }));
    video.dispatchEvent(new Event("playing"));

    video.dispatchEvent(new Event("pause"));
    expect(player.unload).toHaveBeenCalledOnce();
    // Duplicate pause events must not unload again or start a second connection.
    video.dispatchEvent(new Event("pause"));
    expect(player.unload).toHaveBeenCalledOnce();
    video.dispatchEvent(new Event("play"));
    expect(player.load).toHaveBeenCalledTimes(2);
    expect(player.play).toHaveBeenCalledTimes(2);
    expect(activeStreamCount()).toBe(1);
  });

  it("catches up to live when playback falls over 30 seconds behind", async () => {
    vi.useFakeTimers();
    installFlv();
    const video = document.createElement("video");
    vi.spyOn(video, "paused", "get").mockReturnValue(false);
    Object.defineProperty(video, "buffered", { value: { length: 1, start: () => 0, end: () => 120 } });
    video.currentTime = 10;
    handles.push(await attachStream(video, "https://media.example.invalid/live/test.flv", { stallTimeoutMs: 0 }));

    await vi.advanceTimersByTimeAsync(5000);

    expect(video.currentTime).toBe(117);
  });

  it("leaves playback within its buffer budget at the selected position", async () => {
    vi.useFakeTimers();
    installFlv();
    const video = document.createElement("video");
    vi.spyOn(video, "paused", "get").mockReturnValue(false);
    Object.defineProperty(video, "buffered", { value: { length: 1, start: () => 0, end: () => 25 } });
    video.currentTime = 10;
    handles.push(await attachStream(video, "https://media.example.invalid/live/test.flv", { stallTimeoutMs: 0 }));

    await vi.advanceTimersByTimeAsync(5000);

    expect(video.currentTime).toBe(10);
  });

  it("does not seek a paused player or resume a destroyed player", async () => {
    vi.useFakeTimers();
    const { player } = installFlv();
    const video = document.createElement("video");
    Object.defineProperty(video, "buffered", { value: { length: 1, start: () => 0, end: () => 120 } });
    video.currentTime = 10;
    const handle = await attachStream(video, "https://media.example.invalid/live/test.flv", { stallTimeoutMs: 0 });
    handles.push(handle);
    video.dispatchEvent(new Event("playing"));
    video.dispatchEvent(new Event("pause"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(video.currentTime).toBe(10);

    handle.destroy();
    video.dispatchEvent(new Event("play"));
    expect(player.load).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the stream and player when a live connection fails", async () => {
    const { player, listeners } = installFlv();
    const onError = vi.fn();
    const video = document.createElement("video");
    handles.push(await attachStream(video, "https://media.example.invalid/live/test.flv", { stallTimeoutMs: 0, onError }));
    expect(activeStreamCount()).toBe(1);

    listeners.get("error")?.("NetworkError", "Disconnected");

    expect(activeStreamCount()).toBe(0);
    expect(player.unload).toHaveBeenCalledOnce();
    expect(player.detachMediaElement).toHaveBeenCalledOnce();
    expect(player.destroy).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("播放出错：Disconnected");
    expect(video.hasAttribute("src")).toBe(false);
  });

  it("destroys the old player when the same video switches channels", async () => {
    const first = installFlv();
    const video = document.createElement("video");
    const oldHandle = await attachStream(video, "https://media.example.invalid/live/one.flv", { stallTimeoutMs: 0 });
    handles.push(oldHandle);
    const second = installFlv();
    handles.push(await attachStream(video, "https://media.example.invalid/live/two.flv", { stallTimeoutMs: 0 }));

    expect(first.player.destroy).toHaveBeenCalledOnce();
    expect(second.player.load).toHaveBeenCalledOnce();
    expect(activeStreamCount()).toBe(1);
    oldHandle.destroy();
    expect(second.player.destroy).not.toHaveBeenCalled();
    expect(activeStreamCount()).toBe(1);
  });
});
