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
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
        Raised: {row.raisedDateFormatted || row.raisedDate}
      </div>

      {/* Question (Posted Query Details) — bold label + full untruncated text */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: C.sec, marginBottom: 4, fontWeight: 700 }}>
          ❓ Question:
        </div>
        {row.queryText ? (
          <div style={{ fontSize: 13, lineHeight: 1.5, color: C.pri, whiteSpace: "pre-wrap" }}>
            {row.queryText}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>
            Question text not recorded
          </div>
        )}
      </div>

      {/* Status Details (column M) — full text */}
      {row.notes && row.notes !== row.queryText && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: C.sec, marginBottom: 4, fontWeight: 700 }}>
            📝 Status Details:
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: C.sec, whiteSpace: "pre-wrap" }}>
            {row.notes}
          </div>
        </div>
      )}

      {/* Resolution / Answer — completed items only. We don't currently
          have a dedicated "Delay Questions tab > Resolution Notes" feed,
          so we surface the status-details / notes as the resolution
          (with a fallback line when both are empty). */}
      {isCompleted && (
        <div
          style={{
            marginTop: 10,
            padding: "10px 12px",
            background: "rgba(61,197,139,0.08)",
            border: `1px solid rgba(61,197,139,0.25)`,
            borderLeft: `3px solid #3DC58B`,
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 11, color: "#3DC58B", marginBottom: 4, fontWeight: 700 }}>
            ✓ Resolution / Answer:
          </div>
          {row.notes ? (
            <div style={{ fontSize: 12, lineHeight: 1.5, color: C.pri, whiteSpace: "pre-wrap" }}>
              {row.notes}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>
              Resolution notes not recorded
            </div>
          )}
          <div style={{ display: "flex", gap: 14, fontSize: 11, color: C.muted, marginTop: 6, fontFamily: "'DM Mono', monospace" }}>
            {row.resolvedOnFormatted && <span>Resolved on: {row.resolvedOnFormatted}</span>}
            {row.resolvedInDays != null && (
              <span>Resolved in {row.resolvedInDays} day{row.resolvedInDays === 1 ? "" : "s"}</span>
            )}
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

// Card for a Delays-tab question row (separate from the EOD-tab batch row).
// Uses the per-client "{client} Delays" tab fields exposed by backend
// _parse_delays_tab_csv.
function DelayQuestionCard({ q }) {
  const isResolved = !!q.isResolved;
  const ageColorOpen = (q.ageDays || 0) >= 8 ? "#E25C5C" : (q.ageDays || 0) >= 3 ? "#F2895A" : "#F0B947";
  const meta = isResolved
    ? { color: "#3DC58B", label: "Resolved" }
    : { color: ageColorOpen, label: (q.status && q.status.trim()) || "Open" };
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${meta.color}`,
        borderRadius: 8,
        padding: 14,
        marginBottom: 10,
        opacity: isResolved ? 0.85 : 1,
      }}
    >
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
        <div style={{ fontSize: 12, color: isResolved ? "#3DC58B" : ageColorOpen, fontWeight: 600, fontFamily: "'DM Mono', monospace" }}>
          {isResolved && q.resolvedInDays != null
            ? `Resolved in ${q.resolvedInDays} day${q.resolvedInDays === 1 ? "" : "s"}`
            : q.ageDays != null
              ? `${q.ageDays} day${q.ageDays === 1 ? "" : "s"} old`
              : ""}
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, display: "flex", gap: 14, flexWrap: "wrap" }}>
        {q.clientName && <span>Client: <span style={{ color: C.sec, fontWeight: 600 }}>{q.clientName}</span></span>}
        {q.datePosted && <span>Posted: {q.datePosted}</span>}
        {q.postedTo && <span>To: {q.postedTo}</span>}
        {q.fileReference && <span>Ref: {q.fileReference}</span>}
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: C.sec, marginBottom: 4, fontWeight: 700 }}>
          ❓ Question:
        </div>
        {q.questionText ? (
          <div style={{ fontSize: 13, lineHeight: 1.5, color: C.pri, whiteSpace: "pre-wrap" }}>
            {q.questionText}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>
            Question text not recorded in Delays tab
          </div>
        )}
      </div>
      {isResolved && (
        <div
          style={{
            marginTop: 10,
            padding: "10px 12px",
            background: "rgba(61,197,139,0.08)",
            border: `1px solid rgba(61,197,139,0.25)`,
            borderLeft: `3px solid #3DC58B`,
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 11, color: "#3DC58B", marginBottom: 4, fontWeight: 700 }}>
            ✓ Resolution / Answer:
          </div>
          {q.resolutionNotes ? (
            <div style={{ fontSize: 12, lineHeight: 1.5, color: C.pri, whiteSpace: "pre-wrap" }}>
              {q.resolutionNotes}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>
              Resolution notes not recorded
            </div>
          )}
          {q.dateAnswered && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 6, fontFamily: "'DM Mono', monospace" }}>
              Answered on: {q.dateAnswered}
            </div>
          )}
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
  const delayQuestions = Array.isArray(day.delayQuestionsForDay) ? day.delayQuestionsForDay : [];
  const openQuestions      = delayQuestions.filter((q) => !q.isResolved);
  const resolvedQuestions  = delayQuestions.filter((q) =>  q.isResolved);
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
              {delayQuestions.length > 0 && (
                <> · {delayQuestions.length} question{delayQuestions.length === 1 ? "" : "s"} from Delays tab</>
              )}
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

        {/* Delay questions from the per-client "{client} Delays" tab —
            this is where the actual question + resolution text lives. */}
        {openQuestions.length > 0 && (
          <div style={{ marginBottom: 22, marginTop: openRows.length || completedRows.length ? 22 : 0 }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>
              ❓ Open Questions from Delays Tab ({openQuestions.length})
            </div>
            {openQuestions.map((q, i) => (
              <DelayQuestionCard key={`q-open-${i}`} q={q} />
            ))}
          </div>
        )}
        {resolvedQuestions.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>
              ✅ Resolved Questions from Delays Tab ({resolvedQuestions.length})
            </div>
            {resolvedQuestions.map((q, i) => (
              <DelayQuestionCard key={`q-done-${i}`} q={q} />
            ))}
          </div>
        )}

        {/* Empty state */}
        {openRows.length === 0 && completedRows.length === 0 && delayQuestions.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>
            No delay details available for this day.
            <div style={{ marginTop: 8, fontSize: 11, fontStyle: "italic" }}>
              (Delay questions tab not found, or no rows for this date.)
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
