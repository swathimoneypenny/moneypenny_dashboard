import { useEffect, useState } from "react";
import { C } from "../config";

const REFRESH_INTERVAL_SECS = 30;

function formatSecsAgo(s) {
  if (s < 0) s = 0;
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s ago` : `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/**
 * Hook: drives auto-refresh + countdown for a page.
 *
 * Pass:
 *   - fetchFn:       () => Promise|void — called every REFRESH_INTERVAL_SECS
 *                    when isLive is true. Page is responsible for re-fetching
 *                    and stamping its own state.
 *   - isLive:        boolean — only run the auto-refresh interval when true
 *                    (typically `period === "today"`).
 *   - lastRefreshed: Date | null — page-managed timestamp of last successful
 *                    fetch (so the indicator stays in sync with the live data).
 *
 * Returns `now` (Date.now() tick) so callers can derive secsSince/secsUntil
 * without owning their own ticker.
 */
export function useAutoRefresh(fetchFn, isLive, lastRefreshed) {
  const [now, setNow] = useState(Date.now());

  // 1s ticker for countdown display — only while live OR until first refresh
  // is shown (so the "Last refreshed Xm ago" line updates without lag).
  useEffect(() => {
    if (!lastRefreshed) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lastRefreshed, isLive]);

  // Auto-refresh every 30s on Today view
  useEffect(() => {
    if (!isLive || typeof fetchFn !== "function") return;
    const r = setInterval(() => {
      try { fetchFn(); } catch (_) { /* swallow — fetchFn handles its own errors */ }
    }, REFRESH_INTERVAL_SECS * 1000);
    return () => clearInterval(r);
  }, [isLive, fetchFn]);

  return now;
}

/**
 * Visual badge for live-refresh state.
 *
 * Props:
 *   - lastRefreshed: Date | null
 *   - now:           number (Date.now() snapshot for re-render timing)
 *   - isLive:        boolean — pulsing green dot + countdown when true
 *   - onRefresh:     optional () => void — when provided + not isLive, the
 *                    "Last refreshed" label is clickable to force a refetch.
 */
export function LiveIndicator({ lastRefreshed, now, isLive, onRefresh }) {
  if (!lastRefreshed) {
    return (
      <div style={{ fontSize: 11, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
        Loading…
      </div>
    );
  }
  const secsSince = Math.max(0, Math.floor((now - lastRefreshed.getTime()) / 1000));

  if (isLive) {
    const secsUntil = Math.max(0, REFRESH_INTERVAL_SECS - secsSince);
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color: C.muted,
          fontFamily: "'DM Mono', monospace",
          whiteSpace: "nowrap",
        }}
        title="Auto-refreshing every 30 seconds while on Today view"
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: C.green,
            animation: "pulse-dot 2s infinite",
            flexShrink: 0,
          }}
        />
        <span style={{ color: C.green, fontWeight: 600 }}>Live</span>
        <span style={{ color: C.muted }}>·</span>
        <span>Updated {formatSecsAgo(secsSince)}</span>
        <span style={{ color: C.muted }}>·</span>
        <span>Next in {secsUntil}s</span>
      </div>
    );
  }

  const label = `Last refreshed ${formatSecsAgo(secsSince)}`;
  if (onRefresh) {
    return (
      <button
        onClick={onRefresh}
        title="Refresh now"
        style={{
          background: "transparent",
          border: "none",
          color: C.muted,
          fontSize: 11,
          fontFamily: "'DM Mono', monospace",
          cursor: "pointer",
          padding: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = C.sec; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = C.muted; }}
      >
        {label} ↻
      </button>
    );
  }
  return (
    <div style={{ fontSize: 11, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
      {label}
    </div>
  );
}
