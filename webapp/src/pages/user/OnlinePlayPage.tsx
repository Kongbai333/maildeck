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
import { attachStream, isProxied, type StreamHandle } from "../../stream-player";
import type { OnlineHost, OnlinePlatform } from "../../types";
import { copyText, cx } from "../../utils";

/* ---------------------------- 预览并发闸门 ---------------------------- */

/**
 * 预览限流：
 * - 直连 http 页面：浏览器对同一主机最多 6 条连接，实测同 CDN 19 路只有 6 路出画面，
 *   所以预览全局 4 路、同一 CDN 只 1 路，给主播放器留足连接。
 * - HTTPS（走服务端同源代理 + HTTP/2）：没有 6 条/主机限制，可以多开几路，按 3×3 给 9 路。
 */
const PROXIED = isProxied();
const PREVIEW_MAX = PROXIED ? 9 : 4;
const PREVIEW_PER_HOST = PROXIED ? 99 : 1;

let previewActive = 0;
const previewByHost = new Map<string, number>();
const previewWaiters: Array<{ host: string; resolve: (release: () => void) => void }> = [];

function hostOfUrl(url: string): string {
  const matched = url.match(/^https?:\/\/([^/]+)/i);
  return matched ? matched[1].toLowerCase() : "?";
}

function takePreviewSlot(host: string): (() => void) | null {
  if (previewActive >= PREVIEW_MAX) return null;
  if ((previewByHost.get(host) ?? 0) >= PREVIEW_PER_HOST) return null;
  previewActive += 1;
  previewByHost.set(host, (previewByHost.get(host) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    previewActive = Math.max(0, previewActive - 1);
    const left = (previewByHost.get(host) ?? 1) - 1;
    if (left <= 0) previewByHost.delete(host);
    else previewByHost.set(host, left);
    flushPreviewWaiters();
  };
}

function flushPreviewWaiters(): void {
  for (let index = 0; index < previewWaiters.length; ) {
    const waiter = previewWaiters[index];
    const release = takePreviewSlot(waiter.host);
    if (release) {
      previewWaiters.splice(index, 1);
      waiter.resolve(release);
    } else {
      index += 1;
    }
  }
}

function acquirePreview(host: string, urgent = false): Promise<() => void> {
  const release = takePreviewSlot(host);
  if (release) return Promise.resolve(release);
  return new Promise((resolve) => {
    const waiter = { host, resolve };
    // 悬停/点击触发的预览插队到最前面，保证「看到哪个就想看哪个」能立刻出画面
    if (urgent) previewWaiters.unshift(waiter);
    else previewWaiters.push(waiter);
  });
}

/** 还在排队等槽位的预览数（用于决定要不要轮播）。 */
function previewWaitingCount(): number {
  return previewWaiters.length;
}

/** 正在预览的卡片（key = 流地址）→ { stop, host }，用于悬停时腾槽位与轮播 */
const activePreviews = new Map<string, { stop: () => void; host: string }>();
/** 每张卡片的「重新排队」回调，用于轮播：让被清掉的卡重新回到队尾 */
const previewRestart = new Map<string, () => void>();

/**
 * 悬停抢占：腾出一个槽位给 hoveredHost。
 * 优先清掉「同一 CDN 主机」的预览（否则 per-host 限制仍会挡住它），其次清任意一路。
 */
function evictPreviewFor(keepKey: string, keepHost: string): void {
  const sameHost = [...activePreviews.entries()].find(([key, v]) => key !== keepKey && v.host === keepHost);
  const pick = sameHost ?? [...activePreviews.entries()].find(([key]) => key !== keepKey);
  if (!pick) return;
  activePreviews.delete(pick[0]);
  pick[1].stop();
}

/**
 * 轮播：把最早开始的一路预览清掉并重新排队。
 * 浏览器无论直连还是走同源代理，HTTP/1.1 下同一 origin 都只有 6 条连接，
 * 所以「一次只看 4~6 路」是硬限制；轮播让视口内每一路都能轮到，
 * 扫一遍就知道哪个值得点开，比只显示前几路更有用。
 */
function rotatePreview(): boolean {
  if (activePreviews.size === 0) return false;
  const [key, entry] = activePreviews.entries().next().value as [string, { stop: () => void; host: string }];
  activePreviews.delete(key);
  entry.stop();
  // 让这张卡稍后重新进队列（队尾），这样所有可见卡片都能轮流预览
  const restart = previewRestart.get(key);
  if (restart) {
    window.setTimeout(() => restart(), 120);
  }
  return true;
}

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
  const releaseRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const [previewing, setPreviewing] = useState(false);
  const [queued, setQueued] = useState(false);
  const [failed, setFailed] = useState(false);
  const hostname = hostOfUrl(host.address);

  const stop = useCallback((): void => {
    activeRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    handleRef.current?.destroy();
    handleRef.current = null;
    releaseRef.current?.();
    releaseRef.current = null;
    activePreviews.delete(host.address);
    setPreviewing(false);
    setQueued(false);
  }, [host.address]);

  const begin = useCallback(
    (urgent: boolean): void => {
      setQueued(true);
      void (async () => {
        const release = await acquirePreview(hostname, urgent);
        if (!activeRef.current) {
          release();
          return;
        }
        releaseRef.current = release;
        activePreviews.set(host.address, { stop, host: hostname });
        setQueued(false);
        setPreviewing(true);
        const video = videoRef.current;
        if (!video) return;
        const handle = await attachStream(video, host.address, {
          muted: true,
          priority: 1,
          stallTimeoutMs: 8000,
          onPlaying: () => {
            if (activeRef.current) setPreviewing(true);
          },
          onError: () => {
            if (activeRef.current) {
              setFailed(true);
              setPreviewing(false);
              setQueued(false);
              activePreviews.delete(host.address);
            }
          }
        });
        if (activeRef.current) handleRef.current = handle;
        else handle.destroy();
      })();
    },
    [host.address, hostname, stop]
  );

  /**
   * 开始预览：
   * - 「全部预览」模式：进视口即抢槽位；
   * - 悬停 / 聚焦：先去抖 260ms，再插队抢槽位（并挤掉一路自动预览），
   *   保证「看到哪个就想看哪个」能立刻出画面。
   */
  const start = useCallback(
    (urgent = false): void => {
      if (failed || activeRef.current) return;
      activeRef.current = true;
      if (forcePreview || urgent) {
        if (urgent) {
          // 先排队占位，再腾出别的卡片槽位，槽位会直接转交给排在最前面的它
          begin(true);
          evictPreviewFor(host.address, hostname);
        } else {
          begin(false);
        }
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        begin(false);
      }, 260);
    },
    [begin, failed, forcePreview, host.address, hostname]
  );

  /**
   * 悬停抢占：即使这张卡已在轮播队列里排着，也要立刻插到队首并把当前占用的一路挤掉。
   * （已在播放就不用动。）
   */
  const hoverTakeover = useCallback((): void => {
    if (previewing) return;
    if (activeRef.current) {
      // 已在队列中：先撤销旧排队，再以最高优先级重新排
      stop();
    }
    // 悬停重试：之前判过「无画面」的，再悬停一次重新试（begin 不看 failed 标志）
    if (failed) setFailed(false);
    activeRef.current = true;
    begin(true);
    evictPreviewFor(host.address, hostname);
  }, [begin, failed, host.address, hostname, previewing, stop]);

  useEffect(() => () => stop(), [stop]);

  // 注册「重新排队」回调（轮播用），卸载时清理
  useEffect(() => {
    previewRestart.set(host.address, () => {
      if (!activeRef.current) {
        activeRef.current = true;
        begin(false);
      }
    });
    return () => {
      previewRestart.delete(host.address);
      activePreviews.delete(host.address);
    };
  }, [begin, host.address]);

  // 「全部预览」：只对进入视口的卡片抢槽位，滚出视口立即释放
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

  const tag = previewing ? "预览中" : failed ? "无画面" : "悬停预览";

  return (
    <button
      ref={cardRef}
      type="button"
      className={cx("op-card", queued && "op-card-queued")}
      onMouseEnter={() => {
        hoverTakeover();
      }}
      onMouseLeave={() => {
        if (!forcePreview) stop();
      }}
      onFocus={() => {
        hoverTakeover();
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
        <span className={cx("op-preview-tag", !previewing && !failed && "op-preview-tag-idle")}>
          {tag}
        </span>
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
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void attachStream(video, current.address, {
      // 主播放器优先抢槽位（预览会排在它后面）
      priority: 0,
      stallTimeoutMs: 15_000,
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
  }, [current, retryToken]);

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

  const nextHost = (): void => {
    const index = hosts.findIndex((item) => item.address === current.address);
    const next = hosts[(index + 1) % hosts.length];
    if (next) setCurrent(next);
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
          {error !== null ? (
            <div className="alert alert-error">
              <span>{error}</span>
              <span className="op-error-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => setRetryToken((value) => value + 1)}
                >
                  重试
                </button>
                <button type="button" className="btn btn-ghost btn-xs" onClick={nextHost}>
                  换一个频道
                </button>
              </span>
            </div>
          ) : null}
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
          <p className="form-hint">
            部分直播流为 FLV/HLS；若长时间黑屏，多半是该频道已下线或同一 CDN 连接占满，点「换一个频道」即可。
          </p>
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

  // 「全部预览」轮播：视口内每一路轮流上场，扫一遍就知道哪个值得点开
  useEffect(() => {
    if (!previewAll) return undefined;
    const timer = window.setInterval(() => {
      if (previewWaitingCount() > 0) {
        rotatePreview();
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [previewAll]);

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
              title={`对当前平台视口内的频道同时静音预览（最多同时 ${PREVIEW_MAX} 路${PROXIED ? "" : "、同一 CDN 1 路"}，其余排队）`}
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