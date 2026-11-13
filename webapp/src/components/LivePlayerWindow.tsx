import { Copy, GripVertical, Maximize2, Minus, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { attachStream } from "../stream-player";
import type { StreamHandle, StreamMode } from "../stream-player";
import type { OnlineHost } from "../types";
import { copyText, cx } from "../utils";
import { Spinner } from "./Spinner";
import { useToast } from "./Toast";

interface Position { x: number; y: number }
interface Drag { pointerId: number; x: number; y: number; origin: Position }
function playerWidth(): number {
  return Math.min(320, Math.max(150, (window.innerHeight - 160) * 9 / 16), window.innerWidth - 24);
}
function initialPosition(index: number): Position {
  const width = playerWidth();
  const columns = Math.max(1, Math.floor((window.innerWidth - 24) / (width + 12)));
  return { x: Math.max(12, window.innerWidth - 12 - width - (index % columns) * (width + 12)), y: 24 + Math.floor(index / columns) * 36 };
}

export function LivePlayerWindow({ host, channels, mode, index, zIndex, restoreToken, onClose, onActivate, onChange }: {
  host: OnlineHost;
  channels: OnlineHost[];
  mode: StreamMode;
  index: number;
  zIndex: number;
  restoreToken: number;
  onClose: () => void;
  onActivate: () => void;
  onChange: (host: OnlineHost) => void;
}): ReactNode {
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [position, setPosition] = useState<Position>(() => initialPosition(index));
  const [width, setWidth] = useState(playerWidth);
  const [minimized, setMinimized] = useState(false);
  const [muted, setMuted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => { setMinimized(false); }, [restoreToken]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const controller = new AbortController();
    let handle: StreamHandle | null = null;
    setLoading(true);
    setError(null);
    void attachStream(video, host.address, {
      priority: 0, mode, muted: mutedRef.current, signal: controller.signal, stallTimeoutMs: 15000,
      onPlaying: () => { if (!controller.signal.aborted) { setLoading(false); setError(null); } },
      onError: (message) => { if (!controller.signal.aborted) { setError(message); setLoading(false); } },
    }).then((next) => {
      if (controller.signal.aborted) next.destroy(); else handle = next;
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "播放失败，请重试"); setLoading(false); }
    });
    return () => { controller.abort(); handle?.destroy(); };
  }, [host.address, mode, retry]);

  useEffect(() => {
    const clamp = (): void => {
      const bounds = rootRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setPosition((previous) => {
        const x = Math.max(8, Math.min(previous.x, window.innerWidth - bounds.width - 8));
        const y = Math.max(8, Math.min(previous.y, window.innerHeight - bounds.height - 8));
        return x === previous.x && y === previous.y ? previous : { x, y };
      });
    };
    const resize = (): void => { setWidth(playerWidth()); clamp(); };
    const observer = new ResizeObserver(clamp);
    if (rootRef.current) observer.observe(rootRef.current);
    window.addEventListener("resize", resize);
    clamp();
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, []);

  const moveTo = (x: number, y: number): void => {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) });
  };
  const dragStart = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: position };
  };
  const dragMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    moveTo(drag.origin.x + event.clientX - drag.x, drag.origin.y + event.clientY - drag.y);
  };
  const toggleSound = (): void => {
    const video = videoRef.current;
    const next = !(video?.muted ?? muted);
    if (video) {
      video.muted = next;
      if (!next && video.volume === 0) video.volume = 1;
      void video.play().catch(() => undefined);
    }
    setMuted(next);
  };
  const copy = async (): Promise<void> => {
    if (await copyText(host.address)) toast.success("播放地址已复制"); else toast.error("复制失败");
  };
  const choices = channels.some((item) => item.address === host.address) ? channels : [host, ...channels];

  return createPortal(
    <div ref={rootRef} role="dialog" aria-label={`直播窗口：${host.title}`}
      className={cx("op-live-window", minimized && "op-live-window-minimized")}
      style={{ left: position.x, top: position.y, width, zIndex }}
      onPointerDownCapture={onActivate} onFocusCapture={onActivate}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
    >
      <header className="op-live-header" tabIndex={0} aria-label="拖动标题栏或使用方向键移动窗口"
        onPointerDown={dragStart} onPointerMove={dragMove}
        onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}
        onLostPointerCapture={() => { dragRef.current = null; }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const step = event.shiftKey ? 40 : 10;
          const offsets: Record<string, Position> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
          const offset = offsets[event.key];
          if (offset) { event.preventDefault(); moveTo(position.x + offset.x, position.y + offset.y); }
        }}
      >
        <GripVertical size={15} aria-hidden="true" />
        <strong title={host.title}>{host.title}</strong>
        <button type="button" className="icon-btn icon-btn-xs" onClick={() => setMinimized((value) => !value)} aria-label={minimized ? "展开播放器" : "最小化播放器"} title={minimized ? "展开" : "最小化"}>
          {minimized ? <Maximize2 size={15} /> : <Minus size={15} />}
        </button>
        <button type="button" className="icon-btn icon-btn-xs" onClick={onClose} aria-label={`关闭 ${host.title}`} title="关闭窗口"><X size={16} /></button>
      </header>
      <div className="op-live-body">
        <div className="op-live-stage">
          <video ref={videoRef} className="op-live-video" controls playsInline autoPlay muted={muted}
            onVolumeChange={() => { if (videoRef.current) setMuted(videoRef.current.muted); }} />
          {loading && !error ? <div className="op-live-loading" role="status"><Spinner size={22} /><span>正在加载直播…</span></div> : null}
          {error ? <div className="op-live-error" role="alert"><p>{error}</p><button type="button" className="btn btn-primary btn-sm" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />重新连接</button></div> : null}
        </div>
        <footer className="op-live-controls">
          <select className="input op-live-channel" aria-label="切换当前窗口频道" value={host.address}
            onChange={(event) => { const next = choices.find((item) => item.address === event.target.value); if (next) onChange(next); }}
          >{choices.map((item, itemIndex) => <option key={`${item.address}-${itemIndex}`} value={item.address}>{item.title}</option>)}</select>
          <div className="op-live-actions">
            <button type="button" className="btn btn-ghost btn-xs" onClick={toggleSound} title={muted ? "开启声音" : "静音"} aria-label={muted ? "开启声音" : "静音"}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}<span>{muted ? "开启声音" : "静音"}</span>
            </button>
            <button type="button" className="icon-btn icon-btn-xs" onClick={() => setRetry((value) => value + 1)} title="重连" aria-label="重新连接直播"><RefreshCw size={14} /></button>
            <button type="button" className="icon-btn icon-btn-xs" onClick={() => void copy()} title="复制地址" aria-label="复制播放地址"><Copy size={14} /></button>
          </div>
        </footer>
      </div>
    </div>, document.body,
  );
}
