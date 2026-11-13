import { Eye, EyeOff, RefreshCw, Server, Tv, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { isAbortError, isUnauthorizedError, onlinePlayHosts, onlinePlayPlatforms } from "../../api";
import { EmptyState } from "../../components/EmptyState";
import { OnlineHostCard } from "../../components/OnlineHostCard";
import { LivePlayerWindow } from "../../components/LivePlayerWindow";
import { previewLimits, setPreviewPlayerCount, stopAllPreviews } from "../../preview-scheduler";
import "../../styles/online-play.css";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { errorText, useApiFailure } from "../../session";
import {
  getRuntimeStreamMode,
  probeDirect,
  readSavedMode,
  saveMode,
  setRuntimeStreamMode,
  type StreamMode
} from "../../stream-player";
import type { OnlineHost, OnlinePlatform } from "../../types";
import { cx } from "../../utils";

/* ---------------------------- 页面 ---------------------------- */

const MAX_PLAYER_WINDOWS = 6;
interface PlayerEntry {
  id: number;
  host: OnlineHost;
  channels: OnlineHost[];
  slot: number;
  restore: number;
}

export function OnlinePlayPage(): ReactNode {
  const toast = useToast();
  const handleFailure = useApiFailure();
  const [platforms, setPlatforms] = useState<OnlinePlatform[]>([]);
  const [platformsLoading, setPlatformsLoading] = useState(true);
  const [platformsError, setPlatformsError] = useState<string | null>(null);
  const [noPermission, setNoPermission] = useState(false);
  const [activePlatform, setActivePlatform] = useState<string | null>(null);

  const [hosts, setHosts] = useState<OnlineHost[]>([]);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [players, setPlayers] = useState<PlayerEntry[]>([]);
  const [frontId, setFrontId] = useState<number | null>(null);
  const nextPlayerId = useRef(0);
  const [previewAll, setPreviewAll] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  /** 直连（走用户本地流量）还是经服务器代理；由探测决定，也可手动切换 */
  const [mode, setMode] = useState<StreamMode>(() => readSavedMode() ?? getRuntimeStreamMode());
  const [modeDetected, setModeDetected] = useState(() => readSavedMode() !== null);

  useEffect(() => { setPreviewPlayerCount(players.length); }, [players.length]);
  useEffect(() => () => { stopAllPreviews(); setPreviewPlayerCount(0); }, []);

  const focusPlayer = (id: number): void => {
    setFrontId(id);
    setPlayers((previous) => previous.map((entry) => entry.id === id ? { ...entry, restore: entry.restore + 1 } : entry));
  };
  const openPlayer = (host: OnlineHost): void => {
    const existing = players.find((entry) => entry.host.address === host.address);
    if (existing) { focusPlayer(existing.id); return; }
    if (players.length >= MAX_PLAYER_WINDOWS) {
      toast.error("最多同时播放 6 个频道，请先关闭一个窗口");
      return;
    }
    stopAllPreviews();
    setPreviewAll(false);
    const id = ++nextPlayerId.current;
    const occupied = new Set(players.map((entry) => entry.slot));
    let slot = 0;
    while (occupied.has(slot)) slot++;
    setPlayers((previous) => [...previous, { id, host, channels: hosts, slot, restore: 0 }]);
    setFrontId(id);
  };
  const changePlayer = (id: number, host: OnlineHost, channels?: OnlineHost[]): void => {
    const existing = players.find((entry) => entry.id !== id && entry.host.address === host.address);
    if (existing) { focusPlayer(existing.id); return; }
    setPlayers((previous) => previous.map((entry) => entry.id === id ? { ...entry, host, channels: channels ?? entry.channels } : entry));
    setFrontId(id);
  };

  /** 直连不可用时的诊断提示（带具体原因，避免「点了没反应」）。 */
  const [directBlocked, setDirectBlocked] = useState<string | null>(null);

  /**
   * 本地直连入口（绕开 CF 的终极办法）：
   * https 页面没法加载 http 流，但**跳到另一个 http 页面**是可以的（顶层导航不受混合内容限制）。
   * 所以让用户填一次本机的局域网地址（如 http://192.168.1.10:8787），
   * 点一下就打开那个 http 页面，视频由浏览器直连 CDN —— 零 CF 流量、零 NAS 上行。
   */
  const LOCAL_BASE_KEY = "maildeck.onlinePlay.localBase";
  const [localBase, setLocalBase] = useState<string>(() => {
    try {
      return window.localStorage.getItem(LOCAL_BASE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [localInput, setLocalInput] = useState("");
  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";

  const saveLocalBase = (): void => {
    const value = localInput.trim().replace(/\/+$/u, "");
    if (!/^http:\/\/[\w.:[\]-]+(:\d+)?$/u.test(value)) {
      toast.error("请填本机地址，形如 http://192.168.1.10:8787");
      return;
    }
    try {
      window.localStorage.setItem(LOCAL_BASE_KEY, value);
    } catch {
      /* ignore */
    }
    setLocalBase(value);
    setLocalInput("");
    window.open(`${value}/#/online-play`, "_blank", "noopener");
  };

  const applyMode = useCallback((next: StreamMode): void => {
    setRuntimeStreamMode(next);
    saveMode(next);
    // 模式变了，已挂着的流要重挂：把预览全部停掉，交给轮播/悬停重新拉起
    stopAllPreviews();
    setMode(next);
  }, []);

  /** 切换模式：切直连前先自检，被拦就明确告诉用户原因，而不是留一片黑。 */
  const switchMode = useCallback(
    async (next: StreamMode): Promise<void> => {
      if (next === "direct") {
        const sample = hosts[0]?.address;
        if (sample) {
          const probe = await probeDirect(sample);
          if (!probe.ok) {
            const reason = probe.reason.includes("Failed to fetch") || probe.reason === "blocked"
              ? "浏览器仍在拦截 http 流（Mixed Content）"
              : probe.reason;
            setDirectBlocked(reason);
            toast.error(`直连不可用：${reason}`);
            return;
          }
        }
        setDirectBlocked(null);
        applyMode("direct");
        toast.success("已切换到直连：走你本机的网络，不经过服务器和 CF");
        return;
      }
      setDirectBlocked(null);
      applyMode("proxy");
      toast.success("已切换到代理：经服务器中转（适合浏览器拦截 http 流时）");
    },
    [applyMode, hosts, toast]
  );

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

  /**
   * 探测一次：https 页面先试着直连真实 http 流。
   * 成功 → direct（浏览器走自己本地流量，服务器/CF 都不参与）；
   * 被混合内容拦 → proxy（回退服务端代理）。
   */
  useEffect(() => {
    if (modeDetected || hosts.length === 0) return undefined;
    let cancelled = false;
    void probeDirect(hosts[0].address).then((probe) => {
      if (cancelled) return;
      setModeDetected(true);
      if (!probe.ok) {
        setDirectBlocked(
          probe.reason.includes("Failed to fetch") || probe.reason === "blocked"
            ? "浏览器仍在拦截 http 流（Mixed Content）"
            : probe.reason
        );
      }
      if (probe.mode !== getRuntimeStreamMode()) {
        applyMode(probe.mode);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [applyMode, hosts, modeDetected]);

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
                          event.currentTarget.style.visibility = "hidden";
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
              className={cx("btn btn-sm", mode === "direct" ? "btn-ghost" : "btn-ghost")}
              onClick={() => void switchMode(mode === "direct" ? "proxy" : "direct")}
              title={
                mode === "direct"
                  ? "当前：浏览器直连（走你自己的本地流量，服务器与 CF 都不参与）。点击改为经服务器代理。"
                  : "当前：经服务器代理（https 页面被混合内容拦截时的兜底，会占用服务器/CF 流量）。点击改为尝试直连。"
              }
            >
              {mode === "direct" ? <Zap size={15} aria-hidden="true" /> : <Server size={15} aria-hidden="true" />}
              {mode === "direct" ? "直连" : "代理"}
            </button>
            <button
              type="button"
              className={cx("btn btn-sm", previewAll ? "btn-primary" : "btn-ghost")}
              onClick={() => setPreviewAll((v) => !v)}
              disabled={hosts.length === 0}
              title={`可见频道依次静音预览 5 秒后保留最后一帧（最多同时 ${previewLimits().max} 路，其余排队；再次开启可更新画面）`}
            >
              {previewAll ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
              {previewAll ? "停止预览" : "全部预览"}
            </button>
            {players.length > 0 ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPlayers([]); setFrontId(null); }}>
                关闭全部窗口（{players.length}）
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={reload} disabled={hostsLoading}>
              <RefreshCw size={15} aria-hidden="true" />
              刷新
            </button>
          </div>
          <p className="op-preview-help">点击频道打开 9:16 竖屏浮窗，可同时播放 6 路；全部预览在出画面 5 秒后定格，悬停可继续预览。</p>
          {players.length > 0 ? <div className="op-window-list" aria-label="正在播放的窗口">
            {players.map((entry) => <button key={entry.id} type="button" className="btn btn-ghost btn-xs" onClick={() => focusPlayer(entry.id)} title={entry.host.title}>
              <Tv size={13} aria-hidden="true" />{entry.host.title}
            </button>)}
          </div> : null}

          {isHttps ? (
            <div className="alert alert-warning" role="status" style={{ margin: "0 16px 8px" }}>
              <strong>你正通过 HTTPS（CF）访问：</strong>视频若走代理会经服务器 + CF 中转（慢，且流量翻倍）。
              点下面的按钮跳到本机 http 地址播放，视频由浏览器<b>直连 CDN</b>，不经过 CF、不占 NAS 上行。
              <span className="op-local-row">
                {localBase !== "" ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => window.open(`${localBase}/#/online-play`, "_blank", "noopener")}
                    >
                      在本地直连播放（{localBase}）
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => {
                        try {
                          window.localStorage.removeItem(LOCAL_BASE_KEY);
                        } catch {
                          /* ignore */
                        }
                        setLocalBase("");
                      }}
                    >
                      改地址
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      className="input"
                      value={localInput}
                      onChange={(event) => setLocalInput(event.target.value)}
                      placeholder="http://192.168.1.10:8787（你 NAS 的局域网地址）"
                      aria-label="本机局域网地址"
                    />
                    <button type="button" className="btn btn-primary btn-sm" onClick={saveLocalBase}>
                      保存并打开
                    </button>
                  </>
                )}
              </span>
              <span className="cell-muted" style={{ display: "block", marginTop: 4 }}>
                填你 NAS 在局域网里的 IP + 映射端口（在家填 192.168.x.x；在外可用公网 IP 或 IPv6）。
                只有这个 http 页面能直连视频流。
              </span>
            </div>
          ) : null}

          {directBlocked !== null ? (
            <div className="alert alert-warning" role="status" style={{ margin: "0 16px 8px" }}>
              <strong>直连不可用：</strong>
              {directBlocked}
              <span className="cell-muted" style={{ display: "block", marginTop: 4 }}>
                解决：地址栏左侧图标 → 网站设置 → 「不安全内容」改为“允许”，然后<b>完全退出并重启浏览器</b>（仅刷新不够）。
                做不到就继续用「代理」模式，功能正常，只是流量经服务器/CF。
              </span>
            </div>
          ) : null}

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
                <OnlineHostCard
                  key={`${host.address}-${index}`}
                  host={host}
                  mode={mode}
                  forcePreview={previewAll}
                  onOpen={openPlayer}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {players.map((entry, index) => (
        <LivePlayerWindow key={entry.id} host={entry.host} channels={entry.channels} platforms={platforms} mode={mode}
          index={entry.slot} restoreToken={entry.restore} zIndex={70 + index + (entry.id === frontId ? players.length : 0)}
          onActivate={() => setFrontId(entry.id)}
          onClose={() => setPlayers((previous) => previous.filter((item) => item.id !== entry.id))}
          onChange={(next, channels) => changePlayer(entry.id, next, channels)}
        />
      ))}
    </div>
  );
}