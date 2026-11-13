import { Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { attachStream } from "../stream-player";
import type { StreamHandle, StreamMode } from "../stream-player";
import { acquirePreview, markPreviewRunning, registerPreview, streamHost, unregisterPreview } from "../preview-scheduler";
import type { OnlineHost } from "../types";
import { cx } from "../utils";

type Phase = "idle" | "queued" | "loading" | "playing" | "frozen" | "error";
const PREVIEW_MS = 5000;

/** A canvas retains the displayed frame while destroy() releases the actual stream. */
export function OnlineHostCard({ host, mode, forcePreview, onOpen }: {
  host: OnlineHost;
  mode: StreamMode;
  forcePreview: boolean;
  onOpen: (host: OnlineHost) => void;
}): ReactNode {
  const cardRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<StreamHandle | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);
  const keyRef = useRef(Symbol("preview"));
  const generation = useRef(0);
  const activeRef = useRef(false);
  const completedRef = useRef(false);
  const frameRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  const [phase, setPhase] = useState<Phase>("idle");
  const [hasFrame, setHasFrame] = useState(false);

  const updatePhase = useCallback((next: Phase): void => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const capture = useCallback((): void => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    try {
      const context = canvas.getContext("2d");
      if (!context) return;
      const scale = Math.min(1, 320 / video.videoWidth, 570 / video.videoHeight);
      const nextFrame = document.createElement("canvas");
      nextFrame.width = Math.max(1, Math.round(video.videoWidth * scale));
      nextFrame.height = Math.max(1, Math.round(video.videoHeight * scale));
      const nextContext = nextFrame.getContext("2d");
      if (!nextContext) return;
      nextContext.drawImage(video, 0, 0, nextFrame.width, nextFrame.height);
      canvas.width = nextFrame.width;
      canvas.height = nextFrame.height;
      context.drawImage(nextFrame, 0, 0);
      // No readback/export: cross-origin video may taint a canvas but can still be displayed.
      frameRef.current = true;
      setHasFrame(true);
    } catch {
      // Keep the last successful snapshot, or the channel cover if there is no frame yet.
    }
  }, []);

  const stop = useCallback((): void => {
    capture();
    generation.current++;
    activeRef.current = false;
    unregisterPreview(keyRef.current);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    controllerRef.current?.abort();
    controllerRef.current = null;
    handleRef.current?.destroy();
    handleRef.current = null;
    releaseRef.current?.();
    releaseRef.current = null;
    updatePhase(frameRef.current ? "frozen" : "idle");
  }, [capture, updatePhase]);

  const start = useCallback((urgent: boolean): void => {
    if (!urgent && completedRef.current) return;
    if (activeRef.current) {
      if (!urgent || phaseRef.current !== "queued") return;
      stop();
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const currentGeneration = ++generation.current;
    const isCurrent = (): boolean => currentGeneration === generation.current && !controller.signal.aborted;
    activeRef.current = true;
    updatePhase("queued");
    registerPreview(keyRef.current, streamHost(host.address), stop);
    void (async () => {
      const release = await acquirePreview(keyRef.current, streamHost(host.address), controller.signal, urgent);
      if (!release) return;
      if (!isCurrent()) { release(); return; }
      releaseRef.current = release;
      markPreviewRunning(keyRef.current);
      const video = videoRef.current;
      if (!video) { stop(); return; }
      updatePhase("loading");
      const handle = await attachStream(video, host.address, {
        muted: true, priority: 1, mode, signal: controller.signal, stallTimeoutMs: 8000,
        onPlaying: () => {
          if (!isCurrent()) return;
          updatePhase("playing");
          if (forcePreview) {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
              if (!isCurrent()) return;
              completedRef.current = true;
              stop();
            }, PREVIEW_MS);
          }
        },
        onError: () => {
          if (!isCurrent()) return;
          completedRef.current = true;
          stop();
          if (!frameRef.current) updatePhase("error");
        },
      });
      if (isCurrent()) handleRef.current = handle;
      else handle.destroy();
    })().catch(() => {
      if (!isCurrent()) return;
      completedRef.current = true;
      stop();
      if (!frameRef.current) updatePhase("error");
    });
  }, [forcePreview, host.address, mode, stop, updatePhase]);

  useEffect(() => {
    completedRef.current = false;
    if (!forcePreview || !cardRef.current) return () => stop();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) start(false);
        else stop();
      }
    }, { threshold: 0.35 });
    observer.observe(cardRef.current);
    return () => { observer.disconnect(); stop(); };
  }, [forcePreview, mode, start, stop]);

  const tag = phase === "playing" ? "预览中"
    : phase === "queued" ? (hasFrame ? "已定格 · 等待更新" : "等待预览")
    : phase === "loading" ? "加载预览…"
    : hasFrame ? "已定格 · 悬停继续"
    : phase === "error" ? "暂无画面 · 悬停重试" : "悬停预览";

  return (
    <button ref={cardRef} type="button" className={cx("op-card", phase === "queued" && !hasFrame && "op-card-queued")}
      onMouseEnter={() => start(true)} onMouseLeave={() => { if (!forcePreview) stop(); }}
      onFocus={() => start(true)} onBlur={() => { if (!forcePreview) stop(); }}
      onClick={() => { stop(); onOpen(host); }} aria-label={`播放 ${host.title}`}
    >
      <span className="op-cover">
        {host.cover ? <img src={host.cover} alt="" loading="lazy" referrerPolicy="no-referrer"
          onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : null}
        <canvas ref={canvasRef} className={cx("op-preview-frame", hasFrame && "op-preview-frame-on")} aria-hidden="true" />
        <video ref={videoRef} className={cx("op-preview-video", phase === "playing" && "op-preview-video-on")} muted playsInline aria-hidden="true" />
        <span className="op-play-badge"><Play size={26} aria-hidden="true" /></span>
        <span className={cx("op-preview-tag", phase === "idle" && !hasFrame && "op-preview-tag-idle")}>{tag}</span>
      </span>
      <span className="op-card-title">{host.title}</span>
    </button>
  );
}
