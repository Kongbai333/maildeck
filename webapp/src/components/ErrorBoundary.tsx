import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 兜底错误边界：任何子树渲染抛错时展示可恢复的错误页，而不是把整个应用卸载成白屏。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("页面渲染出错：", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="boot-screen">
          <div className="boot-card">
            <h1>页面出错了</h1>
            <p>渲染时遇到问题：{this.state.error.message}</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => this.setState({ error: null })}
              >
                重试
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => window.location.reload()}>
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
