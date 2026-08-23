import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  chatPaneHeight,
  mobileSelectPane,
  setChatPaneHeight,
  splitBounds,
  SPLIT_MOBILE_MEDIA_QUERY,
  type MobileSplitPane,
  type SplitWorkspaceState,
} from "./split-workspace.js";
import { SplitResizer } from "./SplitResizer.js";
import { FolderIcon, MessageIcon } from "./icons.js";

/**
 * W1 (0.2.0 scope amendment §3; accepted companion split architecture §2/§4/
 * §6) — the split-shell component. A shell-level layout wrapper only:
 * closed or companion-less it is a DOM pass-through of the chat, so the
 * Conversation lifecycle, selection, SSE, dispatch, approval/abort, composer,
 * timeline, anchoring, focus, and run-summary behavior are untouched. Open
 * with a companion it renders the upper companion pane, the accessible
 * horizontal resizer, and the lower live chat pane (one scroll owner per
 * pane). Mobile/portrait shows one pane at a time via a labelled toggle; the
 * chat stays mounted and live underneath. All state is in-memory; nothing is
 * fetched, stored, or persisted. A resizer commit fires the smallest existing
 * chat content-version re-anchor signal through `onReAnchor` (anchor core
 * unchanged).
 */

export interface SplitWorkspaceShellProps {
  /** The split state, owned by the shell host (in-memory). */
  state: SplitWorkspaceState;
  /** Apply a state transition from the pure core. */
  onStateChange: (next: SplitWorkspaceState) => void;
  /**
   * The companion module node. Omitted in W1 (no companion module is
   * registered yet); when omitted the shell is always a pass-through and no
   * placeholder surface is rendered.
   */
  companion?: ReactNode;
  /** The live Conversation surface (kept mounted in every mode). */
  chat: ReactNode;
  /** Accessible name for the resizer, e.g. "Resize chat pane". */
  resizerLabel: string;
  /** Label for the chat pane / mobile toggle, e.g. "Chat". */
  chatLabel: string;
  /** Label for the companion pane / mobile toggle. */
  companionLabel: string;
  /** Resizer-commit re-anchor signal (bumps the chat content version). */
  onReAnchor: () => void;
}

export function SplitWorkspaceShell({
  state,
  onStateChange,
  companion,
  chat,
  resizerLabel,
  chatLabel,
  companionLabel,
  onReAnchor,
}: SplitWorkspaceShellProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [availableHeight, setAvailableHeight] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  const active = state.open && companion !== undefined;

  // Measure the available split height (layout observation only; no polling).
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      if (containerRef.current !== null) setAvailableHeight(containerRef.current.clientHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active]);

  // Mobile/portrait one-pane-at-a-time (existing 560px workbench breakpoint).
  useEffect(() => {
    if (!active || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(SPLIT_MOBILE_MEDIA_QUERY);
    const apply = () => setIsMobile(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [active]);

  if (!active) return <>{chat}</>;

  const { min, max } = splitBounds(availableHeight);
  const chatPx = chatPaneHeight(state, availableHeight);
  const hiddenForMobile = (pane: MobileSplitPane): boolean => isMobile && state.mobilePane !== pane;

  const commit = (next: number): void => {
    onStateChange(setChatPaneHeight(state, next, availableHeight));
    onReAnchor();
  };
  const change = (next: number): void => {
    onStateChange(setChatPaneHeight(state, next, availableHeight));
  };

  return (
    <div className="split-workspace" ref={containerRef}>
      <section
        className="split-companion-pane"
        aria-label={companionLabel}
        hidden={hiddenForMobile("companion")}
      >
        {companion}
      </section>
      <div className="split-mobile-toggle" role="group" aria-label="Companion view toggle">
        <button
          type="button"
          aria-pressed={state.mobilePane === "chat"}
          onClick={() => onStateChange(mobileSelectPane(state, "chat"))}
        >
          <MessageIcon size={14} />
          {chatLabel}
        </button>
        <button
          type="button"
          aria-pressed={state.mobilePane === "companion"}
          onClick={() => onStateChange(mobileSelectPane(state, "companion"))}
        >
          <FolderIcon size={14} />
          {companionLabel}
        </button>
      </div>
      <div className="split-resizer-host">
        <SplitResizer
          label={resizerLabel}
          value={chatPx}
          min={min}
          max={max}
          onChange={change}
          onCommit={commit}
        />
      </div>
      <section
        className="split-chat-pane"
        aria-label={chatLabel}
        hidden={hiddenForMobile("chat")}
        style={isMobile ? undefined : { flexBasis: `${chatPx}px` }}
      >
        {chat}
      </section>
    </div>
  );
}
