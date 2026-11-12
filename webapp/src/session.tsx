import { createContext, useCallback, useContext } from "react";
import type { ReactNode } from "react";
import { ApiError, isAbortError, isUnauthorizedError } from "./api";
import { useToast } from "./components/Toast";
import type { SessionUser } from "./types";

export interface SessionContextValue {
  user: SessionUser;
  setUser: (user: SessionUser) => void;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: SessionContextValue;
  children: ReactNode;
}): ReactNode {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession 必须在 SessionProvider 内使用");
  return value;
}

/**
 * 统一的异步错误处理：AbortError 静默、401 清会话回登录、其余弹 toast。
 */
export function useApiFailure(): (error: unknown, fallback?: string) => void {
  const { signOut } = useSession();
  const toast = useToast();

  return useCallback(
    (error: unknown, fallback = "操作失败，请稍后重试") => {
      if (isAbortError(error)) return;
      if (isUnauthorizedError(error)) {
        toast.error("登录已失效，请重新登录");
        signOut();
        return;
      }
      if (error instanceof ApiError) {
        toast.error(error.message.trim() === "" ? fallback : error.message);
        return;
      }
      toast.error(fallback);
    },
    [signOut, toast],
  );
}

/** 把未知错误转成可展示的文案（用于内联错误条） */
export function errorText(error: unknown, fallback = "操作失败，请稍后重试"): string {
  if (error instanceof ApiError) return error.message.trim() === "" ? fallback : error.message;
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return fallback;
}
