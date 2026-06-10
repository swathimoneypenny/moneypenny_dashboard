import { useEffect, useMemo, useState } from "react";
import { C, authFetch } from "../config";
import { WeekDropdown } from "../components/WeeklyChecklistSection";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList,
} from "recharts";

// TL-confirmed palette (2026-06-05):
const COLOR_GREEN  = "#10B981";
const COLOR_YELLOW = "#F59E0B";
const COLOR_RED    = "#EF4444";
const COLOR_GRAY   = "#6B7280";

function gradeColor(pct) {
  if (pct >= 80) return COLOR_GREEN;
  if (pct >= 50) return COLOR_YELLOW;
  return COLOR_RED;
}

function SummaryCard({ label, value, sublabel, color }) {
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
      <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
        {value}
      </div>
      {sublabel && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{sublabel}</div>
      )}
    </div>
  );
}

function TeamCard({ team, onOpen }) {
  const hasData      = !!team.has_data;
  const compliancePct = Number(team.compliance_pct || 0);
  const accent       = hasData ? gradeColor(compliancePct) : COLOR_GRAY;
  const flagBadge    = team.open_flags > 0;
  return (
    <div
      onClick={() => onOpen && onOpen(team)}
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 10,
        padding: "14px 16px",
        cursor: onOpen ? "pointer" : "default",
        transition: "background 0.15s, transform 0.15s",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
      onMouseEnter={(e) => { if (onOpen) { e.currentTarget.style.background = `${accent}0A`; } }}
      onMouseLeave={(e) => { if (onOpen) { e.currentTarget.style.background = C.card; } }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.pri }}>{team.team_label}</div>
          {team.lead && (
            <div style={{ fontSize: 11, color: C.muted }}>Lead: {team.lead}</div>
          )}
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: hasData ? COLOR_GREEN : COLOR_GRAY,
            background: hasData ? "rgba(16,185,129,0.15)" : C.surface,
            padding: "3px 8px",
            borderRadius: 12,
            letterSpacing: 0.4,
          }}
        >
          {hasData ? "✓ Filled" : "Not filled"}
        </span>
      </div>

      {hasData && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, marginTop: 2 }}>
          <div>
            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.6 }}>Compliance</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: accent, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
              {compliancePct.toFixed(1)}%
            </div>
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 11, color: C.sec, fontFamily: "'DM Mono', monospace" }}>
            <span title="Open flags">
              <span style={{ color: flagBadge ? COLOR_YELLOW : C.muted, fontWeight: 700 }}>🚩 {team.open_flags}</span>
            </span>
            <span title="Whale updates" style={{ color: team.whale_updates > 0 ? C.teal : C.muted }}>
              🐳 {team.whale_updates}
            </span>
            <span title="Clients reviewed" style={{ color: team.clients_reviewed > 0 ? C.blue : C.muted }}>
              👥 {team.clients_reviewed}
            </span>
            <span title="Weeks filled" style={{ color: C.muted }}>
              📅 {team.weeks_filled}
            </span>
          </div>
        </div>
      )}

      {hasData && team.training_topics_count > 0 && (
        <div style={{ fontSize: 11, color: C.muted }}>
          {team.training_topics_count} training topic{team.training_topics_count === 1 ? "" : "s"} recorded
        </div>
      )}

      {team.error && (
        <div style={{ fontSize: 10, color: COLOR_RED, fontStyle: "italic" }}>
          {team.error}
        </div>
      )}
    </div>
  );
}

export default function AdminHourPage({ onBack, onSelectTeam }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedWeek, setSelectedWeek] = useState("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = selectedWeek && selectedWeek !== "all"
      ? `/api/checklist/cross-team?week=${encodeURIComponent(selectedWeek)}`
      : `/api/checklist/cross-team`;
    authFetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.error && !d?.teams) { setError(d.error); setData(null); }
        else                        { setData(d); }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedWeek]);

  const summary    = data?.summary || {};
  const teams      = Array.isArray(data?.teams) ? data.teams : [];
  const availWeeks = data?.available_weeks || [];

  const complianceChartData = useMemo(
    () => teams
      .filter((t) => t.has_data)
      .map((t) => ({
        name:           (t.team_label || t.team_id || "").replace(/^Team\s+/i, ""),
        teamId:         t.team_id,
        label:          t.team_label,
        compliance:     Number(t.compliance_pct || 0),
        open_flags:     t.open_flags,
        whale_updates:  t.whale_updates,
      })),
    [teams],
  );

  const heading = selectedWeek && selectedWeek !== "all"
    ? `Week of ${selectedWeek}`
    : "All weeks";

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
            Cross-team Weekly Admin Checklist · {heading}
          </div>
        </div>
        <div style={{ marginLeft: "auto", fontSize: 12, color: C.muted }}>
          {loading
            ? "Loading…"
            : `${summary.teams_with_data ?? 0} of ${summary.total_teams ?? 0} teams filled`}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
        {error && (
          <div style={{ color: COLOR_RED, fontSize: 13, padding: 16, border: `1px solid ${C.border}`, borderRadius: 8 }}>
            Couldn't load Admin Hour data: {error}
          </div>
        )}

        {/* Week dropdown */}
        <WeekDropdown
          weeks={availWeeks}
          selected={selectedWeek}
          onChange={setSelectedWeek}
        />

        {/* Summary cards */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <SummaryCard
            label="Teams with data"
            value={`${summary.teams_with_data ?? 0} / ${summary.total_teams ?? 0}`}
            sublabel="Leads who filled the checklist"
            color={COLOR_GREEN}
          />
          <SummaryCard
            label="Avg compliance"
            value={`${(summary.average_compliance_pct ?? 0).toFixed(1)}%`}
            sublabel="Across teams with data"
            color={gradeColor(summary.average_compliance_pct ?? 0)}
          />
          <SummaryCard
            label="Flags raised"
            value={summary.total_flags ?? 0}
            sublabel="Non-empty flag cells (NIL included)"
            color={(summary.total_flags ?? 0) > 0 ? COLOR_YELLOW : C.muted}
          />
          <SummaryCard
            label="Whale updates"
            value={summary.total_whale_updates ?? 0}
            sublabel="Total URLs across all teams"
            color={C.teal}
          />
          <SummaryCard
            label="Clients reviewed"
            value={summary.total_clients_reviewed ?? 0}
            sublabel="Distinct named clients"
            color={C.blue}
          />
          <SummaryCard
            label="Weeks tracked"
            value={summary.total_weeks_tracked ?? 0}
            sublabel="Across all teams"
            color={C.purple}
          />
        </div>

        {/* Per-team compliance bar chart */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
            Per-team Compliance
          </div>
          {loading ? (
            <div className="kpi-skeleton" style={{ height: 220, borderRadius: 8 }} />
          ) : complianceChartData.length === 0 ? (
            <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontStyle: "italic", fontSize: 13 }}>
              No teams have filled the checklist for {heading.toLowerCase()}.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={complianceChartData} margin={{ top: 16, right: 12, left: -20, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke={C.border} strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fill: C.sec, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} domain={[0, 100]} ticks={[0, 50, 80, 100]} unit="%" />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  contentStyle={{ background: "rgba(11,25,41,0.95)", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.pri }}
                  formatter={(v, _k, p) => [`${Number(v).toFixed(1)}%`, `${p?.payload?.label}`]}
                  labelFormatter={() => ""}
                />
                <Bar dataKey="compliance" radius={[4, 4, 0, 0]}>
                  {complianceChartData.map((e, i) => (
                    <Cell key={i} fill={gradeColor(e.compliance)} />
                  ))}
                  <LabelList dataKey="compliance" position="top" formatter={(v) => `${Math.round(v)}%`} style={{ fill: C.pri, fontSize: 10 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Team grid */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 12 }}>
            Teams ({teams.length})
          </div>
          {loading ? (
            <div className="kpi-skeleton" style={{ height: 280, borderRadius: 8 }} />
          ) : teams.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 13, fontStyle: "italic" }}>No teams configured.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
              {teams.map((t) => (
                <TeamCard
                  key={t.team_id}
                  team={t}
                  onOpen={onSelectTeam ? (team) => onSelectTeam({ id: team.team_id, name: team.team_label }) : null}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
