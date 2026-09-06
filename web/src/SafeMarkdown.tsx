import { createElement, type ReactElement, type ReactNode } from "react";
import {
  parseSafeMarkdown,
  parseSafeMarkdownWithVaultLinks,
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
 *
 * WUX-C — the optional `onNavigateVaultPath` prop is the ONLY way Vault-page
 * links are rendered/navigated: when provided, the body parses through the
 * explicit Vault mode and closed vault-page links become in-place Explorer
 * navigation controls. Without it (ordinary Conversation rendering) the
 * default parser runs unchanged and vault-link nodes can never occur.
 *
 * 0.2.5 S4 — ordered lists render with semantic `<ol start>` from the
 * bounded authored-marker model fact, so blank-separated runs and non-1
 * starts keep their authored numbering in Conversation and Vault Explorer.
 */
export function SafeMarkdownBody({
  text,
  onNavigateVaultPath,
  vaultDocumentPath,
}: {
  text: string;
  onNavigateVaultPath?: (path: string) => void;
  /**
   * S9 — the current open document's vault-relative path: the ONLY base for
   * bounded document-relative Markdown destination resolution. Only read in
   * Vault mode (with `onNavigateVaultPath`); Conversation rendering ignores it.
   */
  vaultDocumentPath?: string;
}): ReactElement {
  let result;
  if (onNavigateVaultPath === undefined) {
    result = parseSafeMarkdown(text);
  } else {
    const options: { documentPath?: string } = {};
    if (vaultDocumentPath !== undefined) options.documentPath = vaultDocumentPath;
    result = parseSafeMarkdownWithVaultLinks(text, options);
  }
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
  return (
    <div className="markdown-body">{result.blocks.map((block, index) => renderBlock(block, index, onNavigateVaultPath))}</div>
  );
}

function renderBlock(block: SafeMarkdownBlock, key: number, vault: RenderVaultContext): ReactElement {
  switch (block.type) {
    case "paragraph":
      return (
        <p className="markdown-paragraph" key={key}>
          {renderInline(block.children, vault)}
        </p>
      );
    case "heading":
      // Bounded semantic mapping: agent body `#` → h4, `##` → h5, `###` → h6;
      // never introduces a second page h1.
      return createElement(
        (`h${block.level + 3}` as "h4") || "h4",
        { className: `markdown-heading markdown-h${block.level}`, key },
        renderInline(block.children, vault),
      );
    case "blockquote":
      return (
        <blockquote className="markdown-blockquote" key={key}>
          {renderInline(block.children, vault)}
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
      // 0.2.5 S4 — ordered lists carry their bounded authored first marker
      // (1..999); semantic `<ol start>` starts each run at its authored
      // number. Never generated marker text, CSS counters, or raw HTML.
      if (block.ordered) {
        return (
          <ol className="markdown-list" key={key} start={block.start}>
            {block.items.map((item, index) => renderListItem(item, index, vault))}
          </ol>
        );
      }
      return (
        <ul className="markdown-list" key={key}>
          {block.items.map((item, index) => renderListItem(item, index, vault))}
        </ul>
      );
  }
}

/** WUX-C — the narrowly scoped vault-navigation context for one render. */
type RenderVaultContext = ((path: string) => void) | undefined;

function renderListItem(item: SafeMarkdownListItem, key: number, vault: RenderVaultContext): ReactElement {
  return (
    <li className="markdown-list-item" key={key}>
      {renderInline(item.children, vault)}
      {item.nested.map((list, index) => renderBlock(list, index, vault))}
    </li>
  );
}

function renderInline(nodes: readonly SafeMarkdownInlineNode[], vault: RenderVaultContext): ReactNode[] {
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
        return <strong key={index}>{renderInline(node.children, vault)}</strong>;
      case "emphasis":
        return <em key={index}>{renderInline(node.children, vault)}</em>;
      case "link":
        return (
          <a key={index} href={node.url} target="_blank" rel="noopener noreferrer" className="markdown-link">
            {renderInline(node.children, vault)}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        );
      case "vault-link":
        // WUX-C — only with an explicit in-place navigation handler does a
        // closed vault-page link become interactive; without one it renders
        // as its label text (never an anchor, never browser navigation).
        if (vault === undefined) {
          return <span key={index}>{renderInline(node.children, vault)}</span>;
        }
        return (
          <button
            type="button"
            key={index}
            className="markdown-link markdown-vault-link"
            onClick={() => vault(node.path)}
          >
            {renderInline(node.children, vault)}
          </button>
        );
    }
  });
}
