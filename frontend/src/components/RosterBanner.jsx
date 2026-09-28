import { useEffect, useState } from "react";
import { authFetch, C } from "../config";

/**
 * Admin roster-sync indicators, both driven by GET /api/roster/health.
 *
 * The backend resolves the team roster in three tiers (see
 * backend/dynamic_roster.get_dynamic_roster):
 *
 *   live         → fresh Timesheets.com data           → small health pill
 *   stale_cache  → last good fetch, now past its TTL   → big yellow banner
 *   fallback     → hardcoded emergency roster          → big red banner
 *
 * /api/roster/* is admin-only, so for everyone else the fetch 403s and this
 * renders nothing. Also silent if the endpoint itself can't be reached — a
 * banner about a banner is just noise.
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

function fmtWhen(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

const CHANGE_ICON = { moved: "↔", added: "+", removed: "−", lead_changed: "★" };

export default function RosterBanner() {
  const [health, setHealth] = useState(null);
  const [dismissedSource, setDismissedSource] = useState(null);
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await authFetch("/api/roster/health");
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setHealth(data);
      } catch {
        /* keep whatever we last had — never surface a fetch error as a banner */
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    authFetch("/api/roster/recent-changes?limit=15")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setChanges(d.changes || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, health?.last_change_at]);

  if (!health) return null;

  const source = health.current_source;
  const degraded = source === "stale_cache" || source === "fallback";

  return (
    <>
      {degraded && dismissedSource !== source && (
        <OutageBanner health={health} onDismiss={() => setDismissedSource(source)} />
      )}
      <HealthPill health={health} open={open} onToggle={() => setOpen((o) => !o)} />
      {open && <HealthPanel health={health} changes={changes} onClose={() => setOpen(false)} />}
    </>
  );
}

function OutageBanner({ health, onDismiss }) {
  const isFallback = health.current_source === "fallback";
  const tone = isFallback
    ? { bg: "rgba(239,68,68,0.22)", border: C.red, icon: "🚨" }
    : { bg: "rgba(240,185,71,0.22)", border: C.yellow, icon: "⚠️" };

  const headline = isFallback
    ? "Using the hardcoded emergency roster — Timesheets.com API unavailable."
    : `Using cached roster from ${humanizeAge(health.cache_age_seconds)}. Timesheets.com API unavailable.`;

  const detail = [
    `Last sync: ${fmtWhen(health.last_sync)}`,
    health.consecutive_failures
      ? `${health.consecutive_failures} failed attempt${health.consecutive_failures === 1 ? "" : "s"}`
      : null,
    health.next_sync ? `retrying ${new Date(health.next_sync).toLocaleTimeString()}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div
      role="alert"
      style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 9000,
        display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12,
        padding: "14px 20px",
        background: tone.bg, borderBottom: `2px solid ${tone.border}`,
        backdropFilter: "blur(8px)", color: C.pri,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 22 }}>{tone.icon}</span>
      <div style={{ flex: "1 1 280px", minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.35 }}>{headline}</div>
        <div style={{ fontSize: 12.5, color: C.sec, marginTop: 3 }}>
          {detail}
          {isFallback && " · team members and clients may be outdated"}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss roster warning"
        style={{
          background: "transparent", border: `1px solid ${C.borderStrong}`,
          borderRadius: 6, color: C.sec, cursor: "pointer", fontSize: 12, padding: "5px 11px",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

function HealthPill({ health, open, onToggle }) {
  const src = health.current_source;
  const dot = !health.sync_healthy
    ? (src === "fallback" ? C.red : C.yellow)
    : (health.warnings?.length ? C.yellow : C.green);
  const label = src === "live" ? "Roster live" : src === "stale_cache" ? "Roster stale" : "Roster fallback";
  const n = health.recent_changes_count || 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title="Timesheets.com roster sync health"
      style={{
        position: "fixed", left: 16, bottom: 16, zIndex: 8990,
        display: "flex", alignItems: "center", gap: 7,
        padding: "6px 11px", borderRadius: 999,
        background: C.elevated, border: `1px solid ${C.border}`,
        color: C.sec, fontSize: 11.5, cursor: "pointer",
        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0 }} />
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ color: C.muted }}>· {humanizeAge(health.cache_age_seconds)}</span>
      {n > 0 && <span style={{ color: C.accent }}>· {n} change{n === 1 ? "" : "s"} (7d)</span>}
    </button>
  );
}

function HealthPanel({ health, changes, onClose }) {
  const teams = Object.entries(health.team_counts || {});
  const cell = { padding: "3px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div
      role="dialog"
      aria-label="Roster sync health"
      style={{
        position: "fixed", left: 16, bottom: 56, zIndex: 8991,
        width: "min(380px, calc(100vw - 32px))", maxHeight: "min(70vh, 560px)", overflowY: "auto",
        background: C.elevated, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
        boxShadow: "0 12px 32px rgba(0,0,0,0.5)", color: C.sec, fontSize: 12, padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ color: C.pri, fontSize: 13, flex: 1 }}>Roster sync</strong>
        <button type="button" onClick={onClose} aria-label="Close"
          style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 16 }}>×</button>
      </div>

      <div style={{ lineHeight: 1.7 }}>
        <div>Source: <b style={{ color: C.pri }}>{health.current_source}</b>
          {health.sync_healthy ? " — healthy" : " — degraded"}</div>
        <div>Last sync: {fmtWhen(health.last_sync)}</div>
        <div>Next sync: {fmtWhen(health.next_sync)} (every {Math.round(health.sync_interval_seconds / 60)} min)</div>
        {health.last_error && <div style={{ color: C.red }}>Last error: {health.last_error}</div>}
      </div>

      {health.warnings?.length > 0 && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 16, color: C.yellow, lineHeight: 1.5 }}>
          {health.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      <div style={{ marginTop: 12, fontWeight: 600, color: C.pri }}>Recent changes</div>
      {changes == null ? (
        <div style={{ color: C.muted, marginTop: 4 }}>Loading…</div>
      ) : changes.length === 0 ? (
        <div style={{ color: C.muted, marginTop: 4 }}>No roster changes detected yet.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, lineHeight: 1.5 }}>
          {changes.map((c, i) => (
            <li key={`${c.at}-${c.timesheet_id}-${i}`} style={{ display: "flex", gap: 6 }}>
              <span style={{ color: C.accent, width: 12, flexShrink: 0 }}>{CHANGE_ICON[c.type] || "•"}</span>
              <span style={{ flex: 1 }}>{c.message}</span>
              <span style={{ color: C.muted, whiteSpace: "nowrap" }}>{fmtWhen(c.at)}</span>
            </li>
          ))}
        </ul>
      )}

      {teams.length > 0 && (
        <>
          <div style={{ marginTop: 12, fontWeight: 600, color: C.pri }}>
            Live vs fallback headcount
            {health.fallback_significantly_behind && (
              <span style={{ color: C.yellow, fontWeight: 400 }}> — fallback out of date</span>
            )}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
            <thead>
              <tr style={{ color: C.muted }}>
                <th style={{ ...cell, textAlign: "left" }}>Team</th>
                <th style={cell}>Live</th>
                <th style={cell}>Fallback</th>
              </tr>
            </thead>
            <tbody>
              {teams.map(([tid, t]) => (
                <tr key={tid} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ ...cell, textAlign: "left" }}>{`Team ${tid.replace("team_", "").toUpperCase()}`}</td>
                  <td style={cell}>{t.live}</td>
                  <td style={{ ...cell, color: t.differs ? C.yellow : C.sec }}>{t.fallback}{t.differs ? " *" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ color: C.muted, marginTop: 4 }}>* fallback differs from live membership</div>
        </>
      )}
    </div>
  );
}
