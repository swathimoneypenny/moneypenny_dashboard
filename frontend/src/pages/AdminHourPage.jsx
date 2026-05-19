import { useEffect, useState, useMemo } from "react";
import { C, authFetch } from "../config";
import WeeklyReviewSection from "../components/WeeklyReviewSection";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

const WEEK_OPTIONS = [
  { value: 0, label: "Most recent week" },
  { value: 1, label: "1 week ago" },
  { value: 2, label: "2 weeks ago" },
  { value: 3, label: "3 weeks ago" },
  { value: 4, label: "4 weeks ago" },
];

function SummaryCard({ label, value, sublabel, color, valueColor }) {
  return (
    <div
      style={{
        background: `linear-gradient(180deg, ${C.card} 0%, ${C.surface} 100%)`,
        border: `1px solid ${C.border}`,
        borderTop: `3px solid ${color}`,
        borderRadius: 10,
        padding: "16px 18px",
        flex: "1 1 180px",
        minWidth: 160,
      }}
    >
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: valueColor || color, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
        {value}
      </div>
      {sublabel && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{sublabel}</div>
      )}
    </div>
  );
}

function TeamAccordionRow({ entry, onNavigate, isOpen, onToggle }) {
  const filled = !!entry.isFilled;
  const accent = filled ? "#3DC58B" : C.muted;
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 8,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          cursor: filled ? "pointer" : "default",
        }}
        onClick={() => filled && onToggle && onToggle()}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate && onNavigate(entry.teamId); }}
          style={{
            background: "transparent",
            border: `1px solid ${C.border}`,
            color: C.pri,
            padding: "5px 12px",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "'DM Sans', sans-serif",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.color = C.blue; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.pri; }}
          title="Open team dashboard"
        >
          {entry.teamLabel || entry.teamId}
        </button>
        <span style={{ fontSize: 12, color: C.sec }}>
          {entry.leadName ? `${entry.leadName}'s team` : ""}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            padding: "3px 10px",
            borderRadius: 12,
            background: filled ? "rgba(61,197,139,0.15)" : C.surface,
            color: accent,
            fontWeight: 700,
            letterSpacing: 0.3,
          }}
        >
          {filled ? "✓ Filled" : "Not filled"}
        </span>
        {filled && (
          <span style={{ color: C.muted, fontSize: 14, marginLeft: 4 }}>
            {isOpen ? "▾" : "▸"}
          </span>
        )}
      </div>
      {filled && isOpen && (
        <div style={{ padding: "8px 14px 14px", borderTop: `1px solid ${C.border}` }}>
          <WeeklyReviewSection teamId={entry.teamId} embedded />
        </div>
      )}
    </div>
  );
}

export default function AdminHourPage({ onBack, onSelectTeam }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExpanded({});
    authFetch(`/api/admin-hour?week_offset=${weekOffset}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.error) { setError(d.error); setData(null); }
        else          { setData(d); }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [weekOffset]);

  const summary = data?.summary || {};
  const teams   = Array.isArray(data?.teams) ? data.teams : [];

  // Compliance chart: one bar per team, filled = 1, not filled = 0
  const complianceData = useMemo(
    () => teams.map((t) => ({
      name:     (t.teamLabel || t.teamId).replace(/^Team\s+/i, ""),
      filled:   t.isFilled ? 1 : 0,
      teamId:   t.teamId,
      label:    t.teamLabel || t.teamId,
      isFilled: t.isFilled,
    })),
    [teams],
  );

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      {/* Header */}
      <div
        style={{
          background: "linear-gradient(180deg,#0e2040 0%,#0b1929 100%)",
          borderBottom: `1px solid ${C.border}`,
          padding: "20px 32px",
          display: "flex",
          alignItems: "center",
          gap: 18,
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "transparent",
            border: `1px solid ${C.border}`,
            color: C.sec,
            borderRadius: 8,
            padding: "8px 14px",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          ← Back
        </button>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.pri, letterSpacing: -0.4 }}>
            Admin Hour
          </div>
          <div style={{ fontSize: 12, color: C.sec, marginTop: 2 }}>
            Cross-team weekly review · {data?.weekRange || "—"}
          </div>
        </div>
        <select
          value={weekOffset}
          onChange={(e) => setWeekOffset(Number(e.target.value))}
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: C.pri,
            padding: "6px 12px",
            fontSize: 12,
            fontFamily: "'DM Sans', sans-serif",
            cursor: "pointer",
            marginLeft: 16,
          }}
        >
          {WEEK_OPTIONS.map((w) => (
            <option key={w.value} value={w.value}>{w.label}</option>
          ))}
        </select>
        <div style={{ marginLeft: "auto", fontSize: 12, color: C.muted }}>
          {loading ? "Loading…" : `${summary.teamsFilled ?? 0} of ${summary.totalTeams ?? 0} filled`}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
        {error && (
          <div style={{ color: C.red, fontSize: 13, padding: 16, border: `1px solid ${C.border}`, borderRadius: 8 }}>
            Couldn't load admin-hour data: {error}
          </div>
        )}

        {/* Summary cards */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <SummaryCard
            label="Compliance"
            value={`${summary.compliancePct ?? 0}%`}
            sublabel={`${summary.teamsFilled ?? 0} / ${summary.totalTeams ?? 0} leads filled`}
            color="#3DC58B"
          />
          <SummaryCard
            label="Issues flagged"
            value={summary.totalIssuesFound ?? 0}
            sublabel="Complaint themes + single-point-failure risks"
            color="#E25C5C"
          />
          <SummaryCard
            label="SOP gaps"
            value={summary.totalSopGaps ?? 0}
            sublabel="Same question asked twice"
            color="#F2895A"
          />
          <SummaryCard
            label="Commitments"
            value={summary.totalCommitments ?? 0}
            sublabel="Open promises across teams"
            color="#F0B947"
          />
        </div>

        {/* Compliance chart */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
            Per-team Compliance
          </div>
          {loading ? (
            <div className="kpi-skeleton" style={{ height: 200, borderRadius: 8 }} />
          ) : complianceData.length === 0 ? (
            <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontStyle: "italic", fontSize: 13 }}>
              No teams configured.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={complianceData} margin={{ top: 4, right: 8, left: -28, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke={C.border} strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fill: C.sec, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fill: C.muted, fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 1]}
                  ticks={[0, 1]}
                  tickFormatter={(v) => v ? "✓" : ""}
                />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  contentStyle={{ background: "rgba(11,25,41,0.95)", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.pri }}
                  formatter={(_v, _k, p) => [p?.payload?.isFilled ? "Filled" : "Not filled", p?.payload?.label]}
                  labelFormatter={() => ""}
                />
                <Bar dataKey="filled" radius={[4, 4, 0, 0]}>
                  {complianceData.map((e, i) => (
                    <Cell key={i} fill={e.isFilled ? "#3DC58B" : "#2A3A55"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Per-team accordion */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 12 }}>
            Teams ({teams.length})
          </div>
          {loading ? (
            <div className="kpi-skeleton" style={{ height: 280, borderRadius: 8 }} />
          ) : teams.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 13, fontStyle: "italic" }}>No teams configured.</div>
          ) : (
            teams.map((t) => (
              <TeamAccordionRow
                key={t.teamId}
                entry={t}
                isOpen={!!expanded[t.teamId]}
                onToggle={() => setExpanded((prev) => ({ ...prev, [t.teamId]: !prev[t.teamId] }))}
                onNavigate={(tid) => onSelectTeam && onSelectTeam({ id: tid, name: t.teamLabel || tid })}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
