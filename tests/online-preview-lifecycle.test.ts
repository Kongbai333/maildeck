// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnlineHostCard } from "../webapp/src/components/OnlineHostCard";
import { setPreviewPlayerCount, stopAllPreviews } from "../webapp/src/preview-scheduler";
import { activeStreamCount, attachStream, setRuntimeStreamMode } from "../webapp/src/stream-player";
import type { StreamHandle, StreamMode } from "../webapp/src/stream-player";

const observers: PreviewObserver[] = [];
const mainHandles: StreamHandle[] = [];
let root: Root;
let container: HTMLDivElement;

// jsdom has no layout engine; drive the browser's visibility boundary explicitly.
class PreviewObserver {
  private target: Element | null = null;
  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(target: Element): void { this.target = target; }
  disconnect(): void { this.target = null; }
  emit(visible: boolean): void {
    if (!this.target) return;
    this.callback([{
      target: this.target,
      isIntersecting: visible,
      intersectionRatio: visible ? 1 : 0
    } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function renderCards(count: number, forcePreview = true, mode: StreamMode = "direct"): void {
  root.render(createElement("div", null, ...Array.from({ length: count }, (_, index) =>
    createElement(OnlineHostCard, {
      key: index,
      host: { title: `Channel ${index}`, cover: "", address: `https://media-${index}.example.invalid/live.mp4` },
      mode,
      forcePreview,
      onOpen: () => undefined
    })
  )));
}

async function showCards(count = 1, mode: StreamMode = "direct"): Promise<void> {
  setRuntimeStreamMode(mode);
  await act(async () => { renderCards(count, true, mode); });
  await act(async () => { for (const observer of [...observers]) observer.emit(true); });
}

async function playFirstPreview(): Promise<HTMLVideoElement> {
  await showCards();
  const video = container.querySelector("video");
  if (!video) throw new Error("Preview video was not rendered");
  await act(async () => { video.dispatchEvent(new Event("playing")); });
  return video;
}

function retainedPixels(): number {
  return [...container.querySelectorAll("canvas")].reduce((total, canvas) => total + canvas.width * canvas.height, 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("IntersectionObserver", PreviewObserver);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(function (this: HTMLMediaElement) {
    return this.hasAttribute("src") ? 2 : 0;
  });
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(1080);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(1920);
  // Test retained bitmap dimensions, not jsdom's missing raster implementation.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    drawImage: () => undefined
  }) as unknown as CanvasRenderingContext2D);
  setPreviewPlayerCount(0);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  stopAllPreviews();
  for (const handle of mainHandles.splice(0)) handle.destroy();
  setPreviewPlayerCount(0);
  observers.length = 0;
  container.remove();
  expect(activeStreamCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe("all-preview resource lifecycle", () => {
  it.each<StreamMode>(["direct", "proxy"])("runs at most two previews before dequeuing the next in %s mode", async (mode) => {
    await showCards(6, mode);
    expect(activeStreamCount()).toBe(2);

    const videos = [...container.querySelectorAll("video")];
    await act(async () => {
      videos[0].dispatchEvent(new Event("playing"));
      videos[1].dispatchEvent(new Event("playing"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(activeStreamCount()).toBe(2);
    expect(videos[0].hasAttribute("src")).toBe(false);
    expect(videos[1].hasAttribute("src")).toBe(false);
    expect(videos[2].hasAttribute("src")).toBe(true);
    expect(videos[3].hasAttribute("src")).toBe(true);
  });

  it("does not extend the five-second preview when playing fires again after buffering", async () => {
    const video = await playFirstPreview();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await act(async () => { video.dispatchEvent(new Event("playing")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(activeStreamCount()).toBe(0);
    expect(video.hasAttribute("src")).toBe(false);
    expect(container.textContent).toContain("已定格");
  });

  it("keeps the visible frozen frame at thumbnail resolution", async () => {
    await playFirstPreview();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(activeStreamCount()).toBe(0);
    expect(retainedPixels()).toBeGreaterThan(0);
    expect(retainedPixels()).toBeLessThanOrEqual(180 * 320);
  });

  it("releases a frozen bitmap when its card leaves the viewport", async () => {
    await playFirstPreview();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(retainedPixels()).toBeGreaterThan(0);

    await act(async () => { observers[0].emit(false); });

    expect(retainedPixels()).toBe(0);
    expect(container.textContent).not.toContain("已定格");
    expect(activeStreamCount()).toBe(0);
  });

  it("releases completed frames when all-preview is switched off", async () => {
    await playFirstPreview();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(retainedPixels()).toBeGreaterThan(0);

    await act(async () => { renderCards(1, false); });

    expect(retainedPixels()).toBe(0);
    expect(container.textContent).not.toContain("已定格");
  });

  it("also releases hover-preview frames when all-preview is off", async () => {
    await act(async () => { renderCards(1, false); });
    const card = container.querySelector("button");
    const video = container.querySelector("video");
    if (!card || !video) throw new Error("Preview card was not rendered");
    await act(async () => { card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    await act(async () => { video.dispatchEvent(new Event("playing")); });
    await act(async () => { card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); });
    expect(activeStreamCount()).toBe(0);
    expect(retainedPixels()).toBeGreaterThan(0);

    await act(async () => { observers[0].emit(false); });

    expect(retainedPixels()).toBe(0);
  });

  it("leaves only one preview slot alongside five main players", async () => {
    setRuntimeStreamMode("proxy");
    for (let index = 0; index < 5; index++) {
      mainHandles.push(await attachStream(document.createElement("video"), `https://main-${index}.example.invalid/live.mp4`, {
        priority: 0, stallTimeoutMs: 0
      }));
    }
    setPreviewPlayerCount(5);

    await showCards(4, "proxy");

    expect(activeStreamCount()).toBe(6);
    expect([...container.querySelectorAll("video")].filter((video) => video.hasAttribute("src"))).toHaveLength(1);
  });

  it("cancels active and queued previews before three main players start", async () => {
    await showCards(8);
    await act(async () => {
      stopAllPreviews();
      setPreviewPlayerCount(3);
      renderCards(8, false);
    });
    expect(activeStreamCount()).toBe(0);

    for (let index = 0; index < 3; index++) {
      mainHandles.push(await attachStream(document.createElement("video"), `https://main-${index}.example.invalid/live.mp4`, {
        priority: 0, stallTimeoutMs: 0
      }));
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(activeStreamCount()).toBe(3);
    expect(retainedPixels()).toBe(0);
    expect([...container.querySelectorAll("video")].every((video) => !video.hasAttribute("src"))).toBe(true);
  });
});
