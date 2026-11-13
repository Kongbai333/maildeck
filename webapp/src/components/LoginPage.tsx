import { ArrowRight, Eye, EyeOff, Inbox, Mail } from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiError, login } from "../api";
import type { SessionUser } from "../types";
import "../styles/entry-overview.css";

export interface LoginPageProps {
  onSuccess: (user: SessionUser) => void;
}

export function LoginPage({ onSuccess }: LoginPageProps): ReactNode {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (username.trim() === "" || password === "") {
      setError("请输入用户名和密码");
      return;
    }
    setSubmitting(true);
    try {
      const user = await login({ username: username.trim(), password });
      onSuccess(user);
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
      } else {
        setError("登录失败，请稍后重试");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="md-entry">
      <section className="md-entry-story" aria-labelledby="md-entry-title">
        <div className="md-entry-brand">
          <span className="md-entry-mark">
            <Mail size={23} strokeWidth={1.6} aria-hidden="true" />
          </span>
          <span>MailDeck<span className="md-entry-brand-caption">邮箱助手</span></span>
        </div>

        <div className="md-entry-intro">
          <p className="md-entry-eyebrow">YOUR MAIL WORKSPACE</p>
          <h1 id="md-entry-title">让每一封邮件，<br />各归其位。</h1>
          <p className="md-entry-description">从邮箱领取到日常收信，在一个清晰、有序的工作台里完成。</p>
        </div>

        <div className="md-entry-drawing" aria-hidden="true">
          <div className="md-entry-drawing-label"><span>MAIL / ORGANIZED</span><span>01 — 03</span></div>
          <div className="md-entry-route">
            <span>Outlook</span><span>域名邮箱</span><span>临时邮箱</span>
          </div>
          <div className="md-entry-route-lines"><i /><i /><i /></div>
          <div className="md-entry-envelope">
            <svg viewBox="0 0 300 172" fill="none">
              <rect x="1" y="1" width="298" height="170" rx="12" />
              <path d="M2 12L134 104a28 28 0 0 0 32 0L298 12M2 162l98-72m198 72-98-72" />
            </svg>
            <span><Inbox size={22} strokeWidth={1.4} />统一收件箱</span>
          </div>
          <div className="md-entry-drawing-foot"><span />一处管理 · 随时收取</div>
        </div>

        <ul className="md-entry-features">
          <li><span>01</span>统一管理邮箱池</li>
          <li><span>02</span>按需领取与释放</li>
          <li><span>03</span>自动刷新收件箱</li>
        </ul>
      </section>

      <section className="md-entry-panel" aria-labelledby="md-entry-form-title">
        <form className="md-entry-form" onSubmit={onSubmit} noValidate aria-busy={submitting}>
          <header className="md-entry-form-head">
            <p className="md-entry-eyebrow">WELCOME BACK</p>
            <h2 id="md-entry-form-title">登录工作台</h2>
            <p>使用你的账号，继续处理今天的邮件。</p>
          </header>

          {error ? (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          ) : null}

          <label className="field">
            <span className="field-label">用户名</span>
            <input
              className="input"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              placeholder="请输入用户名"
              disabled={submitting}
            />
          </label>

          <label className="field">
            <span className="field-label">密码</span>
            <span className="input-with-action">
              <input
                className="input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="请输入密码"
                disabled={submitting}
              />
              <button
                type="button"
                className="icon-btn input-action"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </label>

          <button type="submit" className="btn btn-primary btn-block md-entry-submit" disabled={submitting}>
            {submitting ? "登录中…" : "登录"}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
          <p className="md-entry-account-note">管理员与普通用户使用同一登录入口。</p>
          <p className="md-entry-help">首次使用？管理员初始密码请查看服务端控制台输出；普通用户请向管理员获取账号。</p>
        </form>
        <p className="md-entry-panel-foot">MailDeck <span>·</span> 邮箱与收信，有序相连</p>
      </section>
    </main>
  );
}
