import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { C, API_BASE, authFetch } from "../config";
import { LiveIndicator, useAutoRefresh, timeAgo, formatTimeIST } from "../components/LiveIndicator";
import DelayDetailModal from "../components/DelayDetailModal";
import BarDetailModal from "../components/BarDetailModal";
import SimpleBreakdownModal from "../components/SimpleBreakdownModal";
import PerformanceReasonModal from "../components/PerformanceReasonModal";
import WeeklyReviewSection from "../components/WeeklyReviewSection";
import WeeklyChecklistSection from "../components/WeeklyChecklistSection";
import BodEodReview from "../components/BodEodReview";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart,
  Line,
  Cell,
  LabelList,
} from "recharts";

const API = API_BASE;

const PERIODS = [
  { key: "today",   label: "Today" },
  { key: "weekly",  label: "This Week" },
  { key: "monthly", label: "This Month" },
  { key: "custom",  label: "📅 Custom Range" },
  { key: "review",  label: "📋 Weekly Review" },
  { key: "bodEod",  label: "📊 BOD/EOD Review" },
];

// Default custom range = last 7 days ending today.
function _defaultCustomRange() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(start), to: fmt(today) };
}

// Status thresholds (updated 2026-06-18): CRITICAL means BADLY BEHIND, not
// over-performing. Exceeding target is positive (EXCEEDED), never red.
//   <50%       → CRITICAL      (red — badly behind)
//   50–<80%    → BELOW TARGET  (orange)
//   80–100%    → ON TRACK      (green)
//   100–120%   → ABOVE TARGET  (blue)
//   >120%      → EXCEEDED      (purple — positive overage)
function statusInfo(pct) {
  if (pct < 50)   return { label: "CRITICAL",     color: C.red,    bg: C.statusRed };
  if (pct < 80)   return { label: "BELOW TARGET", color: C.orange, bg: C.statusOrange };
  if (pct <= 100) return { label: "ON TRACK",     color: C.green,  bg: C.statusGreen };
  if (pct <= 120) return { label: "ABOVE TARGET", color: C.blue,   bg: C.statusBlue };
  return { label: "EXCEEDED", color: C.purple, bg: C.statusPurple };
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
      // New per-day fields from compute_delays_aging — feed the rich tooltip
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
          {p.name}: <strong>{typeof p.value === "number" ? p.value.toFixed(2) : p.value}</strong>
        </div>
      ))}
    </div>
  );
}

// ── Animated count-up ──────────────────────────────────────────────
function useCountUp(target, duration = 900) {
  const [value, setValue] = useState(0);
  const startRef = useRef(null);
  const fromRef = useRef(0);
  const targetRef = useRef(target ?? 0);

  useEffect(() => {
    if (typeof target !== "number" || Number.isNaN(target)) {
      setValue(0);
      return undefined;
    }
    fromRef.current = value;
    targetRef.current = target;
    startRef.current = null;
    let raf;
    const step = (ts) => {
      if (startRef.current === null) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const t = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = fromRef.current + (targetRef.current - fromRef.current) * eased;
      setValue(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return value;
}

function KpiCard({ label, value, color, suffix = "h", decimals = 1, sub, onClick }) {
  const animated = useCountUp(typeof value === "number" ? value : 0);
  const display = typeof value === "number"
    ? (decimals === 0 ? Math.round(animated).toString() : animated.toFixed(decimals))
    : "—";
  // When `onClick` is provided, the card lifts on hover and renders a small
  // "CLICK FOR DETAILS →" hint in the bottom-right so the affordance is
  // discoverable without changing the static visual for non-clickable cards.
  const clickable = typeof onClick === "function";
  return (
    <div
      onClick={clickable ? onClick : undefined}
      onMouseEnter={(e) => {
        if (!clickable) return;
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = `0 8px 24px rgba(0,0,0,0.4), inset 0 0 24px ${color}1A`;
        e.currentTarget.style.borderColor = `${color}55`;
      }}
      onMouseLeave={(e) => {
        if (!clickable) return;
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = `0 2px 8px rgba(0,0,0,0.25), inset 0 0 24px ${color}0F`;
        e.currentTarget.style.borderColor = C.border;
      }}
      style={{
        background: `linear-gradient(180deg, ${C.card} 0%, ${C.surface} 100%)`,
        border: `1px solid ${C.border}`,
        borderTop: `3px solid ${color}`,
        borderRadius: 12,
        padding: "22px 24px",
        flex: "1 1 200px",
        minWidth: 180,
        boxShadow: `0 2px 8px rgba(0,0,0,0.25), inset 0 0 24px ${color}0F`,
        position: "relative",
        overflow: "hidden",
        cursor: clickable ? "pointer" : "default",
        transition: "transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: C.muted,
          textTransform: "uppercase",
          letterSpacing: 1.2,
          marginBottom: 14,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 42,
          fontWeight: 700,
          color,
          fontFamily: "'DM Mono', monospace",
          letterSpacing: -1,
          lineHeight: 1,
        }}
      >
        {display}
        {suffix && (
          <span style={{ fontSize: 18, fontWeight: 400, marginLeft: 4, color: C.sec }}>{suffix}</span>
        )}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>
          {sub}
        </div>
      )}
      {clickable && (
        <div
          style={{
            position: "absolute",
            bottom: 6,
            right: 10,
            fontSize: 9,
            color: "rgba(255,255,255,0.40)",
            fontWeight: 700,
            letterSpacing: 0.5,
            pointerEvents: "none",
          }}
        >
          CLICK FOR DETAILS →
        </div>
      )}
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div
      className="kpi-skeleton"
      style={{ flex: "1 1 200px", minWidth: 180, height: 124, borderRadius: 12 }}
    />
  );
}

// ── First-load progress bar ────────────────────────────────────────
function LoadingScreen({ teamName }) {
  return (
    <div style={{ padding: "60px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 13, color: C.sec, marginBottom: 20, fontWeight: 600 }}>
        Loading {teamName} data from Timesheets API...
      </div>
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          margin: "0 auto",
          height: 4,
          background: C.card,
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            background: `linear-gradient(90deg, ${C.teal}, ${C.blue})`,
            borderRadius: 2,
            animation: "progressBar 25s linear forwards",
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 12 }}>
        First load: ~25 sec · Subsequent loads: instant (cached)
      </div>
    </div>
  );
}

// ── Perf table ─────────────────────────────────────────────────────
function SortIcon({ dir }) {
  return <span style={{ marginLeft: 4, opacity: 0.5, fontSize: 10 }}>{dir === "asc" ? "▲" : "▼"}</span>;
}

function PerfTable({ orgs, onRowClick }) {
  const [sort, setSort] = useState({ col: "billable", dir: "desc" });
  const [query, setQuery] = useState("");

  function toggle(col) {
    setSort((s) => ({ col, dir: s.col === col && s.dir === "desc" ? "asc" : "desc" }));
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return q ? orgs.filter((o) => (o.name ?? "").toLowerCase().includes(q)) : orgs;
  }, [orgs, query]);

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sort.col] ?? 0;
    const bv = b[sort.col] ?? 0;
    return sort.dir === "desc" ? bv - av : av - bv;
  });

  const totals = orgs.reduce(
    (acc, o) => ({
      committed: acc.committed + (o.committed ?? 0),
      billable:  acc.billable  + (o.billable  ?? 0),
      delays:    acc.delays    + (o.delays    ?? 0),
    }),
    { committed: 0, billable: 0, delays: 0 }
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
    borderBottom: `1px solid rgba(255,255,255,0.05)`,
  };

  return (
    <div>
      <div style={{ marginBottom: 12, position: "relative", maxWidth: 320 }}>
        <span
          style={{
            position: "absolute",
            left: 12,
            top: "50%",
            transform: "translateY(-50%)",
            color: C.muted,
            fontSize: 13,
            pointerEvents: "none",
          }}
        >
          🔍
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search organizations…"
          style={{
            width: "100%",
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "8px 12px 8px 34px",
            color: C.pri,
            fontSize: 13,
            outline: "none",
            fontFamily: "'DM Sans', sans-serif",
          }}
        />
      </div>

      <div style={{ overflowX: "auto", maxHeight: 480, overflowY: "auto", borderRadius: 8, border: `1px solid ${C.border}` }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Organization</th>
            {[
              ["gap",        "Gap"],
              ["committed",  "Committed"],
              ["billable",   "Billable"],
              ["delays",     "Delays"],
            ].map(([col, lbl]) => (
              <th key={col} style={{ ...th, textAlign: "right" }} onClick={() => toggle(col)}>
                {lbl}
                {sort.col === col && <SortIcon dir={sort.dir} />}
              </th>
            ))}
            <th style={{ ...th, textAlign: "center" }}>Timezone</th>
            <th style={{ ...th, textAlign: "left" }}>Next Meeting</th>
            <th style={{ ...th, textAlign: "center" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((o, i) => {
            const eff = o.efficiency ?? 0;
            const gap = o.gap ?? 0;
            const committed = o.committed ?? 0;
            const isPlaceholder = !!o.isPlaceholder;
            const isInternalOther = !!o.isInternalOther;
            const st = isPlaceholder
              ? { label: "PLACEHOLDER", color: C.muted, bg: "transparent" }
              : isInternalOther
                ? { label: "OTHER", color: C.muted, bg: "transparent" }
                : statusInfo(eff);
            const baseBg = i % 2 === 0 ? "transparent" : C.surface;
            const delays = o.delays ?? 0;
            // Click is enabled whenever the org actually has timesheet rows
            // behind it — Internal/Other has no `committed` but still has
            // entries we want to show.
            const hasEntries = Array.isArray(o.entries) && o.entries.length > 0;
            const clickable  = onRowClick && !isPlaceholder && hasEntries;
            return (
              <tr
                key={i}
                style={{ transition: "background 0.12s", background: baseBg, cursor: clickable ? "pointer" : "default" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(61,142,240,0.05)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = baseBg; }}
                onClick={() => { if (clickable) onRowClick(o); }}
              >
                <td style={{ ...td, textAlign: "left" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 7,
                        background: gradientFor(o.name ?? ""),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#fff",
                        flexShrink: 0,
                        opacity: isPlaceholder ? 0.5 : 1,
                      }}
                    >
                      {initials(o.name ?? "?")}
                    </div>
                    <span style={{ fontWeight: 500, color: isPlaceholder ? C.muted : C.pri }}>{o.name}</span>
                  </div>
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: committed > 0 ? (gap >= 0 ? C.green : C.red) : C.muted }}>
                  {committed > 0 ? `${gap >= 0 ? "+" : ""}${gap.toFixed(2)}` : "—"}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: committed > 0 ? C.blue : C.muted }}>
                  {committed > 0 ? committed.toFixed(2) : "—"}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.teal }}>{(o.billable ?? 0).toFixed(2)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: delayColor(delays), fontWeight: 600 }}>{delays}</td>
                <td style={{ ...td, textAlign: "center", fontSize: 11, color: C.sec, fontFamily: "'DM Mono', monospace" }}>
                  {o.timezone || "—"}
                </td>
                <td style={{ ...td, textAlign: "left", fontSize: 11, color: C.sec, maxWidth: 280 }}>
                  {o.meeting && o.meeting !== "No scheduled meeting" ? o.meeting : <span style={{ color: C.muted }}>—</span>}
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
            <td style={{ ...td, borderTop: `2px solid ${C.border}` }} />
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.blue, borderTop: `2px solid ${C.border}` }}>{totals.committed.toFixed(2)}</td>
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.teal, borderTop: `2px solid ${C.border}` }}>{totals.billable.toFixed(2)}</td>
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.orange, borderTop: `2px solid ${C.border}` }}>{totals.delays}</td>
            <td style={{ ...td, borderTop: `2px solid ${C.border}` }} colSpan={3} />
          </tr>
        </tfoot>
      </table>
      </div>

      {/* Prominent TOTAL HOURS footer — sum of billable hours across all orgs shown. */}
      <div
        style={{
          marginTop: 12,
          padding: "14px 18px",
          background: "rgba(255,255,255,0.08)",
          borderTop: `2px solid ${C.accent}`,
          borderRadius: "0 0 12px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "#FFFFFF",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          TOTAL HOURS
        </span>
        <span
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: "#FFFFFF",
            fontFamily: "'DM Mono', monospace",
          }}
        >
          {totals.billable.toFixed(2)}h
        </span>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap" }}>
        {[
          { color: C.red,    label: "< 50% — Critical" },
          { color: C.orange, label: "50–80% — Below Target" },
          { color: C.green,  label: "80–100% — On Track" },
          { color: C.blue,   label: "100–120% — Above Target" },
          { color: C.purple, label: "> 120% — Exceeded" },
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

// "Billable vs Non-Billable by Client" — grouped vertical bar chart that
// replaces the per-month committed/utilized view (Penny 2026-06-15). Two
// bars per client (green billable / orange non-billable); clicking either
// opens BarDetailModal with that client's entries pre-filtered by billable
// flag. Internal/Other and zero-hour configured clients are dropped.
function BillableNonBillableByClient({ clients, periodLabel, loading, onBarClick }) {
  const real = (clients || []).filter(
    (c) =>
      !c.isInternalOther &&
      c.name !== "Internal / Other" &&
      ((Number(c.billable) || 0) > 0 || (Number(c.nonBillable) || 0) > 0),
  );
  const chartData = real.map((c) => ({
    name:           c.name,
    Billable:       Number(c.billable)    || 0,
    "Non-Billable": Number(c.nonBillable) || 0,
    _client:        c,
  }));

  return (
    <div
      style={{
        background:   "#0A0F1C",
        border:       "1px solid rgba(255,255,255,0.10)",
        borderRadius: 12,
        padding:      20,
      }}
    >
      <div
        style={{
          display:        "flex",
          justifyContent: "space-between",
          alignItems:     "center",
          marginBottom:   16,
          gap:            12,
          flexWrap:       "wrap",
        }}
      >
        <h3
          style={{
            fontSize:      14,
            fontWeight:    800,
            color:         "#FFFFFF",
            margin:        0,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          💼 Billable vs Non-Billable by Client
        </h3>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.60)", fontWeight: 600 }}>
          {periodLabel}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontStyle: "italic", marginBottom: 12 }}>
        Click any bar to see detailed entries breakdown
      </div>

      {loading ? (
        <div className="kpi-skeleton" style={{ height: 360 }} />
      ) : chartData.length === 0 ? (
        <div
          style={{
            height: 360, display: "flex", alignItems: "center", justifyContent: "center",
            color: "rgba(255,255,255,0.55)", fontSize: 13, fontStyle: "italic",
          }}
        >
          No client hours logged for this period.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={380}>
          <BarChart
            data={chartData}
            margin={{ top: 20, right: 20, bottom: 80, left: 20 }}
            onClick={(e) => {
              // Chart-level fallback — fires when the click misses the
              // colored segment but still lands inside a column.
              const hit = e?.activePayload?.[0];
              if (hit?.payload?._client && onBarClick) {
                onBarClick(hit.payload._client, hit.dataKey);
              }
            }}
            style={{ cursor: "pointer" }}
          >
            <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fill: "#FFFFFF", fontSize: 11, fontWeight: 600 }}
              axisLine={{ stroke: "rgba(255,255,255,0.20)" }}
              tickLine={false}
              angle={-45}
              textAnchor="end"
              height={96}
              interval={0}
              label={{ value: "Client", position: "insideBottom", offset: 2, fill: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: 700 }}
            />
            <YAxis
              tick={{ fill: "#FFFFFF", fontSize: 11, fontWeight: 600 }}
              axisLine={{ stroke: "rgba(255,255,255,0.20)" }}
              tickLine={false}
              label={{ value: "Hours", angle: -90, position: "insideLeft", fill: "#FFFFFF", fontSize: 11, fontWeight: 700 }}
            />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.08)" }}
              contentStyle={{
                background:   "#050810",
                border:       "1px solid rgba(255,255,255,0.20)",
                borderRadius: 8,
                fontSize:     12,
                color:        "#FFFFFF",
                fontWeight:   600,
                padding:      "10px 14px",
              }}
              labelStyle={{ color: "#FFFFFF", fontWeight: 800, marginBottom: 6 }}
              itemStyle={{ color: "#FFFFFF", fontWeight: 600 }}
              formatter={(v) => [`${Number(v).toFixed(2)}h`, ""]}
            />
            <Legend
              wrapperStyle={{ color: "#FFFFFF", fontWeight: 700, fontSize: 12, paddingTop: 10 }}
              iconType="square"
            />
            <Bar
              dataKey="Billable"
              fill="#10B981"
              radius={[4, 4, 0, 0]}
              style={{ cursor: "pointer" }}
              onClick={(payload) => {
                if (payload?._client && onBarClick) onBarClick(payload._client, "Billable");
              }}
            >
              <LabelList
                dataKey="Billable"
                position="top"
                formatter={(v) => (v > 0 ? `${Number(v).toFixed(2)}h` : "")}
                style={{ fill: "#10B981", fontSize: 10, fontWeight: 700, fontFamily: "'DM Mono', monospace" }}
              />
            </Bar>
            <Bar
              dataKey="Non-Billable"
              fill="#F2895A"
              radius={[4, 4, 0, 0]}
              style={{ cursor: "pointer" }}
              onClick={(payload) => {
                if (payload?._client && onBarClick) onBarClick(payload._client, "Non-Billable");
              }}
            >
              <LabelList
                dataKey="Non-Billable"
                position="top"
                formatter={(v) => (v > 0 ? `${Number(v).toFixed(2)}h` : "")}
                style={{ fill: "#F2895A", fontSize: 10, fontWeight: 700, fontFamily: "'DM Mono', monospace" }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Setup-needed roster card ───────────────────────────────────────
function buildSnippet(teamId, members) {
  // Produces:  "team_a": ["jane doe", "john o'brien", ...],
  const names = (members ?? []).map((m) => `"${(m.name ?? "").toLowerCase()}"`);
  return `"${teamId}": [${names.join(", ")}],`;
}

function MembersList({ members, emptyText = "No staff detected." }) {
  if (!members || members.length === 0) {
    return <div style={{ color: C.muted, fontStyle: "italic" }}>{emptyText}</div>;
  }
  return members.map((m, i) => (
    <div
      key={i}
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "3px 0",
        borderBottom: i < members.length - 1 ? `1px solid rgba(255,255,255,0.05)` : "none",
      }}
    >
      <span>{m.name}</span>
      <span style={{ color: C.sec }}>{(m.hours ?? 0).toFixed(2)}h</span>
    </div>
  ));
}

function CopyRow({ teamId, members, label = "Copy roster" }) {
  const [copied, setCopied] = useState(false);
  const snippet = useMemo(() => buildSnippet(teamId, members), [teamId, members]);

  function copySnippet() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
      <code
        style={{
          flex: 1,
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: "8px 10px",
          fontSize: 11,
          color: C.pri,
          fontFamily: "'DM Mono', monospace",
          whiteSpace: "nowrap",
          overflowX: "auto",
        }}
      >
        {snippet}
      </code>
      <button
        onClick={copySnippet}
        disabled={!members || members.length === 0}
        style={{
          background: copied ? C.teal : C.blue,
          border: "none",
          color: "#fff",
          borderRadius: 6,
          padding: "8px 14px",
          fontSize: 12,
          fontWeight: 600,
          cursor: !members || members.length === 0 ? "not-allowed" : "pointer",
          opacity: !members || members.length === 0 ? 0.5 : 1,
          transition: "background 0.15s",
          fontFamily: "'DM Sans', sans-serif",
          whiteSpace: "nowrap",
        }}
      >
        {copied ? "✓ Copied" : label}
      </button>
    </div>
  );
}

function DepartmentAccordion({ dept, teamId }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          padding: "10px 14px",
          color: C.pri,
          fontSize: 12,
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <span style={{ fontWeight: 600 }}>
          {open ? "▾ " : "▸ "}{dept.department}
        </span>
        <span style={{ color: C.muted, fontSize: 11 }}>
          {dept.member_count} member{dept.member_count === 1 ? "" : "s"} · {(dept.total_hours ?? 0).toFixed(2)}h
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 14px 12px" }}>
          <div
            style={{
              background: C.bg,
              borderRadius: 6,
              padding: 10,
              fontSize: 12,
              fontFamily: "'DM Mono', monospace",
              color: C.pri,
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            <MembersList members={dept.members} />
          </div>
          <CopyRow teamId={teamId} members={dept.members} label="Copy this dept" />
        </div>
      )}
    </div>
  );
}

function RosterSetupCard({ teamId, teamName }) {
  const [resp, setResp] = useState(null);
  const [loadingDetect, setLoadingDetect] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoadingDetect(true);
    authFetch(`/api/team/${teamId}/detect-roster`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        setResp(d ?? {});
        setLoadingDetect(false);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") {
          console.error("[detect-roster] fetch failed", err);
          setResp({});
          setLoadingDetect(false);
        }
      });
    return () => ctrl.abort();
  }, [teamId]);

  const bestMatch     = resp?.best_match ?? { department: "", confidence: "low", members: [] };
  const allDepts      = resp?.all_departments ?? [];
  const unassigned    = resp?.unassigned ?? [];
  const totalStaff    = resp?.totalStaff ?? 0;
  const noData        = !loadingDetect && totalStaff === 0 && allDepts.length === 0;
  const lowConfidence = bestMatch.confidence === "low" || bestMatch.members.length === 0;

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "48px 32px 40px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 40, marginBottom: 16 }}>⚙️</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.pri, marginBottom: 8 }}>
        Team Roster Not Configured
      </div>
      <div style={{ fontSize: 13, color: C.muted, maxWidth: 520, margin: "0 auto", lineHeight: 1.7 }}>
        To show {teamName} data, add team member names to TEAM_ROSTERS in backend/main.py.
      </div>

      <div style={{ maxWidth: 720, margin: "24px auto 0", textAlign: "left" }}>
        {noData ? (
          <div style={{ color: C.muted, fontStyle: "italic", textAlign: "center", padding: "24px 0" }}>
            No timesheet data found in the last 30 days.
          </div>
        ) : (
          <>
            {/* Best-match block */}
            <div
              style={{
                fontSize: 11,
                color: C.muted,
                textTransform: "uppercase",
                letterSpacing: 1,
                fontWeight: 600,
                marginBottom: 8,
              }}
            >
              Suggested roster (last 30 days)
              {bestMatch.department && (
                <span style={{ marginLeft: 8, color: C.sec, textTransform: "none", letterSpacing: 0 }}>
                  · matched dept “{bestMatch.department}”
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 4,
                      background:
                        bestMatch.confidence === "high"  ? `${C.teal}22`   :
                        bestMatch.confidence === "medium" ? `${C.orange}22` :
                        `${C.red}22`,
                      color:
                        bestMatch.confidence === "high"  ? C.teal   :
                        bestMatch.confidence === "medium" ? C.orange :
                        C.red,
                    }}
                  >
                    {bestMatch.confidence}
                  </span>
                </span>
              )}
            </div>

            {lowConfidence && !loadingDetect && (
              <div
                style={{
                  background: `${C.orange}14`,
                  border: `1px solid ${C.orange}40`,
                  borderRadius: 6,
                  padding: "8px 12px",
                  fontSize: 12,
                  color: C.orange,
                  marginBottom: 10,
                }}
              >
                ⚠ Could not auto-detect {teamName} members. Pick the correct department below.
              </div>
            )}

            <div
              style={{
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: 12,
                maxHeight: 280,
                overflowY: "auto",
                fontSize: 12,
                color: C.pri,
                fontFamily: "'DM Mono', monospace",
              }}
            >
              {loadingDetect ? (
                <div style={{ color: C.muted, fontStyle: "italic" }}>Loading…</div>
              ) : (
                <MembersList members={bestMatch.members} emptyText="No members in the matched department." />
              )}
            </div>

            <CopyRow teamId={teamId} members={bestMatch.members} />

            {/* Other departments */}
            {allDepts.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: C.muted,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    fontWeight: 600,
                    marginBottom: 10,
                  }}
                >
                  Other departments ({allDepts.length})
                </div>
                {allDepts.map((d, i) => (
                  <DepartmentAccordion key={d.department + i} dept={d} teamId={teamId} />
                ))}
              </div>
            )}

            {unassigned.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <DepartmentAccordion
                  teamId={teamId}
                  dept={{
                    department: "(no department)",
                    member_count: unassigned.length,
                    total_hours: unassigned.reduce((s, u) => s + (u.hours ?? 0), 0),
                    members: unassigned,
                  }}
                />
              </div>
            )}
          </>
        )}

        <div style={{ fontSize: 11, color: C.muted, marginTop: 18 }}>
          Paste into <code>TEAM_ROSTERS</code> in <code>backend/main.py</code>, then restart uvicorn or POST
          {" "}<code>/api/clear-cache</code>.
        </div>
      </div>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────
export default function TeamDashboard({ teamId, teamName, onBack, onContextUpdate, onSelectEmployee }) {
  const [period, setPeriod] = useState("monthly");
  const [customRange, setCustomRange] = useState(_defaultCustomRange);
  const [pendingCustom, setPendingCustom] = useState(_defaultCustomRange);
  // Leaderboard for the current period (drives "Team Members" table).
  const [leaderboard, setLeaderboard] = useState(null);
  // Weekly leaderboard for "Most Underutilized This Week" widget.
  const [weeklyLeaderboard, setWeeklyLeaderboard] = useState(null);
  const lbAbortRef     = useRef(null);
  const weeklyAbortRef = useRef(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [forceRefreshing, setForceRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState("");
  // Universal bar-drill-down modal. One state shared by every chart/table on
  // the team view: clicking any org bar or table row populates `org` with the
  // clicked client object and the modal lists its underlying entries.
  const [orgModal, setOrgModal] = useState({ open: false, org: null });
  // KPI-card drill-down modal — clicking any top KPI card (Organizations,
  // Billable, Non-Billable, Internal, Total) opens the same BarDetailModal
  // with the matching filter applied to the aggregated entry list.
  const [kpiModal, setKpiModal] = useState({ open: false, type: null });
  // Billable / Non-Billable by Client chart — clicking either bar on a
  // client opens BarDetailModal with that client's entries pre-filtered
  // by billable flag (type = "Billable" or "Non-Billable").
  const [clientBarModal, setClientBarModal] = useState({ open: false, client: null, type: null });
  // Performance-by-Organization row click → reason modal (WHY behind target /
  // HOW to fix). Stays separate from `orgModal` (Hours-by-Org chart bar
  // click → entries table) — different surfaces, different drill-downs.
  const [perfModal, setPerfModal] = useState({ open: false, org: null });
  // Recurring-meeting reminder banner (dynamic, computed server-side vs IST day).
  const [meetingInfo, setMeetingInfo] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    let alive = true;
    authFetch(`/api/team/${teamId}/meeting-status`)
      .then((r) => r.json())
      .then((j) => { if (alive) setMeetingInfo(j); })
      .catch(() => { if (alive) setMeetingInfo(null); });
    return () => { alive = false; };
  }, [teamId]);

  const fetchData = useCallback((silent = false) => {
    // The Weekly Review and BOD/EOD tabs have their own data sources —
    // don't hit /api/team/{id}/review (would 404 / hit the period catch-all).
    if (period === "review") return;
    if (period === "bodEod") return;
    if (period === "custom" && (!customRange.from || !customRange.to)) return;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!silent) setLoading(true);
    const url = period === "custom"
      ? `/api/team/${teamId}/custom?from=${customRange.from}&to=${customRange.to}`
      : `/api/team/${teamId}/${period}`;
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
        console.error("[TeamDashboard] fetch failed", err);
        setData({ summary: {}, clients: [], eod: [] });
        if (!silent) setLoading(false);
      });
  }, [teamId, period, customRange.from, customRange.to]);

  useEffect(() => {
    fetchData();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchData]);

  // Auto-refresh on Today view (silent — don't flash skeletons)
  const isLive = period === "today";
  const refreshSilent = useCallback(() => fetchData(true), [fetchData]);
  const tickNow = useAutoRefresh(refreshSilent, isLive, lastRefreshed);

  // Force-refresh: clears server-side caches for this team, then re-fetches.
  // Use when displayed hours diverge from the timesheet source.
  const forceRefresh = useCallback(async () => {
    setForceRefreshing(true);
    setRefreshNotice("");
    try {
      const r = await authFetch(`/api/team/${teamId}/refresh`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) {
        setRefreshNotice(`✓ Cache cleared — fetching fresh data…`);
      } else {
        setRefreshNotice(`Refresh failed: ${j?.error || r.status}`);
      }
    } catch (err) {
      setRefreshNotice(`Refresh failed: ${err?.message || String(err)}`);
    }
    fetchData(false);
    setForceRefreshing(false);
    setTimeout(() => setRefreshNotice(""), 5000);
  }, [teamId, fetchData]);

  // Leaderboard for the active period (drives Team Members table).
  useEffect(() => {
    if (period === "review") return;
    if (period === "bodEod") return;
    if (period === "custom" && (!customRange.from || !customRange.to)) return;
    if (lbAbortRef.current) lbAbortRef.current.abort();
    const ctrl = new AbortController();
    lbAbortRef.current = ctrl;
    setLeaderboard(null);
    const url = period === "custom"
      ? `/api/team/${teamId}/leaderboard/custom?from=${customRange.from}&to=${customRange.to}`
      : `/api/team/${teamId}/leaderboard/${period}`;
    authFetch(url, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setLeaderboard(d);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        console.error("[TeamDashboard] leaderboard fetch failed", err);
        setLeaderboard({ members: [] });
      });
    return () => ctrl.abort();
  }, [teamId, period, customRange.from, customRange.to]);

  // Weekly leaderboard for the "Most Underutilized This Week" widget.
  useEffect(() => {
    if (weeklyAbortRef.current) weeklyAbortRef.current.abort();
    const ctrl = new AbortController();
    weeklyAbortRef.current = ctrl;
    setWeeklyLeaderboard(null);
    authFetch(`/api/team/${teamId}/leaderboard/weekly`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setWeeklyLeaderboard(d);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setWeeklyLeaderboard({ members: [] });
      });
    return () => ctrl.abort();
  }, [teamId]);

  // Filter "Internal / Other" out at the source so it disappears from every
  // consumer below: the Performance by Organization table + its TOTALS row,
  // the Organizations KPI count, the Hours by Org chart, and the chatbot
  // context. Non-billable hours that used to land here are still represented
  // in the Non-Billable KPI card and per-employee Non-Billable Breakdown.
  const clients = useMemo(
    () => (data?.clients ?? []).filter((o) =>
      !o.isInternalOther
      && (o.name ?? "").toLowerCase() !== "internal / other"
      && (o.org ?? "").toLowerCase()  !== "internal / other"
    ),
    [data],
  );
  const summary = data?.summary ?? {};
  const eod = useMemo(() => data?.eod ?? [], [data]);
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    if (!data || !onContextUpdate) return;
    const ctx = `Team: ${teamName} — ${data.period ?? ""}
Total: Committed ${summary.totalCommitted ?? 0}h | Utilized ${summary.totalBillable ?? 0}h | Non-Bill ${summary.totalNonBillable ?? 0}h | Util ${summary.overallEfficiency ?? 0}% | Delays ${summary.totalDelays ?? 0}

ORGANIZATIONS:
${clients.map((o) => (
  `• ${o.name}: ${o.committed ?? 0}h committed, ${o.billable ?? 0}h utilized, ${o.nonBillable ?? 0}h non-billable, ${o.efficiency ?? 0}% util, ${o.delays ?? 0} delays`
)).join("\n")}`;
    onContextUpdate(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, teamName]);

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";
  const totalHours = (summary.totalBillable ?? 0) + (summary.totalNonBillable ?? 0) + (summary.totalInternal ?? 0);

  // Chart 1 — prefer EOD-by-month when available; else fall back to monthlyTrend (rows-derived)
  const monthlyEod = useMemo(() => {
    const buckets = {};
    eod.forEach((row) => {
      if (!row.date) return;
      const dateStr = String(row.date);
      let dateObj;
      if (dateStr.includes("/")) {
        const parts = dateStr.split("/");
        if (parts.length < 3) return;
        const year = parts[2].length === 2 ? "20" + parts[2] : parts[2];
        dateObj = new Date(`${year}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`);
      } else {
        dateObj = new Date(dateStr);
      }
      if (Number.isNaN(dateObj.getTime())) return;

      const monthKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}`;
      const label    = dateObj.toLocaleString("default", { month: "short" });

      if (!buckets[monthKey]) {
        buckets[monthKey] = { monthKey, month: label, committed: 0, booked: 0 };
      }
      buckets[monthKey].committed += Number(row.committed) || 0;
      buckets[monthKey].booked    += Number(row.booked ?? row.billable) || 0;
    });

    const eodChart = Object.values(buckets)
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
      .map((b) => ({
        month:     b.month,
        Committed: Math.round(b.committed * 10) / 10,
        Utilized:  Math.round(b.booked * 10) / 10,
      }));

    if (eodChart.length > 0) return eodChart;

    // Fallback: backend-provided monthlyTrend from roster-matched timesheet rows
    const trend = data?.monthlyTrend ?? [];
    return trend
      .slice()
      .sort((a, b) => (a.monthKey ?? "").localeCompare(b.monthKey ?? ""))
      .map((b) => {
        const mk = b.monthKey ?? "";
        const [y, m] = mk.split("-");
        const d = y && m ? new Date(Number(y), Number(m) - 1, 1) : null;
        const month = d ? d.toLocaleString("default", { month: "short" }) : mk;
        const committed = Number(b.committed) || 0;
        const utilized  = Number(b.utilized)  || 0;
        return {
          month,
          Committed: Math.round(committed * 10) / 10,
          Utilized:  Math.round(utilized * 10) / 10,
        };
      });
  }, [eod, data]);

  // Flat list of every entry under this team for the current period — sourced
  // by concatenating each org's `entries[]` (shipped by the backend). Powers
  // the KPI-card drill-down modals so a click on Total / Billable / Internal
  // opens a single filtered list.
  const allEntries = useMemo(
    () => {
      const out = [];
      for (const c of clients) {
        const list = Array.isArray(c.entries) ? c.entries : [];
        for (const e of list) out.push(e);
      }
      return out;
    },
    [clients],
  );

  // Real client rows only — exclude "Internal / Other" AND configured clients
  // with zero actual hours this period (they're still kept in the PerfTable as
  // "—" rows). Backend marks Internal/Other via isInternalOther=true.
  const chartClients = useMemo(
    () => clients.filter(
      (o) =>
        !o.isInternalOther &&
        (o.name ?? "").toLowerCase() !== "internal / other" &&
        (Number(o.total ?? 0) > 0)
    ),
    [clients]
  );

  // Chart 2 — Hours by Org, horizontal, sorted by total desc. Each bar
  // payload carries `_org` (the full client object including entries[]) so
  // the chart-level onClick can open BarDetailModal without a second lookup.
  const hoursByOrg = useMemo(
    () => [...chartClients]
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
      .map((o) => ({
        name:  o.name,
        Hours: Number((o.total ?? 0).toFixed(2)),
        _org:  o,
      })),
    [chartClients]
  );

  const agingSummary = data?.delaysAgeSummary ?? null;
  const delaysByDay  = data?.delaysByDay ?? [];
  const agingChart   = useMemo(() => buildAgingChartData(delaysByDay), [delaysByDay]);
  const agingTotalOpen = (agingSummary?.totalOpen ?? 0);
  const agingHasAnyData = useMemo(
    () => agingChart.some((d) => (d.Completed + d.Fresh + d.Aging + d.Overdue) > 0),
    [agingChart],
  );
  const [selectedDay, setSelectedDay] = useState(null);
  // onClick on individual <Bar> in a stacked chart fires only when the small
  // colored segment is hit and Recharts intermittently drops the event near
  // segment borders. Moving the handler to the parent <BarChart> uses the
  // chart's hit-test against the nearest x-value, so any click anywhere in
  // the chart area resolves to the right day.
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
  // BarChart.onClick activePayload on stacked-bar clicks, so we also wire
  // onClick on each <Bar> — there `entry.payload` is the underlying row.
  const handleBarSegmentClick = useCallback((entry) => {
    const p = entry?.payload || entry;
    if (p && (p.allRows || p.fullDate || p.day)) {
      console.log("[delay-chart] bar-segment click payload:", p);
      setSelectedDay(p);
    }
  }, []);

  const displayLabel = data?.teamLabel ?? data?.team ?? teamName ?? teamId;
  const displayLead  = data?.lead ?? data?.leadName ?? "";
  const rosterCount  = data?.rosterCount ?? 0;
  // Member count = the actual number of rows in the Team Members table (the
  // leaderboard members list), so the header badge can never disagree with the
  // table. Falls back to rosterCount until the leaderboard finishes loading.
  const memberCount  = Array.isArray(leaderboard?.members) ? leaderboard.members.length : rosterCount;
  const matchedRows  = data?.matchedRows ?? 0;
  const totalRows    = data?.totalRows ?? 0;
  const fromCache    = !!data?.fromCache;
  const cacheAge     = data?.cacheAge ?? 0;
  const letter = (displayLabel ?? "").replace(/^Team\s+/i, "") || teamId?.slice(-1).toUpperCase();

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      {meetingInfo?.has_meeting && (() => {
        const u = meetingInfo.urgency;
        const tone = u === "today"    ? { bg: "rgba(239,68,68,0.14)",  bd: "#EF4444" }
                   : u === "tomorrow" ? { bg: "rgba(240,185,71,0.16)", bd: "#F0B947" }
                   : u === "soon"     ? { bg: "rgba(74,143,231,0.15)",  bd: "#4A8FE7" }
                   :                    { bg: "rgba(255,255,255,0.06)", bd: C.border };
        return (
          <div style={{
            background: tone.bg, borderBottom: `2px solid ${tone.bd}`,
            color: C.pri, padding: "10px 32px", fontWeight: 700, fontSize: 13,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            {meetingInfo.message}
          </div>
        );
      })()}
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
            display: "flex",
            alignItems: "center",
            gap: 6,
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.color = C.pri; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.sec; }}
        >
          ← Back
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 14, flex: 1 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 12,
              background: "linear-gradient(135deg,#3d8ef0,#9f7aea)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              fontWeight: 700,
              color: "#fff",
              letterSpacing: 0.5,
              boxShadow: "inset 0 -8px 16px rgba(0,0,0,0.18)",
            }}
          >
            {letter}
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.pri, letterSpacing: -0.4, lineHeight: 1.15 }}>
              {displayLabel}
            </div>
            {displayLead && (
              <div style={{ fontSize: 13, color: C.sec, marginTop: 2 }}>
                Lead: {displayLead}{memberCount > 0 ? ` · ${memberCount} ${memberCount === 1 ? "member" : "members"}` : ""}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, background: C.card, borderRadius: 8, padding: 3, border: `1px solid ${C.border}`, opacity: data?.unconfigured || data?.needsRosterSetup ? 0.5 : 1 }}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              disabled={!!(data?.unconfigured || data?.needsRosterSetup)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "none",
                cursor: data?.unconfigured || data?.needsRosterSetup ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "'DM Sans', sans-serif",
                transition: "all 0.15s",
                background: period === p.key ? (p.key === "review" ? "#7C3AED" : p.key === "bodEod" ? "#3DC58B" : p.key === "custom" ? "#F2895A" : C.blue) : "transparent",
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

        {fromCache && (
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: C.teal,
              background: `${C.teal}14`,
              border: `1px solid ${C.teal}55`,
              padding: "4px 10px",
              borderRadius: 999,
            }}
          >
            ⚡ Cached {cacheAge}s ago
          </div>
        )}

        <LiveIndicator
          lastRefreshed={lastRefreshed}
          now={tickNow}
          isLive={isLive}
          onRefresh={() => fetchData(false)}
        />

        <button
          onClick={forceRefresh}
          disabled={forceRefreshing || loading}
          title="Clear server cache and re-fetch from timesheet API. Use if displayed hours look stale."
          style={{
            background: forceRefreshing ? C.surface : "transparent",
            border: `1px solid ${C.border}`,
            color: forceRefreshing ? C.muted : C.sec,
            borderRadius: 8,
            padding: "6px 12px",
            cursor: forceRefreshing || loading ? "not-allowed" : "pointer",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "'DM Sans', sans-serif",
            transition: "all 0.15s",
            opacity: forceRefreshing || loading ? 0.6 : 1,
          }}
          onMouseEnter={(e) => {
            if (forceRefreshing || loading) return;
            e.currentTarget.style.borderColor = C.teal;
            e.currentTarget.style.color = C.teal;
          }}
          onMouseLeave={(e) => {
            if (forceRefreshing || loading) return;
            e.currentTarget.style.borderColor = C.border;
            e.currentTarget.style.color = C.sec;
          }}
        >
          {forceRefreshing ? "⟳ Refreshing…" : "⟳ Refresh"}
        </button>

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
          <div style={{ fontSize: 11, color: C.muted }}>
            {periodLabel} · {today}
          </div>
          {data?.summary?.isProrated && data?.summary?.workingDaysTotal > 0 && (
            <div
              style={{
                fontSize: 10,
                color: C.teal,
                fontFamily: "'DM Mono', monospace",
                marginTop: 2,
                letterSpacing: 0.3,
              }}
              title={`Targets pro-rated by working days elapsed (${data.summary.periodStart} → ${data.summary.periodEnd})`}
            >
              Day {data.summary.workingDaysElapsed}/{data.summary.workingDaysTotal} · pro-rated
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
        {period === "review" ? (
          <>
            {!data?.needsRosterSetup && (
              <WeeklyChecklistSection teamId={teamId} />
            )}
          </>
        ) : period === "bodEod" ? (
          <BodEodReview teamId={teamId} />
        ) : (<>
        {/* Roster info banner */}
        {!loading && data && !data.error && !data.needsRosterSetup && (
          <div
            style={{
              background: "rgba(0,200,150,0.06)",
              border: "1px solid rgba(0,200,150,0.15)",
              borderRadius: 6,
              padding: "8px 16px",
              fontSize: 11,
              color: "#00c896",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <span>
              ✓ Filtered by team roster: <strong>{memberCount}</strong> member{memberCount === 1 ? "" : "s"}{" — "}
              Lead <strong>{displayLead || "Not set"}</strong>{" — "}
              <strong>{matchedRows}</strong> of {totalRows} timesheet rows matched
            </span>
            {fromCache && (
              <span style={{ color: C.teal, fontSize: 10 }}>⚡ Cached</span>
            )}
          </div>
        )}

        {!loading && data?.error && (
          <div
            style={{
              background: `${C.red}14`,
              border: `1px solid ${C.red}55`,
              borderLeft: `3px solid ${C.red}`,
              borderRadius: 8,
              padding: "12px 16px",
              fontSize: 13,
              color: C.pri,
            }}
          >
            <strong style={{ color: C.red }}>Error:</strong> {data.error}
          </div>
        )}

        {refreshNotice && (
          <div
            style={{
              background: `${C.teal}14`,
              border: `1px solid ${C.teal}55`,
              borderLeft: `3px solid ${C.teal}`,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 12,
              color: C.pri,
            }}
          >
            {refreshNotice}
          </div>
        )}

        {/* Setup-needed message */}
        {!loading && data?.needsRosterSetup && (
          <RosterSetupCard teamId={teamId} teamName={displayLabel} />
        )}

        {/* Empty data (roster configured but no matching rows) */}
        {!loading && data && !data.needsRosterSetup && clients.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px", color: C.muted, fontSize: 13 }}>
            No timesheet data found for this period.
          </div>
        )}

        {/* KPIs */}
        {loading ? (
          <LoadingScreen teamName={displayLabel} />
        ) : data?.needsRosterSetup ? null : (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <KpiCard
              label="Organizations"
              value={clients.length}
              color={C.blue}
              suffix=""
              decimals={0}
              sub="Active this period"
              onClick={() => setKpiModal({ open: true, type: "organizations" })}
            />
            <KpiCard
              label="Total Billable"
              value={summary.totalBillable}
              color={C.teal}
              onClick={() => setKpiModal({ open: true, type: "billable" })}
            />
            <KpiCard
              label="Non-Billable"
              value={summary.totalNonBillable}
              color={C.orange}
              onClick={() => setKpiModal({ open: true, type: "nonBillable" })}
            />
            <KpiCard
              label="Internal"
              value={summary.totalInternal ?? 0}
              color={C.purple}
              onClick={() => setKpiModal({ open: true, type: "internal" })}
            />
            <KpiCard
              label="Total Hours"
              value={totalHours}
              color={C.blue}
              onClick={() => setKpiModal({ open: true, type: "total" })}
            />
          </div>
        )}

        {/* Most Underutilized This Week — only shows when team has >= 3 members */}
        {!data?.needsRosterSetup && weeklyLeaderboard && Array.isArray(weeklyLeaderboard.members) && weeklyLeaderboard.members.length >= 3 && (
          <UnderutilizedWidget
            members={weeklyLeaderboard.members}
            onSelect={(name) => onSelectEmployee && onSelectEmployee({ teamId, employeeName: name, teamName: displayLabel })}
          />
        )}

        {/* Currently Active — drives off lastLoggedAt / activeNow from the leaderboard */}
        {!data?.needsRosterSetup && leaderboard && Array.isArray(leaderboard.members) && leaderboard.members.length > 0 && (
          <CurrentlyActiveWidget
            members={leaderboard.members}
            onSelect={(name) => onSelectEmployee && onSelectEmployee({ teamId, employeeName: name, teamName: displayLabel })}
          />
        )}

        {!data?.needsRosterSetup && (
          <BillableNonBillableByClient
            clients={clients}
            periodLabel={periodLabel}
            loading={loading}
            onBarClick={(client, type) => setClientBarModal({ open: true, client, type })}
          />
        )}

        {!data?.needsRosterSetup && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {/* Hours by Organization spans both columns now that the per-month
              committed/utilized chart was removed — otherwise it would sit
              orphaned in the left half. */}
          <div style={{ gridColumn: "1 / -1" }}>
          <ChartCard title="Hours by Organization">
            {loading ? (
              <div className="kpi-skeleton" style={{ height: 260 }} />
            ) : hoursByOrg.length === 0 ? (
              <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic" }}>
                No organization data
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={hoursByOrg}
                  layout="vertical"
                  barCategoryGap="25%"
                  onClick={(e) => {
                    // Recharts 3.x: chart-level onClick fires reliably only
                    // when the cursor hits inside the plot area. We keep it
                    // as a fallback for clicks adjacent to the bar, but the
                    // per-Bar onClick below is the primary trigger.
                    const p = e?.activePayload?.[0]?.payload;
                    if (p && p._org) setOrgModal({ open: true, org: p._org });
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                  <XAxis type="number" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} height={42}
                    label={{ value: "Hours", position: "insideBottom", offset: 0, fill: C.sec, fontSize: 11, fontWeight: 700 }} />
                  <YAxis dataKey="name" type="category" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={130}
                    label={{ value: "Organization", angle: -90, position: "insideLeft", fill: C.sec, fontSize: 11, fontWeight: 700, style: { textAnchor: "middle" } }} />
                  <Tooltip content={<DarkTooltip />} />
                  <Bar
                    dataKey="Hours"
                    fill={C.blue}
                    radius={[0, 4, 4, 0]}
                    style={{ cursor: "pointer" }}
                    onClick={(payload) => {
                      // In Recharts, <Bar>'s onClick fires per-bar with the
                      // row payload as the first argument. More reliable than
                      // the chart-level handler for direct bar hits.
                      if (payload && payload._org) {
                        setOrgModal({ open: true, org: payload._org });
                      }
                    }}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
          </div>

          {/* Spans both columns — third chart card on a 2-wide grid would
              otherwise sit alone in the left column. */}
          <div style={{ gridColumn: "1 / -1" }}>
          <ChartCard title="Open Questions & Delays — Aging Report">
            {loading ? (
              <div className="kpi-skeleton" style={{ height: 260 }} />
            ) : data?.hasEodSheet === false ? (
              <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: 16 }}>
                No EOD sheet configured for this team.
              </div>
            ) : agingTotalOpen === 0 && !agingHasAnyData ? (
              <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: C.green, fontSize: 14, fontWeight: 600, textAlign: "center", padding: 16 }}>
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
                <ResponsiveContainer width="100%" height={232}>
                  <BarChart
                    data={agingChart}
                    margin={{ top: 4, right: 8, left: 10, bottom: 52 }}
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
                      height={64}
                      label={{ value: "Day of Month", position: "insideBottom", offset: 2, fill: C.sec, fontSize: 11, fontWeight: 700 }}
                    />
                    <YAxis
                      tick={{ fill: C.muted, fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                      label={{ value: "Number of Delays", angle: -90, position: "insideLeft", fill: C.sec, fontSize: 11, fontWeight: 700, style: { textAnchor: "middle" } }}
                    />
                    <Tooltip content={<AgingTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                    <Bar dataKey="Completed" stackId="a" fill="#3DC58B" onClick={handleBarSegmentClick} cursor="pointer" />
                    <Bar dataKey="Fresh"     stackId="a" fill="#F0B947" onClick={handleBarSegmentClick} cursor="pointer" />
                    <Bar dataKey="Aging"     stackId="a" fill="#F2895A" onClick={handleBarSegmentClick} cursor="pointer" />
                    <Bar dataKey="Overdue"   stackId="a" fill="#E25C5C" radius={[4, 4, 0, 0]} onClick={handleBarSegmentClick} cursor="pointer" />
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 6, textAlign: "center", letterSpacing: 0.3 }}>
                  X-axis: day of month · Y-axis: number of delays · hover for summary · click a bar for details
                </div>
              </>
            )}
          </ChartCard>
          </div>
        </div>
        )}

        {!data?.needsRosterSetup && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
            Performance by Organization
          </div>
          {loading ? (
            <div className="kpi-skeleton" style={{ height: 240 }} />
          ) : (
            <PerfTable
              orgs={clients}
              onRowClick={(org) => setPerfModal({ open: true, org })}
            />
          )}
        </div>
        )}

        {!data?.needsRosterSetup && (
          <UserSelectorDropdown
            members={leaderboard?.members ?? null}
            onSelect={(name) => onSelectEmployee && onSelectEmployee({ teamId, employeeName: name, teamName: displayLabel })}
          />
        )}

        {!data?.needsRosterSetup && (
          <TeamMembersTable
            members={leaderboard?.members ?? null}
            onSelect={(name) => onSelectEmployee && onSelectEmployee({ teamId, employeeName: name, teamName: displayLabel })}
          />
        )}
        </>)}
      </div>
      <DelayDetailModal day={selectedDay} teamId={teamId} onClose={() => setSelectedDay(null)} />
      <BarDetailModal
        open={orgModal.open}
        onClose={() => setOrgModal({ open: false, org: null })}
        title={orgModal.org?.name || ""}
        subtitle={`Organization · ${periodLabel}`}
        entries={orgModal.org?.entries || []}
        accentColor={C.orange}
        totalHours={Number(orgModal.org?.total ?? orgModal.org?.actual ?? 0)}
      />
      <PerformanceReasonModal
        open={perfModal.open}
        onClose={() => setPerfModal({ open: false, org: null })}
        org={perfModal.org}
        periodLabel={periodLabel}
        workingDays={Number(summary?.workingDaysElapsed) || 1}
      />
      {clientBarModal.open && (() => {
        const client = clientBarModal.client || {};
        const type   = clientBarModal.type;
        const want   = type === "Billable";
        const all    = Array.isArray(client.entries) ? client.entries : [];
        const filtered = all.filter((e) => !!e.billable === want);
        const total    = type === "Billable"
          ? Number(client.billable ?? 0)
          : Number(client.nonBillable ?? 0);
        return (
          <BarDetailModal
            open
            onClose={() => setClientBarModal({ open: false, client: null, type: null })}
            title={`${client.name || ""} · ${type}`}
            subtitle={`${type} hours · ${periodLabel}`}
            entries={filtered}
            accentColor={want ? "#10B981" : "#F2895A"}
            totalHours={total}
          />
        );
      })()}
      {kpiModal.open && (() => {
        const props = _buildKpiModalProps({
          type:        kpiModal.type,
          periodLabel,
          clients,
          summary,
          allEntries,
          totalHours,
        });
        if (!props) return null;
        return (
          <SimpleBreakdownModal
            open
            onClose={() => setKpiModal({ open: false, type: null })}
            {...props}
          />
        );
      })()}
    </div>
  );
}

// Per-KPI internal-category set — matches backend INTERNAL_CODES verbatim so
// the modal aggregations line up with the totalInternal KPI number to the
// last decimal even though we slice the same allEntries list client-side.
const _INTERNAL_NAMES = new Set([
  "snmp", "breaks for teams", "choose customer",
  "internal", "internal / other", "training", "admin", "cleanup", "allocation",
]);
function _isInternalEntry(e) {
  return _INTERNAL_NAMES.has(String(e.client || "").trim().toLowerCase());
}

// Build the props object for SimpleBreakdownModal per clicked KPI card.
// Centralized here so the JSX stays a one-liner and the per-type aggregations
// are unit-testable side-by-side. Items are sorted desc and stripped of zero
// rows so the list focuses on what's actually contributing.
function _buildKpiModalProps({ type, periodLabel, clients, summary, allEntries, totalHours }) {
  switch (type) {
    case "organizations": {
      const items = (clients || [])
        .filter((c) => !c.isInternalOther)
        .map((c) => ({
          name: c.name,
          value: Number(c.total ?? c.actual ?? 0),
          color: C.blue,
        }))
        .filter((it) => it.value > 0)
        .sort((a, b) => b.value - a.value);
      const sum = items.reduce((s, it) => s + it.value, 0);
      return {
        title: "📊 Organizations",
        subtitle: `${items.length} active · ${periodLabel}`,
        total: `${sum.toFixed(2)}h`,
        accentColor: C.blue,
        showPercentage: true,
        items,
      };
    }
    case "billable": {
      const items = (clients || [])
        .filter((c) => !c.isInternalOther)
        .map((c) => ({ name: c.name, value: Number(c.billable ?? 0), color: C.teal }))
        .filter((it) => it.value > 0)
        .sort((a, b) => b.value - a.value);
      return {
        title: "💰 Total Billable Breakdown",
        subtitle: `By organization · ${periodLabel}`,
        total: `${(summary?.totalBillable ?? 0).toFixed(2)}h`,
        accentColor: C.teal,
        showPercentage: true,
        items,
      };
    }
    case "nonBillable": {
      const items = (clients || [])
        .filter((c) => !c.isInternalOther)
        .map((c) => ({ name: c.name, value: Number(c.nonBillable ?? 0), color: C.orange }))
        .filter((it) => it.value > 0)
        .sort((a, b) => b.value - a.value);
      return {
        title: "📋 Non-Billable Breakdown",
        subtitle: `By organization (excludes Internal) · ${periodLabel}`,
        total: `${(summary?.totalNonBillable ?? 0).toFixed(2)}h`,
        accentColor: C.orange,
        showPercentage: true,
        items,
      };
    }
    case "internal": {
      // Aggregate internal-category entries by raw customer name (SNMP /
      // BREAKS FOR TEAMS / Admin / Training / etc.). Sourced from allEntries
      // so the totals match the team-summary totalInternal exactly.
      const bucket = {};
      for (const e of (allEntries || [])) {
        if (!_isInternalEntry(e)) continue;
        const name = (e.client || "").trim() || "Unspecified";
        bucket[name] = (bucket[name] || 0) + (Number(e.hours) || 0);
      }
      const items = Object.entries(bucket)
        .map(([name, value]) => ({ name, value: Number(value), color: C.purple }))
        .filter((it) => it.value > 0)
        .sort((a, b) => b.value - a.value);
      return {
        title: "🏢 Internal Hours Breakdown",
        subtitle: `SNMP / Breaks / Admin / Training · ${periodLabel}`,
        total: `${(summary?.totalInternal ?? 0).toFixed(2)}h`,
        accentColor: C.purple,
        showPercentage: true,
        items,
      };
    }
    case "total":
    default: {
      const items = [
        { name: "Billable",     value: Number(summary?.totalBillable    ?? 0), color: C.teal   },
        { name: "Non-Billable", value: Number(summary?.totalNonBillable ?? 0), color: C.orange },
        { name: "Internal",     value: Number(summary?.totalInternal    ?? 0), color: C.purple },
      ].filter((it) => it.value > 0);
      return {
        title: "📊 Total Hours Overview",
        subtitle: `All activity · ${periodLabel}`,
        total: `${Number(totalHours || 0).toFixed(2)}h`,
        accentColor: "#FFFFFF",
        showPercentage: true,
        items,
      };
    }
  }
}

// ── Most Underutilized This Week ───────────────────────────────────
function UnderutilizedWidget({ members, onSelect }) {
  // Lowest util%, but exclude truly-zero rows (likely no data, not low usage).
  const bottom = useMemo(
    () => [...members]
      .filter((m) => (m.utilPct ?? 0) > 0 || (m.billable ?? 0) > 0)
      .sort((a, b) => (a.utilPct ?? 0) - (b.utilPct ?? 0))
      .slice(0, 3),
    [members]
  );
  if (bottom.length === 0) return null;
  return (
    <div
      style={{
        background: `${C.orange}10`,
        border: `1px solid ${C.orange}30`,
        borderLeft: `3px solid ${C.orange}`,
        borderRadius: 8,
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div style={{ fontSize: 11, color: C.orange, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, whiteSpace: "nowrap" }}>
        ⚠ Most Underutilized This Week
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", flex: 1 }}>
        {bottom.map((m, i) => (
          <button
            key={i}
            onClick={() => onSelect && onSelect(m.name)}
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "6px 12px 6px 6px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
              color: C.pri,
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.background = `${C.orange}14`; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = "transparent"; }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: gradientFor(m.name),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 700,
                color: "#fff",
              }}
            >
              {initials(m.name)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{m.name}</span>
              <span style={{ fontSize: 10, color: C.teal, fontFamily: "'DM Mono', monospace" }}>
                {(m.billable ?? 0).toFixed(2)}h billable
                {m.trend === "up"   && <span style={{ marginLeft: 6, color: C.green }}>▲</span>}
                {m.trend === "down" && <span style={{ marginLeft: 6, color: C.red }}>▼</span>}
                {m.trend === "flat" && <span style={{ marginLeft: 6, color: C.muted }}>–</span>}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Currently Active widget ──────────────────────────────────────
function _isBusinessHoursIST(date = new Date()) {
  // Convert local time to Asia/Kolkata using Intl. Day-of-week from IST.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric", hour12: false, weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const wk = parts.find((p) => p.type === "weekday")?.value || "";
  const hh = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const weekday = !["Sat", "Sun"].includes(wk);
  const inHours = hh >= 9 && hh < 19;
  return weekday && inHours;
}

function CurrentlyActiveWidget({ members, onSelect }) {
  const active = useMemo(
    () => members
      .filter((m) => m.activeNow && m.lastLoggedAt)
      .slice()
      .sort((a, b) => String(b.lastLoggedAt).localeCompare(String(a.lastLoggedAt))),
    [members],
  );
  const inactive = useMemo(
    () => members.filter((m) => !m.activeNow),
    [members],
  );
  const total = members.length;
  const businessHours = _isBusinessHoursIST();

  if (active.length === 0) {
    const msg = businessHours
      ? "⚠ No active members during business hours."
      : "No active members. Outside business hours.";
    const color = businessHours ? C.orange : C.muted;
    return (
      <div
        style={{
          background: businessHours ? `${C.orange}10` : "rgba(255,255,255,0.06)",
          border: `1px solid ${businessHours ? `${C.orange}30` : C.border}`,
          borderLeft: `3px solid ${color}`,
          borderRadius: 8,
          padding: "10px 16px",
          fontSize: 12,
          color,
          fontWeight: 500,
        }}
      >
        {msg}
      </div>
    );
  }

  return (
    <div
      style={{
        background: "rgba(61,197,139,0.05)",
        border: "1px solid rgba(61,197,139,0.20)",
        borderLeft: "3px solid #3DC58B",
        borderRadius: 8,
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#3DC58B", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#3DC58B", animation: "pulse-dot 2s infinite" }} />
        Currently Active ({active.length} of {total} team members)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {active.map((m, i) => (
          <button
            key={i}
            onClick={() => onSelect && onSelect(m.name)}
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: "6px 10px 6px 6px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
              color: C.pri,
              transition: "all 0.15s",
              textAlign: "left",
            }}
            title={formatTimeIST(m.lastLoggedAt)}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#3DC58B"; e.currentTarget.style.background = "rgba(61,197,139,0.08)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = "transparent"; }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: gradientFor(m.name),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 700,
                color: "#fff",
                flexShrink: 0,
              }}
            >
              {initials(m.name)}
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, minWidth: 160 }}>{m.name}</span>
            <span style={{ fontSize: 12, color: C.sec, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              · {m.lastLoggedClient || "—"}
            </span>
            <span style={{ fontSize: 11, color: "#3DC58B", fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>
              {timeAgo(m.lastLoggedAt)}
            </span>
          </button>
        ))}
      </div>
      {inactive.length > 0 && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2, lineHeight: 1.5 }}>
          Inactive ({inactive.length}): {inactive.map((m) => m.name).join(", ")}
        </div>
      )}
    </div>
  );
}


// ── Team Members table ────────────────────────────────────────────
// ── User dropdown selector ─────────────────────────────────────────
// TL-requested shortcut: pick a member from a dropdown to jump straight to
// their detail view. Augments the table below (does not replace it).
function UserSelectorDropdown({ members, onSelect }) {
  const [selected, setSelected] = useState("");
  const sorted = useMemo(() => {
    if (!Array.isArray(members)) return [];
    return [...members].sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""))
    );
  }, [members]);

  if (members === null) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
        <div className="kpi-skeleton" style={{ height: 40 }} />
      </div>
    );
  }
  if (sorted.length === 0) return null;

  function handleChange(e) {
    const name = e.target.value;
    setSelected(name);
    if (name && onSelect) onSelect(name);
  }

  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "16px 20px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: 0.8 }}>
        Select User
      </span>
      <select
        value={selected}
        onChange={handleChange}
        style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          color: C.pri,
          padding: "8px 14px",
          fontSize: 13,
          fontFamily: "'DM Sans', sans-serif",
          minWidth: 260,
          cursor: "pointer",
          outline: "none",
        }}
      >
        <option value="">— Pick a member to open their profile —</option>
        {sorted.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
            {typeof m.billable === "number" ? ` (${m.billable.toFixed(2)}h billable)` : ""}
          </option>
        ))}
      </select>
      <span style={{ fontSize: 11, color: C.muted, marginLeft: "auto" }}>
        {sorted.length} member{sorted.length === 1 ? "" : "s"} · click table row or use dropdown
      </span>
    </div>
  );
}


function TeamMembersTable({ members, onSelect }) {
  const [sort, setSort] = useState({ col: "billable", dir: "desc" });
  const sorted = useMemo(() => {
    if (!Array.isArray(members)) return [];
    const arr = [...members];
    arr.sort((a, b) => {
      const av = a[sort.col] ?? 0;
      const bv = b[sort.col] ?? 0;
      if (sort.col === "name") {
        return sort.dir === "asc"
          ? String(a.name).localeCompare(String(b.name))
          : String(b.name).localeCompare(String(a.name));
      }
      return sort.dir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [members, sort]);

  function toggle(col) {
    setSort((s) => ({ col, dir: s.col === col && s.dir === "asc" ? "desc" : "asc" }));
  }

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
    borderBottom: `1px solid rgba(255,255,255,0.05)`,
  };

  // Identify top-3 most underutilized for red accent
  const lowUtilSet = new Set();
  if (sorted.length > 0) {
    [...sorted]
      .filter((m) => m.hasActivity !== false && (m.utilPct ?? 0) < 75)
      .sort((a, b) => (a.utilPct ?? 0) - (b.utilPct ?? 0))
      .slice(0, 3)
      .forEach((m) => lowUtilSet.add(m.name));
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
        Team Members
      </div>
      {members === null ? (
        <div className="kpi-skeleton" style={{ height: 200 }} />
      ) : sorted.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 13, fontStyle: "italic", padding: "16px 0" }}>
          No team members matched timesheet rows for this period.
        </div>
      ) : (
        <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${C.border}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left", cursor: "pointer" }} onClick={() => toggle("name")}>
                  Member {sort.col === "name" && <span style={{ marginLeft: 4, opacity: 0.5, fontSize: 10 }}>{sort.dir === "asc" ? "▲" : "▼"}</span>}
                </th>
                {[
                  ["totalHours", "Total Hours"],
                  ["billable",   "Billable"],
                  ["committed",  "Committed"],
                ].map(([col, lbl]) => (
                  <th key={col} style={{ ...th, textAlign: "right" }} onClick={() => toggle(col)}>
                    {lbl}{sort.col === col && <span style={{ marginLeft: 4, opacity: 0.5, fontSize: 10 }}>{sort.dir === "asc" ? "▲" : "▼"}</span>}
                  </th>
                ))}
                <th style={{ ...th, textAlign: "left" }}>Last Logged</th>
                <th style={{ ...th, textAlign: "center" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m, i) => {
                const util = m.utilPct ?? 0;
                const st = statusInfo(util);
                const inactive = m.hasActivity === false;
                const baseBg = i % 2 === 0 ? "transparent" : C.surface;
                const isLow = lowUtilSet.has(m.name);
                const lastDotColor = m.activeNow ? "#3DC58B" : C.muted;
                const lastTooltip = m.lastLoggedAt
                  ? `${m.lastLoggedClient || "—"} · ${formatTimeIST(m.lastLoggedAt)}`
                  : "No activity recorded";
                return (
                  <tr
                    key={i}
                    onClick={() => onSelect && onSelect(m.name)}
                    style={{
                      background: baseBg,
                      cursor: "pointer",
                      transition: "background 0.12s",
                      borderLeft: isLow ? `3px solid ${C.red}` : "3px solid transparent",
                      opacity: inactive ? 0.55 : 1,
                      fontStyle: inactive ? "italic" : "normal",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(61,142,240,0.06)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = baseBg; }}
                  >
                    <td style={{ ...td, textAlign: "left" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: 7,
                            background: gradientFor(m.name),
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                            fontWeight: 700,
                            color: "#fff",
                          }}
                        >
                          {initials(m.name)}
                        </div>
                        <span style={{ fontWeight: 500 }}>{m.name}</span>
                        {m.trend === "up"   && <span style={{ color: C.green, marginLeft: 6 }}>▲</span>}
                        {m.trend === "down" && <span style={{ color: C.red,   marginLeft: 6 }}>▼</span>}
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>
                      {(m.totalHours ?? 0).toFixed(2)}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.teal }}>
                      {(m.billable ?? 0).toFixed(2)}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.blue }}>
                      {(m.committed ?? 0) > 0 ? (m.committed ?? 0).toFixed(2) : "—"}
                    </td>
                    <td
                      style={{ ...td, fontSize: 12 }}
                      title={lastTooltip}
                    >
                      {m.lastLoggedAt ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: lastDotColor,
                            flexShrink: 0,
                            animation: m.activeNow ? "pulse-dot 2s infinite" : "none",
                          }} />
                          <span style={{ color: m.activeNow ? "#3DC58B" : C.sec }}>
                            {timeAgo(m.lastLoggedAt)}
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: C.muted }}>—</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>
                      {inactive ? (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            color: "rgba(255,255,255,0.5)",
                            background: "rgba(255,255,255,0.05)",
                            padding: "3px 8px",
                            borderRadius: 20,
                            letterSpacing: 0.5,
                          }}
                        >
                          NO ACTIVITY
                        </span>
                      ) : (
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
                      )}
                    </td>
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
