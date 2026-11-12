import { Eye, EyeOff, Mail } from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiError, login } from "../api";
import type { SessionUser } from "../types";

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
    <div className="login-page">
      <section className="login-brand">
        <div className="login-brand-inner">
          <div className="brand-mark brand-mark-lg">
            <Mail size={26} aria-hidden="true" />
          </div>
          <h1 className="login-brand-title">MailDeck · 邮箱助手</h1>
          <p className="login-brand-desc">邮箱池统一管理，登录即可领取邮箱、收验证码。</p>
          <ul className="login-features">
            <li>管理员维护服务商与邮箱池</li>
            <li>普通用户自助领取、随时释放</li>
            <li>收件箱 10 秒自动刷新</li>
          </ul>
          <p className="login-brand-foot">首次启动的管理员初始密码见服务端控制台输出。</p>
        </div>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={onSubmit} noValidate>
          <header className="login-card-head">
            <h2>登录</h2>
            <p>使用管理员或普通用户账号进入控制台</p>
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
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </label>

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? "登录中…" : "登录"}
          </button>
        </form>
      </section>
    </div>
  );
}
