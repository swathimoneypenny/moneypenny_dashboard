import { useEffect } from "react";
import { C } from "../config";

const STATUS_META = {
  awaiting_response: { color: "#E25C5C", label: "Awaiting Response" },
  in_progress:       { color: "#F0B947", label: "In Progress" },
  completed:         { color: "#3DC58B", label: "Completed" },
};

function ageColor(age) {
  if (age >= 8) return "#E25C5C";
  if (age >= 3) return "#F2895A";
  return "#F0B947";
}

function DelayRowCard({ row, isCompleted = false }) {
  const meta = STATUS_META[row.statusNorm] || { color: C.muted, label: row.eodStatus || "Unknown" };
  const ac = ageColor(row.ageDays || 0);
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: 14,
        marginBottom: 10,
        opacity: isCompleted ? 0.75 : 1,
      }}
    >
      {/* Top row: status badge + age */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            padding: "3px 10px",
            borderRadius: 12,
            background: `${meta.color}22`,
            color: meta.color,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.color }} />
          {meta.label}
        </div>
        <div style={{ fontSize: 12, color: ac, fontWeight: 600, fontFamily: "'DM Mono', monospace" }}>
          {isCompleted && row.resolvedInDays != null
            ? `Resolved in ${row.resolvedInDays} day${row.resolvedInDays === 1 ? "" : "s"}`
            : `${row.ageDays} day${row.ageDays === 1 ? "" : "s"} old`}
        </div>
      </div>

      {/* Raised date */}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
        Raised: {row.raisedDateFormatted || row.raisedDate}
      </div>

      {/* Query text (full, not truncated) */}
      {row.queryText && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>
            Query Details
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: C.pri, whiteSpace: "pre-wrap" }}>
            {row.queryText}
          </div>
        </div>
      )}

      {/* Notes (status details) — full text */}
      {row.notes && row.notes !== row.queryText && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>
            Status Details
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: C.sec, whiteSpace: "pre-wrap" }}>
            {row.notes}
          </div>
        </div>
      )}

      {/* Hours context (when committed > 0) */}
      {(row.committed || 0) > 0 && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: `1px solid ${C.border}`,
            display: "flex",
            gap: 16,
            fontSize: 11,
            color: C.muted,
            fontFamily: "'DM Mono', monospace",
          }}
        >
          <span>Committed: {Number(row.committed).toFixed(1)}h</span>
          <span>Booked: {Number(row.booked || 0).toFixed(1)}h</span>
          <span>Util: {Number(row.utilPct || 0).toFixed(0)}%</span>
        </div>
      )}

      {/* Status source — only show when we inferred it from notes (not from
          explicit column L), so a manager can spot heuristic classifications */}
      {row.statusNormSource === "notes_heuristic" && (
        <div style={{ marginTop: 8, fontSize: 10, color: C.muted, fontStyle: "italic" }}>
          ⓘ Status inferred from notes — column L was blank
        </div>
      )}
    </div>
  );
}

export default function DelayDetailModal({ day, onClose }) {
  // ESC closes
  useEffect(() => {
    if (!day) return;
    function onKey(e) {
      if (e.key === "Escape") onClose && onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [day, onClose]);

  // Body scroll lock while open
  useEffect(() => {
    if (!day) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [day]);

  if (!day) return null;

  const allRows = Array.isArray(day.allRows) ? day.allRows : [];
  const openRows      = allRows.filter((r) => !r.isCompleted);
  const completedRows = allRows.filter((r) => r.isCompleted);
  const headerDate = day.fullDateLabel || day.date || "—";
  const total = day.total ?? allRows.length;

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
          maxWidth: 720,
          maxHeight: "85vh",
          overflow: "auto",
          width: "90%",
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
            <div style={{ fontSize: 20, fontWeight: 600, color: C.pri, letterSpacing: -0.3, marginBottom: 4 }}>
              {headerDate} Delays
            </div>
            <div style={{ fontSize: 13, color: C.muted }}>
              {total} total · {openRows.length} open · {completedRows.length} completed
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
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#E25C5C"; e.currentTarget.style.color = "#E25C5C"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.sec; }}
          >
            ✕ Close
          </button>
        </div>

        {/* Open delays section */}
        {openRows.length > 0 && (
          <div style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>
              🔴 Open Delays ({openRows.length})
            </div>
            {openRows.map((row, i) => (
              <DelayRowCard key={`open-${i}`} row={row} />
            ))}
          </div>
        )}

        {/* Completed delays section */}
        {completedRows.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>
              ✅ Completed Delays ({completedRows.length})
            </div>
            {completedRows.map((row, i) => (
              <DelayRowCard key={`done-${i}`} row={row} isCompleted />
            ))}
          </div>
        )}

        {/* Empty state */}
        {openRows.length === 0 && completedRows.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>
            No delay details available for this day.
          </div>
        )}
      </div>
    </div>
  );
}
