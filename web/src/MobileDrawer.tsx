import { useEffect, useRef, type ReactNode } from "react";

/**
 * Mobile/portrait burger drawer (ADR-0041 R3b-2.5). A labelled transient
 * overlay for the main navigation: opening moves focus into it, Tab cycles
 * inside (focus trap), Escape closes it. Closing returns focus to the toggle
 * (handled by the caller). The drawer is a view-layer overlay only — it
 * never blocks or cancels an active room/chat run.
 */
export function MobileDrawer({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    if (!drawer) return;

    const focusables = () =>
      Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      );

    const first = focusables()[0];
    (first ?? drawer).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const list = focusables();
        if (list.length === 0) return;
        const firstEl = list[0] as HTMLElement;
        const lastEl = list[list.length - 1] as HTMLElement;
        const active = document.activeElement;
        if (event.shiftKey && (active === firstEl || !drawer.contains(active))) {
          event.preventDefault();
          lastEl.focus();
        } else if (!event.shiftKey && active === lastEl) {
          event.preventDefault();
          firstEl.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div
        ref={drawerRef}
        className="mobile-drawer"
        role="region"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
