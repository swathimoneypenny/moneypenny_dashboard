import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { C, API_BASE, authFetch } from "../config";
import { LiveIndicator, useAutoRefresh } from "../components/LiveIndicator";
import DelayDetailModal from "../components/DelayDetailModal";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  Cell,
  LabelList,
} from "recharts";

const API = API_BASE;

const PERIODS = [
  { key: "today",   label: "Today",            endpoint: "today" },
  { key: "weekly",  label: "This Week",        endpoint: "weekly" },
  { key: "monthly", label: "This Month",       endpoint: "monthly" },
  { key: "custom",  label: "📅 Custom Range", endpoint: "custom" },
];

// Default custom range = last 7 days ending today. Mirrors TeamDashboard.
function _defaultCustomRange() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(start), to: fmt(today) };
}

function statusInfo(pct) {
  if (pct < 75)  return { label: "BELOW TARGET", color: C.red,    bg: C.statusRed };
  if (pct < 95)  return { label: "ON TARGET",    color: C.green,  bg: C.statusGreen };
  if (pct <= 120) return { label: "OVER TARGET", color: C.green,  bg: C.statusGreen };
  return { label: "CRITICAL", color: C.orange, bg: C.statusOrange };
}

function delayColor(count) {
  if (count <= 0) return C.green;
  if (count <= 2) return C.yellow;
  if (count <= 5) return C.orange;
  return C.red;
}

const AGING_LEGEND = [
  { color: "#3DC58B", label: "Completed" },
  { color: "#F0B947", label: "Fresh (0-2d)" },
  { color: "#F2895A", label: "Aging (3-7d)" },
  { color: "#E25C5C", label: "Overdue (8+d)" },
];

function AgingLegend() {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10, fontSize: 11, color: C.muted }}>
      {AGING_LEGEND.map(({ color, label }) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
          {label}
        </div>
      ))}
    </div>
  );
}

function AgingCard({ label, value, color, pulse }) {
  const active = (value ?? 0) > 0;
  const borderColor = active ? color : C.border;
  const numberColor = active ? color : C.muted;
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 80,
        background: C.surface,
        border: `2px solid ${borderColor}`,
        borderRadius: 8,
        padding: "10px 12px",
        textAlign: "center",
        animation: pulse && active ? "pulseRed 1.6s ease-in-out infinite" : "none",
        transition: "border-color 0.2s",
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: numberColor, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
        {value ?? 0}
      </div>
    </div>
  );
}

function AgingSummaryRow({ summary }) {
  const today  = summary?.today ?? 0;
  const t12    = summary?.["1to2days"] ?? 0;
  const t37    = summary?.["3to7days"] ?? 0;
  const t8plus = summary?.["8plusDays"] ?? 0;
  const todayColor = today === 0 ? "#3DC58B" : "#F0B947";
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
      <AgingCard label="Today"          value={today}  color={todayColor} />
      <AgingCard label="1-2 Days"       value={t12}    color="#F0B947" />
      <AgingCard label="3-7 Days"       value={t37}    color="#F2895A" />
      <AgingCard label="8+ Days Overdue" value={t8plus} color="#E25C5C" pulse />
    </div>
  );
}

function AgingTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload ?? {};
  const total = (p.Completed ?? 0) + (p.Fresh ?? 0) + (p.Aging ?? 0) + (p.Overdue ?? 0);
  const sb = p.statusBreakdown || {};
  const topQ = Array.isArray(p.topQueries) ? p.topQueries : [];
  return (
    <div
      style={{
        background: "rgba(11,25,41,0.95)",
        backdropFilter: "blur(10px)",
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "12px 14px",
        fontSize: 12,
        color: C.pri,
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        maxWidth: 380,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: C.sec }}>
        {p.fullDateLabel || p.fullDate || `Day ${p.day}`}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
        {total} delay{total === 1 ? "" : "s"}
        {(p.Overdue ?? 0) > 0 && (
          <> · <span style={{ color: "#E25C5C" }}>{p.Overdue} overdue</span></>
        )}
      </div>
      <div style={{ fontSize: 11, marginBottom: 6, display: "flex", gap: 10, flexWrap: "wrap" }}>
        {(sb.completed ?? 0) > 0 && (
          <span style={{ color: "#3DC58B" }}>● {sb.completed} Completed</span>
        )}
        {(sb.in_progress ?? 0) > 0 && (
          <span style={{ color: "#F0B947" }}>● {sb.in_progress} In Progress</span>
        )}
        {(sb.awaiting_response ?? 0) > 0 && (
          <span style={{ color: "#E25C5C" }}>● {sb.awaiting_response} Awaiting Response</span>
        )}
      </div>
      {topQ.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8, marginTop: 8 }}>
          <div style={{ fontSize: 10, color: C.muted, marginBottom: 4, letterSpacing: 0.8, fontWeight: 600 }}>
            OLDEST QUERIES
          </div>
          {topQ.map((q, i) => {
            const age = Number(q.ageDays) || 0;
            const ageColor = age >= 8 ? "#E25C5C" : age >= 3 ? "#F2895A" : "#F0B947";
            return (
              <div key={i} style={{ fontSize: 11, marginBottom: 4, lineHeight: 1.4 }}>
                <span style={{ color: ageColor, fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>
                  {age}d old
                </span>
                <span style={{ color: C.muted }}> — </span>
                <span style={{ color: C.pri }}>{q.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function buildAgingChartData(delaysByDay) {
  return (delaysByDay || []).map((d) => {
    const dateStr = String(d.date ?? "");
    const dt = dateStr.length >= 10 ? new Date(dateStr) : null;
    const day  = dt && !Number.isNaN(dt.getTime()) ? dt.getDate() : Number(dateStr.slice(-2));
    const monthLabel = dt ? dt.toLocaleString("default", { month: "short" }) : "";
    const yr = dt ? dt.getFullYear() : "";
    return {
      day: String(day || dateStr.slice(-2) || ""),
      fullDate: dateStr,
      fullDateLabel: dt ? `${monthLabel} ${day}, ${yr}` : dateStr,
      Completed: Number(d.completed) || 0,
      Fresh:     Number(d.fresh)     || 0,
      Aging:     Number(d.aging)     || 0,
      Overdue:   Number(d.overdue)   || 0,
      statusBreakdown: d.statusBreakdown || {},
      topQueries:      Array.isArray(d.topQueries) ? d.topQueries : [],
      allRows:         Array.isArray(d.allRows) ? d.allRows : [],
      queryPreview:    d.queryPreview || "",
    };
  });
}

function initials(name) {
  return (name ?? "?")
    .split(/[\s-]+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function gradientFor(str) {
  const GRADS = [
    "linear-gradient(135deg,#3d8ef0,#9f7aea)",
    "linear-gradient(135deg,#00c896,#3d8ef0)",
    "linear-gradient(135deg,#ed8936,#e53e3e)",
    "linear-gradient(135deg,#9f7aea,#1db954)",
    "linear-gradient(135deg,#1db954,#00c896)",
  ];
  let h = 0;
  for (let i = 0; i < (str ?? "").length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return GRADS[h % GRADS.length];
}

const today = new Date().toLocaleDateString("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

// ── Custom tooltip ──────────────────────────────────────────────
function DarkTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: "rgba(11,25,41,0.95)",
        backdropFilter: "blur(10px)",
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 12,
        color: C.pri,
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: C.sec }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: <strong>{typeof p.value === "number" ? p.value.toFixed(1) : p.value}</strong>
        </div>
      ))}
    </div>
  );
}

// ── KPI card ────────────────────────────────────────────────────
function KpiCard({ label, value, color, suffix = "h", sublabel }) {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 10,
        padding: "16px 18px",
        flex: "1 1 160px",
        minWidth: 140,
        boxShadow: `inset 0 0 20px ${color}10`,
      }}
    >
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color, fontFamily: "'DM Mono', monospace" }}>
        {typeof value === "number" ? value.toFixed(1) : "—"}
        <span style={{ fontSize: 14, fontWeight: 400, marginLeft: 3, color: C.sec }}>{suffix}</span>
      </div>
      {sublabel && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sublabel}</div>}
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div
      className="kpi-skeleton"
      style={{ flex: "1 1 160px", minWidth: 140, height: 90 }}
    />
  );
}

// ── Sortable Staff table ─────────────────────────────────────────
function SortIcon({ dir }) {
  return <span style={{ marginLeft: 4, opacity: 0.5, fontSize: 10 }}>{dir === "asc" ? "▲" : "▼"}</span>;
}

function StaffTable({ staff }) {
  const [sort, setSort] = useState({ col: "billable", dir: "desc" });

  function toggle(col) {
    setSort((s) => ({ col, dir: s.col === col && s.dir === "desc" ? "asc" : "desc" }));
  }

  const sorted = [...staff].sort((a, b) => {
    const av = a[sort.col] ?? 0;
    const bv = b[sort.col] ?? 0;
    return sort.dir === "desc" ? bv - av : av - bv;
  });

  const totals = staff.reduce(
    (acc, s) => ({
      committed:   acc.committed   + (s.committed   ?? 0),
      billable:    acc.billable    + (s.billable    ?? 0),
      nonBillable: acc.nonBillable + (s.nonBillable ?? 0),
    }),
    { committed: 0, billable: 0, nonBillable: 0 }
  );

  const th = {
    padding: "12px 14px",
    fontSize: 11,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    cursor: "pointer",
    userSelect: "none",
    borderBottom: `1px solid ${C.border}`,
    whiteSpace: "nowrap",
    background: C.card,
  };
  const td = {
    padding: "12px 14px",
    fontSize: 13,
    color: C.pri,
    borderBottom: `1px solid ${C.border}40`,
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Staff Member</th>
            {[
              ["committed",   "Committed"],
              ["billable",    "Billable (h)"],
              ["nonBillable", "Non-Bill (h)"],
              ["gap",         "Gap"],
            ].map(([col, lbl]) => (
              <th key={col} style={{ ...th, textAlign: "right" }} onClick={() => toggle(col)}>
                {lbl}
                {sort.col === col && <SortIcon dir={sort.dir} />}
              </th>
            ))}
            <th style={{ ...th, textAlign: "center" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => {
            const util = s.committed > 0 ? (s.billable / s.committed) * 100 : 0;
            const gap = (s.billable ?? 0) - (s.committed ?? 0);
            const st = statusInfo(util);
            const baseBg = i % 2 === 0 ? "transparent" : C.surface;
            return (
              <tr
                key={i}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(61,142,240,0.05)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = baseBg; }}
                style={{ transition: "background 0.12s", background: baseBg }}
              >
                <td style={{ ...td, textAlign: "left" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 7,
                        background: gradientFor(s.staff ?? ""),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#fff",
                        flexShrink: 0,
                      }}
                    >
                      {initials(s.staff)}
                    </div>
                    <span style={{ fontWeight: 500 }}>{s.staff}</span>
                  </div>
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{(s.committed ?? 0).toFixed(1)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.teal }}>{(s.billable ?? 0).toFixed(1)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.orange }}>{(s.nonBillable ?? 0).toFixed(1)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: gap >= 0 ? C.green : C.red }}>
                  {gap >= 0 ? "+" : ""}{gap.toFixed(1)}
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      color: st.color,
                      background: st.bg,
                      padding: "3px 8px",
                      borderRadius: 20,
                      borderLeft: `3px solid ${st.color}`,
                      letterSpacing: 0.5,
                    }}
                  >
                    {st.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ background: C.card, fontWeight: 700 }}>
            <td style={{ ...td, color: C.sec, borderTop: `2px solid ${C.border}` }}>TOTALS</td>
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", borderTop: `2px solid ${C.border}` }}>{totals.committed.toFixed(1)}</td>
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.teal, borderTop: `2px solid ${C.border}` }}>{totals.billable.toFixed(1)}</td>
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.orange, borderTop: `2px solid ${C.border}` }}>{totals.nonBillable.toFixed(1)}</td>
            <td style={{ ...td, borderTop: `2px solid ${C.border}` }} colSpan={2} />
          </tr>
        </tfoot>
      </table>

      <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap" }}>
        {[
          { color: C.red,    label: "< 75% — Below Target" },
          { color: C.teal,   label: "75–95% — On Target" },
          { color: C.green,  label: "95–120% — Over Target" },
          { color: C.orange, label: "> 120% — Critical" },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.muted }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Projects breakdown: vertical bar chart + drill-down modal ────
// Hours-vs-average color bands. Computed over the FULL project list (not the
// top-15 slice) so toggling Show All doesn't redefine the bands.
const _PROJ_RED    = "#EF4444";  // below 0.5 × avg
const _PROJ_YELLOW = "#F0B947";  // average band
const _PROJ_GREEN  = "#10B981";  // above 1.5 × avg
function projectColor(hours, redT, greenT) {
  if (hours < redT)  return _PROJ_RED;
  if (hours > greenT) return _PROJ_GREEN;
  return _PROJ_YELLOW;
}

function ProjectDetailModal({ project, clientName, onClose }) {
  const [sortBy, setSortBy] = useState("date_desc");
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const entries = useMemo(() => {
    const arr = [...(project?.entries || [])];
    switch (sortBy) {
      case "date_asc":
        return arr.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      case "employee_asc":
        return arr.sort((a, b) => (a.employee || "").localeCompare(b.employee || ""));
      case "service_asc":
        return arr.sort((a, b) => (a.serviceCode || "").localeCompare(b.serviceCode || ""));
      case "hours_desc":
        return arr.sort((a, b) => (b.hours || 0) - (a.hours || 0));
      case "hours_asc":
        return arr.sort((a, b) => (a.hours || 0) - (b.hours || 0));
      case "billable_first":
        return arr.sort((a, b) => {
          if (a.billable === b.billable) return 0;
          return a.billable === "BILLABLE" ? -1 : 1;
        });
      case "date_desc":
      default:
        return arr.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    }
  }, [project, sortBy]);
  if (!project) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
        zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.surface, borderRadius: 12, borderLeft: "4px solid #4A8FE7",
          maxWidth: 1000, width: "100%", maxHeight: "85vh", overflow: "auto",
          padding: 24, border: `1px solid ${C.border}`,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.65)", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 4 }}>
              {clientName || ""}
            </div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#FFFFFF" }}>
              📊 {project.projectName}
            </h2>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.78)", marginTop: 6, fontFamily: "'DM Mono', monospace" }}>
              <span style={{ color: "#FFFFFF", fontWeight: 600 }}>{(project.hours ?? 0).toFixed(1)}h total</span> ·{" "}
              <span style={{ color: _PROJ_GREEN }}>{(project.billableHours ?? 0).toFixed(1)}h billable</span> ·{" "}
              <span style={{ color: "#F2895A" }}>{(project.nonBillableHours ?? 0).toFixed(1)}h non-bill</span> ·{" "}
              {entries.length} entries · {project.uniqueEmployeesCount ?? 0} employee{(project.uniqueEmployeesCount ?? 0) === 1 ? "" : "s"}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#FFFFFF",
              fontSize: 12, lineHeight: 1, padding: "6px 12px", borderRadius: 6, cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Sort bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 14,
            padding: "10px 14px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.78)", fontWeight: 600, letterSpacing: 0.3 }}>
            🔄 Sort by:
          </span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              background: "rgba(255,255,255,0.08)",
              color: "#FFFFFF",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              cursor: "pointer",
              outline: "none",
              minWidth: 200,
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            <option value="date_desc"      style={{ background: "#0F1F3A", color: "#FFFFFF" }}>📅 Date (newest first)</option>
            <option value="date_asc"       style={{ background: "#0F1F3A", color: "#FFFFFF" }}>📅 Date (oldest first)</option>
            <option value="employee_asc"   style={{ background: "#0F1F3A", color: "#FFFFFF" }}>👤 Employee (A → Z)</option>
            <option value="service_asc"    style={{ background: "#0F1F3A", color: "#FFFFFF" }}>🔧 Service Code (A → Z)</option>
            <option value="hours_desc"     style={{ background: "#0F1F3A", color: "#FFFFFF" }}>⏱ Hours (highest first)</option>
            <option value="hours_asc"      style={{ background: "#0F1F3A", color: "#FFFFFF" }}>⏱ Hours (lowest first)</option>
            <option value="billable_first" style={{ background: "#0F1F3A", color: "#FFFFFF" }}>💰 Billable first</option>
          </select>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
            {entries.length} entr{entries.length === 1 ? "y" : "ies"}
          </span>
        </div>

        <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: "#FFFFFF" }}>
            <thead>
              <tr style={{ background: "rgba(255,255,255,0.08)" }}>
                {[["Date", "left"], ["Employee", "left"], ["Service Code", "left"], ["Notes", "left"], ["Hours", "right"], ["Billable", "center"]].map(([h, a]) => (
                  <th key={h} style={{ padding: "10px 12px", textAlign: a, fontSize: 11, color: "#FFFFFF", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 24, textAlign: "center", color: "rgba(255,255,255,0.6)", fontStyle: "italic" }}>
                    No entries for this project.
                  </td>
                </tr>
              ) : entries.map((e, i) => (
                <tr key={i} style={{ borderTop: "1px solid rgba(255,255,255,0.08)", background: i % 2 ? "rgba(255,255,255,0.03)" : "transparent" }}>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap", color: "rgba(255,255,255,0.75)", fontFamily: "'DM Mono', monospace" }}>
                    {e.date || "—"}
                  </td>
                  <td style={{ padding: "8px 12px", color: "#FFFFFF", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {e.employee || "—"}
                  </td>
                  <td title={e.serviceCode || ""} style={{ padding: "8px 12px", color: "#C5B3FF", fontFamily: "'DM Mono', monospace", fontSize: 11, whiteSpace: "nowrap" }}>
                    {e.serviceCode || "—"}
                  </td>
                  <td style={{ padding: "8px 12px", color: "#FFFFFF" }}>
                    {e.notes || <span style={{ color: "rgba(255,255,255,0.5)" }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600, color: "#FFFFFF" }}>
                    {(e.hours ?? 0).toFixed(2)}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "center" }}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: 0.5, padding: "3px 8px", borderRadius: 20,
                      color: e.billable === "BILLABLE" ? _PROJ_GREEN : "#F2895A",
                      background: e.billable === "BILLABLE" ? "rgba(16,185,129,0.15)" : "rgba(242,137,90,0.15)",
                    }}>
                      {e.billable}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const _VIEW_MODES = {
  billable:    { label: "Billable Only",     title: "Billable Hours",     option: "💰 Billable Only" },
  nonBillable: { label: "Non-Billable Only", title: "Non-Billable Hours", option: "📋 Non-Billable Only" },
  total:       { label: "Total (Both)",      title: "Total Hours",        option: "📊 Total (Both)" },
};

function _projectValueFor(p, mode) {
  if (mode === "billable")    return Number(p.billableHours    || 0);
  if (mode === "nonBillable") return Number(p.nonBillableHours || 0);
  return Number(p.hours || 0);
}

function ProjectsBreakdownChart({ projects, clientName, loading }) {
  const [selected, setSelected]   = useState(null);
  const [showAll, setShowAll]     = useState(false);
  const [viewMode, setViewMode]   = useState("billable");
  const list   = Array.isArray(projects) ? projects : [];

  // Mode-specific list: each project gets a displayValue per the active view,
  // zero-value projects are dropped, and the list is re-sorted by value desc.
  // Thresholds and totals are recomputed from this slice so the legend,
  // header summary, and bar colors all stay self-consistent per view.
  const processed = useMemo(() => {
    return list
      .map((p) => ({ ...p, displayValue: _projectValueFor(p, viewMode) }))
      .filter((p) => p.displayValue > 0)
      .sort((a, b) => b.displayValue - a.displayValue);
  }, [list, viewMode]);
  const totalShown = useMemo(
    () => processed.reduce((s, p) => s + p.displayValue, 0),
    [processed],
  );
  const avgHours = processed.length ? totalShown / processed.length : 0;
  const redT     = avgHours * 0.5;
  const greenT   = avgHours * 1.5;
  const shown    = showAll ? processed : processed.slice(0, 15);
  const viewMeta = _VIEW_MODES[viewMode] || _VIEW_MODES.billable;

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderLeft: "4px solid #4A8FE7", borderRadius: 12, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#FFFFFF", textTransform: "uppercase", letterSpacing: 1 }}>
          📊 Projects · {viewMeta.title}
        </h3>
        {!loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>👁 View:</span>
            <select
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value)}
              style={{
                background: "rgba(255,255,255,0.08)",
                color: "#FFFFFF",
                border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 12,
                cursor: "pointer",
                outline: "none",
                minWidth: 180,
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              <option value="billable"    style={{ background: "#0F1F3A", color: "#FFFFFF" }}>{_VIEW_MODES.billable.option}</option>
              <option value="nonBillable" style={{ background: "#0F1F3A", color: "#FFFFFF" }}>{_VIEW_MODES.nonBillable.option}</option>
              <option value="total"       style={{ background: "#0F1F3A", color: "#FFFFFF" }}>{_VIEW_MODES.total.option}</option>
            </select>
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", fontStyle: "italic", marginBottom: 12 }}>
        Click any bar to see every timesheet entry under that project (the modal always shows billable + non-billable rows). Color bands are vs. project average ({avgHours.toFixed(1)}h) in this view.
      </div>

      {/* Color-band legend */}
      {!loading && processed.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 16,
            padding: "10px 14px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            marginBottom: 14,
            fontSize: 12,
            color: "#FFFFFF",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 14, height: 14, background: _PROJ_RED, borderRadius: 3, flexShrink: 0 }} />
            <span>Below average · &lt; {redT.toFixed(1)}h</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 14, height: 14, background: _PROJ_YELLOW, borderRadius: 3, flexShrink: 0 }} />
            <span>Average · {redT.toFixed(1)}h – {greenT.toFixed(1)}h</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 14, height: 14, background: _PROJ_GREEN, borderRadius: 3, flexShrink: 0 }} />
            <span>Above average · &gt; {greenT.toFixed(1)}h</span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="kpi-skeleton" style={{ height: 320 }} />
      ) : list.length === 0 ? (
        <div style={{ padding: "24px 0", color: "rgba(255,255,255,0.6)", fontSize: 13, fontStyle: "italic", textAlign: "center" }}>
          No project hours logged for this client in the active period.
        </div>
      ) : processed.length === 0 ? (
        <div style={{ padding: "24px 0", color: "rgba(255,255,255,0.6)", fontSize: 13, fontStyle: "italic", textAlign: "center" }}>
          No {viewMeta.label.toLowerCase()} hours logged for any project in this period.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={360}>
          <BarChart
            data={shown}
            margin={{ top: 20, right: 16, bottom: 90, left: 8 }}
            onClick={(e) => {
              // Chart-level fallback — fires when the click lands anywhere
              // along the column's x-band, even outside the colored bar.
              const p = e?.activePayload?.[0]?.payload;
              if (p) setSelected(p);
            }}
            style={{ cursor: "pointer" }}
          >
            <CartesianGrid stroke="rgba(255,255,255,0.1)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="projectName"
              tick={{ fill: "#FFFFFF", fontSize: 10 }}
              axisLine={{ stroke: "rgba(255,255,255,0.2)" }}
              tickLine={false}
              angle={-45}
              textAnchor="end"
              height={90}
              interval={0}
            />
            <YAxis
              tick={{ fill: "#FFFFFF", fontSize: 10 }}
              axisLine={{ stroke: "rgba(255,255,255,0.2)" }}
              tickLine={false}
              label={{ value: "Hours", angle: -90, position: "insideLeft", fill: "#FFFFFF", fontSize: 11 }}
            />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.08)" }}
              contentStyle={{
                background: "rgba(0,0,0,0.9)",
                border: "1px solid rgba(255,255,255,0.2)",
                borderRadius: 6,
                fontSize: 11,
                padding: "8px 12px",
                color: "#FFFFFF",
              }}
              labelStyle={{ color: "#FFFFFF", fontWeight: 700, marginBottom: 4 }}
              itemStyle={{ color: "#FFFFFF" }}
              formatter={(value, _name, props) => {
                const p = props.payload || {};
                return [
                  `${Number(value).toFixed(1)}h · ${(p.billableHours ?? 0).toFixed(1)}h bill / ${(p.nonBillableHours ?? 0).toFixed(1)}h non-bill · ${p.entriesCount ?? 0} entries`,
                  viewMeta.title,
                ];
              }}
            />
            <Bar
              dataKey="displayValue"
              radius={[4, 4, 0, 0]}
              maxBarSize={48}
              onClick={(payload) => {
                // Recharts hands the bar's data as the first arg when this
                // prop is on <Bar>. Fires on direct hits on the colored
                // segment; chart-level onClick covers everything else.
                if (payload) setSelected(payload);
              }}
              style={{ cursor: "pointer" }}
            >
              {shown.map((entry, i) => (
                <Cell
                  key={i}
                  fill={projectColor(entry.displayValue, redT, greenT)}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelected(entry)}
                />
              ))}
              <LabelList
                dataKey="displayValue"
                position="top"
                formatter={(v) => `${Number(v).toFixed(1)}h`}
                style={{ fill: "#FFFFFF", fontSize: 10, fontFamily: "'DM Mono', monospace" }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
      {!loading && processed.length > 0 && (
        <div
          style={{
            marginTop: 12,
            padding: "8px 14px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            fontSize: 11,
            color: "rgba(255,255,255,0.78)",
            fontFamily: "'DM Mono', monospace",
          }}
        >
          Showing {processed.length} project{processed.length === 1 ? "" : "s"} with {viewMeta.label.toLowerCase()} hours · {totalShown.toFixed(1)}h total
        </div>
      )}
      {processed.length > 15 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          style={{
            marginTop: 12, background: "transparent", border: "1px solid rgba(255,255,255,0.2)",
            color: "#FFFFFF", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12,
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          {showAll ? "Show top 15" : `Show all ${processed.length} projects`}
        </button>
      )}
      {selected && (
        <ProjectDetailModal project={selected} clientName={clientName} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────
export default function ClientDashboard({ clientName, onBack, onContextUpdate, onOpenDepartureAnalysis }) {
  const [period, setPeriod] = useState("monthly");
  const [customRange, setCustomRange]   = useState(_defaultCustomRange);
  const [pendingCustom, setPendingCustom] = useState(_defaultCustomRange);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [trend, setTrend] = useState([]);
  const [trendLoading, setTrendLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const trendCacheRef = useRef({});
  const mainAbortRef  = useRef(null);
  const trendAbortRef = useRef(null);

  const [lastRefreshed, setLastRefreshed] = useState(null);

  const fetchMain = useCallback((silent = false) => {
    if (mainAbortRef.current) mainAbortRef.current.abort();
    const ctrl = new AbortController();
    mainAbortRef.current = ctrl;
    const p = PERIODS.find((pp) => pp.key === period) ?? PERIODS[2];
    if (period === "custom" && (!customRange.from || !customRange.to)) return;
    if (!silent) setLoading(true);
    const url = period === "custom"
      ? `/api/client/${encodeURIComponent(clientName)}/custom?from=${customRange.from}&to=${customRange.to}`
      : `/api/client/${encodeURIComponent(clientName)}/${p.endpoint}`;
    authFetch(url, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setData(d);
        setLastRefreshed(new Date());
        if (!silent) setLoading(false);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setData({ summary: {}, staff: [] });
        if (!silent) setLoading(false);
      });
  }, [clientName, period, customRange.from, customRange.to]);

  const isLive = period === "today";
  const refreshSilent = useCallback(() => fetchMain(true), [fetchMain]);
  const tickNow = useAutoRefresh(refreshSilent, isLive, lastRefreshed);

  const fetchTrend = useCallback(
    (bustCache = false) => {
      const cacheKey = clientName;
      if (!bustCache && trendCacheRef.current[cacheKey]) {
        setTrend(trendCacheRef.current[cacheKey]);
        setTrendLoading(false);
        return;
      }
      if (trendAbortRef.current) trendAbortRef.current.abort();
      const ctrl = new AbortController();
      trendAbortRef.current = ctrl;
      setTrendLoading(true);
      authFetch(`/api/client/${encodeURIComponent(clientName)}/trend`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => {
          if (ctrl.signal.aborted) return;
          const t = d.trend ?? d.monthly ?? [];
          trendCacheRef.current[cacheKey] = t;
          setTrend(t);
          setTrendLoading(false);
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          setTrendLoading(false);
        });
    },
    [clientName]
  );

  useEffect(() => {
    fetchMain();
    return () => {
      if (mainAbortRef.current) mainAbortRef.current.abort();
    };
  }, [fetchMain]);
  useEffect(() => {
    fetchTrend();
    return () => {
      if (trendAbortRef.current) trendAbortRef.current.abort();
    };
  }, [fetchTrend]);

  // Push rich context to App so the chatbot can answer accurately
  useEffect(() => {
    if (!data || !onContextUpdate) return;
    const summary = data.summary ?? {};
    const staffObj = {};
    (data.staff ?? []).forEach((s) => {
      staffObj[s.staff] = {
        billable:    s.billable ?? 0,
        nonBillable: s.nonBillable ?? 0,
        committed:   s.committed ?? 0,
        notes:       s.notes ?? [],
      };
    });
    const utilRate = summary.overallEfficiency ?? 0;
    const targetCtx = summary.isProrated
      ? `Target ${(summary.targetHours ?? 0).toFixed(1)}h (pro-rated · full month ${(summary.targetHoursFull ?? 0).toFixed(1)}h, day ${summary.workingDaysElapsed}/${summary.workingDaysTotal})`
      : `Target ${(summary.targetHours ?? 0).toFixed(1)}h`;
    const ctx = `Client: ${clientName} — ${data.period ?? ""}
Total: ${targetCtx} | Billable ${summary.totalBillable ?? 0}h | Non-Bill ${summary.totalNonBillable ?? 0}h | Util ${utilRate}%

STAFF DETAILS:
${Object.entries(staffObj).map(([name, v]) => {
  const total = v.billable + v.nonBillable;
  const rate = total > 0 ? Math.round((v.billable / total) * 100) : 0;
  const notesStr = v.notes?.length
    ? `\n   Work done: ${v.notes.slice(0, 3).join(" | ")}`
    : "";
  return `• ${name}: ${v.billable}h billable, ${v.nonBillable}h non-billable, ${rate}% util${notesStr}`;
}).join("\n")}`;
    onContextUpdate(ctx);
  }, [data, clientName, onContextUpdate]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await authFetch(`/api/clear-cache`, { method: "POST" });
    } catch (_) {}
    delete trendCacheRef.current[clientName];
    fetchTrend(true);
    fetchMain();
    setTimeout(() => setRefreshing(false), 800);
  }, [clientName, fetchMain, fetchTrend]);

  const summary = data?.summary ?? {};

  const periodLabel = period === "custom"
    ? (data?.period || `${customRange.from} – ${customRange.to}`)
    : (PERIODS.find((p) => p.key === period)?.label ?? "");

  const staff = useMemo(
    () => (data?.staff ?? []).map((s) => ({
      ...s,
      gap: (s.billable ?? 0) - (s.committed ?? 0),
    })),
    [data]
  );

  const totalHours = (summary.totalBillable ?? 0) + (summary.totalNonBillable ?? 0);

  const staffHours = useMemo(
    () => staff.map((s) => ({
      name: (s.staff ?? "").split(" ")[0],
      Billable: s.billable ?? 0,
      "Non-Billable": s.nonBillable ?? 0,
    })),
    [staff]
  );

  const trendChart = useMemo(
    () => trend.map((t) => ({
      month: t.month ?? t.date ?? "",
      Hours: t.hours ?? t.totalBillable ?? t.billable ?? 0,
    })),
    [trend]
  );

  const hoursBreakdown = useMemo(
    () => ({
      billable:    summary.totalBillable    ?? 0,
      nonBillable: summary.totalNonBillable ?? 0,
      total:       totalHours,
      // Use the pro-rated client target (estHrs scaled to working days
      // elapsed), not the legacy totalCommitted which was just total hours.
      target:      summary.targetHours      ?? 0,
    }),
    [summary.totalBillable, summary.totalNonBillable, summary.targetHours, totalHours]
  );

  const agingSummary   = data?.delaysAgeSummary ?? null;
  const delaysByDay    = data?.delaysByDay ?? [];
  const agingChart     = useMemo(() => buildAgingChartData(delaysByDay), [delaysByDay]);
  const agingTotalOpen = (agingSummary?.totalOpen ?? 0);
  const agingHasAnyData = useMemo(
    () => agingChart.some((d) => (d.Completed + d.Fresh + d.Aging + d.Overdue) > 0),
    [agingChart],
  );
  const [selectedDay, setSelectedDay] = useState(null);
  // onClick on individual <Bar> in a stacked chart fires only when the small
  // colored segment is hit and Recharts intermittently drops the event near
  // segment borders. Parent <BarChart> uses the chart's hit-test against the
  // nearest x-value, so any click anywhere in the chart area resolves.
  const handleBarChartClick = useCallback((chartData) => {
    console.log("[delay-chart] click event activePayload:", chartData?.activePayload);
    const p = chartData?.activePayload?.[0]?.payload;
    console.log("[delay-chart] day data:", p);
    if (p) {
      console.log("[delay-chart] setSelectedDay called with:", p);
      setSelectedDay(p);
    }
  }, []);

  // Bar-level click as a fallback. Recharts 3.x sometimes drops the
  // BarChart.onClick activePayload on stacked-bar clicks.
  const handleBarSegmentClick = useCallback((entry) => {
    const p = entry?.payload || entry;
    if (p && (p.allRows || p.fullDate || p.day)) {
      console.log("[delay-chart] bar-segment click payload:", p);
      setSelectedDay(p);
    }
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      {/* Header */}
      <div
        style={{
          background: "linear-gradient(180deg,#0e2040 0%,#0b1929 100%)",
          borderBottom: `1px solid ${C.border}`,
          padding: "16px 32px",
          display: "flex",
          alignItems: "center",
          gap: 16,
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
            padding: "7px 14px",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "'DM Sans', sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          ← Back
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: gradientFor(clientName ?? ""),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              fontWeight: 700,
              color: "#fff",
            }}
          >
            {initials(clientName)}
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.pri }}>{clientName}</div>
            <div style={{ fontSize: 12, color: C.sec }}>Client Performance Dashboard</div>
          </div>
        </div>

        {/* Departure analysis entry */}
        {onOpenDepartureAnalysis && (
          <button
            onClick={() => onOpenDepartureAnalysis(
              (clientName || "").toLowerCase().replace(/\s+/g, "-")
            )}
            style={{
              background: "linear-gradient(135deg, rgba(124,58,237,0.18), rgba(59,130,246,0.12))",
              border: "1px solid #7C3AED55",
              color: "#A78BFA",
              borderRadius: 8,
              padding: "7px 14px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "'DM Sans', sans-serif",
              letterSpacing: 0.3,
            }}
            title="AI root-cause analysis using last 6 months of data"
          >
            📉 View Departure Analysis
          </button>
        )}

        {/* Period buttons */}
        <div style={{ display: "flex", gap: 4, background: C.card, borderRadius: 8, padding: 3, border: `1px solid ${C.border}` }}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "'DM Sans', sans-serif",
                transition: "all 0.15s",
                background: period === p.key ? (p.key === "custom" ? "#F2895A" : C.blue) : "transparent",
                color: period === p.key ? "#fff" : C.sec,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {period === "custom" && (
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "6px 10px",
            }}
          >
            <input
              type="date"
              value={pendingCustom.from || ""}
              max={pendingCustom.to || undefined}
              onChange={(e) => setPendingCustom((p) => ({ ...p, from: e.target.value }))}
              style={{
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                color: C.pri,
                padding: "4px 8px",
                fontSize: 12,
                fontFamily: "'DM Mono', monospace",
              }}
            />
            <span style={{ color: C.muted, fontSize: 11 }}>to</span>
            <input
              type="date"
              value={pendingCustom.to || ""}
              min={pendingCustom.from || undefined}
              onChange={(e) => setPendingCustom((p) => ({ ...p, to: e.target.value }))}
              style={{
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                color: C.pri,
                padding: "4px 8px",
                fontSize: 12,
                fontFamily: "'DM Mono', monospace",
              }}
            />
            <button
              onClick={() => {
                if (pendingCustom.from && pendingCustom.to && pendingCustom.from <= pendingCustom.to) {
                  setCustomRange(pendingCustom);
                }
              }}
              disabled={
                !pendingCustom.from || !pendingCustom.to ||
                pendingCustom.from > pendingCustom.to ||
                (pendingCustom.from === customRange.from && pendingCustom.to === customRange.to)
              }
              style={{
                background: "#F2895A",
                border: "none",
                color: "#fff",
                padding: "5px 12px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.4,
                opacity:
                  !pendingCustom.from || !pendingCustom.to ||
                  pendingCustom.from > pendingCustom.to ||
                  (pendingCustom.from === customRange.from && pendingCustom.to === customRange.to)
                    ? 0.5 : 1,
              }}
            >
              APPLY
            </button>
          </div>
        )}

        {/* Refresh button */}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          title="Clear cache and refresh"
          style={{
            background: "transparent",
            border: `1px solid ${C.border}`,
            color: C.sec,
            borderRadius: 8,
            padding: "7px 12px",
            cursor: "pointer",
            fontSize: 16,
            fontFamily: "'DM Sans', sans-serif",
            transition: "all 0.15s",
            opacity: refreshing ? 0.5 : 1,
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <span
            style={{
              display: "inline-block",
              animation: refreshing ? "spin 0.8s linear infinite" : "none",
            }}
          >
            ↻
          </span>
        </button>

        <LiveIndicator
          lastRefreshed={lastRefreshed}
          now={tickNow}
          isLive={isLive}
          onRefresh={() => fetchMain(false)}
        />

        <div style={{ textAlign: "right", marginLeft: "auto" }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              background: "linear-gradient(135deg,#00c896,#3d8ef0)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            MoneyPenny LLC
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>{periodLabel} · {today}</div>
          {summary.isProrated && summary.workingDaysTotal > 0 && (
            <div
              style={{
                fontSize: 10,
                color: C.teal,
                fontFamily: "'DM Mono', monospace",
                marginTop: 2,
                letterSpacing: 0.3,
              }}
              title={`Target pro-rated by working days elapsed (${summary.periodStart} → ${summary.periodEnd})`}
            >
              Day {summary.workingDaysElapsed}/{summary.workingDaysTotal} · target {(summary.targetHours ?? 0).toFixed(1)}h / {(summary.targetHoursFull ?? 0).toFixed(1)}h full
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
        {/* KPIs (skeleton or real) */}
        {loading ? (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {[1, 2, 3, 4, 5].map((i) => <KpiSkeleton key={i} />)}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <KpiCard
              label="Target Hours"
              value={summary.targetHours}
              color={C.blue}
              sublabel={
                summary.isProrated && summary.workingDaysTotal > 0
                  ? `Day ${summary.workingDaysElapsed}/${summary.workingDaysTotal} · ${(summary.targetHoursFull ?? 0).toFixed(1)}h full`
                  : (summary.targetHoursFull > 0 && summary.targetHoursFull !== summary.targetHours
                      ? `${(summary.targetHoursFull ?? 0).toFixed(1)}h full`
                      : "pro-rated to today")
              }
            />
            <KpiCard label="Total Billable"  value={summary.totalBillable}  color={C.teal} />
            <KpiCard label="Non-Billable" value={summary.totalNonBillable} color={C.orange} />
            <KpiCard label="Total Hours"  value={totalHours}                color={C.purple} />
            <KpiCard
              label="Staff Count"
              value={staff.length}
              color={C.blue}
              suffix=""
              sublabel="active staff"
            />
          </div>
        )}

        {/* Projects breakdown — bars per project, click for entries modal */}
        <ProjectsBreakdownChart
          projects={data?.projectsBreakdown}
          clientName={clientName}
          loading={loading}
        />

        {/* Charts grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {/* Monthly trend (independent loader) */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
              Monthly Hours Trend
            </div>
            {trendLoading ? (
              <div
                style={{
                  height: 220,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div className="spinner" style={{ width: 24, height: 24, borderWidth: 2 }} />
                <div style={{ fontSize: 12, color: C.muted }}>Loading 6-month trend…</div>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={trendChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<DarkTooltip />} />
                  <Line type="monotone" dataKey="Hours" stroke={C.blue} strokeWidth={2} dot={{ fill: C.blue, r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Hours by Staff horizontal bar */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
              Hours by Staff
            </div>
            {loading ? (
              <div style={{ height: 220 }} className="kpi-skeleton" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={staffHours} layout="vertical" barGap={4} barCategoryGap="30%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                  <XAxis type="number" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis dataKey="name" type="category" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={80} />
                  <Tooltip content={<DarkTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11, color: C.sec }} />
                  <Bar dataKey="Billable" fill={C.blue} radius={[0, 4, 4, 0]} />
                  <Bar dataKey="Non-Billable" fill={C.red} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Open Questions & Delays — Aging Report (from parent team's EOD sheet) */}
          {/* Spans both columns — third card on a 2-wide grid would otherwise
              sit alone in the left column. */}
          <div style={{ gridColumn: "1 / -1", background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
              Open Questions & Delays — Aging Report
            </div>
            {loading ? (
              <div style={{ height: 220 }} className="kpi-skeleton" />
            ) : !data?.parentTeamId ? (
              <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: C.orange, fontSize: 13, textAlign: "center", padding: 16, lineHeight: 1.5 }}>
                Client not mapped to any team — contact admin to add it to TEAM_CLIENTS.
              </div>
            ) : !data?.hasEodSheet ? (
              <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: 16 }}>
                No EOD sheet configured for {data?.parentTeamId}.
              </div>
            ) : agingTotalOpen === 0 && !agingHasAnyData ? (
              <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: C.green, fontSize: 14, fontWeight: 600, textAlign: "center", padding: 16 }}>
                ✓ No open delays in this period
              </div>
            ) : (
              <>
                <AgingSummaryRow summary={agingSummary} />
                {agingSummary?.oldestDays > 0 && (
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
                    Oldest open query: <span style={{ color: C.red, fontWeight: 600 }}>{agingSummary.oldestDays} day{agingSummary.oldestDays === 1 ? "" : "s"}</span>
                    {agingSummary.oldestQuery && (
                      <span style={{ fontStyle: "italic" }}> — “{agingSummary.oldestQuery.slice(0, 80)}{agingSummary.oldestQuery.length > 80 ? "…" : ""}”</span>
                    )}
                  </div>
                )}
                <AgingLegend />
                <ResponsiveContainer width="100%" height={170}>
                  <BarChart
                    data={agingChart}
                    margin={{ top: 4, right: 8, left: -18, bottom: 36 }}
                    onClick={handleBarChartClick}
                    maxBarSize={40}
                    style={{ cursor: "pointer" }}
                  >
                    <CartesianGrid vertical={false} stroke={C.border} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="day"
                      tick={{ fill: C.sec, fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      interval={0}
                      angle={-45}
                      textAnchor="end"
                      height={50}
                    />
                    <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={<AgingTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                    <Bar dataKey="Completed" stackId="a" fill="#3DC58B" onClick={handleBarSegmentClick} cursor="pointer" />
                    <Bar dataKey="Fresh"     stackId="a" fill="#F0B947" onClick={handleBarSegmentClick} cursor="pointer" />
                    <Bar dataKey="Aging"     stackId="a" fill="#F2895A" onClick={handleBarSegmentClick} cursor="pointer" />
                    <Bar dataKey="Overdue"   stackId="a" fill="#E25C5C" radius={[4, 4, 0, 0]} onClick={handleBarSegmentClick} cursor="pointer" />
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 6, textAlign: "center", letterSpacing: 0.3 }}>
                  Hover for summary · Click any bar for full details
                </div>
              </>
            )}
          </div>

          {/* Hours Breakdown Summary */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 22px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 20 }}>
              Hours Breakdown Summary
            </div>
            {loading ? (
              <div style={{ height: 200 }} className="kpi-skeleton" />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {[
                  { label: "Target",       value: hoursBreakdown.target,      color: C.blue },
                  { label: "Billable",     value: hoursBreakdown.billable,    color: C.teal },
                  { label: "Non-Billable", value: hoursBreakdown.nonBillable, color: C.orange },
                  { label: "Total Logged", value: hoursBreakdown.total,       color: C.purple },
                ].map(({ label, value, color }) => {
                  const pct = hoursBreakdown.total > 0 ? (value / hoursBreakdown.total) * 100 : 0;
                  return (
                    <div key={label}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}>
                        <span style={{ color: C.sec }}>{label}</span>
                        <span style={{ color, fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>
                          {value.toFixed(1)}h
                          {label !== "Total Logged" && label !== "Target" && (
                            <span style={{ color: C.muted, fontWeight: 400, marginLeft: 6 }}>
                              ({pct.toFixed(0)}%)
                            </span>
                          )}
                        </span>
                      </div>
                      <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.min(pct, 100)}%`,
                            background: color,
                            borderRadius: 3,
                            transition: "width 0.4s ease",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Staff Performance Table */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
            Staff Performance
          </div>
          {loading ? (
            <div style={{ height: 200 }} className="kpi-skeleton" />
          ) : (
            <StaffTable staff={staff} />
          )}
        </div>
      </div>
      <DelayDetailModal
        day={selectedDay}
        clientName={clientName}
        onClose={() => setSelectedDay(null)}
      />
    </div>
  );
}
