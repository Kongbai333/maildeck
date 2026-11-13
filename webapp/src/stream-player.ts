/** 在线播放流媒体挂载：支持 FLV(flv.js) / HLS(hls.js) / 原生 video。 */

type FlvErrorListener = (type: unknown, detail: unknown) => void;

interface FlvPlayer {
  on(event: string, listener: FlvErrorListener): void;
  off?(event: string, listener: FlvErrorListener): void;
  attachMediaElement(video: HTMLVideoElement): void;
  load(): void;
  play(): Promise<void> | void;
  pause(): void;
  unload(): void;
  detachMediaElement(): void;
  destroy(): void;
}

interface FlvLibrary {
  isSupported(): boolean;
  createPlayer(source: { type: "flv"; url: string; isLive: boolean; hasAudio: boolean }): FlvPlayer;
  Events: { ERROR: string };
}

interface HlsErrorData {
  fatal?: boolean;
}

type HlsListener = (event: unknown, data?: HlsErrorData) => void;

interface HlsPlayer {
  on(event: string, listener: HlsListener): void;
  off?(event: string, listener: HlsListener): void;
  loadSource(url: string): void;
  attachMedia(video: HTMLVideoElement): void;
  destroy(): void;
}

interface HlsLibrary {
  new (): HlsPlayer;
  isSupported(): boolean;
  Events: { ERROR: string; MANIFEST_PARSED: string };
}

declare global {
  interface Window {
    flvjs?: FlvLibrary;
    Hls?: HlsLibrary;
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
const streamWaiters: Array<{ priority: StreamPriority; grant: () => void }> = [];

function maxStreams(): number {
  return getRuntimeStreamMode() === "proxy" ? PROXIED_MAX_STREAMS : DIRECT_MAX_STREAMS;
}

function drainStreamWaiters(): void {
  while (activeStreams < maxStreams() && streamWaiters.length > 0) {
    streamWaiters.shift()?.grant();
  }
}

function acquireStreamSlot(priority: StreamPriority, signal: AbortSignal): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let release: (() => void) | null = null;
    const onAbort = (): void => {
      if (release) {
        release();
      } else {
        const index = streamWaiters.indexOf(waiter);
        if (index !== -1) streamWaiters.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      }
    };
    const waiter = {
      priority,
      grant: (): void => {
        if (signal.aborted) {
          onAbort();
          return;
        }
        activeStreams += 1;
        let released = false;
        release = (): void => {
          if (released) return;
          released = true;
          signal.removeEventListener("abort", onAbort);
          activeStreams -= 1;
          drainStreamWaiters();
        };
        // 保留 abort 监听直到释放，覆盖发放槽位后、await 恢复前的取消。
        resolve(release);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    streamWaiters.push(waiter);
    streamWaiters.sort((a, b) => a.priority - b.priority);
    drainStreamWaiters();
  });
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

/** 按模式拼出实际请求地址：直连 = 原 CDN 地址；代理 = 同源 /api 代理。 */
export function streamUrlFor(url: string, mode: StreamMode): string {
  return mode === "proxy" ? `/api/me/online-play/stream?url=${encodeURIComponent(url)}` : url;
}

/** 模式记忆：下次进来沿用上次选择。 */
const MODE_KEY = "maildeck.onlinePlay.mode";

export function readSavedMode(): StreamMode | null {
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    return saved === "direct" || saved === "proxy" ? saved : null;
  } catch {
    return null;
  }
}

export function saveMode(mode: StreamMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* 隐私模式忽略 */
  }
}

export interface ModeProbe {
  /** 可用的话应该是哪种模式 */
  mode: StreamMode;
  ok: boolean;
  /** 诊断原因：http-page / reachable / blocked / HTTP xxx */
  reason: string;
}

/**
 * 探测能否直连（走用户本地流量）。
 * https 页面下用真实 http 流试拉一次：
 * - 成功 → 直连可用（用户在站点设置里允许了「不安全内容」）
 * - 抛错 → 浏览器按混合内容拦截（或网络不可达），只能走代理
 */
export async function probeDirect(sampleUrl: string): Promise<ModeProbe> {
  if (typeof window === "undefined") {
    return { mode: "direct", ok: true, reason: "no-window" };
  }
  if (window.location.protocol !== "https:") {
    return { mode: "direct", ok: true, reason: "http-page" };
  }
  if (!/^http:\/\//iu.test(sampleUrl)) {
    return { mode: "direct", ok: true, reason: "already-https" };
  }
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 6000);
    const response = await fetch(sampleUrl, { mode: "cors", cache: "no-store", signal: controller.signal });
    window.clearTimeout(timer);
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    if (response.ok) {
      return { mode: "direct", ok: true, reason: "reachable" };
    }
    return { mode: "proxy", ok: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { mode: "proxy", ok: false, reason: message || "blocked" };
  }
}

/** 兼容旧调用：只返回模式。 */
export async function detectStreamMode(sampleUrl: string): Promise<StreamMode> {
  const probe = await probeDirect(sampleUrl);
  return probe.mode;
}

/** 兼容旧调用：是否处于同源代理模式。 */
export function isProxied(): boolean {
  return getRuntimeStreamMode() === "proxy";
}

type LibraryName = "flvjs" | "Hls";

interface ScriptSubscriber {
  resolve(): void;
  reject(error: Error): void;
}

interface ScriptLoad {
  subscribers: Set<ScriptSubscriber>;
  start(): void;
  cancel(): void;
}

const scriptLoads = new Map<LibraryName, ScriptLoad>();

function libraryReady(name: LibraryName): boolean {
  if (name === "flvjs") {
    const library = window.flvjs;
    return !!library && typeof library.isSupported === "function"
      && typeof library.createPlayer === "function" && typeof library.Events?.ERROR === "string";
  }
  const library = window.Hls;
  return typeof library === "function" && typeof library.isSupported === "function"
    && typeof library.Events?.ERROR === "string" && typeof library.Events?.MANIFEST_PARSED === "string";
}

function createScriptLoad(src: string, name: LibraryName): ScriptLoad {
  const script = document.createElement("script");
  script.src = src;
  script.async = true;
  script.dataset.lib = name;
  const subscribers = new Set<ScriptSubscriber>();
  let settled = false;
  let timer: number | null = null;
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    script.removeEventListener("load", onLoad);
    script.removeEventListener("error", onError);
    if (scriptLoads.get(name) === load) scriptLoads.delete(name);
    if (error) {
      script.remove();
      if (!libraryReady(name)) delete window[name];
    }
    for (const subscriber of [...subscribers]) {
      if (error) subscriber.reject(error);
      else subscriber.resolve();
    }
    subscribers.clear();
  };
  const onLoad = (): void => {
    finish(libraryReady(name) ? undefined : new Error("播放库无效，请重试"));
  };
  const onError = (): void => finish(new Error("播放库加载失败（请检查网络）"));
  const load: ScriptLoad = {
    subscribers,
    start: (): void => {
      try {
        // 没有缓存任务且没有可用全局库的旧标签可能已失败，重新加载才可重试。
        document.querySelector<HTMLScriptElement>(`script[data-lib="${name}"]`)?.remove();
        script.addEventListener("load", onLoad);
        script.addEventListener("error", onError);
        timer = window.setTimeout(() => finish(new Error("播放库加载超时，请重试")), 15_000);
        document.head.appendChild(script);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("播放库加载失败"));
      }
    },
    cancel: (): void => finish(new Error("播放库加载已取消"))
  };
  return load;
}

/** 多路挂载共享加载任务；每个等待者独立取消，最后一位离开时撤销脚本和计时器。 */
function loadScript(src: string, name: LibraryName, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (libraryReady(name)) return Promise.resolve(true);
  if (window[name] !== undefined) {
    delete window[name];
    return Promise.reject(new Error("播放库无效，请重试"));
  }
  let load = scriptLoads.get(name);
  const shouldStart = !load;
  if (!load) {
    load = createScriptLoad(src, name);
    scriptLoads.set(name, load);
  }
  const pending = load;
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      pending.subscribers.delete(subscriber);
    };
    const onAbort = (): void => {
      cleanup();
      resolve(false);
      if (pending.subscribers.size === 0) pending.cancel();
    };
    const subscriber: ScriptSubscriber = {
      resolve: (): void => { cleanup(); resolve(true); },
      reject: (error): void => { cleanup(); reject(error); }
    };
    pending.subscribers.add(subscriber);
    signal.addEventListener("abort", onAbort, { once: true });
    if (shouldStart) pending.start();
  });
}

export interface StreamHandle {
  /** 彻底停止连接并释放资源；预览定格由调用方在销毁前复制到 canvas。 */
  destroy(): void;
}

export interface AttachOptions {
  muted?: boolean;
  /** 0 = 主播放器，1 = 预览（默认 1） */
  priority?: StreamPriority;
  /** 直连 or 走代理；不传则用页面探测到的全局模式 */
  mode?: StreamMode;
  /** 同时取消排队、库加载等待和已挂载的播放器。 */
  signal?: AbortSignal;
  /** 超过这个时间还没出画面就判定「卡住」，默认 12s；0 = 不检测 */
  stallTimeoutMs?: number;
  onError?: (message: string) => void;
  onPlaying?: () => void;
}

const videoOwners = new WeakMap<HTMLVideoElement, StreamHandle>();

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // 单项清理或调用方回调失败不应打断剩余清理，也不应产生异步拒绝。
  }
}

/** 挂载后返回句柄，不等待 play()；失败通过 onError 回调，取消静默返回已销毁句柄。 */
export async function attachStream(
  video: HTMLVideoElement,
  url: string,
  options: AttachOptions = {}
): Promise<StreamHandle> {
  const controller = new AbortController();
  const signal = options.signal;
  let disposed = false;
  let playing = false;
  let release: (() => void) | null = null;
  let player: FlvPlayer | null = null;
  let hls: HlsPlayer | null = null;
  let flvErrorEvent = "";
  let hlsErrorEvent = "";
  let hlsManifestEvent = "";
  let stallTimer: number | null = null;

  const clearStallTimer = (): void => {
    if (stallTimer !== null) window.clearTimeout(stallTimer);
    stallTimer = null;
  };
  const disposeFlv = (instance: FlvPlayer): void => {
    if (flvErrorEvent) safely(() => instance.off?.(flvErrorEvent, onFlvError));
    safely(() => instance.pause());
    safely(() => instance.unload());
    safely(() => instance.detachMediaElement());
    safely(() => instance.destroy());
  };
  const disposeHls = (instance: HlsPlayer): void => {
    if (hlsErrorEvent) safely(() => instance.off?.(hlsErrorEvent, onHlsError));
    if (hlsManifestEvent) safely(() => instance.off?.(hlsManifestEvent, onHlsManifest));
    safely(() => instance.destroy());
  };
  const destroy = (): void => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", destroy);
    controller.abort();
    clearStallTimer();
    video.removeEventListener("playing", onPlaying);
    video.removeEventListener("error", onVideoError);
    const oldPlayer = player;
    const oldHls = hls;
    player = null;
    hls = null;
    if (oldPlayer) disposeFlv(oldPlayer);
    if (oldHls) disposeHls(oldHls);
    // 旧句柄和迟到的异步结果永远不能清空后来挂载到同一 video 的资源。
    if (videoOwners.get(video) === handle) {
      videoOwners.delete(video);
      safely(() => video.pause());
      safely(() => video.removeAttribute("src"));
      safely(() => video.load());
    }
    release?.();
    release = null;
  };
  const handle: StreamHandle = { destroy };
  const isCurrent = (): boolean => !disposed && videoOwners.get(video) === handle;
  const fail = (message: string): void => {
    if (!isCurrent()) return;
    // 先归还资源，回调即使抛错或立即开始新一轮挂载也不会泄漏或误清理。
    destroy();
    safely(() => options.onError?.(message));
  };
  const startPlayback = (play: () => Promise<void> | void): void => {
    if (!isCurrent()) return;
    try {
      void Promise.resolve(play()).catch((error: unknown) => {
        fail(error instanceof Error ? error.message : "播放失败");
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : "播放失败");
    }
  };
  const onPlaying = (): void => {
    if (!isCurrent()) return;
    playing = true;
    clearStallTimer();
    safely(() => options.onPlaying?.());
  };
  const onVideoError = (): void => fail(video.error?.message || "播放出错：流不可用或格式不支持");
  const onFlvError: FlvErrorListener = (_type, detail): void => {
    fail(`播放出错：${typeof detail === "string" && detail ? detail : "流不可用/被跨域拦截"}`);
  };
  const onHlsError: HlsListener = (_event, data): void => {
    if (data?.fatal) fail("播放出错：HLS 流不可用");
  };
  const onHlsManifest = (): void => {
    if (!isCurrent()) return;
    const instance = hls;
    if (instance) safely(() => instance.off?.(hlsManifestEvent, onHlsManifest));
    startPlayback(() => video.play());
  };

  if (signal?.aborted) {
    destroy();
    return handle;
  }
  // 在首次 await 前建立归属，使同一个元素的重复挂载也能取消旧排队/加载。
  videoOwners.get(video)?.destroy();
  videoOwners.set(video, handle);
  signal?.addEventListener("abort", destroy, { once: true });
  if (signal?.aborted) {
    destroy();
    return handle;
  }

  try {
    release = await acquireStreamSlot(options.priority ?? 1, controller.signal);
    if (!release || !isCurrent()) {
      release?.();
      release = null;
      return handle;
    }
    if (options.muted !== undefined) video.muted = options.muted;
    video.addEventListener("playing", onPlaying, { once: true });
    video.addEventListener("error", onVideoError);
    const stallMs = options.stallTimeoutMs ?? 12_000;
    if (stallMs > 0) {
      stallTimer = window.setTimeout(() => {
        stallTimer = null;
        if (!playing) fail("频道无响应（可能是同一 CDN 连接占满或该频道已下线），换一个试试");
      }, stallMs);
    }

    const target = streamUrlFor(url, options.mode ?? getRuntimeStreamMode());
    if (/\.flv(\?|$)/i.test(url)) {
      if (!await loadScript(FLV_CDN, "flvjs", controller.signal) || !isCurrent()) return handle;
      const flvjs = window.flvjs;
      if (!flvjs || !flvjs.isSupported()) {
        fail("当前浏览器不支持 FLV 直播");
        return handle;
      }
      const instance = flvjs.createPlayer({ type: "flv", url: target, isLive: true, hasAudio: true });
      if (!isCurrent()) {
        disposeFlv(instance);
        return handle;
      }
      player = instance;
      flvErrorEvent = flvjs.Events.ERROR;
      instance.on(flvErrorEvent, onFlvError);
      if (!isCurrent()) return handle;
      instance.attachMediaElement(video);
      if (!isCurrent()) return handle;
      instance.load();
      startPlayback(() => instance.play());
    } else if (/\.m3u8(\?|$)/i.test(url) && !video.canPlayType("application/vnd.apple.mpegurl")) {
      if (!await loadScript(HLS_CDN, "Hls", controller.signal) || !isCurrent()) return handle;
      const Hls = window.Hls;
      if (!Hls || !Hls.isSupported()) {
        fail("当前浏览器不支持 HLS 直播");
        return handle;
      }
      const instance = new Hls();
      if (!isCurrent()) {
        disposeHls(instance);
        return handle;
      }
      hls = instance;
      hlsErrorEvent = Hls.Events.ERROR;
      hlsManifestEvent = Hls.Events.MANIFEST_PARSED;
      instance.on(hlsErrorEvent, onHlsError);
      if (!isCurrent()) return handle;
      instance.on(hlsManifestEvent, onHlsManifest);
      if (!isCurrent()) return handle;
      instance.attachMedia(video);
      if (!isCurrent()) return handle;
      instance.loadSource(target);
    } else {
      // 包括浏览器原生 HLS；与 flv.js/hls.js 使用相同的直连/代理目标。
      video.src = target;
      startPlayback(() => video.play());
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "播放失败");
  }

  return handle;
}
