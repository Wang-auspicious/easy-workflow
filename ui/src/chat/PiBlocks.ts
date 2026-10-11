// Easy Workflow adapters for Pi Web UI's markdown-block / code-block contracts.
// Keep model text untrusted; no HTML, event handlers or unsafe URLs reach the DOM.
import { html, LitElement } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import DOMPurify from "dompurify";

class MarkdownBlock extends LitElement {
  static properties = { content: {}, isThinking: { type: Boolean } };
  declare content: string;
  createRenderRoot() { return this; }
  render() {
    const parsed = marked.parse(this.content ?? "", { async: false, breaks: true });
    const safe = DOMPurify.sanitize(parsed, { USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "video", "audio", "iframe", "style", "form", "input", "button"], FORBID_ATTR: ["style"] });
    return html`<div class="markdown">${unsafeHTML(safe)}</div>`;
  }
}
class CodeBlock extends LitElement {
  static properties = { code: {} };
  declare code: string;
  createRenderRoot() { return this; }
  render() { return html`<pre><code>${this.code ?? ""}</code></pre>`; }
}
customElements.define("markdown-block", MarkdownBlock);
customElements.define("code-block", CodeBlock);
