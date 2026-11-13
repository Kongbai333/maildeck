import { Heart, Play, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { isUnauthorizedError, onlinePlayHosts } from "../api";
import type { OnlineFollow } from "../api";
import { errorText, useApiFailure } from "../session";
import type { OnlineHost, OnlinePlatform } from "../types";
import { followKey } from "../use-host-follows";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";

export function FollowedHostsPanel({ follows, loading, error, busy, onReload, onToggle, onOpen }: {
  follows: OnlineFollow[]; loading: boolean; error: string | null; busy: Set<string>;
  onReload: () => void;
  onToggle: (host: OnlineHost, platform: OnlinePlatform) => Promise<void>;
  onOpen: (host: OnlineHost, channels: OnlineHost[], platform: OnlinePlatform) => void;
}): ReactNode {
  const [search, setSearch] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const toast = useToast();
  const handleFailure = useApiFailure();
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);
  const open = async (follow: OnlineFollow): Promise<void> => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller; setOpening(follow.id);
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const channels = await onlinePlayHosts(follow.platformAddress, controller.signal);
      if (controller.signal.aborted) return;
      const matches = channels.filter((item) => item.title.trim() === follow.title.trim());
      const current = matches.find((item) => item.address === follow.address) ?? (matches.length === 1 ? matches[0] : undefined);
      if (!current) { toast.error("该主播暂未出现在平台列表中，可能尚未开播，稍后再试"); return; }
      onOpen(current, channels, { address: follow.platformAddress, title: follow.platformTitle, cover: "", count: channels.length });
    } catch (cause: unknown) {
      if (pending.current !== controller) return;
      if (isUnauthorizedError(cause)) handleFailure(cause);
      else toast.error(controller.signal.aborted ? "刷新主播信息超时，请重试" : errorText(cause, "刷新主播信息失败"));
    } finally {
      window.clearTimeout(timer);
      if (pending.current === controller) { pending.current = null; setOpening(null); }
    }
  };
  const filtered = follows.filter((item) => `${item.title} ${item.platformTitle}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="op-follows-panel" aria-label="我的关注主播">
    <div className="op-follows-toolbar">
      <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索已关注主播或平台" aria-label="搜索我的关注" />
      <button type="button" className="btn btn-ghost btn-sm" onClick={onReload} disabled={loading || busy.size > 0}><RefreshCw size={14} aria-hidden="true" />刷新关注</button>
    </div>
    <p className="op-preview-help">关注随当前账号保存；播放时会先刷新主播的最新地址。</p>
    {error ? <div className="alert alert-error" role="alert">{error}</div> : loading ? <p className="op-follow-notice" role="status">正在加载关注…</p> : filtered.length === 0 ?
      <EmptyState compact icon={<Heart size={22} />} title={follows.length ? "没有匹配的关注主播" : "还没有关注主播"} description="在主播卡片或播放窗口点击爱心，下次直接来这里找。" /> :
      <div className="op-grid op-follow-grid">{filtered.map((item) => {
        const platform = { address: item.platformAddress, title: item.platformTitle, cover: "", count: 0 };
        return <article className="op-follow-card" key={item.id}>
          <button type="button" className="op-card" onClick={() => void open(item)} disabled={opening === item.id} aria-label={`播放已关注主播 ${item.title}`}>
            <span className="op-cover">{item.cover ? <img src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : null}<span className="op-play-badge"><Play size={26} /></span>{opening === item.id ? <span className="op-preview-tag">刷新地址中…</span> : null}</span>
            <strong className="op-card-title">{item.title}</strong><span className="op-follow-platform">{item.platformTitle}</span>
          </button>
          <button type="button" className="op-follow-toggle op-follow-toggle-active" disabled={busy.has(followKey(item.platformAddress, item.title))} onClick={() => void onToggle(item, platform)} title="取消关注" aria-label={`取消关注 ${item.title}`} aria-pressed="true"><Heart size={16} fill="currentColor" /></button>
        </article>;
      })}</div>}
  </section>;
}
