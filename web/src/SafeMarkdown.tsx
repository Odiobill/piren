import { createElement, type ReactElement, type ReactNode } from "react";
import {
  parseSafeMarkdown,
  SAFE_MARKDOWN_OVERFLOW_NOTICE,
  type SafeMarkdownBlock,
  type SafeMarkdownInlineNode,
  type SafeMarkdownListItem,
} from "./safe-markdown";

/**
 * P4 — React renderer for the safe ordinary agent-message Markdown model
 * (accepted `conversation-safe-markdown-contract.md`, 2026-08-12). Builds
 * React elements and text children only: never a raw-HTML injection path,
 * an HTML string, or DOM parsing. Agent body headings map to h4/h5/h6 (never
 * a page h1). Safe anchors get the exact href, `target="_blank"`,
 * `rel="noopener noreferrer"`, and a visually-hidden external-link suffix.
 * A body over the parser bounds renders ENTIRELY as literal pre-wrapped text
 * with the exact visible/screen-reader notice.
 */
export function SafeMarkdownBody({ text }: { text: string }): ReactElement {
  const result = parseSafeMarkdown(text);
  if (!result.ok) {
    return (
      <>
        <p className="transcript-body markdown-overflow-literal">{text}</p>
        <p className="markdown-overflow-notice" role="status">
          {SAFE_MARKDOWN_OVERFLOW_NOTICE}
        </p>
      </>
    );
  }
  return <div className="markdown-body">{result.blocks.map((block, index) => renderBlock(block, index))}</div>;
}

function renderBlock(block: SafeMarkdownBlock, key: number): ReactElement {
  switch (block.type) {
    case "paragraph":
      return (
        <p className="markdown-paragraph" key={key}>
          {renderInline(block.children)}
        </p>
      );
    case "heading":
      // Bounded semantic mapping: agent body `#` → h4, `##` → h5, `###` → h6;
      // never introduces a second page h1.
      return createElement(
        (`h${block.level + 3}` as "h4") || "h4",
        { className: `markdown-heading markdown-h${block.level}`, key },
        renderInline(block.children),
      );
    case "blockquote":
      return (
        <blockquote className="markdown-blockquote" key={key}>
          {renderInline(block.children)}
        </blockquote>
      );
    case "code-block":
      return (
        <pre className="markdown-code" key={key}>
          {block.label !== "" && <span className="markdown-code-label">{block.label}</span>}
          <code>{block.text}</code>
        </pre>
      );
    case "list":
      if (block.ordered) {
        return (
          <ol className="markdown-list" key={key}>
            {block.items.map((item, index) => renderListItem(item, index))}
          </ol>
        );
      }
      return (
        <ul className="markdown-list" key={key}>
          {block.items.map((item, index) => renderListItem(item, index))}
        </ul>
      );
  }
}

function renderListItem(item: SafeMarkdownListItem, key: number): ReactElement {
  return (
    <li className="markdown-list-item" key={key}>
      {renderInline(item.children)}
      {item.nested.map((list, index) => renderBlock(list, index))}
    </li>
  );
}

function renderInline(nodes: readonly SafeMarkdownInlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return (
          <code className="markdown-inline-code" key={index}>
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "emphasis":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "link":
        return (
          <a key={index} href={node.url} target="_blank" rel="noopener noreferrer" className="markdown-link">
            {renderInline(node.children)}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        );
    }
  });
}
