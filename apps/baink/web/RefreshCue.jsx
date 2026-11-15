import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { updatedAgo } from "./refresh-loop.js";

/** A visible "Updated 20 s ago · Refresh" cue for a list that refreshes itself. */
export default function RefreshCue({
  at,
  onRefresh,
  busy = false,
  label = "Refresh",
  failed = false,
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const text = busy
    ? "Updating…"
    : updatedAgo(at, Math.max(now, at || 0)) || "Not updated yet";
  return (
    <span className="refresh-cue" role="status" aria-live="off">
      <small>
        {text}
        {failed && !busy ? " · last update failed, retrying" : ""}
      </small>
      {onRefresh && (
        <button
          type="button"
          className="text-link"
          onClick={onRefresh}
          disabled={busy}
          aria-label={label}
        >
          <RefreshCw
            size={13}
            className={busy ? "spin" : ""}
            aria-hidden="true"
          />{" "}
          Refresh
        </button>
      )}
    </span>
  );
}
