// Tests for web/markdown.js (safe markdown renderer). Run: node --test mock/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "web", "markdown.js"), "utf8");
const mod = { exports: {} };
new Function("module", "exports", src)(mod, mod.exports);
const { render } = mod.exports;

// Only these tags may ever appear in output.
const ALLOWED = new Set(["p", "br", "strong", "em", "del", "code", "pre", "a", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "hr", "span"]);
function assertSafe(html) {
  for (const m of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)) {
    assert.ok(ALLOWED.has(m[1].toLowerCase()), `unexpected tag <${m[1]}> in ${html}`);
    assert.doesNotMatch(m[2], /\son\w+\s*=/i, "no event handler attributes");
    const href = m[2].match(/href="([^"]*)"/);
    if (href) assert.match(href[1], /^(https?:|mailto:)/i, "only safe hrefs");
  }
}

test("escapes raw HTML", () => {
  const html = render('<script>alert(1)</script><img src=x onerror="alert(2)">');
  assert.ok(!html.includes("<script"), html);
  assert.ok(html.includes("&lt;script&gt;"));
  assertSafe(html);
});

test("headings, bold, italic, inline code", () => {
  const html = render("# Title\n## Sub\nSome **bold**, *italic*, _also_ and `x < y`.");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>Sub<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<em>also<\/em>/);
  assert.match(html, /<code>x &lt; y<\/code>/);
});

test("heading offset", () => {
  assert.match(render("# A", { headingOffset: 2 }), /<h3>A<\/h3>/);
});

test("code spans are not formatted", () => {
  assert.match(render("`**not bold**`"), /<code>\*\*not bold\*\*<\/code>/);
});

test("fenced code blocks keep content escaped and verbatim", () => {
  const html = render("```js\nconst a = '<b>';\n**x**\n```");
  assert.match(html, /<pre class="code" data-lang="js"><code>const a = &#39;&lt;b&gt;&#39;;\n\*\*x\*\*<\/code><\/pre>/);
});

test("diff fences are coloured", () => {
  const html = render("```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n```");
  assert.match(html, /class="dl d-meta">--- a\/x/);
  assert.match(html, /class="dl d-hunk">@@/);
  assert.match(html, /class="dl d-del">-old/);
  assert.match(html, /class="dl d-add">\+new/);
  assertSafe(html);
});

test("links: safe schemes only, rel=noopener", () => {
  const ok = render("[docs](https://example.com/a?b=1&c=2)");
  assert.match(ok, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  const bad = render("[x](javascript:alert(1)) [y](data:text/html,hi) [z](JaVaScRiPt:alert(1))");
  assert.ok(!/<a /.test(bad), bad);
  assertSafe(bad);
});

test("attribute breakout attempts stay inert", () => {
  for (const s of [
    '[a](https://x.com/"onmouseover="alert(1))',
    "[a](https://x.com/'onmouseover='alert(1))",
    'https://x.com/"><script>alert(1)</script>',
    "**<img src=x onerror=alert(1)>**",
    "> <iframe src=javascript:alert(1)>",
    "- [x] <svg onload=alert(1)>",
    "```\n</code></pre><script>alert(1)</script>\n```",
    "\u00000\u0000<b>",
  ]) {
    const html = render(s);
    assertSafe(html);
    assert.ok(!/<(script|img|iframe|svg|b)\b/i.test(html), html);
  }
});

test("bare URLs are linked without trailing punctuation", () => {
  const html = render("See https://example.com/path_with_underscores_ok.");
  assert.match(html, /<a href="https:\/\/example.com\/path_with_underscores_ok"[^>]*>https:\/\/example.com\/path_with_underscores_ok<\/a>\./);
});

test("lists, task lists, quotes and rules", () => {
  const html = render("- one\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n\n> quoted **text**\n\n---");
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<li class="task done">/);
  assert.match(html, /<li class="task">/);
  assert.match(html, /<blockquote><p>quoted <strong>text<\/strong><\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
});

test("paragraph line breaks are preserved", () => {
  assert.equal(render("a\nb\n\nc"), "<p>a<br>b</p>\n<p>c</p>");
});

test("handles null and empty", () => {
  assert.equal(render(null), "");
  assert.equal(render(""), "");
});
