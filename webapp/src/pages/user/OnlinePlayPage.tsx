import { Copy, ExternalLink, Eye, EyeOff, Play, RefreshCw, Tv } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { isAbortError, isUnauthorizedError, onlinePlayHosts, onlinePlayPlatforms } from "../../api";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
import { Skeleton } from "../../components/Skeleton";
import { Spinner } from "../../components/Spinner";
import { useToast } from "../../components/Toast";
import { errorText, useApiFailure } from "../../session";
import { attachStream, type StreamHandle } from "../../stream-player";
import type { OnlineHost, OnlinePlatform } from "../../types";
import { copyText, cx } from "../../utils";

/* ---------------------------- 主播卡片（悬停预览） ---------------------------- */

function HostCard({
  host,
  onOpen,
  forcePreview
}: {
  host: OnlineHost;
  onOpen: (host: OnlineHost) => void;
  forcePreview: boolean;
}): ReactNode {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handleRef = useRef<StreamHandle | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const [previewing, setPreviewing] = useState(false);
  const [failed, setFailed] = useState(false);

  const stop = useCallback((): void => {
    activeRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    handleRef.current?.destroy();
    handleRef.current = null;
    setPreviewing(false);
  }, []);

  const start = useCallback((): void => {
    if (failed || timerRef.current !== null || handleRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const video = videoRef.current;
      if (!video) return;
      activeRef.current = true;
      setPreviewing(true);
      void attachStream(video, host.address, {
        muted: true,
        onPlaying: () => {
          if (activeRef.current) setPreviewing(true);
        },
        onError: () => {
          if (activeRef.current) {
            setFailed(true);
            setPreviewing(false);
          }
        }
      }).then((handle) => {
        // 若期间已被停止（如点了播放/关闭全部预览），立刻销毁，避免延迟回调把预览又点亮
        if (activeRef.current) handleRef.current = handle;
        else handle.destroy();
      });
    }, 260);
  }, [failed, host.address]);

  useEffect(() => () => stop(), [stop]);

  // 「全部预览」：只对视口内的卡片拉流，滚出视口即停止，避免一次开上百路把浏览器拖垮
  useEffect(() => {
    if (!forcePreview) return undefined;
    const el = cardRef.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) start();
          else stop();
        }
      },
      { threshold: 0.35 }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      stop();
    };
  }, [forcePreview, start, stop]);

  return (
    <button
      ref={cardRef}
      type="button"
      className="op-card"
      onMouseEnter={() => {
        if (!forcePreview) start();
      }}
      onMouseLeave={() => {
        if (!forcePreview) stop();
      }}
      onFocus={() => {
        if (!forcePreview) start();
      }}
      onBlur={() => {
        if (!forcePreview) stop();
      }}
      onClick={() => {
        stop();
        onOpen(host);
      }}
    >
      <span className="op-cover">
        {host.cover ? (
          <img
            src={host.cover}
            alt={host.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
          />
        ) : null}
        <video ref={videoRef} className={cx("op-preview-video", previewing && "op-preview-video-on")} muted playsInline />
        <span className="op-play-badge">
          <Play size={26} aria-hidden="true" />
        </span>
        {previewing ? <span className="op-preview-tag">预览中</span> : <span className="op-preview-tag op-preview-tag-idle">悬停预览</span>}
      </span>
      <span className="op-card-title">{host.title}</span>
    </button>
  );
}

/* ---------------------------- 播放弹窗（左播放器 / 右频道切换） ---------------------------- */

function PlayerModal({
  hosts,
  start,
  onClose
}: {
  hosts: OnlineHost[];
  start: OnlineHost;
  onClose: () => void;
}): ReactNode {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handleRef = useRef<StreamHandle | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState<OnlineHost>(start);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void attachStream(video, current.address, {
      onPlaying: () => {
        if (!cancelled) setLoading(false);
      },
      onError: (message) => {
        if (!cancelled) {
          setError(message);
          setLoading(false);
        }
      }
    }).then((handle) => {
      if (cancelled) handle.destroy();
      else handleRef.current = handle;
    });
    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [current]);

  // 切换时把当前项滚进可视区
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(".op-switch-item-active");
    active?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onCopy = async (): Promise<void> => {
    const copied = await copyText(current.address);
    if (copied) toast.success("播放地址已复制");
    else toast.error("复制失败");
  };

  return (
    <Modal open title={current.title || "在线播放"} onClose={onClose} maxWidth={1180} closeOnBackdrop={false}>
      <div className="op-player-split">
        <div className="op-player-left">
          <div className="op-player-stage">
            <video ref={videoRef} className="op-video" controls playsInline autoPlay />
            {loading && error === null ? (
              <div className="op-player-loading">
                <Spinner size={22} />
                <span>正在加载直播流…</span>
              </div>
            ) : null}
          </div>
          {error !== null ? <div className="alert alert-error">{error}</div> : null}
          <div className="op-player-bar">
            <span className="op-player-url" title={current.address}>
              {current.address}
            </span>
            <div className="op-player-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onCopy()}>
                <Copy size={15} aria-hidden="true" />
                复制地址
              </button>
              <a className="btn btn-primary btn-sm" href={current.address} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={15} aria-hidden="true" />
                新窗口打开
              </a>
            </div>
          </div>
          <p className="form-hint">部分直播流为 FLV/HLS，若无法直接播放，请用「新窗口打开」在本机播放器打开。</p>
        </div>

        <aside className="op-player-right">
          <div className="op-switch-head">其他频道 · {hosts.length}</div>
          <div className="op-switch-list" ref={listRef}>
            {hosts.map((host, index) => (
              <button
                key={`${host.address}-${index}`}
                type="button"
                className={cx("op-switch-item", host.address === current.address && "op-switch-item-active")}
                onClick={() => setCurrent(host)}
                title={host.title}
              >
                <span className="op-switch-thumb">
                  {host.cover ? <img src={host.cover} alt={host.title} loading="lazy" referrerPolicy="no-referrer" /> : null}
                </span>
                <span className="op-switch-title">{host.title}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </Modal>
  );
}

/* ---------------------------- 页面 ---------------------------- */

export function OnlinePlayPage(): ReactNode {
  const handleFailure = useApiFailure();
  const [platforms, setPlatforms] = useState<OnlinePlatform[]>([]);
  const [platformsLoading, setPlatformsLoading] = useState(true);
  const [platformsError, setPlatformsError] = useState<string | null>(null);
  const [noPermission, setNoPermission] = useState(false);
  const [activePlatform, setActivePlatform] = useState<string | null>(null);

  const [hosts, setHosts] = useState<OnlineHost[]>([]);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<OnlineHost | null>(null);
  const [previewAll, setPreviewAll] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setPlatformsLoading(true);
    onlinePlayPlatforms(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setPlatforms(list);
        setPlatformsError(null);
        setNoPermission(false);
        setActivePlatform((prev) =>
          prev !== null && list.some((item) => item.address === prev) ? prev : (list[0]?.address ?? null),
        );
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        if ((cause as { status?: number }).status === 403) {
          setNoPermission(true);
          return;
        }
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        setPlatformsError(errorText(cause, "频道列表加载失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPlatformsLoading(false);
      });
    return () => controller.abort();
  }, [handleFailure, reloadToken]);

  useEffect(() => {
    if (activePlatform === null) {
      setHosts([]);
      return undefined;
    }
    const controller = new AbortController();
    setHostsLoading(true);
    setHostsError(null);
    onlinePlayHosts(activePlatform, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setHosts(list);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        setHosts([]);
        setHostsError(errorText(cause, "频道内容加载失败"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setHostsLoading(false);
      });
    return () => controller.abort();
  }, [activePlatform, reloadToken]);

  const reload = useCallback(() => setReloadToken((v) => v + 1), []);
  const activeTitle = platforms.find((item) => item.address === activePlatform)?.title ?? "";

  if (noPermission) {
    return (
      <section className="card">
        <EmptyState
          icon={<Tv size={22} aria-hidden="true" />}
          title="没有「在线播放」权限"
          description="该功能需要管理员在「用户管理」里为你的账号开通权限后才能使用。"
        />
      </section>
    );
  }

  return (
    <div className="page-stack op-page">
      <div className="op-layout">
        <aside className="card op-side">
          <div className="op-side-head">
            <span>频道平台</span>
            <span className="op-side-total">{platforms.length}</span>
            <button type="button" className="icon-btn" onClick={reload} title="刷新" aria-label="刷新">
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="op-side-list">
            {platformsLoading && platforms.length === 0 ? (
              Array.from({ length: 10 }).map((_, index) => <Skeleton key={index} height={56} radius={10} />)
            ) : platformsError !== null ? (
              <div className="alert alert-error">{platformsError}</div>
            ) : (
              platforms.map((item) => (
                <button
                  key={item.address}
                  type="button"
                  className={cx("op-side-item", activePlatform === item.address && "op-side-item-active")}
                  onClick={() => setActivePlatform(item.address)}
                  title={item.title}
                >
                  <span className="op-side-thumb">
                    {item.cover ? (
                      <img
                        src={item.cover}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(event) => {
                          (event.currentTarget as HTMLImageElement).style.visibility = "hidden";
                        }}
                      />
                    ) : null}
                  </span>
                  <span className="op-side-title">{item.title}</span>
                  <span className="op-side-count">{item.count}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="card op-main">
          <div className="op-main-head">
            <div className="op-main-title">
              <strong>{activeTitle || "主播"}</strong>
              <span className="cell-muted"> · {hostsLoading ? "加载中…" : `${hosts.length} 个频道`}</span>
            </div>
            <button
              type="button"
              className={cx("btn btn-sm", previewAll ? "btn-primary" : "btn-ghost")}
              onClick={() => setPreviewAll((v) => !v)}
              disabled={hosts.length === 0}
              title="对当前平台视口内的频道同时静音预览"
            >
              {previewAll ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
              {previewAll ? "关闭全部预览" : "全部预览"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={reload} disabled={hostsLoading}>
              <RefreshCw size={15} aria-hidden="true" />
              刷新
            </button>
          </div>

          {hostsError !== null ? (
            <div className="alert alert-error" role="alert" style={{ margin: "0 16px 8px" }}>
              {hostsError}
            </div>
          ) : null}

          {hostsLoading ? (
            <div className="op-grid">
              {Array.from({ length: 12 }).map((_, index) => (
                <Skeleton key={index} height={170} radius={12} />
              ))}
            </div>
          ) : hosts.length === 0 ? (
            <EmptyState compact icon={<Tv size={22} aria-hidden="true" />} title="该平台暂无可播放频道" description="换一个平台试试，或点右上角刷新。" />
          ) : (
            <div className="op-grid">
              {hosts.map((host, index) => (
                <HostCard
                  key={`${host.address}-${index}`}
                  host={host}
                  forcePreview={previewAll}
                  onOpen={(next) => {
                    setPreviewAll(false);
                    setPlaying(next);
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {playing !== null ? <PlayerModal hosts={hosts} start={playing} onClose={() => setPlaying(null)} /> : null}
    </div>
  );
}
