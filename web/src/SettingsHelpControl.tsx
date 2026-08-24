import { useEffect, useRef, useState, type ReactElement } from "react";
import { InfoIcon, XIcon } from "./icons";

/**
 * ST-2A (Settings contract §4.2): a static, first-party, accessible help
 * control for transport bot setup. The trigger opens a labelled modal dialog
 * with concise suggested platform steps. Accessibility contract: opening
 * moves focus into the dialog; focus is trapped inside; Escape and the
 * explicit close button dismiss it; dismissal returns focus to the trigger.
 *
 * Hard boundaries: no fetch/platform contact, no storage, no token handling,
 * no remote content, no service action. The content is a fixed constant.
 */

export interface SettingsHelpTopic {
  /** Trigger label, e.g. "Telegram". */
  transport: string;
  /** Dialog title, e.g. "How to set up a Telegram bot". */
  title: string;
  /** Ordered suggested setup steps (static text). */
  steps: string[];
}

export function SettingsHelpControl({ topic }: { topic: SettingsHelpTopic }): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  function close(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusables = (): HTMLElement[] =>
      Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'));
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const active = document.activeElement;
      const index = list.indexOf(active as HTMLElement);
      if (event.shiftKey && (index <= 0 || active === dialog)) {
        event.preventDefault();
        list[list.length - 1]?.focus();
      } else if (!event.shiftKey && (index === -1 || index === list.length - 1)) {
        event.preventDefault();
        list[0]?.focus();
      }
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const titleId = `settings-help-${topic.transport.toLowerCase()}-title`;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="settings-help-trigger button-link"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <InfoIcon size={13} />
        {`How to set up a ${topic.transport} bot`}
      </button>
      {open && (
        <div
          className="settings-help-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={dialogRef}
            className="settings-help-dialog card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <header className="settings-help-header">
              <h4 id={titleId}>{topic.title}</h4>
              <button type="button" ref={closeRef} className="settings-help-close" aria-label={`Close ${topic.title}`} onClick={close}>
                <XIcon size={14} />
              </button>
            </header>
            <ol className="settings-help-steps">
              {topic.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="muted">
              These are suggestions only. Piren never contacts the platform and never displays a saved token.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
