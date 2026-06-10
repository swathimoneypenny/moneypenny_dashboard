import { useEffect, useMemo, useState } from "react";
import { C, authFetch } from "../config";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from "recharts";

// TL-confirmed palette (2026-06-05):
const YN_COLOR = {
  yes:   "#10B981",
  no:    "#EF4444",
  na:    "#6B7280",
  other: "#9DB1CC",
  flag:  "#F59E0B",
};

const BOOL_COLUMNS = [
  { key: "reviewed_procedure",    label: "Reviewed Procedure" },
  { key: "updated_escalation",    label: "Updated Escalation" },
  { key: "assigned_reading",      label: "Assigned Reading" },
  { key: "assigned_quiz",         label: "Assigned Quiz" },
  { key: "checked_tsheet",        label: "Checked Tsheet" },
  { key: "checked_meeting_notes", label: "Checked Mtg Notes" },
  { key: "meeting_notes_shared",  label: "Mtg Notes Shared" },
];

function YnPill({ value }) {
  const v = String(value || "na").toLowerCase();
  if (v === "yes") return <span style={{ color: YN_COLOR.yes, fontWeight: 700 }}>✓</span>;
  if (v === "no")  return <span style={{ color: YN_COLOR.no,  fontWeight: 700 }}>✗</span>;
  if (v === "na")  return <span style={{ color: YN_COLOR.na }}>—</span>;
  return <span style={{ color: YN_COLOR.other, fontSize: 11 }}>{value}</span>;
}

function StatCard({ label, value, sublabel, color }) {
  return (
    <div
      style={{
        background: `linear-gradient(180deg, ${C.card} 0%, ${C.surface} 100%)`,
        border: `1px solid ${C.border}`,
        borderTop: `3px solid ${color || C.blue}`,
        borderRadius: 10,
        padding: "14px 16px",
        flex: "1 1 140px",
        minWidth: 130,
      }}
    >
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || C.pri, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
        {value}
      </div>
      {sublabel && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{sublabel}</div>
      )}
    </div>
  );
}

function ChecklistSummaryCards({ summary }) {
  if (!summary) return null;
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <StatCard label="Weeks tracked"    value={summary.total_weeks ?? 0}              color={C.blue} />
      <StatCard label="Clients reviewed" value={summary.total_clients_reviewed ?? 0}   color={C.purple} />
      <StatCard label="Compliance"       value={`${(summary.compliance_pct ?? 0).toFixed(1)}%`} color={(summary.compliance_pct ?? 0) >= 80 ? YN_COLOR.yes : (summary.compliance_pct ?? 0) >= 50 ? YN_COLOR.flag : YN_COLOR.no} sublabel="Yes ÷ (Yes + No)" />
      <StatCard label="Open flags"       value={summary.open_flags ?? 0}               color={(summary.open_flags ?? 0) > 0 ? YN_COLOR.flag : C.muted} />
      <StatCard label="Whale updates"    value={summary.whale_links_count ?? 0}        color={C.teal} />
    </div>
  );
}

function ChecklistComplianceChart({ summary }) {
  const data = useMemo(() => {
    const fc = summary?.field_compliance || {};
    return BOOL_COLUMNS.map((col) => {
      const c = fc[col.key] || { yes: 0, no: 0, na: 0, other: 0, pct: 0 };
      return {
        name:  col.label.replace(" Procedure", "")
                       .replace("Checked ", "")
                       .replace("Updated ", ""),
        Yes:   c.yes   || 0,
        No:    c.no    || 0,
        NA:    c.na    || 0,
        pct:   c.pct   || 0,
      };
    });
  }, [summary]);
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 14px" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.sec, marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.8 }}>
        📊 Field Compliance
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} interval={0} angle={-18} textAnchor="end" height={56} />
          <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            contentStyle={{ background: "rgba(11,25,41,0.95)", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.pri }}
            formatter={(v, name) => [`${v}`, name]}
            labelFormatter={(lbl, payload) => {
              const pct = payload?.[0]?.payload?.pct;
              return `${lbl} · ${pct != null ? `${pct.toFixed(0)}% compliance` : ""}`;
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11, color: C.sec }} />
          <Bar dataKey="Yes" stackId="a" fill={YN_COLOR.yes} radius={[0, 0, 0, 0]} />
          <Bar dataKey="No"  stackId="a" fill={YN_COLOR.no}  radius={[0, 0, 0, 0]} />
          <Bar dataKey="NA"  stackId="a" fill={YN_COLOR.na}  radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrainingNeedsBlock({ summary }) {
  const preparers = (summary?.training_preparers || []).slice(0, 6);
  const tls       = (summary?.training_myself    || []).slice(0, 6);
  if (preparers.length === 0 && tls.length === 0) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px", color: C.muted, fontSize: 12, fontStyle: "italic" }}>
        No training topics recorded this period.
      </div>
    );
  }
  function topicList(items, emptyLabel) {
    if (items.length === 0) {
      return <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12 }}>{emptyLabel}</div>;
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((t, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.pri }}>
            <span>{t.topic}</span>
            <span style={{ color: C.muted, fontFamily: "'DM Mono', monospace" }}>×{t.count}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.sec, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.8 }}>
        🎓 Training Needs
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginBottom: 8 }}>Preparers need:</div>
          {topicList(preparers, "No preparer-training topics yet.")}
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginBottom: 8 }}>TL needs:</div>
          {topicList(tls, "No TL-training topics yet.")}
        </div>
      </div>
    </div>
  );
}

// "Nothing-to-flag" values that still get shown but rendered muted (gray)
// instead of orange — TLs use them to mark a row as actively reviewed.
const _NIL_FLAG_TOKENS = new Set(["nil", "n/a", "na", "none", "-", "—"]);

function isNilFlag(text) {
  return _NIL_FLAG_TOKENS.has((text || "").trim().toLowerCase());
}

function OpenFlagsList({ summary }) {
  const flags = summary?.flags || [];
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: C.sec,
          marginBottom: 10,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>🚩 Open Flags</span>
        <span
          style={{
            fontSize: 11,
            fontFamily: "'DM Mono', monospace",
            background: C.surface,
            color: flags.length > 0 ? C.pri : C.muted,
            padding: "2px 8px",
            borderRadius: 12,
            fontWeight: 700,
          }}
        >
          {flags.length}
        </span>
      </div>
      {flags.length === 0 ? (
        <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12 }}>
          (none this period)
        </div>
      ) : (
        flags.map((f, i) => {
          const nil = isNilFlag(f.flag);
          const accent = nil ? YN_COLOR.na : YN_COLOR.flag;
          return (
            <div
              key={i}
              style={{
                padding: "10px 12px",
                background: nil ? "rgba(107, 122, 149, 0.06)" : `${YN_COLOR.flag}14`,
                border: nil ? `1px solid ${C.border}` : `1px solid ${YN_COLOR.flag}55`,
                borderLeft: `3px solid ${accent}`,
                borderRadius: 6,
                marginBottom: 8,
                fontSize: 12,
                color: nil ? C.muted : C.pri,
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono', monospace", marginBottom: 4 }}>
                {f.week} · {f.client}
              </div>
              <div style={{ fontWeight: nil ? 500 : 600, fontStyle: nil ? "italic" : "normal" }}>
                {f.flag}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// Accepts either an array of URLs (`urls={r.whale_links}`) or, for backward
// compat, a single `url` string. Strings are split on whitespace / comma /
// semicolon if they contain multiple URLs, so a single populated cell with
// "https://… https://…" still renders both.
function WhaleLinkCell({ urls, url }) {
  let list = [];
  if (Array.isArray(urls)) {
    list = urls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
  } else if (typeof url === "string") {
    list = (url.match(/https?:\/\/[^\s,;'"\)]+/gi) || [])
      .map((u) => u.replace(/[.,;:)]+$/, ""))
      .filter(Boolean);
  }
  if (list.length === 0) {
    return <span style={{ color: C.muted, fontSize: 11 }}>—</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {list.map((u, i) => (
        <a
          key={i}
          href={u}
          target="_blank"
          rel="noopener noreferrer"
          title={u}
          style={{
            color: C.teal,
            fontSize: 11,
            textDecoration: "none",
            borderBottom: `1px dashed ${C.teal}`,
            whiteSpace: "nowrap",
          }}
        >
          🐳 Whale{list.length > 1 ? ` ${i + 1}` : ""}
        </a>
      ))}
    </div>
  );
}

function ChecklistTable({ weeks, expanded, onToggle }) {
  const rows = useMemo(() => {
    const out = [];
    for (const w of weeks || []) {
      for (const e of w.entries || []) {
        out.push({ week: w.week, ...e });
      }
    }
    return out;
  }, [weeks]);

  if (rows.length === 0) {
    return (
      <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12, padding: 14 }}>
        No checklist rows yet.
      </div>
    );
  }

  const th = {
    padding: "10px 10px",
    fontSize: 10,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    borderBottom: `1px solid ${C.border}`,
    background: C.card,
    whiteSpace: "nowrap",
    textAlign: "left",
  };
  const td = {
    padding: "8px 10px",
    fontSize: 12,
    color: C.pri,
    borderBottom: `1px solid ${C.border}40`,
    verticalAlign: "top",
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          padding: "12px 16px",
          color: C.pri,
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: "'DM Sans', sans-serif",
          textTransform: "uppercase",
          letterSpacing: 0.8,
        }}
      >
        <span style={{ color: C.sec }}>🗂 Detail Table ({rows.length} row{rows.length === 1 ? "" : "s"})</span>
        <span style={{ color: C.muted, fontSize: 14 }}>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div style={{ overflowX: "auto", borderTop: `1px solid ${C.border}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Week</th>
                <th style={th}>Client</th>
                <th style={{ ...th, textAlign: "center" }}>Reviewed</th>
                <th style={th}>Updated</th>
                <th style={th}>New</th>
                <th style={{ ...th, textAlign: "center" }}>Esc.</th>
                <th style={{ ...th, textAlign: "center" }}>Read</th>
                <th style={{ ...th, textAlign: "center" }}>Quiz</th>
                <th style={th}>Train Preparers</th>
                <th style={th}>Train TL</th>
                <th style={{ ...th, textAlign: "center" }}>Tsheet</th>
                <th style={{ ...th, textAlign: "center" }}>Mtg</th>
                <th style={{ ...th, textAlign: "center" }}>Shared</th>
                <th style={th}>Flag</th>
                <th style={{ ...th, textAlign: "center" }}>Whale</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const baseBg = i % 2 === 0 ? "transparent" : C.surface;
                const flagText = (r.flag_tm_ops || "").trim();
                const flagOpen = flagText && !["nil", "n/a", "na", "none", "-", "—"].includes(flagText.toLowerCase());
                return (
                  <tr key={i} style={{ background: baseBg }}>
                    <td style={{ ...td, fontFamily: "'DM Mono', monospace", color: C.sec, whiteSpace: "nowrap" }}>{r.week}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{r.client}</td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.reviewed_procedure} /></td>
                    <td style={td}>{r.updated_procedure || <span style={{ color: C.muted }}>—</span>}</td>
                    <td style={td}>{r.new_procedure || <span style={{ color: C.muted }}>—</span>}</td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.updated_escalation} /></td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.assigned_reading} /></td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.assigned_quiz} /></td>
                    <td style={td}>{r.training_preparers || <span style={{ color: C.muted }}>—</span>}</td>
                    <td style={td}>{r.training_myself || <span style={{ color: C.muted }}>—</span>}</td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.checked_tsheet} /></td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.checked_meeting_notes} /></td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.meeting_notes_shared} /></td>
                    <td style={td}>
                      {flagOpen ? (
                        <span style={{ color: YN_COLOR.flag, fontWeight: 600 }}>{flagText}</span>
                      ) : (
                        <span style={{ color: C.muted }}>NIL</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "center" }}><WhaleLinkCell urls={r.whale_links} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


export default function WeeklyChecklistSection({ teamId }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [tableOpen, setTableOpen] = useState(false);

  useEffect(() => {
    if (!teamId) return;
    const ctrl = new AbortController();
    setState({ loading: true, data: null, error: null });
    authFetch(`/api/team/${teamId}/checklist`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => {
        if (ctrl.signal.aborted) return;
        setState({ loading: false, data: j, error: j?.error || null });
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setState({ loading: false, data: null, error: err?.message || String(err) });
      });
    return () => ctrl.abort();
  }, [teamId]);

  const data = state.data;
  const summary = data?.summary;
  const weeks = data?.weeks || [];

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.pri, marginBottom: 4 }}>
        📋 Weekly Admin Checklist
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 16 }}>
        Sourced from the per-team checklist tab (cached server-side for 10 min).
      </div>

      {state.loading && (
        <div style={{ padding: 30, textAlign: "center", color: C.muted, fontSize: 12 }}>
          <span
            style={{
              display: "inline-block",
              width: 14, height: 14,
              border: `2px solid ${C.border}`,
              borderTopColor: C.teal,
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
              marginRight: 10,
              verticalAlign: "middle",
            }}
          />
          Loading checklist…
        </div>
      )}

      {!state.loading && state.error && (
        <div
          style={{
            padding: "12px 14px",
            background: `${YN_COLOR.flag}14`,
            border: `1px solid ${YN_COLOR.flag}55`,
            borderLeft: `3px solid ${YN_COLOR.flag}`,
            borderRadius: 6,
            color: C.sec,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: YN_COLOR.flag }}>Checklist unavailable:</strong>{" "}
          {data?.error_detail || state.error}
        </div>
      )}

      {!state.loading && !state.error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <ChecklistSummaryCards summary={summary} />
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
            <ChecklistComplianceChart summary={summary} />
            <TrainingNeedsBlock summary={summary} />
          </div>
          <OpenFlagsList summary={summary} />
          <ChecklistTable weeks={weeks} expanded={tableOpen} onToggle={() => setTableOpen((v) => !v)} />
        </div>
      )}
    </div>
  );
}
