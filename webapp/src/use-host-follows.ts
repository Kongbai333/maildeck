import { useCallback, useEffect, useRef, useState } from "react";
import { followOnlineHost, isAbortError, isUnauthorizedError, onlinePlayFollows, unfollowOnlineHost } from "./api";
import type { OnlineFollow } from "./api";
import type { OnlineHost, OnlinePlatform } from "./types";
import { errorText, useApiFailure } from "./session";
import { useToast } from "./components/Toast";

export function followKey(platform: string, title: string): string { return JSON.stringify([platform, title.trim()]); }
export function useHostFollows() {
  const [follows, setFollows] = useState<OnlineFollow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const locks = useRef(new Set<string>());
  const generation = useRef(0);
  const toast = useToast();
  const handleFailure = useApiFailure();
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true); setError(null);
    void onlinePlayFollows(controller.signal).then((list) => {
      if (!controller.signal.aborted && generation.current === current) setFollows(list);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || isAbortError(cause)) return;
      if (isUnauthorizedError(cause)) handleFailure(cause);
      else setError(errorText(cause, "关注列表加载失败"));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); generation.current = current + 1; };
  }, [handleFailure, reloadToken]);
  const toggle = useCallback(async(host: OnlineHost, platform: OnlinePlatform): Promise<void> => {
    if (loading || error) { toast.error("请先刷新关注列表，再进行操作"); return; }
    const key = followKey(platform.address, host.title);
    if (locks.current.has(key)) return;
    locks.current.add(key); setBusy(new Set(locks.current));
    const currentGeneration = generation.current;
    const existing = follows.find((item) => followKey(item.platformAddress, item.title) === key);
    try {
      if (existing) {
        await unfollowOnlineHost(existing.id);
        if (generation.current !== currentGeneration) return;
        setFollows((previous) => previous.filter((item) => item.id !== existing.id));
        toast.success("已取消关注");
      } else {
        const saved = await followOnlineHost({ ...host, platformAddress: platform.address, platformTitle: platform.title });
        if (generation.current !== currentGeneration) return;
        setFollows((previous) => [saved, ...previous.filter((item) => followKey(item.platformAddress, item.title) !== key)]);
        toast.success("已关注，可在「我的关注」中找到");
      }
    } catch(cause: unknown) {
      if (generation.current !== currentGeneration) return;
      if (isUnauthorizedError(cause)) handleFailure(cause); else toast.error(errorText(cause, "关注操作失败"));
    } finally { locks.current.delete(key); setBusy(new Set(locks.current)); }
  }, [error, follows, handleFailure, loading, toast]);
  return { follows, loading, error, busy, toggle, reload: () => setReloadToken((value) => value + 1) };
}
