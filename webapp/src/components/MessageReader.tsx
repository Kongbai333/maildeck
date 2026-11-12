import { ArrowLeft, FileText, Paperclip, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { sanitizeMailHtml, splitTextBody } from "../sanitize";
import type { MessageAddress, MessageDetail } from "../types";
import { formatBytes, formatDateTime } from "../utils";

function addressText(address: MessageAddress | null): string {
  if (!address) return "—";
  if (address.name.trim() === "") return address.address || "—";
  return `${address.name} <${address.address}>`;
}

function addressList(list: MessageAddress[]): string {
  if (list.length === 0) return "—";
  return list.map((item) => (item.name.trim() === "" ? item.address : `${item.name} <${item.address}>`)).join("、");
}

export interface MessageReaderProps {
  detail: MessageDetail;
  onDelete?: () => void;
  deleting?: boolean;
  onBack?: () => void;
}

export function MessageReader({
  detail,
  onDelete,
  deleting = false,
  onBack,
}: MessageReaderProps): ReactNode {
  // 防御：不同来源（Outlook / IMAP / 各临时邮箱服务商）返回的详情字段并不齐全，
  // 缺字段时给安全默认值，避免直接读 undefined.length 抛错导致整页白屏。
  const body = detail.body ?? { contentType: "text" as const, content: "" };
  const attachments = detail.attachments ?? [];
  const toRecipients = detail.toRecipients ?? [];
  const ccRecipients = detail.ccRecipients ?? [];
  const subject = detail.subject ?? "";
  const safeHtml = useMemo(
    () => (body.contentType === "html" ? sanitizeMailHtml(body.content) : null),
    [body.content, body.contentType],
  );
  const textLines = useMemo(
    () => (body.contentType === "text" ? splitTextBody(body.content) : []),
    [body.content, body.contentType],
  );

  return (
    <article className="mail-reader">
      <header className="mail-reader-head">
        <div className="mail-reader-title-row">
          {onBack ? (
            <button type="button" className="icon-btn mail-reader-back" onClick={onBack} aria-label="返回列表">
              <ArrowLeft size={18} aria-hidden="true" />
            </button>
          ) : null}
          <h2 className="mail-subject">{subject.trim() === "" ? "(无主题)" : subject}</h2>
          {onDelete ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm mail-delete"
              onClick={onDelete}
              disabled={deleting}
            >
              <Trash2 size={15} aria-hidden="true" />
              删除
            </button>
          ) : null}
        </div>
        <dl className="mail-meta">
          <div>
            <dt>发件人</dt>
            <dd>{addressText(detail.from)}</dd>
          </div>
          <div>
            <dt>收件人</dt>
            <dd>{addressList(toRecipients)}</dd>
          </div>
          {ccRecipients.length > 0 ? (
            <div>
              <dt>抄送</dt>
              <dd>{addressList(ccRecipients)}</dd>
            </div>
          ) : null}
          <div>
            <dt>时间</dt>
            <dd>{formatDateTime(detail.receivedDateTime ?? detail.sentDateTime)}</dd>
          </div>
          {detail.webLink ? (
            <div>
              <dt>链接</dt>
              <dd>
                <a href={detail.webLink} target="_blank" rel="noreferrer noopener">
                  在网页中打开
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      </header>

      <div className="mail-body">
        {safeHtml !== null ? (
          // safeHtml 已通过 DOMPurify 清洗，并统一处理了 a 标签的 target / rel
          <div className="mail-html" dangerouslySetInnerHTML={{ __html: safeHtml }} />
        ) : textLines.length > 0 ? (
          <pre className="mail-text">{body.content}</pre>
        ) : (
          <p className="mail-empty-body">（正文为空）</p>
        )}
      </div>

      {attachments.length > 0 ? (
        <footer className="mail-attachments">
          <h3>
            <Paperclip size={15} aria-hidden="true" />
            附件（{attachments.length}）
          </h3>
          <ul>
            {attachments.map((item) => (
              <li key={item.id}>
                <FileText size={14} aria-hidden="true" />
                <span className="attachment-name">{item.filename}</span>
                <span className="attachment-size">{formatBytes(item.size)}</span>
              </li>
            ))}
          </ul>
        </footer>
      ) : null}
    </article>
  );
}
