import type { ReactElement } from "react";

/**
 * P1 — local inline SVG icon primitives (accepted workbench chat-surface
 * polish plan decision 8): small stroke icons with no icon font and no
 * network dependency. Every icon is decorative (`aria-hidden="true"`), so
 * interactive call sites must carry their own accessible name
 * (`aria-label`/`title`).
 */
export interface IconProps {
  size?: number;
}

/** Labelled-close X icon (replaces the modal's visible Close text). */
export function XIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/** Return/Enter key glyph for the page-local submit-shortcut toggle. */
export function ReturnKeyIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}

/** Information glyph for the composer-right Conversation details action. */
export function InfoIcon({ size = 18 }: IconProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/** P5: square stop glyph for the transient-run abort control. */
export function StopIcon({ size = 14 }: IconProps): ReactElement {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/** D1: message glyph for the Dashboard start-conversation primary action. */
export function MessageIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
