import { useEffect, useMemo, useState } from "react";
import { C, authFetch } from "../config";
import {
  PieChart, Pie, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell, Legend,
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

// Backend now returns each section field as { text, lines } where lines is
// an array of { text, severity }. Older callers passed plain strings, so
// fieldText/fieldLines tolerate both shapes.
function fieldText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  return (v.text || "").trim();
}
function fieldLines(v) {
  if (!v) return [];
  if (typeof v === "string") {
    return v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((t) => ({ text: t, severity: "neutral" }));
  }
  if (Array.isArray(v.lines) && v.lines.length) return v.lines;
  return fieldText(v)
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .map((t) => ({ text: t, severity: "neutral" }));
}

const SEVERITY_DOT_COLORS = {
  high:      "#EF4444",
  medium:    "#F59E0B",
  completed: "#10B981",
  neutral:   "#6B7280",
};

function ReviewField({ label, value }) {
  const lines = fieldLines(value);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 600 }}>
        {label}
      </div>
      {lines.length === 0 ? (
        <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>—</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {lines.map((ln, j) => (
            <div key={j} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  marginTop: 7,
                  flexShrink: 0,
                  background: SEVERITY_DOT_COLORS[ln.severity] || SEVERITY_DOT_COLORS.neutral,
                }}
              />
              <span style={{ fontSize: 12, color: C.pri, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {ln.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function KeyActionsCard({ actionItems }) {
  if (!Array.isArray(actionItems) || actionItems.length === 0) return null;
  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(124,58,237,0.15), rgba(59,130,246,0.10))",
      border: "1px solid #7C3AED40",
      borderLeft: "4px solid #7C3AED",
      borderRadius: 8,
      padding: 20,
    }}>
      <div style={{
        fontSize: 14,
        fontWeight: 600,
        color: "#A78BFA",
        marginBottom: 12,
        letterSpacing: 1,
        textTransform: "uppercase",
      }}>
        Key Actions This Week
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {actionItems.map((action, i) => (
          <div key={i} style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            fontSize: 14,
            lineHeight: 1.5,
            color: C.pri,
          }}>
            <span style={{
              display: "inline-flex",
              justifyContent: "center",
              alignItems: "center",
              minWidth: 24,
              height: 24,
              borderRadius: "50%",
              background: "#7C3AED",
              color: "white",
              fontSize: 12,
              fontWeight: 700,
              flexShrink: 0,
            }}>
              {i + 1}
            </span>
            <span>{action}</span>
          </div>
        ))}
      </div>
      <div style={{
        fontSize: 11,
        color: C.muted,
        marginTop: 12,
        fontStyle: "italic",
      }}>
        Auto-generated from this week's review · Updates when review is refreshed
      </div>
    </div>
  );
}

// Wrapper used by the 3 charts in the row above the section cards
function ChartCard({ title, subtitle, caption, children }) {
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
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: caption ? 4 : 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.sec, textTransform: "uppercase", letterSpacing: 1 }}>
          {title}
        </span>
        {subtitle && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
            {subtitle}
          </span>
        )}
      </div>
      {caption && (
        <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic", marginBottom: 10, lineHeight: 1.4 }}>
          {caption}
        </div>
      )}
      {children}
    </div>
  );
}

// Split free-text into a count of distinct entries — leads write commitments
// and issues as bullets/lines, so a newline-separated count is the truest
// signal. Falls back to "1 if any non-whitespace text exists" for prose blobs.
function countItems(text) {
  if (!text) return 0;
  // Defensive: accept the new {text, lines} shape too — chart accessors
  // already wrap with fieldText, but this keeps countItems safe to call
  // with raw section field values from anywhere.
  const s = typeof text === "string" ? text : fieldText(text);
  if (!s) return 0;
  const lines = s
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s•\-*]+/, "").trim())
    .filter(Boolean);
  if (lines.length) return lines.length;
  return s.trim() ? 1 : 0;
}

const ISSUE_CATEGORIES = [
  { key: "lateFiles",    label: "Late/Missing files",          color: "#E25C5C" },
  { key: "blockedJobs",  label: "Blocked — awaiting response", color: "#F0B947" },
  { key: "scopeCreep",   label: "Scope creep",                 color: "#F2895A" },
  { key: "repeatIssues", label: "Quality / Rework",            color: "#9B7EE8" },
];

function IssueBreakdownChart({ sections, weekRange }) {
  const data = useMemo(() => {
    const wi = sections?.workIntake || {};
    const q  = sections?.quality    || {};
    const sourceMap = {
      lateFiles:    fieldText(wi.lateFiles),
      blockedJobs:  fieldText(wi.blockedJobs),
      scopeCreep:   fieldText(wi.scopeCreep),
      repeatIssues: fieldText(q.repeatIssues),
    };
    return ISSUE_CATEGORIES.map((c) => ({
      ...c,
      count: countItems(sourceMap[c.key]),
    }));
  }, [sections]);
  const total = data.reduce((a, d) => a + d.count, 0);
  const pieData = data.filter((d) => d.count > 0);
  return (
    <ChartCard
      title="Issue Type Breakdown"
      subtitle={total ? `${total} this week${weekRange ? ` · ${weekRange}` : ""}` : (weekRange || "")}
      caption="What this means: Shows the types of issues the team faced this week. Bigger slice = more issues of that type."
    >
      {total === 0 ? (
        <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 11, fontStyle: "italic" }}>
          No issues logged this week.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <PieChart>
            <Pie
              data={pieData}
              dataKey="count"
              nameKey="label"
              cx="35%"
              cy="50%"
              innerRadius={36}
              outerRadius={66}
              paddingAngle={2}
              stroke="none"
            >
              {pieData.map((d, i) => (
                <Cell key={i} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: "rgba(11,25,41,0.95)", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, color: C.pri }}
              formatter={(v, n) => [`${v} (${Math.round(v * 100 / total)}%)`, n]}
            />
            <Legend
              layout="vertical"
              align="right"
              verticalAlign="middle"
              wrapperStyle={{ fontSize: 11, color: C.sec, lineHeight: "1.6em" }}
              iconType="circle"
              iconSize={8}
              formatter={(value, entry) => {
                const c = entry?.payload?.count ?? 0;
                return `${value} · ${c}`;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

const COMMITMENT_CATEGORIES = [
  { key: "iOweClients", label: "Clients", color: "#4A8FE7" },
  { key: "iOweStaff",   label: "Staff",   color: "#3DC58B" },
  { key: "iOweUS",      label: "US",      color: "#F2895A" },
];

function PendingCommitmentsChart({ sections, weekRange, commitmentCounts }) {
  const data = useMemo(() => {
    const c = sections?.commitments || {};
    return COMMITMENT_CATEGORIES.map((cat) => {
      // Backend now computes commitmentCounts via _count_commitments — it
      // tolerates single-sentence fields (no separators) that the simple
      // newline split here would otherwise undercount. Fall back to the
      // local counter if the backend payload didn't ship the field.
      const backendCount = commitmentCounts && Number.isFinite(commitmentCounts[cat.key])
        ? commitmentCounts[cat.key]
        : countItems(fieldText(c[cat.key]));
      return { ...cat, count: backendCount };
    });
  }, [sections, commitmentCounts]);
  const total       = data.reduce((a, d) => a + d.count, 0);
  // Empty-state check: only show "No open commitments" when nothing was
  // counted AND every I-owe field is also literally empty / dash.
  const hasAnyText = COMMITMENT_CATEGORIES.some((cat) => {
    const t = fieldText((sections?.commitments || {})[cat.key]).trim();
    return t && t !== "—";
  });
  const empty = total === 0 && !hasAnyText;
  return (
    <ChartCard
      title="Commitments for Next Week"
      subtitle={total ? `${total} open${weekRange ? ` · ${weekRange}` : ""}` : (weekRange || "")}
      caption={
        empty
          ? "What this means: No open commitments tracked this week."
          : "What this means: Open promises the TL made this week — to clients, staff, or US contacts. These need follow-up next week."
      }
    >
      {empty ? (
        <div style={{ height: 160, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 11, fontStyle: "italic" }}>
          No open commitments this week.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fill: C.muted, fontSize: 9 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fill: C.sec, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={70}
            />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              contentStyle={{ background: "rgba(11,25,41,0.95)", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11, color: C.pri }}
              formatter={(v) => [`${v} promise${v === 1 ? "" : "s"}`, ""]}
              labelFormatter={(l) => `I owe — ${l}`}
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={22}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.color} />
              ))}
            </Bar>
          </BarChart>
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
      caption="What this means: How often each client appeared in this week's review. Higher bar = client needed more TL attention."
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
  const fieldsWithValues = section.fields.filter(([k]) => fieldText(content?.[k]));
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
          <KeyActionsCard actionItems={data?.actionItems} />
          {data?.reviewedBy && (
            <div style={{ fontSize: 11, color: C.muted }}>
              Reviewed by <span style={{ color: C.sec, fontWeight: 600 }}>{data.reviewedBy}</span>
              {data.teamClient ? ` · ${data.teamClient}` : ""}
            </div>
          )}
          {!embedded && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <IssueBreakdownChart sections={sections} weekRange={data?.weekRange} />
              <ClientMentionsChart mentions={data?.clientMentions} weekRange={data?.weekRange} />
              <PendingCommitmentsChart sections={sections} weekRange={data?.weekRange} commitmentCounts={data?.commitmentCounts} />
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
