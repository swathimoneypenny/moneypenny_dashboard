import { useEffect, useState } from "react";
import { authFetch, C } from "../config";

/**
 * Health banner for the Timesheets.com roster sync.
 *
 * The backend resolves the team roster in three tiers (see
 * backend/dynamic_roster.get_dynamic_roster):
 *
 *   live         → fresh Timesheets.com data           → no banner
 *   stale_cache  → last good fetch, now past its TTL   → yellow warning
 *   fallback     → hardcoded emergency roster          → red alert
 *
 * Silent on `live` so the normal case adds no chrome, and silent if the status
 * endpoint itself can't be reached — a banner about a banner is just noise.
 */
const POLL_MS = 60_000;

function humanizeAge(seconds) {
  if (seconds == null) return "unknown";
  if (seconds < 90) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

export default function RosterBanner() {
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await authFetch("/api/roster/status");
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setStatus(data);
      } catch {
        /* keep whatever we last had — never surface a fetch error as a banner */
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!status) return null;

  const source = status.current_source;
  if (source !== "stale_cache" && source !== "fallback") return null;
  // Re-shows on the next source change because the key resets the component.
  if (dismissed) return null;

  const isFallback = source === "fallback";
  const tone = isFallback
    ? { bg: "rgba(239,68,68,0.16)", border: C.red, icon: "🚨" }
    : { bg: "rgba(240,185,71,0.16)", border: C.yellow, icon: "⚠️" };

  const message = isFallback
    ? "Using emergency fallback roster — Timesheets.com unreachable. Team members and clients may be outdated."
    : `Roster last synced ${humanizeAge(status.cache_age_seconds)} — showing the last known good data.`;

  const detail = [
    status.consecutive_failures
      ? `${status.consecutive_failures} failed attempt${status.consecutive_failures === 1 ? "" : "s"}`
      : null,
    status.next_retry
      ? `retrying ${new Date(status.next_retry).toLocaleTimeString()}`
      : null,
  ].filter(Boolean).join(" · ");

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 16px",
        background: tone.bg,
        borderBottom: `1px solid ${tone.border}`,
        backdropFilter: "blur(8px)",
        color: C.pri,
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      <span aria-hidden="true">{tone.icon}</span>
      <span style={{ flex: 1 }}>
        {message}
        {detail && (
          <span style={{ color: C.muted, marginLeft: 8 }}>({detail})</span>
        )}
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss roster warning"
        style={{
          background: "transparent",
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          color: C.sec,
          cursor: "pointer",
          fontSize: 12,
          padding: "3px 9px",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
