/** 在线播放流媒体挂载：支持 FLV(flv.js) / HLS(hls.js) / 原生 video。 */

declare global {
  interface Window {
    flvjs?: any;
    Hls?: any;
  }
}

const FLV_CDN = "https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js";
const HLS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js";

/**
 * 全局并发闸门。
 * 浏览器对**同一个主机**最多 6 条 HTTP/1.1 连接（实测同一 CDN 上 19 路并发只有 6 路能出画面，
 * 其余静默排队、readyState 一直是 0），所以直连时把「同时拉流的总数」压到 6，
 * 并让主播放器优先于预览抢槽位，避免预览把主播放器挤死。
 *
 * HTTPS 走同源代理时：浏览器对同一 origin 用 HTTP/2 多路复用（不再按 6 条算），
 * 上游连接由服务端建立（实测同主机 12 路并发全部 200），所以闸门放宽到 12 路。
 */
const DIRECT_MAX_STREAMS = 6;
const PROXIED_MAX_STREAMS = 12;
/** 0 = 主播放器（最高优先），1 = 预览 */
export type StreamPriority = 0 | 1;

/** 当前生效的播放模式（由页面探测后写入）。 */
let runtimeMode: StreamMode | null = null;

export function setRuntimeStreamMode(mode: StreamMode): void {
  runtimeMode = mode;
}

export function getRuntimeStreamMode(): StreamMode {
  if (runtimeMode !== null) return runtimeMode;
  return typeof window !== "undefined" && window.location.protocol === "https:" ? "proxy" : "direct";
}

let activeStreams = 0;
const streamWaiters: Array<{ priority: StreamPriority; resolve: () => void }> = [];

function maxStreams(): number {
  return getRuntimeStreamMode() === "proxy" ? PROXIED_MAX_STREAMS : DIRECT_MAX_STREAMS;
}

function makeReleaser(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = streamWaiters.shift();
    if (next) {
      // 槽位直接转交，active 不变
      next.resolve();
    } else {
      activeStreams = Math.max(0, activeStreams - 1);
    }
  };
}

async function acquireStreamSlot(priority: StreamPriority): Promise<() => void> {
  if (activeStreams < maxStreams() && streamWaiters.length === 0) {
    activeStreams += 1;
    return makeReleaser();
  }
  await new Promise<void>((resolve) => {
    streamWaiters.push({ priority, resolve });
    streamWaiters.sort((a, b) => a.priority - b.priority);
  });
  return makeReleaser();
}

/** 当前占用中的流连接数（调试/展示用）。 */
export function activeStreamCount(): number {
  return activeStreams;
}

/**
 * 播放模式：
 * - direct：浏览器直接拉 CDN 的 http 流（走用户本地流量，服务器/CF 都不参与）
 * - proxy ：经服务端同源代理（https 页面被混合内容拦截时才不得不走）
 */
export type StreamMode = "direct" | "proxy";

export function streamUrlFor(url: string, mode: StreamMode): string {
  return mode === "proxy" ? `/api/me/online-play/stream?url=${encodeURIComponent(url)}` : url;
}

/**
 * 探测能否直连（用户本地流量）。
 * - 非 https 页面：本来就能直连，直接 direct；
 * - https 页面：试着拉一下真实的 http 流。浏览器若按混合内容拦截 → 抛错 → 回退 proxy；
 *   若用户在站点设置里允许了「不安全内容」，这里会成功 → 直连，省掉服务器/CF 流量。
 */
export async function detectStreamMode(sampleUrl: string): Promise<StreamMode> {
  if (typeof window === "undefined") {
    return "direct";
  }
  if (window.location.protocol !== "https:") {
    return "direct";
  }
  if (!/^http:\/\//iu.test(sampleUrl)) {
    return "direct";
  }
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    const response = await fetch(sampleUrl, { mode: "cors", cache: "no-store", signal: controller.signal });
    window.clearTimeout(timer);
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    return response.ok ? "direct" : "proxy";
  } catch {
    return "proxy";
  }
}

/** 兼容旧调用：是否处于同源代理模式。 */
export function isProxied(): boolean {
  return getRuntimeStreamMode() === "proxy";
}

function loadScript(src: string, globalName: "flvjs" | "Hls"): Promise<any> {
  return new Promise((resolve, reject) => {
    if (window[globalName]) {
      resolve(window[globalName]);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[data-lib="${globalName}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window[globalName]));
      existing.addEventListener("error", () => reject(new Error("播放库加载失败")));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.lib = globalName;
    script.onload = () => resolve(window[globalName]);
    script.onerror = () => reject(new Error("播放库加载失败（请检查网络）"));
    document.head.appendChild(script);
  });
}

export interface StreamHandle {
  destroy(): void;
}

export interface AttachOptions {
  muted?: boolean;
  /** 0 = 主播放器，1 = 预览（默认 1） */
  priority?: StreamPriority;
  /** 直连 or 走代理；不传则用页面探测到的全局模式 */
  mode?: StreamMode;
  /** 超过这个时间还没出画面就判定「卡住」，默认 12s；0 = 不检测 */
  stallTimeoutMs?: number;
  onError?: (message: string) => void;
  onPlaying?: () => void;
}

/** 把直播流挂到 <video>，返回销毁句柄。不抛错，失败通过 onError 回调。 */
export async function attachStream(
  video: HTMLVideoElement,
  url: string,
  options: AttachOptions = {}
): Promise<StreamHandle> {
  const priority = options.priority ?? 1;
  const release = await acquireStreamSlot(priority);
  let disposed = false;
  let playing = false;
  let player: any = null;
  let hls: any = null;
  let stallTimer: number | null = null;
  if (options.muted) video.muted = true;

  const destroy = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (stallTimer !== null) {
      window.clearTimeout(stallTimer);
      stallTimer = null;
    }
    try {
      player?.pause?.();
      player?.unload?.();
      player?.detachMediaElement?.();
      player?.destroy?.();
    } catch {
      /* ignore */
    }
    try {
      hls?.destroy?.();
    } catch {
      /* ignore */
    }
    try {
      video.removeAttribute("src");
      video.load();
    } catch {
      /* ignore */
    }
    release();
  };

  const onPlaying = (): void => {
    playing = true;
    if (stallTimer !== null) {
      window.clearTimeout(stallTimer);
      stallTimer = null;
    }
    options.onPlaying?.();
  };

  const stallMs = options.stallTimeoutMs ?? 12_000;
  if (stallMs > 0) {
    stallTimer = window.setTimeout(() => {
      stallTimer = null;
      if (!disposed && !playing) {
        options.onError?.("频道无响应（可能是同一 CDN 连接占满或该频道已下线），换一个试试");
      }
    }, stallMs);
  }

  try {
    const target = streamUrlFor(url, options.mode ?? getRuntimeStreamMode());
    if (/\.flv(\?|$)/i.test(url)) {
      const flvjs = await loadScript(FLV_CDN, "flvjs");
      if (disposed) return { destroy };
      if (!flvjs?.isSupported?.()) {
        options.onError?.("当前浏览器不支持 FLV 直播");
        return { destroy };
      }
      player = flvjs.createPlayer({ type: "flv", url: target, isLive: true, hasAudio: true });
      player.on(flvjs.Events.ERROR, (_type: string, detail: string) => {
        if (!disposed) options.onError?.(`播放出错：${detail || "流不可用/被跨域拦截"}`);
      });
      player.attachMediaElement(video);
      player.load();
      video.addEventListener("playing", onPlaying, { once: true });
      await player.play().catch(() => undefined);
    } else if (/\.m3u8(\?|$)/i.test(url)) {
      const Hls = await loadScript(HLS_CDN, "Hls");
      if (disposed) return { destroy };
      if (Hls?.isSupported?.()) {
        hls = new Hls();
        hls.on(Hls.Events.ERROR, (_event: unknown, data: any) => {
          if (data?.fatal && !disposed) options.onError?.("播放出错：HLS 流不可用");
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        video.src = url;
      }
      video.addEventListener("playing", onPlaying, { once: true });
      await video.play().catch(() => undefined);
    } else {
      video.src = target;
      video.addEventListener("playing", onPlaying, { once: true });
      await video.play().catch(() => undefined);
    }
  } catch (error) {
    if (!disposed) {
      options.onError?.(error instanceof Error ? error.message : "播放失败");
      destroy();
    }
  }

  return { destroy };
}