import DOMPurify from "dompurify";

/**
 * 邮件 HTML 正文清洗：
 * 1. DOMPurify 走 html profile，禁掉脚本/样式/框架/表单等危险标签与内联事件属性；
 * 2. 移除 a[target]，并统一补 rel="noreferrer noopener"，避免 target 逃逸与 window.opener 劫持。
 */
export function sanitizeMailHtml(html: string): string {
  const cleaned = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  });

  const container = document.createElement("div");
  container.innerHTML = cleaned;
  const anchors = container.querySelectorAll("a");
  anchors.forEach((anchor) => {
    anchor.removeAttribute("target");
    anchor.setAttribute("rel", "noreferrer noopener");
  });
  return container.innerHTML;
}

/** 正文是纯文本时按行渲染，避免把文本当 HTML 处理 */
export function splitTextBody(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}
