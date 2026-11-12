/** 在线播放流媒体挂载：支持 FLV(flv.js) / HLS(hls.js) / 原生 video。 */

declare global {
  interface Window {
    flvjs?: any;
    Hls?: any;
  }
}

const FLV_CDN = "https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js";
const HLS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js";

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
  onError?: (message: string) => void;
  onPlaying?: () => void;
}

/** 把直播流挂到 <video>，返回销毁句柄。不抛错，失败通过 onError 回调。 */
export async function attachStream(video: HTMLVideoElement, url: string, options: AttachOptions = {}): Promise<StreamHandle> {
  let disposed = false;
  let player: any = null;
  let hls: any = null;
  if (options.muted) video.muted = true;

  const destroy = (): void => {
    disposed = true;
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
  };

  const onPlaying = (): void => options.onPlaying?.();

  try {
    if (/\.flv(\?|$)/i.test(url)) {
      const flvjs = await loadScript(FLV_CDN, "flvjs");
      if (disposed) return { destroy };
      if (!flvjs?.isSupported?.()) {
        options.onError?.("当前浏览器不支持 FLV 直播");
        return { destroy };
      }
      player = flvjs.createPlayer({ type: "flv", url, isLive: true, hasAudio: true });
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
      video.src = url;
      video.addEventListener("playing", onPlaying, { once: true });
      await video.play().catch(() => undefined);
    }
  } catch (error) {
    if (!disposed) options.onError?.(error instanceof Error ? error.message : "播放失败");
  }

  return { destroy };
}
