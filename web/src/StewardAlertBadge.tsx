import { useEffect, useState } from "react";
import { fetchStewardAlerts, UnauthorizedError } from "./api";

/** One explicit/reconnect read of gateway-owned attention count; never polls. */
export function StewardAlertBadge({
  token,
  reloadKey,
  onOpen,
  onUnauthorized,
  onValidated,
}: {
  token: string;
  reloadKey: number;
  onOpen: () => void;
  onUnauthorized: () => void;
  onValidated: () => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchStewardAlerts(token, controller.signal).then((result) => {
      setCount(result.attentionCount);
      onValidated();
    }).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (cause instanceof UnauthorizedError) onUnauthorized();
      else setCount(null);
    });
    return () => controller.abort();
  }, [onUnauthorized, onValidated, reloadKey, token]);

  if (count === null || count === 0) return null;
  const text = count > 99 ? "99+" : String(count);
  return (
    <button type="button" className="steward-alert-badge" onClick={onOpen} aria-label={`${count} high or urgent steward alerts require attention`}>
      {text}
    </button>
  );
}
