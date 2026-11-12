import { Clock3, Globe2, Inbox, Mail, Server, Settings } from "lucide-react";
import type { AccountView } from "../types";
import { getCurrentConnectionConfig } from "../connection-config";
import { mailboxCategoryOf, type MailboxCategory } from "../mailbox-category";

export function AppMenuSidebar({
  accounts,
  activeCategory,
  onSelectCategory,
  onOpenSettings
}: {
  accounts: readonly AccountView[];
  activeCategory: MailboxCategory;
  onSelectCategory: (category: MailboxCategory) => void;
  onOpenSettings: () => void;
}) {
  const connection = getCurrentConnectionConfig();
  const counts = {
    all: accounts.length,
    outlook: 0,
    domain: 0,
    temp: 0
  };
  for (const account of accounts) {
    counts[mailboxCategoryOf(account)] += 1;
  }

  return (
    <aside className="app-menu-rail">
      <div className="app-menu-brand">
        <span className="app-menu-brand-mark"><Mail size={20} /></span>
        <div>
          <strong>MailDeck</strong>
          <span>邮箱助手</span>
        </div>
      </div>

      <nav className="app-menu-nav">
        <p className="app-menu-label">邮箱分类</p>
        <button type="button" className={activeCategory === "all" ? "active" : ""} onClick={() => onSelectCategory("all")}>
          <Inbox size={16} /><span>全部邮箱</span><em>{counts.all}</em>
        </button>
        <button type="button" className={activeCategory === "outlook" ? "active" : ""} onClick={() => onSelectCategory("outlook")}>
          <Mail size={16} /><span>Outlook 邮箱</span><em>{counts.outlook}</em>
        </button>
        <button type="button" className={activeCategory === "domain" ? "active" : ""} onClick={() => onSelectCategory("domain")}>
          <Globe2 size={16} /><span>域名邮箱</span><em>{counts.domain}</em>
        </button>
        <button type="button" className={activeCategory === "temp" ? "active" : ""} onClick={() => onSelectCategory("temp")}>
          <Clock3 size={16} /><span>临时邮箱</span><em>{counts.temp}</em>
        </button>

        {/* 预留两个分类位，暂不绑定数据。 */}
        <div className="app-menu-placeholder" aria-hidden="true" />
        <div className="app-menu-placeholder" aria-hidden="true" />
      </nav>

      <div className="app-menu-footer">
        <button type="button" onClick={onOpenSettings}><Settings size={16} /><span>设置</span></button>
        {connection ? (
          <p title={connection.serverUrl}><Server size={12} /><span>{connection.serverUrl}</span></p>
        ) : null}
      </div>
    </aside>
  );
}
