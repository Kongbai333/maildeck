/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { sanitizeMailHtml, splitTextBody } from "../webapp/src/sanitize";

function fragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = sanitizeMailHtml(html);
  return template.content;
}

describe("web mail content security", () => {
  it("removes executable markup, embedded frames and form containers", () => {
    const body = fragment('<p>Keep this message</p><script>alert(1)</script><style>body{display:none}</style><iframe src="https://example.invalid"></iframe><object></object><embed><form action="https://example.invalid"><p>form content</p></form>');
    expect(body.querySelector("script, style, iframe, object, embed, form")).toBeNull();
    expect(body.textContent).toContain("Keep this message");
  });

  it("strips event-handler attributes from allowed elements", () => {
    const body = fragment('<img src="data:image/png;base64,AA==" onerror="alert(1)"><div onclick="alert(1)" onmouseover="alert(2)">body</div>');
    expect(body.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(body.querySelector("div")?.hasAttribute("onclick")).toBe(false);
    expect(body.querySelector("div")?.hasAttribute("onmouseover")).toBe(false);
  });

  it("removes script URLs and protects ordinary links from opener access", () => {
    const body = fragment('<a data-link="bad" href="javascript:alert(1)" target="_top">bad</a><a data-link="good" href="https://example.com/mail" target="_blank">good</a>');
    expect(body.querySelector('[data-link="bad"]')?.getAttribute("href")).toBeNull();
    const good = body.querySelector('[data-link="good"]');
    expect(good?.getAttribute("href")).toBe("https://example.com/mail");
    expect(good?.hasAttribute("target")).toBe(false);
    expect(good?.getAttribute("rel")?.split(" ")).toEqual(expect.arrayContaining(["noreferrer", "noopener"]));
  });

  it("preserves useful mail formatting and embedded images", () => {
    const body = fragment('<table><tbody><tr><td><strong>Order</strong></td></tr></tbody></table><img src="data:image/png;base64,AA==">');
    expect(body.querySelector("td strong")?.textContent).toBe("Order");
    expect(body.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  });

  it("normalizes text line breaks without interpreting markup as HTML", () => {
    expect(splitTextBody('first\r\n<img src=x onerror=alert(1)>\nlast')).toEqual(["first", "<img src=x onerror=alert(1)>", "last"]);
  });
});
