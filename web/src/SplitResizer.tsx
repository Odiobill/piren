import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clampSplitValue, RESIZER_STEP_PX } from "./split-workspace.js";

/**
 * W1 (accepted companion split architecture §3) — the real accessible
 * resizer between the upper companion pane and the lower chat pane. A
 * focusable `role="separator"` with horizontal orientation and bounded
 * aria-valuemin/max/now (chat pane height px). ArrowUp/ArrowDown adjust by a
 * deterministic 10px; Home/End jump to min/max. Pointer drag listens on the
 * WINDOW for pointermove/pointerup with cleanup, so dragging outside the
 * element keeps working and no listeners dangle. Keyboard focus stays on the
 * resizer; there is no per-tick live-region announcement. Reduced-motion is
 * irrelevant: resizing is layout, not animation.
 */

export interface SplitResizerProps {
  /** Accessible name, e.g. "Resize chat pane". */
  label: string;
  /** Current chat pane height (px) — aria-valuenow. */
  value: number;
  /** Minimum chat pane height (px) — aria-valuemin. */
  min: number;
  /** Maximum chat pane height (px) — aria-valuemax. */
  max: number;
  /** Live value update during a pointer drag. */
  onChange: (nextValue: number) => void;
  /** Final commit: keyboard step, Home/End, or pointerup. */
  onCommit: (nextValue: number) => void;
}

export function SplitResizer({ label, value, min, max, onChange, onCommit }: SplitResizerProps): React.JSX.Element {
  const [dragging, setDragging] = useState<{ startY: number; startValue: number } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
    }
    let next: number;
    if (event.key === "ArrowUp") next = clampSplitValue(value + RESIZER_STEP_PX, min, max);
    else if (event.key === "ArrowDown") next = clampSplitValue(value - RESIZER_STEP_PX, min, max);
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else return;
    onCommit(next);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    setDragging({ startY: event.clientY, startValue: valueRef.current });
  }

  useEffect(() => {
    if (dragging === null) return;
    const onPointerMove = (event: PointerEvent): void => {
      // Absolute math from the drag start: moving the pointer up grows the
      // chat pane. Absolute values avoid drift with stale React state.
      const next = clampSplitValue(dragging.startValue + (dragging.startY - event.clientY), min, max);
      onChange(next);
    };
    const onPointerUp = (event: PointerEvent): void => {
      const next = clampSplitValue(dragging.startValue + (dragging.startY - event.clientY), min, max);
      setDragging(null);
      onCommit(next);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragging, min, max, onChange, onCommit]);

  return (
    <div
      className="split-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
    />
  );
}
