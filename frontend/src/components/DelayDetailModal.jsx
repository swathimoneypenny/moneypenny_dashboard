import { useEffect, useMemo, useState } from "react";
import { C, authFetch } from "../config";

// TL-confirmed status palette (2026-06-05):
//   open        → red    #EF4444
//   in_progress → yellow #F59E0B
//   completed   → green  #10B981
const STATUS_PALETTE = {
  open:        { color: "#EF4444", label: "🔴 Open",        bg: "rgba(239, 68, 68, 0.10)", border: "rgba(239, 68, 68, 0.45)" },
  in_progress: { color: "#F59E0B", label: "🟡 In Progress", bg: "rgba(245, 158, 11, 0.10)", border: "rgba(245, 158, 11, 0.45)" },
  completed:   { color: "#10B981", label: "✅ Closed",      bg: "rgba(16, 185, 129, 0.10)", border: "rgba(16, 185, 129, 0.45)" },
};

function statusMeta(status) {
  return STATUS_PALETTE[status] || STATUS_PALETTE.open;
}

function ageColor(age, status) {
  if (status === "completed") return "#10B981";
  if (age >= 8) return "#EF4444";
  if (age >= 3) return "#F2895A";
  return "#F0B947";
}

function formatHeaderDate(dateStr) {
  if (!dateStr) return "—";
  const s = String(dateStr);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return s;
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const SHOW_MORE_THRESHOLD = 200;

function ExpandableText({ text, color }) {
  const [expanded, setExpanded] = useState(false);
  const safe = (text || "").trim();
  if (!safe) return null;
  const isLong = safe.length > SHOW_MORE_THRESHOLD;
  const shown = !isLong || expanded ? safe : `${safe.slice(0, SHOW_MORE_THRESHOLD)}…`;
  return (
    <>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: color || C.pri, whiteSpace: "pre-wrap" }}>
        {shown}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: 6,
            background: "transparent",
            border: "none",
            color: C.teal,
            padding: 0,
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

function DelayCard({ d }) {
  const meta = statusMeta(d.status);
  const age = d.days_aging ?? 0;
  const ac  = ageColor(age, d.status);
  return (
    <div
      style={{
        background: meta.bg,
        border: `1px solid ${meta.border}`,
        borderLeft: `3px solid ${meta.color}`,
        borderRadius: 8,
        padding: 14,
        marginBottom: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {d.serial_no != null && (
            <span
              style={{
                fontSize: 11,
                fontFamily: "'DM Mono', monospace",
                color: C.muted,
                background: C.surface,
                padding: "2px 7px",
                borderRadius: 4,
                fontWeight: 600,
              }}
            >
              #{d.serial_no}
            </span>
          )}
          {d.reason && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: C.sec,
                background: `${C.blue}22`,
                padding: "3px 8px",
                borderRadius: 12,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              {d.reason}
            </span>
          )}
          <span
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 12,
              background: `${meta.color}22`,
              color: meta.color,
              fontWeight: 700,
              letterSpacing: 0.3,
            }}
          >
            {meta.label}
          </span>
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: ac, fontFamily: "'DM Mono', monospace" }}>
          {age} day{age === 1 ? "" : "s"}{d.status === "completed" ? " to close" : " old"}
        </span>
      </div>

      <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, fontFamily: "'DM Mono', monospace" }}>
        Posted: {d.date_posted || "—"}
        {d.close_date && <> · Closed: {d.close_date}</>}
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: C.sec, marginBottom: 4, fontWeight: 700 }}>
          ❓ Question:
        </div>
        {d.question ? (
          <ExpandableText text={d.question} />
        ) : (
          <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>
            No question text recorded
          </div>
        )}
      </div>

      {d.client_reply && (
        <div
          style={{
            marginBottom: 10,
            padding: "10px 12px",
            background: "rgba(74,143,231,0.08)",
            border: `1px solid rgba(74,143,231,0.25)`,
            borderLeft: `3px solid ${C.blue}`,
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 11, color: C.blue, marginBottom: 4, fontWeight: 700 }}>
            💬 Client Reply:
          </div>
          <ExpandableText text={d.client_reply} />
        </div>
      )}

      {d.mp_reply && (
        <div
          style={{
            padding: "10px 12px",
            background: "rgba(16, 185, 129, 0.08)",
            border: `1px solid rgba(16, 185, 129, 0.30)`,
            borderLeft: `3px solid #10B981`,
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 11, color: "#10B981", marginBottom: 4, fontWeight: 700 }}>
            ✅ MP Response:
          </div>
          <ExpandableText text={d.mp_reply} />
        </div>
      )}
    </div>
  );
}

function ClientSection({ section, date }) {
  const delays = Array.isArray(section.delays) ? section.delays : [];
  const headerColor = delays.length > 0 ? C.pri : C.muted;
  return (
    <div style={{ marginBottom: 22 }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: headerColor,
          letterSpacing: 0.2,
          marginBottom: 10,
          paddingBottom: 8,
          borderBottom: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span>🏢 {section.client_name}</span>
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 500, fontFamily: "'DM Mono', monospace" }}>
          gid {section.tab_gid} · {delays.length} item{delays.length === 1 ? "" : "s"}
        </span>
      </div>
      {delays.length === 0 ? (
        <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic", padding: "8px 4px" }}>
          ✓ No delays for {section.client_name}{date ? " on this date" : ""}.
        </div>
      ) : (
        delays.map((d, i) => (
          <DelayCard key={`${section.tab_gid}-${d.serial_no || i}`} d={d} />
        ))
      )}
    </div>
  );
}

export default function DelayDetailModal({ day, teamId, onClose }) {
  useEffect(() => {
    if (!day) return;
    function onKey(e) {
      if (e.key === "Escape") onClose && onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [day, onClose]);

  useEffect(() => {
    if (!day) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [day]);

  const [fetchState, setFetchState] = useState({ loading: false, data: null, error: null });
  const dayDate = day?.fullDate || day?.date || "";

  useEffect(() => {
    if (!day || !teamId || !dayDate) {
      setFetchState({ loading: false, data: null, error: null });
      return;
    }
    const ctrl = new AbortController();
    setFetchState({ loading: true, data: null, error: null });
    const isoDate = String(dayDate).slice(0, 10);
    authFetch(`/api/team/${teamId}/delays?date=${encodeURIComponent(isoDate)}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => {
        if (ctrl.signal.aborted) return;
        setFetchState({ loading: false, data: j, error: j?.error || null });
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setFetchState({ loading: false, data: null, error: err?.message || String(err) });
      });
    return () => ctrl.abort();
  }, [day, teamId, dayDate]);

  // Only render visible non-empty sections — but always show at least one
  // "✓ No delays for X" row if filter matched at least one client.
  const sections = useMemo(() => {
    const all = fetchState.data?.clients || [];
    if (!all.length) return [];
    const withDelays = all.filter((s) => (s.delays || []).length > 0);
    return withDelays.length > 0 ? withDelays : all;
  }, [fetchState.data]);

  const totals = fetchState.data?.totals || { total: 0, open: 0, in_progress: 0, completed: 0 };
  const tabErrors = fetchState.data?.tab_errors || [];

  if (!day) return null;

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        background: "rgba(0,0,0,0.72)",
        backdropFilter: "blur(4px)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: 24,
          maxWidth: 760,
          maxHeight: "85vh",
          overflow: "auto",
          width: "92%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
            marginBottom: 18,
            paddingBottom: 14,
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.pri, letterSpacing: -0.3, marginBottom: 4 }}>
              📋 Open Questions &amp; Delays
            </div>
            <div style={{ fontSize: 13, color: C.sec, marginBottom: 4 }}>
              {totals.open} open · {totals.in_progress} in progress · {totals.completed} completed
              {totals.total > 0 && <> · {totals.total} total</>}
            </div>
            <div style={{ fontSize: 12, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
              {formatHeaderDate(dayDate)}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              color: C.sec,
              padding: "6px 12px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "'DM Sans', sans-serif",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#EF4444"; e.currentTarget.style.color = "#EF4444"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.sec; }}
          >
            ✕ Close
          </button>
        </div>

        {/* Loading */}
        {fetchState.loading && (
          <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 12 }}>
            <span
              style={{
                display: "inline-block",
                width: 16,
                height: 16,
                border: `2px solid ${C.border}`,
                borderTopColor: C.teal,
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
                marginRight: 10,
                verticalAlign: "middle",
              }}
            />
            Loading delays from Google Sheet…
          </div>
        )}

        {/* Hard error from backend */}
        {!fetchState.loading && fetchState.error && (
          <div
            style={{
              padding: "12px 14px",
              background: "rgba(239,68,68,0.08)",
              border: `1px solid rgba(239,68,68,0.30)`,
              borderLeft: `3px solid #EF4444`,
              borderRadius: 6,
              color: C.sec,
              fontSize: 12,
              lineHeight: 1.5,
              marginBottom: 16,
            }}
          >
            <strong style={{ color: "#EF4444" }}>Couldn't load delays:</strong>{" "}
            {fetchState.data?.error_detail || fetchState.error}
            {fetchState.data?.error === "no_delays_tabs_configured" && (
              <div style={{ marginTop: 6, color: C.muted, fontSize: 11 }}>
                Add this team to <code style={{ background: C.surface, padding: "1px 5px", borderRadius: 3, fontSize: 10 }}>DELAYS_TAB_GIDS</code> in <code style={{ background: C.surface, padding: "1px 5px", borderRadius: 3, fontSize: 10 }}>backend/main.py</code>.
              </div>
            )}
          </div>
        )}

        {/* Per-tab errors — partial failure (some clients loaded, others didn't) */}
        {!fetchState.loading && !fetchState.error && tabErrors.length > 0 && (
          <div
            style={{
              padding: "10px 14px",
              background: "rgba(240,185,71,0.06)",
              border: `1px solid rgba(240,185,71,0.25)`,
              borderLeft: `3px solid #F0B947`,
              borderRadius: 6,
              color: C.sec,
              fontSize: 11,
              lineHeight: 1.5,
              marginBottom: 14,
            }}
          >
            <strong style={{ color: "#F0B947" }}>Some Delays tabs failed to load:</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {tabErrors.map((te, i) => (
                <li key={i}>
                  {te.client_name} (gid {te.tab_gid}) — {te.error}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Client sections */}
        {!fetchState.loading && !fetchState.error && sections.map((section) => (
          <ClientSection
            key={section.tab_gid}
            section={section}
            date={fetchState.data?.date_filter}
          />
        ))}

        {/* No data at all */}
        {!fetchState.loading && !fetchState.error && sections.length === 0 && (
          <div
            style={{
              padding: "12px 14px",
              background: "rgba(240,185,71,0.06)",
              border: `1px solid rgba(240,185,71,0.25)`,
              borderLeft: `3px solid #F0B947`,
              borderRadius: 6,
              color: C.sec,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "#F0B947" }}>No questions or delays tracked for this date.</strong>
            <div style={{ marginTop: 6, color: C.muted, fontSize: 11 }}>
              All configured Delays tabs returned zero rows for {formatHeaderDate(dayDate)}.
              If you expected entries, verify the Date column in the team's Delays tab.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
