import { Heart, Copy, GripVertical, Maximize2, Minus, RefreshCw, Shuffle, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { attachStream } from "../stream-player";
import type { StreamHandle, StreamMode } from "../stream-player";
import type { OnlineHost, OnlinePlatform } from "../types";
import { isAbortError, isUnauthorizedError, onlinePlayHosts } from "../api";
import { useApiFailure } from "../session";
import { copyText, cx } from "../utils";
import { Spinner } from "./Spinner";
import { useToast } from "./Toast";

interface Position { x: number; y: number }
interface Drag { pointerId: number; x: number; y: number; origin: Position }
function playerWidth(): number {
  const sidebar = Math.max(112, Math.min(200, window.innerWidth * .29));
  const video = Math.min(320, Math.max(120, (window.innerHeight - 150) * 9 / 16), Math.max(96, window.innerWidth - sidebar - 28));
  return video + sidebar;
}
function initialPosition(index: number): Position {
  const width = playerWidth();
  const columns = Math.max(1, Math.floor((window.innerWidth - 24) / (width + 12)));
  return { x: Math.max(12, window.innerWidth - 12 - width - (index % columns) * (width + 12)), y: 24 + Math.floor(index / columns) * 36 };
}

export function LivePlayerWindow({ host, channels, platforms, mode, index, zIndex, restoreToken, followed, followBusy, onToggleFollow, onClose, onActivate, onChange }: {
  host: OnlineHost;
  channels: OnlineHost[];
  platforms: OnlinePlatform[];
  mode: StreamMode;
  index: number;
  zIndex: number;
  restoreToken: number;
  followed: boolean;
  followBusy: boolean;
  onToggleFollow: () => void;
  onClose: () => void;
  onActivate: () => void;
  onChange: (host: OnlineHost, channels?: OnlineHost[], platform?: OnlinePlatform) => void;
}): ReactNode {
  const toast = useToast();
  const handleFailure = useApiFailure();
  const randomController = useRef<AbortController | null>(null);
  const [randomLoading, setRandomLoading] = useState(false);
  const [search, setSearch] = useState("");
  const activeChannelRef = useRef<HTMLButtonElement>(null);
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
  useEffect(() => () => { randomController.current?.abort(); randomController.current = null; }, []);
  useEffect(() => {
    randomController.current?.abort();
    randomController.current = null;
    setRandomLoading(false);
    setSearch("");
    activeChannelRef.current?.scrollIntoView({ block: "nearest" });
  }, [host.address]);

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
  const visibleChoices = choices.filter((item) => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const selectChannel = (next: OnlineHost): void => {
    randomController.current?.abort();
    randomController.current = null;
    setRandomLoading(false);
    onChange(next);
  };
  const randomHost = async (): Promise<void> => {
    randomController.current?.abort();
    const controller = new AbortController();
    randomController.current = controller;
    setRandomLoading(true);
    const pool = [...platforms];
    for (let i = pool.length - 1; i > 0; i--) {
      const pick = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[pick]] = [pool[pick], pool[i]];
    }
    try {
      for (const platform of pool) {
        if (controller.signal.aborted) return;
        const attempt = new AbortController();
        const abort = (): void => attempt.abort();
        controller.signal.addEventListener("abort", abort, { once: true });
        const timer = window.setTimeout(abort, 8000);
        try {
          const list = await onlinePlayHosts(platform.address, attempt.signal);
          if (controller.signal.aborted) return;
          const candidates = list.filter((item) => item.address !== host.address);
          if (candidates.length === 0) continue;
          const next = candidates[Math.floor(Math.random() * candidates.length)];
          onChange(next, list, platform);
          toast.success("随机主播：" + platform.title + " · " + next.title);
          return;
        } catch (cause: unknown) {
          if (controller.signal.aborted) return;
          if (isUnauthorizedError(cause)) { handleFailure(cause); return; }
          if (!isAbortError(cause)) { /* Try another randomly ordered platform. */ }
        } finally {
          window.clearTimeout(timer);
          controller.signal.removeEventListener("abort", abort);
        }
      }
      if (!controller.signal.aborted) toast.error("暂时没有其他可选主播，请刷新后重试");
    } finally {
      if (randomController.current === controller) { randomController.current = null; setRandomLoading(false); }
    }
  };

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
        <button type="button" className={cx("icon-btn icon-btn-xs", followed && "op-follow-icon-active")} disabled={followBusy} onClick={onToggleFollow} title={followed ? "取消关注" : "关注主播"} aria-label={followed ? "取消关注当前主播" : "关注当前主播"} aria-pressed={followed}><Heart size={15} fill={followed ? "currentColor" : "none"} /></button>
        <button type="button" className="icon-btn icon-btn-xs" onClick={() => setMinimized((value) => !value)} aria-label={minimized ? "展开播放器" : "最小化播放器"} title={minimized ? "展开" : "最小化"}>
          {minimized ? <Maximize2 size={15} /> : <Minus size={15} />}
        </button>
        <button type="button" className="icon-btn icon-btn-xs" onClick={onClose} aria-label={`关闭 ${host.title}`} title="关闭窗口"><X size={16} /></button>
      </header>
      <div className="op-live-body">
        <div className="op-live-player-column">
        <div className="op-live-stage">
          <video ref={videoRef} className="op-live-video" controls playsInline autoPlay muted={muted}
            onVolumeChange={() => { if (videoRef.current) setMuted(videoRef.current.muted); }} />
          {loading && !error ? <div className="op-live-loading" role="status"><Spinner size={22} /><span>正在加载直播…</span></div> : null}
          {error ? <div className="op-live-error" role="alert"><p>{error}</p><button type="button" className="btn btn-primary btn-sm" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} />重新连接</button></div> : null}
        </div>
        <footer className="op-live-controls">

          <div className="op-live-actions">
            <button type="button" className="btn btn-ghost btn-xs" onClick={toggleSound} title={muted ? "开启声音" : "静音"} aria-label={muted ? "开启声音" : "静音"}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}<span>{muted ? "开启声音" : "静音"}</span>
            </button>
            <button type="button" className="icon-btn icon-btn-xs" onClick={() => setRetry((value) => value + 1)} title="重连" aria-label="重新连接直播"><RefreshCw size={14} /></button>
            <button type="button" className="icon-btn icon-btn-xs" onClick={() => void copy()} title="复制地址" aria-label="复制播放地址"><Copy size={14} /></button>
          </div>
        </footer>
        </div>
        <aside className="op-live-sidebar" aria-label="其他主播快捷切换">
          <div className="op-live-sidebar-head">
            <strong>其他主播 <small>{choices.length}</small></strong>
            <button type="button" className="btn btn-primary btn-sm op-live-random" disabled={randomLoading || platforms.length === 0}
              onClick={() => void randomHost()} title="随机选择一个平台，再从该平台随机选择主播">
              <Shuffle size={14} aria-hidden="true" />{randomLoading ? "随机选择中…" : "随机主播"}
            </button>
            <input className="input op-live-search" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索其他主播" placeholder="搜索主播" />
          </div>
          <div className="op-live-host-list">
            {visibleChoices.map((item, itemIndex) => <button key={`${item.address}-${itemIndex}`} type="button"
              ref={item.address === host.address ? activeChannelRef : undefined}
              className={cx("op-live-host", item.address === host.address && "op-live-host-active")}
              aria-pressed={item.address === host.address} onClick={() => selectChannel(item)} title={item.title}>
              <span className="op-live-host-cover">{item.cover ? <img src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : <span>▶</span>}</span>
              <span className="op-live-host-name"><strong>{item.title}</strong>{item.address === host.address ? <small>正在播放</small> : null}</span>
            </button>)}
            {visibleChoices.length === 0 ? <p className="op-live-host-empty">没有匹配的主播</p> : null}
          </div>
        </aside>
      </div>
    </div>, document.body,
  );
}
