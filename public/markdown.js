"use strict";

// Piren Gateway Markdown renderer. Vanilla JS, no framework, no build step,
// no runtime dependency. Kept intentionally minimal per ADR-0012.
//
// XSS safety model (O7 W3):
//   * Structural block detection runs on the RAW text (so markers like `>`
//     for blockquotes are not pre-escaped), but EVERY fragment that becomes
//     HTML text is escaped via escapeHtml() before any inline substitution.
//   * Inline substitution escapes first, then stashes code/wiki/markdown/bare
//     links as inert placeholders BEFORE bold/italic run, so markers in file
//     content can never inject HTML and link targets cannot interfere with
//     one another.
//   * Link URLs are restricted to safe schemes (http(s):, mailto:, anchors,
//     relative/absolute paths). Bare URLs are linkified only for http(s).
//     javascript:/data: and other dangerous schemes are never emitted.
//   * This module has NO DOM dependency so it can be unit-tested in a
//     DOM-free vm sandbox and reused by both the chat view and the read-only
//     vault document viewer.

(function (global) {
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Scheme allow-list for [label](url). Rejects javascript:, data:, etc.
  function isSafeUrl(url) {
    return /^(https?:|mailto:|#|\.\/|\.\.\/|\/)/i.test(url);
  }

  // Split a table row into trimmed cells, tolerating an optional leading and
  // trailing pipe. Does not handle escaped "\|" pipes (basic tables only).
  function splitTableRow(line) {
    let s = line.replace(/^\s+|\s+$/g, "");
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map(function (cell) {
      return cell.replace(/^\s+|\s+$/g, "");
    });
  }

  // GitHub-style table separator: pipes with dash/colon fillers and optional
  // alignment colons. Requires at least one dash segment.
  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
  }

  function renderMarkdown(md) {
    const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    let inUl = false;
    let inOl = false;

    function closeLists() {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (inOl) { out.push("</ol>"); inOl = false; }
    }

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      const fence = line.match(/^```(.*)$/);
      if (fence) {
        closeLists();
        const lang = (fence[1] || "").replace(/[^a-z0-9-]/gi, "");
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        out.push('<pre><code class="lang-' + lang + '">' + escapeHtml(code.join("\n")) + "</code></pre>");
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) {
        closeLists();
        i++;
        continue;
      }

      // Heading
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeLists();
        const level = heading[1].length;
        out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
        i++;
        continue;
      }

      // Horizontal rule
      if (/^\s*([-*_])\1\1[-*_\s]*$/.test(line)) {
        closeLists();
        out.push("<hr>");
        i++;
        continue;
      }

      // Blockquote
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        closeLists();
        const block = [quote[1]];
        i++;
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          block.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + inline(block.join(" ")) + "</blockquote>");
        continue;
      }

      // GitHub-style table: a piped header row followed by a separator row.
      if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        closeLists();
        const header = splitTableRow(line);
        i += 2; // skip header + separator
        const rows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && !/^\s*$/.test(lines[i])) {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        let table = "<table><thead><tr>";
        for (let h = 0; h < header.length; h++) {
          table += "<th>" + inline(header[h]) + "</th>";
        }
        table += "</tr></thead><tbody>";
        for (let r = 0; r < rows.length; r++) {
          table += "<tr>";
          const row = rows[r];
          const cols = Math.max(row.length, header.length);
          for (let c = 0; c < cols; c++) {
            table += "<td>" + inline(row[c] || "") + "</td>";
          }
          table += "</tr>";
        }
        table += "</tbody></table>";
        out.push(table);
        continue;
      }

      // Ordered list item
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        if (inUl) { out.push("</ul>"); inUl = false; }
        if (!inOl) { out.push("<ol>"); inOl = true; }
        out.push("<li>" + inline(ol[1]) + "</li>");
        i++;
        continue;
      }

      // Unordered list item
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        if (inOl) { out.push("</ol>"); inOl = false; }
        if (!inUl) { out.push("<ul>"); inUl = true; }
        out.push("<li>" + inline(ul[1]) + "</li>");
        i++;
        continue;
      }

      // Paragraph (collect consecutive non-blank, non-special lines)
      closeLists();
      const para = [line];
      i++;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(#{1,6})\s/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\s*\d+\.\s/.test(lines[i]) &&
        !/^\s*[-*+]\s/.test(lines[i]) &&
        !(lines[i].indexOf("|") !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        para.push(lines[i]);
        i++;
      }
      out.push("<p>" + inline(para.join(" ")) + "</p>");
    }
    closeLists();
    return out.join("\n");

    // Inline formatting: escape first, then stash code/wiki/markdown/bare
    // links as inert placeholders, apply bold/italic, and restore last. All
    // link/code content is captured AFTER escaping, so it can never inject
    // HTML; placeholders contain no '*', so bold/italic leave them untouched.
    function inline(text) {
      let s = escapeHtml(text);
      const stash = [];
      function place(html) {
        stash.push(html);
        return "\u0000X" + (stash.length - 1) + "\u0000";
      }

      // Inline code first to protect its content from every other substitution.
      s = s.replace(/`([^`]+)`/g, function (_m, code) {
        return place("<code>" + code + "</code>");
      });

      // Wiki links: [[target]] or [[target|label]] -> read-only vault links.
      s = s.replace(/\[\[([^\]]+)\]\]/g, function (_m, inner) {
        const parts = inner.split("|");
        const target = (parts[0] || "").replace(/^\s+|\s+$/g, "");
        if (!target) return inner;
        const label = (parts[1] || parts[0] || "").replace(/^\s+|\s+$/g, "");
        return place('<a class="md-vault-link" data-vault-target="' + target + '">' + label + "</a>");
      });

      // Markdown links [label](url); url restricted to safe schemes.
      // Bundle-relative vault Markdown paths (/Projects/Foo/bar.md) become
      // read-only vault links opened in the Files tab (leading "/" stripped).
      // External http(s)/mailto, anchors, and ./ ../ links stay ordinary links.
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, label, url) {
        if (!isSafeUrl(url)) return label;
        if (/^\/.*\.md$/i.test(url)) {
          return place('<a class="md-vault-link" data-vault-target="' + url.slice(1) + '">' + label + "</a>");
        }
        return place('<a href="' + url + '" target="_blank" rel="noopener">' + label + "</a>");
      });

      // Bare http/https URLs not already part of a stashed link/code span.
      // Trailing sentence punctuation is kept outside the link.
      s = s.replace(/(?<![\w])(https?:\/\/[^\s<"]+)/gi, function (whole) {
        const m = whole.match(/[.,;:!?]+$/);
        const punct = m ? m[0] : "";
        const url = punct ? whole.slice(0, whole.length - punct.length) : whole;
        return place('<a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>") + punct;
      });

      // Bold + italic on the remaining text (placeholders are inert).
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

      // Restore stashed code and links last.
      s = s.replace(/\u0000X(\d+)\u0000/g, function (_m, idx) {
        return stash[Number(idx)];
      });
      return s;
    }
  }

  global.PirenMarkdown = { renderMarkdown: renderMarkdown, escapeHtml: escapeHtml };
})(typeof window !== "undefined" ? window : globalThis);
