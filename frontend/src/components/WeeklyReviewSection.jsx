import { useEffect, useMemo, useState } from "react";
import { C, authFetch } from "../config";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";

// Section meta — order, label, color, and the field-name → label map for
// each card inside the section.
const SECTIONS = [
  {
    key:    "workIntake",
    label:  "Work Intake",
    icon:   "🔴",
    color:  "#E25C5C",
    fields: [
      ["lateFiles",     "Late or missing files"],
      ["blockedJobs",   "Jobs blocked awaiting US response"],
      ["scopeCreep",    "Scope creep"],
    ],
  },
  {
    key:    "hoursCapacity",
    label:  "Hours & Capacity",
    icon:   "🔵",
    color:  "#4A8FE7",
    fields: [
      ["deliveredVsContracted", "Delivered vs contracted"],
      ["clientBlockedHours",    "Client-blocked hours"],
      ["trainingPto",           "Training / PTO / absences"],
      ["utilFlags",             "Over/under utilization flags"],
    ],
  },
  {
    key:    "quality",
    label:  "Quality",
    icon:   "🟢",
    color:  "#3DC58B",
    fields: [
      ["usNotes",         "US notes, corrections, rework"],
      ["repeatIssues",    "Repeat issues + root cause"],
      ["questionVolume",  "Question volume to US side"],
    ],
  },
  {
    key:    "staffNotes",
    label:  "Staff Notes",
    icon:   "🟡",
    color:  "#F0B947",
    fields: [
      ["recognize",         "Recognize this week"],
      ["needsConversation", "Needs a conversation"],
      ["spanOfControl",     "Team Lead span-of-control check"],
    ],
  },
  {
    key:    "patterns",
    label:  "Patterns to Act On",
    icon:   "🟣",
    color:  "#9B7EE8",
    fields: [
      ["sopGap",             "SOP gap (same question twice)"],
      ["complaintTheme",     "Emerging complaint theme"],
      ["singlePointFailure", "Single-point-of-failure risk"],
    ],
  },
  {
    key:    "whale",
    label:  "Whale Updates",
    icon:   "🟢",
    color:  "#3DC58B",
    fields: [
      ["updatedThisWeek", "Updated this week"],
      ["newProcedure",    "New procedure to document"],
      ["pendingUpdates",  "Pending updates"],
    ],
  },
  {
    key:    "commitments",
    label:  "Open Commitments",
    icon:   "🟠",
    color:  "#F2895A",
    fields: [
      ["iOweClients", "I owe — clients"],
      ["iOweStaff",   "I owe — staff"],
      ["iOweUS",      "I owe — US contacts"],
    ],
  },
];

function ReviewField({ label, value }) {
  const v = (value || "").trim();
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: v ? C.pri : C.muted, lineHeight: 1.5, whiteSpace: "pre-wrap", fontStyle: v ? "normal" : "italic" }}>
        {v || "—"}
      </div>
    </div>
  );
}

// Wrapper used by the 3 charts in the row above the section cards
function ChartCard({ title, subtitle, children }) {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: "14px 16px",
        flex: "1 1 320px",
        minWidth: 280,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.sec, textTransform: "uppercase", letterSpacing: 1 }}>
          {title}
        </span>
        {subtitle && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
            {subtitle}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function SectionCompletionChart({ sections }) {
  const stats = useMemo(() => SECTIONS.map((s) => {
    const total  = s.fields.length;
    const filled = s.fields.filter(([k]) => (sections?.[s.key]?.[k] || "").trim()).length;
    return { key: s.key, label: s.label, icon: s.icon, color: s.color, filled, total };
  }), [sections]);
  const totalFilled = stats.reduce((a, s) => a + s.filled, 0);
  const totalAll    = stats.reduce((a, s) => a + s.total, 0);
  const overallPct  = totalAll ? Math.round(totalFilled * 100 / totalAll) : 0;
  return (
    <ChartCard
      title={`Section Completion (${totalFilled}/${totalAll})`}
      subtitle={`Overall ${overallPct}%`}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {stats.map((s) => {
          const pct = s.total ? (s.filled * 100 / s.total) : 0;
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10 }}>{s.icon}</span>
              <span style={{ fontSize: 10, color: C.sec, width: 96, flexShrink: 0 }}>{s.label}</span>
              <div style={{ flex: 1, height: 8, background: C.surface, borderRadius: 4, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: s.color,
                    transition: "width .25s",
                  }}
                />
              </div>
              <span style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono', monospace", width: 38, textAlign: "right" }}>
                {s.filled}/{s.total}
              </span>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}

function WeeklyTrendChart({ teamId }) {
  const [weeks, setWeeks]   = useState(null);
  const [error, setError]   = useState(null);
  useEffect(() => {
    let cancelled = false;
    setWeeks(null);
    setError(null);
    authFetch(`/api/team/${teamId}/weekly-trend?weeks=8`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.error) { setError(d.error); setWeeks([]); }
        else          { setWeeks(Array.isArray(d?.weeks) ? d.weeks : []); }
      })
      .catch((e) => { if (!cancelled) { setError(e?.message || String(e)); setWeeks([]); } });
    return () => { cancelled = true; };
  }, [teamId]);

  const latest = weeks && weeks.length ? weeks[weeks.length - 1] : null;
  const belowTarget = !!latest && latest.completionPct < 80;
  const subtitle = latest
    ? `Latest ${latest.weekRange} · ${latest.completionPct}%${belowTarget ? " ⚠" : ""}`
    : "";

  return (
    <ChartCard title="Completion Trend — Last 8 Weeks" subtitle={subtitle}>
      {weeks === null ? (
        <div className="kpi-skeleton" style={{ height: 160, borderRadius: 6 }} />
      ) : error ? (
        <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 11, fontStyle: "italic" }}>
          Couldn't load trend: {error}
        </div>
      ) : weeks.length === 0 ? (
        <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 11, fontStyle: "italic" }}>
          No filled weeks yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={weeks} margin={{ top: 6, right: 10, left: -20, bottom: 4 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="weekRange"
              tick={{ fill: C.muted, fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              interval={0}
              tickFormatter={(v) => (v || "").replace(/\s*-\s*.*/, "")}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fill: C.muted, fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              ticks={[0, 50, 80, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              cursor={{ stroke: C.border }}
              contentStyle={{ background: "rgba(11,25,41,0.95)", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, color: C.pri }}
              formatter={(v, _k, p) => [`${v}% (${p?.payload?.filledFields}/${p?.payload?.totalFields})`, "Completion"]}
              labelFormatter={(l) => l}
            />
            <ReferenceLine y={80} stroke="#3DC58B" strokeDasharray="4 4" />
            <Line
              type="monotone"
              dataKey="completionPct"
              stroke="#4A8FE7"
              strokeWidth={2}
              dot={({ cx, cy, payload, index }) => {
                const isLast = index === weeks.length - 1;
                const red    = isLast && payload.completionPct < 80;
                return (
                  <circle
                    key={index}
                    cx={cx}
                    cy={cy}
                    r={isLast ? 5 : 3}
                    fill={red ? "#E25C5C" : "#4A8FE7"}
                    stroke={red ? "#E25C5C" : "#4A8FE7"}
                  />
                );
              }}
              activeDot={{ r: 6 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

function ClientMentionsChart({ mentions, weekRange }) {
  const data = Array.isArray(mentions) ? mentions : [];
  return (
    <ChartCard
      title="Issues Mentioned Per Client"
      subtitle={weekRange ? `Week of ${weekRange}` : ""}
    >
      {data.length === 0 ? (
        <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 11, fontStyle: "italic" }}>
          No client mentions in Work Intake this week.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(120, data.length * 36)}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={{ fill: C.muted, fontSize: 9 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <YAxis
              type="category"
              dataKey="client"
              tick={{ fill: C.sec, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={110}
            />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              contentStyle={{ background: "rgba(11,25,41,0.95)", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, color: C.pri }}
              formatter={(v) => [`${v} mention${v === 1 ? "" : "s"}`, ""]}
              labelFormatter={(l) => l}
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={20}>
              {data.map((_, i) => (
                <Cell key={i} fill="#E25C5C" />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

function SectionCard({ section, content }) {
  const fieldsWithValues = section.fields.filter(([k]) => (content?.[k] || "").trim());
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${section.color}`,
        borderRadius: 10,
        padding: "14px 16px",
        flex: "1 1 320px",
        minWidth: 280,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 12 }}>{section.icon}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: section.color, textTransform: "uppercase", letterSpacing: 1 }}>
          {section.label}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
          {fieldsWithValues.length}/{section.fields.length}
        </span>
      </div>
      {section.fields.map(([k, label]) => (
        <ReviewField key={k} label={label} value={content?.[k]} />
      ))}
    </div>
  );
}

export default function WeeklyReviewSection({ teamId, embedded = false }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/team/${teamId}/admin-review?week_offset=${weekOffset}`)
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
  }, [teamId, weekOffset]);

  const filled = !!data?.isFilled;
  const sections = data?.sections || null;
  const availableWeeks = Array.isArray(data?.availableWeeks) ? data.availableWeeks : [];

  return (
    <div
      style={{
        background: embedded ? "transparent" : C.card,
        border: embedded ? "none" : `1px solid ${C.border}`,
        borderRadius: 12,
        padding: embedded ? 0 : 20,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.sec, letterSpacing: -0.2 }}>
            Weekly Review
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {data?.leadName ? `${data.leadName}'s reflection` : "Team Lead reflection"}
            {data?.weekRange ? ` · ${data.weekRange}` : ""}
          </div>
        </div>
        {availableWeeks.length > 0 && (
          <select
            value={weekOffset}
            onChange={(e) => setWeekOffset(Number(e.target.value))}
            style={{
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              color: C.pri,
              padding: "6px 10px",
              fontSize: 12,
              fontFamily: "'DM Sans', sans-serif",
              cursor: "pointer",
            }}
          >
            {availableWeeks.slice(0, 8).map((w, i) => (
              <option key={i} value={i}>
                {w.weekRange}{w.isFilled ? "" : " (not filled)"}
              </option>
            ))}
          </select>
        )}
        <div style={{ marginLeft: "auto", fontSize: 11, color: filled ? "#3DC58B" : C.muted, fontWeight: 600 }}>
          {loading ? "Loading…" : filled ? "✓ Filled" : "Not filled yet"}
        </div>
      </div>

      {/* Body */}
      {error && (
        <div style={{ padding: 12, color: C.muted, fontSize: 12, fontStyle: "italic" }}>
          Couldn't load weekly review: {error}
        </div>
      )}
      {!error && loading && (
        <div className="kpi-skeleton" style={{ height: 160, borderRadius: 8 }} />
      )}
      {!error && !loading && !filled && (
        <div style={{ padding: "18px 16px", color: C.muted, fontSize: 12, fontStyle: "italic", border: `1px dashed ${C.border}`, borderRadius: 8 }}>
          Not filled yet for this week.
          {availableWeeks.length > 0 && (
            <> Most recent on file: <span style={{ color: C.sec }}>{availableWeeks[0]?.weekRange}</span>.</>
          )}
          {!data?.matchedTab && (
            <div style={{ marginTop: 6, fontSize: 11 }}>
              (No matching tab found in the weekly-review sheet for {data?.leadName || teamId}.)
            </div>
          )}
        </div>
      )}
      {!error && !loading && filled && sections && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {data?.reviewedBy && (
            <div style={{ fontSize: 11, color: C.muted }}>
              Reviewed by <span style={{ color: C.sec, fontWeight: 600 }}>{data.reviewedBy}</span>
              {data.teamClient ? ` · ${data.teamClient}` : ""}
            </div>
          )}
          {!embedded && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <SectionCompletionChart sections={sections} />
              <WeeklyTrendChart teamId={teamId} />
              <ClientMentionsChart mentions={data?.clientMentions} weekRange={data?.weekRange} />
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {SECTIONS.map((s) => (
              <SectionCard key={s.key} section={s} content={sections[s.key]} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
