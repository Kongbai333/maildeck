import { Inbox, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { isAbortError, isUnauthorizedError } from "../api";
import { errorText, useApiFailure } from "../session";
import type { MessageDetail, MessageSummary } from "../types";
import { cx, formatShortTime } from "../utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { MessageReader } from "./MessageReader";
import { LoadingBlock, Spinner } from "./Spinner";
import { useToast } from "./Toast";

type ConfirmState = { kind: "clear" } | { kind: "delete"; messageId: string } | null;

export interface MailboxInboxPanelProps {
  mailboxId: string;
  listMessages: (mailboxId: string, signal?: AbortSignal) => Promise<MessageSummary[]>;
  getMessage: (mailboxId: string, messageId: string, signal?: AbortSignal) => Promise<MessageDetail>;
  /** 0 表示不轮询 */
  pollIntervalMs?: number;
  onDeleteMessage?: (messageId: string) => Promise<void>;
  onClearInbox?: () => Promise<void>;
  /** 值变化时重新拉取列表（父组件刷新按钮用） */
  refreshKey?: number;
  emptyHint?: string;
  /** Outlook 账号暂不支持删除单封 / 清空收件箱（服务端 409），传 false 隐藏相关按钮 */
  allowDelete?: boolean;
}

export function MailboxInboxPanel({
  mailboxId,
  listMessages,
  getMessage,
  pollIntervalMs = 0,
  onDeleteMessage,
  onClearInbox,
  refreshKey = 0,
  emptyHint = "收件箱还是空的，新邮件到达后会自动出现。",
  allowDelete = true,
}: MailboxInboxPanelProps): ReactNode {
  const toast = useToast();
  const handleFailure = useApiFailure();

  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [detailToken, setDetailToken] = useState(0);

  const listAbort = useRef<AbortController | null>(null);

  const loadList = useCallback(
    async (silent: boolean): Promise<void> => {
      listAbort.current?.abort();
      const controller = new AbortController();
      listAbort.current = controller;
      if (!silent) setListLoading(true);
      try {
        const data = await listMessages(mailboxId, controller.signal);
        if (controller.signal.aborted) return;
        setMessages(data);
        setListError(null);
      } catch (cause) {
        if (isAbortError(cause)) return;
        if (isUnauthorizedError(cause)) {
          handleFailure(cause);
          return;
        }
        // 列表错误用内联错误条展示；静默轮询失败不弹 toast，避免每 10 秒刷屏
        setListError(errorText(cause, "收件箱加载失败"));
      } finally {
        if (!silent) setListLoading(false);
      }
    },
    [handleFailure, listMessages, mailboxId],
  );

  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    void loadList(false);
    return () => {
      listAbort.current?.abort();
    };
  }, [loadList, refreshKey]);

  useEffect(() => {
    if (pollIntervalMs <= 0) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadList(true);
    }, pollIntervalMs);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void loadList(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadList, pollIntervalMs]);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setDetailLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setDetail(null); // 切换/重试时先清掉旧正文，明确进入“加载中”，避免停在上一封内容上毫无反馈
    setDetailLoading(true);
    setDetailError(null);
    getMessage(mailboxId, selectedId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setDetail(value);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || isAbortError(cause)) return;
        setDetailError(errorText(cause, "邮件详情加载失败"));
        handleFailure(cause, "邮件详情加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [detailToken, getMessage, handleFailure, mailboxId, selectedId]);

  const selectedInList = useMemo(
    () => selectedId !== null && messages.some((item) => item.id === selectedId),
    [messages, selectedId],
  );

  useEffect(() => {
    if (selectedId !== null && !listLoading && !selectedInList) {
      setSelectedId(null);
      setDetail(null);
    }
  }, [listLoading, selectedId, selectedInList]);

  const runConfirm = async (): Promise<void> => {
    if (confirmState === null) return;
    setConfirmLoading(true);
    try {
      if (confirmState.kind === "clear") {
        await onClearInbox?.();
        setSelectedId(null);
        setDetail(null);
        toast.success("收件箱已清空");
      } else {
        await onDeleteMessage?.(confirmState.messageId);
        if (selectedId === confirmState.messageId) {
          setSelectedId(null);
          setDetail(null);
        }
        toast.success("邮件已删除");
      }
      setConfirmState(null);
      await loadList(true);
    } catch (cause) {
      handleFailure(cause, "操作失败，请稍后重试");
    } finally {
      setConfirmLoading(false);
    }
  };

  const readerOpen = selectedId !== null;

  return (
    <div className={cx("inbox", readerOpen && "inbox-reader-open")}>
      <div className="inbox-list-col">
        <div className="inbox-toolbar">
          <div className="inbox-count">
            <Inbox size={16} aria-hidden="true" />
            <span>
              收件箱 <strong>{messages.length}</strong>
            </span>
            {listLoading ? <Spinner size={14} /> : null}
          </div>
          <div className="inbox-toolbar-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void loadList(false)}
              disabled={listLoading}
            >
              <RefreshCw size={15} aria-hidden="true" />
              刷新
            </button>
            {allowDelete && onClearInbox && messages.length > 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-ghost-danger"
                onClick={() => setConfirmState({ kind: "clear" })}
              >
                <Trash2 size={15} aria-hidden="true" />
                清空
              </button>
            ) : null}
          </div>
        </div>

        {listError ? (
          <div className="alert alert-error inbox-alert" role="alert">
            {listError}
          </div>
        ) : null}

        <div className="inbox-list">
          {listLoading && messages.length === 0 ? (
            <LoadingBlock label="正在加载邮件…" />
          ) : messages.length === 0 ? (
            <EmptyState
              compact
              icon={<Inbox size={22} aria-hidden="true" />}
              title="暂无邮件"
              description={emptyHint}
            />
          ) : (
            messages.map((item) => {
              const from = item.from;
              const fromLabel = from
                ? from.name.trim() !== ""
                  ? from.name
                  : from.address
                : "未知发件人";
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cx(
                    "msg-item",
                    !item.isRead && "msg-item-unread",
                    item.id === selectedId && "msg-item-active",
                  )}
                  onClick={() => {
                    setSelectedId(item.id);
                    setDetail(null); // 立即进入加载态，给用户明确反馈
                  }}
                >
                  <span className="msg-item-top">
                    <span className="msg-from">{fromLabel}</span>
                    <span className="msg-time">
                      {formatShortTime(item.receivedDateTime ?? item.sentDateTime)}
                    </span>
                  </span>
                  <span className="msg-subject">{item.subject.trim() === "" ? "(无主题)" : item.subject}</span>
                  <span className="msg-preview">{item.bodyPreview || "（无预览）"}</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="inbox-reader-col">
        {selectedId === null ? (
          <div className="inbox-reader-placeholder">
            <EmptyState
              compact
              icon={<Inbox size={22} aria-hidden="true" />}
              title="选择一封邮件"
              description="点击左侧列表中的邮件即可在这里查看正文。"
            />
          </div>
        ) : detailLoading ? (
          <LoadingBlock label="正在加载正文…" />
        ) : detailError ? (
          <div className="inbox-reader-error">
            <div className="alert alert-error">{detailError}</div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setDetailToken((prev) => prev + 1)}
            >
              重试
            </button>
          </div>
        ) : detail ? (
          <MessageReader
            detail={detail}
            onBack={() => setSelectedId(null)}
            deleting={confirmLoading}
            onDelete={
              allowDelete && onDeleteMessage
                ? () => setConfirmState({ kind: "delete", messageId: detail.id })
                : undefined
            }
          />
        ) : (
          <LoadingBlock label="正在加载正文…" />
        )}
      </div>

      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.kind === "clear" ? "清空收件箱" : "删除邮件"}
        danger
        loading={confirmLoading}
        confirmText={confirmState?.kind === "clear" ? "清空" : "删除"}
        message={
          confirmState?.kind === "clear"
            ? "确定清空该邮箱的全部邮件吗？此操作不可撤销。"
            : "确定删除这封邮件吗？此操作不可撤销。"
        }
        onCancel={() => setConfirmState(null)}
        onConfirm={() => void runConfirm()}
      />
    </div>
  );
}
