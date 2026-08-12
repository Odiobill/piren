/**
 * P4 — safe ordinary agent-message Markdown (accepted
 * `conversation-safe-markdown-contract.md`, 2026-08-12). A dependency-free,
 * pure, bounded parser over an ordinary durable `agent_message` body ONLY:
 *
 * - Approved blocks: paragraphs (line breaks preserved), ATX `#`/`##`/`###`
 *   with exactly one space, unordered/ordered lists with <=3 two-space-indent
 *   nesting (0/2/4 leading spaces), one-level `> ` blockquotes, and fenced
 *   ``` blocks with an optional <=32 ASCII alnum/hyphen label (text only).
 * - Approved inline: one-backtick code (no newline), `**`/`__` strong,
 *   `*`/`_` emphasis, and safe `[label](url)` links (label parsed inline
 *   WITHOUT further links; url must pass `isSafeMarkdownLinkUrl`).
 * - Every malformed/unsupported/unclosed construct stays literal text.
 * - Hard rendering-work bounds: <=32768 UTF-16 input, <=2048 block nodes,
 *   <=8192 inline nodes. Overflow returns `{ok:false}` and the caller renders
 *   the ENTIRE original body literally with the exact overflow notice.
 *
 * The parser builds a deterministic element model only — it never constructs
 * HTML strings, touches the DOM, fetches, stores, or reads authority.
 */

export const SAFE_MARKDOWN_MAX_INPUT_UTF16 = 32768;
export const SAFE_MARKDOWN_MAX_BLOCKS = 2048;
export const SAFE_MARKDOWN_MAX_INLINE_NODES = 8192;
export const SAFE_MARKDOWN_MAX_LIST_DEPTH = 3;
export const SAFE_MARKDOWN_MAX_FENCE_LABEL_LENGTH = 32;
/** Bounded look-ahead window for one inline link attempt (label + url). */
const SAFE_MARKDOWN_LINK_WINDOW = 2048;
export const SAFE_MARKDOWN_OVERFLOW_NOTICE = "Markdown formatting unavailable for this long message.";

export interface SafeMarkdownTextNode {
  type: "text";
  text: string;
}
export interface SafeMarkdownCodeNode {
  type: "code";
  text: string;
}
export interface SafeMarkdownStrongNode {
  type: "strong";
  children: SafeMarkdownInlineNode[];
}
export interface SafeMarkdownEmphasisNode {
  type: "emphasis";
  children: SafeMarkdownInlineNode[];
}
export interface SafeMarkdownLinkNode {
  type: "link";
  url: string;
  children: SafeMarkdownInlineNode[];
}
export type SafeMarkdownInlineNode = SafeMarkdownTextNode | SafeMarkdownCodeNode | SafeMarkdownStrongNode | SafeMarkdownEmphasisNode | SafeMarkdownLinkNode;

export interface SafeMarkdownListItem {
  children: SafeMarkdownInlineNode[];
  /** Sibling nested lists (type changes at the same depth stay separate). */
  nested: SafeMarkdownListNode[];
}
export interface SafeMarkdownListNode {
  type: "list";
  ordered: boolean;
  items: SafeMarkdownListItem[];
}
export interface SafeMarkdownParagraphNode {
  type: "paragraph";
  children: SafeMarkdownInlineNode[];
}
export interface SafeMarkdownHeadingNode {
  type: "heading";
  level: 1 | 2 | 3;
  children: SafeMarkdownInlineNode[];
}
export interface SafeMarkdownBlockquoteNode {
  type: "blockquote";
  children: SafeMarkdownInlineNode[];
}
export interface SafeMarkdownCodeBlockNode {
  type: "code-block";
  label: string;
  text: string;
}
export type SafeMarkdownBlock = SafeMarkdownParagraphNode | SafeMarkdownHeadingNode | SafeMarkdownBlockquoteNode | SafeMarkdownCodeBlockNode | SafeMarkdownListNode;

export type SafeMarkdownParseResult =
  | { ok: true; blocks: SafeMarkdownBlock[] }
  | { ok: false; reason: "over-limit" };

/** A parsed list-item source line. */
interface ItemLine {
  depth: number;
  ordered: boolean;
  content: string;
}

const HEADING_RE = /^(#{1,3}) ([^ ].*)$/;
const QUOTE_RE = /^> (.*)$/;
const FENCE_OPEN_RE = /^```([A-Za-z0-9-]{0,32})$/;
const FENCE_CLOSE = "```";
const ORDERED_ITEM_RE = /^(\d{1,3})\. (.*)$/;

/** true when the line is a list item at depth 0..2 (0/2/4 leading spaces). */
function listItemLine(line: string): ItemLine | null {
  const leading = line.length - line.trimStart().length;
  if (leading !== 0 && leading !== 2 && leading !== 4) return null;
  const rest = line.slice(leading);
  if (rest === "") return null;
  if (rest.startsWith("- ") || rest.startsWith("* ")) {
    return { depth: leading / 2, ordered: false, content: rest.slice(2) };
  }
  const ordered = ORDERED_ITEM_RE.exec(rest);
  if (ordered !== null) {
    const number = Number(ordered[1] as string);
    if (number >= 1 && number <= 999) {
      return { depth: leading / 2, ordered: true, content: ordered[2] as string };
    }
  }
  return null;
}

/** Exact safe-link rule: absolute http:/https:, hostname, no controls/space, no credentials. */
export function isSafeMarkdownLinkUrl(raw: string): boolean {
  if (raw === "") return false;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.hostname === "") return false;
  if (url.username !== "" || url.password !== "") return false;
  return true;
}

class SafeMarkdownParser {
  private overflow = false;
  private blockCount = 0;
  private inlineCount = 0;
  /** Cached position: no fence closer exists anywhere after this index. */
  private noFenceCloserAfter = Number.POSITIVE_INFINITY;

  constructor(private readonly lines: string[]) {}

  parse(): SafeMarkdownParseResult {
    const blocks = this.parseBlocks();
    if (this.overflow) return { ok: false, reason: "over-limit" };
    return { ok: true, blocks };
  }

  private bumpBlock(): void {
    this.blockCount += 1;
    if (this.blockCount > SAFE_MARKDOWN_MAX_BLOCKS) this.overflow = true;
  }

  private bumpInline(): void {
    this.inlineCount += 1;
    if (this.inlineCount > SAFE_MARKDOWN_MAX_INLINE_NODES) this.overflow = true;
  }

  private parseBlocks(): SafeMarkdownBlock[] {
    const blocks: SafeMarkdownBlock[] = [];
    const lines = this.lines;
    let index = 0;
    while (index < lines.length && !this.overflow) {
      const line = lines[index] as string;
      if (line === "") {
        index += 1;
        continue;
      }
      const heading = HEADING_RE.exec(line);
      if (heading !== null) {
        this.bumpBlock();
        blocks.push({
          type: "heading",
          level: (heading[1] as string).length as 1 | 2 | 3,
          children: this.parseInline(heading[2] as string, { allowLinks: true }),
        });
        index += 1;
        continue;
      }
      const quote = QUOTE_RE.exec(line);
      if (quote !== null) {
        const quoteLines = [quote[1] as string];
        index += 1;
        while (index < lines.length && (lines[index] as string).startsWith("> ")) {
          quoteLines.push((lines[index] as string).slice(2));
          index += 1;
        }
        this.bumpBlock();
        blocks.push({ type: "blockquote", children: this.parseInline(quoteLines.join("\n"), { allowLinks: true }) });
        continue;
      }
      if (FENCE_OPEN_RE.test(line)) {
        const closer = this.findFenceCloser(lines, index);
        if (closer !== -1) {
          this.bumpBlock();
          blocks.push({
            type: "code-block",
            label: (line.match(FENCE_OPEN_RE) as RegExpMatchArray)[1] as string,
            text: lines.slice(index + 1, closer).join("\n"),
          });
          index = closer + 1;
          continue;
        }
        // Unterminated fence: the opener is ordinary literal text.
      }
      const item = listItemLine(line);
      if (item !== null) {
        const run = [item];
        index += 1;
        while (index < lines.length && listItemLine(lines[index] as string) !== null) {
          run.push(listItemLine(lines[index] as string) as ItemLine);
          index += 1;
        }
        for (const list of this.buildListTree(run)) {
          this.bumpBlock();
          blocks.push(list);
        }
        continue;
      }
      // Ordinary paragraph: consecutive nonblank non-special lines.
      const paragraphLines = [line];
      index += 1;
      while (index < lines.length) {
        const next = lines[index] as string;
        if (next === "" || HEADING_RE.test(next) || QUOTE_RE.test(next) || FENCE_OPEN_RE.test(next) || listItemLine(next) !== null) break;
        paragraphLines.push(next);
        index += 1;
      }
      this.bumpBlock();
      blocks.push({ type: "paragraph", children: this.parseInline(paragraphLines.join("\n"), { allowLinks: true }) });
    }
    return blocks;
  }

  /** Find the next exact ` ``` ` closer after `from`, or -1 (cached result). */
  private findFenceCloser(lines: string[], from: number): number {
    if (from >= this.noFenceCloserAfter) return -1;
    for (let cursor = from + 1; cursor < lines.length; cursor += 1) {
      if ((lines[cursor] as string) === FENCE_CLOSE) return cursor;
    }
    this.noFenceCloserAfter = from;
    return -1;
  }

  private buildListTree(itemLines: readonly ItemLine[]): SafeMarkdownListNode[] {
    const top: SafeMarkdownListNode[] = [];
    const stack: Array<{ depth: number; list: SafeMarkdownListNode }> = [];
    const pushListAt = (ordered: boolean, depth: number): SafeMarkdownListNode => {
      const list: SafeMarkdownListNode = { type: "list", ordered, items: [] };
      if (depth === 0) {
        top.push(list);
      } else {
        const parent = stack[stack.length - 1];
        const lastItem = parent?.list.items[parent.list.items.length - 1];
        lastItem?.nested.push(list);
      }
      stack.push({ depth, list });
      return list;
    };
    for (const line of itemLines) {
      if (this.overflow) break;
      while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth > line.depth) stack.pop();
      let list: SafeMarkdownListNode;
      if (stack.length === 0) {
        list = pushListAt(line.ordered, line.depth);
      } else if ((stack[stack.length - 1] as { depth: number }).depth < line.depth) {
        // Nested under the previous item of the current list.
        list = pushListAt(line.ordered, line.depth);
      } else {
        const current = stack[stack.length - 1] as { depth: number; list: SafeMarkdownListNode };
        if (current.list.ordered !== line.ordered) {
          // Type change at the same depth starts a new sibling list.
          stack.pop();
          list = pushListAt(line.ordered, line.depth);
        } else {
          list = current.list;
        }
      }
      list.items.push({ children: this.parseInline(line.content, { allowLinks: true }), nested: [] });
      this.bumpBlock(); // each list item counts toward the block bound
    }
    return top;
  }

  /** Append literal text, merging adjacent text nodes (deterministic model). */
  private pushText(nodes: SafeMarkdownInlineNode[], text: string): void {
    const last = nodes[nodes.length - 1];
    if (last !== undefined && last.type === "text") {
      last.text += text;
      return;
    }
    this.bumpInline();
    nodes.push({ type: "text", text });
  }

  /**
   * Deterministic bounded inline scan. `allowLinks:false` is used for link
   * labels so nested anchors are never produced.
   */
  private parseInline(text: string, options: { allowLinks: boolean }): SafeMarkdownInlineNode[] {
    const nodes: SafeMarkdownInlineNode[] = [];
    let cursor = 0;
    const length = text.length;
    while (cursor < length && !this.overflow) {
      const char = text[cursor] as string;
      if (char === "`") {
        const close = text.indexOf("`", cursor + 1);
        if (close !== -1 && !text.slice(cursor + 1, close).includes("\n")) {
          this.bumpInline();
          nodes.push({ type: "code", text: text.slice(cursor + 1, close) });
          cursor = close + 1;
          continue;
        }
        this.pushText(nodes, "`");
        cursor += 1;
        continue;
      }
      if ((char === "*" && text.startsWith("**", cursor)) || (char === "_" && text.startsWith("__", cursor))) {
        const opener = char === "*" ? "**" : "__";
        const close = text.indexOf(opener, cursor + 2);
        if (close !== -1) {
          this.bumpInline();
          nodes.push({ type: "strong", children: this.parseInline(text.slice(cursor + 2, close), { allowLinks: true }) });
          cursor = close + 2;
          continue;
        }
        this.pushText(nodes, opener);
        cursor += 2;
        continue;
      }
      if (char === "*" || char === "_") {
        const close = text.indexOf(char, cursor + 1);
        if (close !== -1) {
          this.bumpInline();
          nodes.push({ type: "emphasis", children: this.parseInline(text.slice(cursor + 1, close), { allowLinks: true }) });
          cursor = close + 1;
          continue;
        }
        this.pushText(nodes, char);
        cursor += 1;
        continue;
      }
      if (char === "[" && options.allowLinks && text[cursor - 1] !== "!") {
        const link = this.tryParseLink(text, cursor);
        if (link !== null) {
          this.bumpInline();
          nodes.push(link.node);
          cursor = link.end;
          continue;
        }
        this.pushText(nodes, "[");
        cursor += 1;
        continue;
      }
      // Accumulate literal text up to the next special character.
      let end = cursor + 1;
      while (end < length) {
        const next = text[end] as string;
        if (next === "`" || next === "*" || next === "_" || (next === "[" && options.allowLinks)) break;
        end += 1;
      }
      this.pushText(nodes, text.slice(cursor, end));
      cursor = end;
    }
    return nodes;
  }

  private tryParseLink(text: string, start: number): { node: SafeMarkdownLinkNode; end: number } | null {
    const labelEnd = text.indexOf("]", start + 1);
    if (labelEnd === -1 || labelEnd - start > SAFE_MARKDOWN_LINK_WINDOW) return null;
    if (text[labelEnd + 1] !== "(") return null;
    const urlStart = labelEnd + 2;
    const urlEnd = text.indexOf(")", urlStart);
    if (urlEnd === -1 || urlEnd - urlStart > SAFE_MARKDOWN_LINK_WINDOW) return null;
    const rawUrl = text.slice(urlStart, urlEnd);
    if (!isSafeMarkdownLinkUrl(rawUrl)) return null;
    return {
      node: {
        type: "link",
        url: rawUrl,
        children: this.parseInline(text.slice(start + 1, labelEnd), { allowLinks: false }),
      },
      end: urlEnd + 1,
    };
  }
}

/** Parse one ordinary agent-message body into the deterministic element model. */
export function parseSafeMarkdown(body: string): SafeMarkdownParseResult {
  if (body.length > SAFE_MARKDOWN_MAX_INPUT_UTF16) return { ok: false, reason: "over-limit" };
  return new SafeMarkdownParser(body.split("\n")).parse();
}
