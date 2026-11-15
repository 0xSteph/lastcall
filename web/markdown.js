/*
 * markdown.js — a deliberately small, SAFE markdown renderer for Last Call.
 *
 * Everything is HTML-escaped first; the renderer then only ever emits its own
 * fixed set of tags. Raw HTML in the input is shown as text, never executed.
 * Links are allowed only for http(s) and mailto URLs and open with
 * rel="noopener noreferrer".
 *
 * Supports: headings, paragraphs (line breaks kept), bold, italic,
 * strikethrough, inline code, fenced code blocks (``` with diff colouring),
 * bullet / numbered / task lists, blockquotes, horizontal rules, links and
 * bare URLs.
 */
(function (root) {
  "use strict";

  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  // Works on already-escaped text.
  function isSafeUrl(escapedUrl) {
    var raw = escapedUrl.replace(/&amp;/g, "&");
    return /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(raw);
  }

  function highlightDiff(escaped) {
    var lines = escaped.replace(/\n$/, "").split("\n");
    return lines.map(function (line) {
      var cls = "";
      if (/^(diff --git|index |\+\+\+ |--- |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) cls = "d-meta";
      else if (/^@@/.test(line)) cls = "d-hunk";
      else if (/^\+/.test(line)) cls = "d-add";
      else if (/^-/.test(line)) cls = "d-del";
      return '<span class="dl' + (cls ? " " + cls : "") + '">' + (line === "" ? " " : line) + "</span>";
    }).join("");
  }

  function looksLikeDiff(text) {
    return /^(diff --git |--- |\+\+\+ |@@ )/m.test(text) && /^[+-]/m.test(text);
  }

  // Inline formatting on escaped text.
  function renderInline(text) {
    var slots = [];
    function hold(html) { slots.push(html); return "\u0000" + (slots.length - 1) + "\u0000"; }

    // code spans first: their content is never formatted
    text = text.replace(/`([^`\n]+)`/g, function (_, code) { return hold("<code>" + code + "</code>"); });

    // [label](url)
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (all, label, url) {
      if (!isSafeUrl(url)) return all;
      return hold('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + emphasis(label) + "</a>");
    });

    // bare URLs
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>]+)/g, function (all, pre, url) {
      var trail = "";
      // trim trailing punctuation and escaped quotes
      for (;;) {
        var m = url.match(/(&quot;|&#39;|&gt;|[.,;:!?)\]])$/);
        if (!m) break;
        trail = m[1] + trail;
        url = url.slice(0, -m[1].length);
      }
      if (!url || !isSafeUrl(url)) return all;
      return pre + hold('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>") + trail;
    });

    text = emphasis(text);
    // slots can nest (code inside a link label), so restore until stable
    for (var guard = 0; guard < 5 && /\u0000\d+\u0000/.test(text); guard++) {
      text = text.replace(/\u0000(\d+)\u0000/g, function (_, i) { return slots[+i]; });
    }
    return text;
  }

  function emphasis(text) {
    return text
      .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
      .replace(/~~(?=\S)([^\n]*?\S)~~/g, "<del>$1</del>")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
  }

  function render(md, opts) {
    opts = opts || {};
    var offset = opts.headingOffset || 0;
    var lines = escapeHtml(String(md == null ? "" : md).replace(/\u0000/g, "")).replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var i = 0;

    function flushParagraph(buf) {
      if (buf.length) out.push("<p>" + buf.map(renderInline).join("<br>") + "</p>");
    }

    var para = [];
    while (i < lines.length) {
      var line = lines[i];
      var m;

      if ((m = line.match(/^\s*(`{3,}|~{3,})\s*([\w+.-]*)\s*$/))) {
        flushParagraph(para); para = [];
        var fence = m[1], lang = m[2].toLowerCase(), code = [];
        i++;
        while (i < lines.length && !new RegExp("^\\s*" + fence.charAt(0) + "{" + fence.length + ",}\\s*$").test(lines[i])) {
          code.push(lines[i]); i++;
        }
        i++; // closing fence (or EOF)
        var body = code.join("\n");
        var isDiff = lang === "diff" || lang === "patch" || (!lang && looksLikeDiff(body));
        out.push('<pre class="code' + (isDiff ? " diff" : "") + '"' + (lang ? ' data-lang="' + lang + '"' : "") +
          "><code>" + (isDiff ? highlightDiff(body) : body) + "</code></pre>");
        continue;
      }

      if (/^\s*$/.test(line)) { flushParagraph(para); para = []; i++; continue; }

      if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        flushParagraph(para); para = [];
        var level = Math.min(6, m[1].length + offset);
        out.push("<h" + level + ">" + renderInline(m[2]) + "</h" + level + ">");
        i++; continue;
      }

      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushParagraph(para); para = [];
        out.push("<hr>"); i++; continue;
      }

      if (/^\s*&gt;\s?/.test(line)) {
        flushParagraph(para); para = [];
        var quote = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++;
        }
        // re-render the unescaped quote content (it is escaped again inside)
        out.push("<blockquote>" + render(unescape(quote.join("\n")), opts) + "</blockquote>");
        continue;
      }

      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flushParagraph(para); para = [];
        var ordered = /^\s*\d+[.)]\s+/.test(line);
        var itemRe = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        var items = [];
        while (i < lines.length) {
          var im = lines[i].match(itemRe);
          if (im) { items.push(im[1]); i++; continue; }
          // indented continuation line
          if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1] += "\n" + lines[i].trim(); i++; continue; }
          break;
        }
        var tag = ordered ? "ol" : "ul";
        out.push("<" + tag + ">" + items.map(function (it) {
          var task = it.match(/^\[([ xX])\]\s+([\s\S]*)$/);
          if (task) {
            var done = task[1] !== " ";
            return '<li class="task' + (done ? " done" : "") + '"><span class="tick" aria-hidden="true">' +
              (done ? "&#10003;" : "") + "</span>" + '<span class="sr-only">' + (done ? "done: " : "to do: ") + "</span>" +
              task[2].split("\n").map(renderInline).join("<br>") + "</li>";
          }
          return "<li>" + it.split("\n").map(renderInline).join("<br>") + "</li>";
        }).join("") + "</" + tag + ">");
        continue;
      }

      para.push(line);
      i++;
    }
    flushParagraph(para);
    return out.join("\n");
  }

  function unescape(s) {
    return s.replace(/&(amp|lt|gt|quot|#39);/g, function (_, e) {
      return { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e];
    });
  }

  var api = { render: render, escapeHtml: escapeHtml, highlightDiff: highlightDiff, looksLikeDiff: looksLikeDiff };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LastCallMarkdown = api;
})(typeof self !== "undefined" ? self : this);
