import { Mail, X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { adminMessage, adminMessages } from "../../api";
import { Badge } from "../../components/Badge";
import { MailboxInboxPanel } from "../../components/MailboxInboxPanel";
import type { AdminMailboxView } from "../../types";
import { MAILBOX_STATUS_LABEL, MAILBOX_STATUS_TONE } from "../../utils";

export interface MailboxMessagesDrawerProps {
  mailbox: AdminMailboxView | null;
  onClose: () => void;
}

export function MailboxMessagesDrawer({ mailbox, onClose }: MailboxMessagesDrawerProps): ReactNode {
  useEffect(() => {
    if (mailbox === null) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [mailbox, onClose]);

  if (mailbox === null) return null;

  return (
    <div className="drawer-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`${mailbox.email} 的邮件`}>
        <header className="drawer-head">
          <span className="drawer-icon">
            <Mail size={18} aria-hidden="true" />
          </span>
          <div className="drawer-title">
            <strong>{mailbox.email}</strong>
            <span className="drawer-sub">
              {mailbox.providerName}
              <Badge tone={MAILBOX_STATUS_TONE[mailbox.status]}>
                {MAILBOX_STATUS_LABEL[mailbox.status]}
              </Badge>
              {mailbox.assignedUsername ? <span>归属 {mailbox.assignedUsername}</span> : null}
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="drawer-body">
          <MailboxInboxPanel
            key={mailbox.id}
            mailboxId={mailbox.id}
            listMessages={adminMessages}
            getMessage={adminMessage}
            allowDelete={mailbox.kind !== "outlook"}
            emptyHint="该邮箱暂无邮件，可在普通用户侧注册后回来看。"
          />
        </div>
      </aside>
    </div>
  );
}
