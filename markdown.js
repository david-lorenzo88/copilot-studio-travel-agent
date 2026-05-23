/* ============================================================
   markdown.js
   Focused markdown to HTML converter. Handles what the agent
   actually outputs: headers, bold, italic, code (inline + block),
   lists, links, horizontal rules, blockquotes, and line breaks.
   Not a full CommonMark implementation — deliberately small.

   Usage:
     const html = mdToHtml(rawText);
     const hasMd = looksLikeMarkdown(rawText);
   ============================================================ */

(() => {
  /**
   * Cheap heuristic: does this text contain markdown features
   * worth rendering as HTML? Used to decide between plain text
   * and the markdown renderer.
   */
  function looksLikeMarkdown(text) {
    if (!text) return false;
    return /(\*\*|__|^#{1,6}\s|^[-*]\s|^\d+\.\s|^>\s|^---|^```|\[[^\]]+\]\([^)]+\)|`[^`\n]+`)/m.test(text);
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * Detects raw JSON payloads that are meant for internal use (itinerary data,
   * structured agent output) and should not be rendered as a chat bubble.
   * Kept deliberately strict so normal messages that merely contain a brace
   * are never suppressed.
   */
  function isInternalJsonPayload(act) {
    // Never suppress activities that carry cards/attachments — those are
    // sign-in cards, adaptive cards, hotel cards, etc.
    if (act.attachments && act.attachments.length > 0) return false;

    const text = act.text;
    if (!text) return false;

    let trimmed = text.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;

    let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch { return false; }

  // Only suppress the itinerary contract specifically
  return parsed && Array.isArray(parsed.days);
}

  /**
   * Convert a markdown string to safe HTML.
   * Order matters: code blocks first (to protect their content from
   * being parsed as markdown), then inline elements, then blocks.
   */
  function mdToHtml(text) {
    if (!text) return "";

    // Normalize line endings
    let src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // ---- Step 1: extract fenced code blocks (protect them) ----
    const codeBlocks = [];
    src = src.replace(/```([a-z0-9]*)\n([\s\S]*?)```/g, (_, lang, body) => {
      const i = codeBlocks.length;
      codeBlocks.push({ lang, body });
      return `\u0001CODEBLOCK${i}\u0001`;
    });

    // ---- Step 2: extract inline code (protect from other inline) ----
    const inlineCodes = [];
    src = src.replace(/`([^`\n]+)`/g, (_, body) => {
      const i = inlineCodes.length;
      inlineCodes.push(body);
      return `\u0001INLINECODE${i}\u0001`;
    });

    // ---- Step 3: escape all remaining HTML ----
    src = escapeHtml(src);

    // ---- Step 4: block-level constructs (line-by-line) ----
    const lines = src.split("\n");
    const out = [];
    let i = 0;
    let listStack = []; // track open lists for nesting / closing

    function closeListsTo(depth) {
      while (listStack.length > depth) {
        const item = listStack.pop();
        out.push(item === "ol" ? "</ol>" : "</ul>");
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      // Horizontal rule
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        closeListsTo(0);
        out.push("<hr>");
        i++;
        continue;
      }

      // Headers
      const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        closeListsTo(0);
        const level = hMatch[1].length;
        out.push(`<h${level}>${inline(hMatch[2])}</h${level}>`);
        i++;
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        closeListsTo(0);
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${inline(quoteLines.join(" "))}</blockquote>`);
        continue;
      }

      // Unordered list item
      const ulMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
      if (ulMatch) {
        const depth = Math.floor(ulMatch[1].length / 2) + 1;
        // Close deeper lists, open new ones as needed
        while (listStack.length > depth) {
          const item = listStack.pop();
          out.push(item === "ol" ? "</ol>" : "</ul>");
        }
        while (listStack.length < depth) {
          listStack.push("ul");
          out.push("<ul>");
        }
        if (listStack[depth - 1] !== "ul") {
          out.push(listStack[depth - 1] === "ol" ? "</ol>" : "</ul>");
          out.push("<ul>");
          listStack[depth - 1] = "ul";
        }
        out.push(`<li>${inline(ulMatch[2])}</li>`);
        i++;
        continue;
      }

      // Ordered list item
      const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
      if (olMatch) {
        const depth = Math.floor(olMatch[1].length / 2) + 1;
        while (listStack.length > depth) {
          const item = listStack.pop();
          out.push(item === "ol" ? "</ol>" : "</ul>");
        }
        while (listStack.length < depth) {
          listStack.push("ol");
          out.push("<ol>");
        }
        if (listStack[depth - 1] !== "ol") {
          out.push(listStack[depth - 1] === "ol" ? "</ol>" : "</ul>");
          out.push("<ol>");
          listStack[depth - 1] = "ol";
        }
        out.push(`<li>${inline(olMatch[2])}</li>`);
        i++;
        continue;
      }

      // Blank line: close lists, paragraph break
      if (/^\s*$/.test(line)) {
        closeListsTo(0);
        i++;
        continue;
      }

      // Paragraph: gather consecutive non-block lines
      closeListsTo(0);
      const paraLines = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(#{1,6}\s|>\s|---\s*$|\*\*\*\s*$|___\s*$|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length > 0) {
        out.push(`<p>${inline(paraLines.join(" "))}</p>`);
      }
    }
    closeListsTo(0);

    let html = out.join("\n");

    // ---- Step 5: restore inline code (still escaped, wrap in <code>) ----
    html = html.replace(/\u0001INLINECODE(\d+)\u0001/g, (_, i) => {
      return `<code>${escapeHtml(inlineCodes[parseInt(i, 10)])}</code>`;
    });

    // ---- Step 6: restore code blocks ----
    html = html.replace(/\u0001CODEBLOCK(\d+)\u0001/g, (_, idx) => {
      const { lang, body } = codeBlocks[parseInt(idx, 10)];
      const langAttr = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
      return `<pre><code${langAttr}>${escapeHtml(body)}</code></pre>`;
    });

    return html;
  }

  /**
   * Apply inline markdown transformations: bold, italic, links.
   * Operates on already-escaped HTML, so it's safe.
   */
  function inline(s) {
    // Bold (**text** or __text__)
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");

    // Italic (*text* or _text_) — but not inside HTML attributes
    s = s.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
    s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<em>$1</em>");

    // Markdown links [text](url) — url already escaped by escapeHtml step
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    return s;
  }

  window.mdToHtml = mdToHtml;
  window.looksLikeMarkdown = looksLikeMarkdown;
  window.isInternalJsonPayload = isInternalJsonPayload;
})();