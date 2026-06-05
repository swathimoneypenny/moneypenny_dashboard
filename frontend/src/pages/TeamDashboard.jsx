import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { C, API_BASE, authFetch } from "../config";
import { LiveIndicator, useAutoRefresh, timeAgo, formatTimeIST } from "../components/LiveIndicator";
import DelayDetailModal from "../components/DelayDetailModal";
import WeeklyReviewSection from "../components/WeeklyReviewSection";
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
  { key: "review",  label: "📋 Weekly Review" },
];

// TL-approved thresholds (verified 2026-05-25):
//   <80%       → BELOW TARGET  (yellow)
//   80–<100%   → ON TRACK      (green)
//   100–<120%  → ABOVE TARGET  (orange)
//   >=120%     → CRITICAL      (red)
function utilColor(pct) {
  if (pct < 80)   return C.yellow;
  if (pct < 100)  return C.green;
  if (pct < 120)  return C.orange;
  return C.red;
}

function statusInfo(pct) {
  if (pct < 80)   return { label: "BELOW TARGET", color: C.yellow, bg: C.statusYellow };
  if (pct < 100)  return { label: "ON TRACK",     color: C.green,  bg: C.statusGreen };
  if (pct < 120)  return { label: "ABOVE TARGET", color: C.orange, bg: C.statusOrange };
  return { label: "CRITICAL", color: C.red, bg: C.statusRed };
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
          {p.name}: <strong>{typeof p.value === "number" ? p.value.toFixed(1) : p.value}</strong>
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

function KpiCard({ label, value, color, suffix = "h", decimals = 1, sub }) {
  const animated = useCountUp(typeof value === "number" ? value : 0);
  const display = typeof value === "number"
    ? (decimals === 0 ? Math.round(animated).toString() : animated.toFixed(decimals))
    : "—";
  return (
    <div
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

function PerfTable({ orgs }) {
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
  const totalUtil = totals.committed > 0 ? (totals.billable / totals.committed) * 100 : 0;

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
              ["efficiency", "Util %"],
              ["gap",        "Gap"],
              ["committed",  "Committed"],
              ["billable",   "Utilized"],
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
            return (
              <tr
                key={i}
                style={{ transition: "background 0.12s", background: baseBg }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(61,142,240,0.05)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = baseBg; }}
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
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: committed > 0 ? utilColor(eff) : C.muted }}>
                  {committed > 0 ? `${eff.toFixed(1)}%` : "—"}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: committed > 0 ? (gap >= 0 ? C.green : C.red) : C.muted }}>
                  {committed > 0 ? `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}` : "—"}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: committed > 0 ? C.blue : C.muted }}>
                  {committed > 0 ? committed.toFixed(1) : "—"}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.teal }}>{(o.billable ?? 0).toFixed(1)}</td>
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
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: utilColor(totalUtil), borderTop: `2px solid ${C.border}` }}>{totalUtil.toFixed(1)}%</td>
            <td style={{ ...td, borderTop: `2px solid ${C.border}` }} />
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.blue, borderTop: `2px solid ${C.border}` }}>{totals.committed.toFixed(1)}</td>
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.teal, borderTop: `2px solid ${C.border}` }}>{totals.billable.toFixed(1)}</td>
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.orange, borderTop: `2px solid ${C.border}` }}>{totals.delays}</td>
            <td style={{ ...td, borderTop: `2px solid ${C.border}` }} colSpan={3} />
          </tr>
        </tfoot>
      </table>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap" }}>
        {[
          { color: C.yellow, label: "< 80% — Below Target" },
          { color: C.green,  label: "80–100% — On Track" },
          { color: C.orange, label: "100–120% — Above Target" },
          { color: C.red,    label: "≥ 120% — Critical" },
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
        borderBottom: i < members.length - 1 ? `1px solid ${C.border}40` : "none",
      }}
    >
      <span>{m.name}</span>
      <span style={{ color: C.sec }}>{(m.hours ?? 0).toFixed(1)}h</span>
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
          {dept.member_count} member{dept.member_count === 1 ? "" : "s"} · {(dept.total_hours ?? 0).toFixed(1)}h
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
  const abortRef = useRef(null);

  const fetchData = useCallback((silent = false) => {
    // The Weekly Review tab has its own data source (admin-review endpoint) —
    // don't hit /api/team/{id}/review (would 404 / hit the period catch-all).
    if (period === "review") return;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!silent) setLoading(true);
    authFetch(`/api/team/${teamId}/${period}`, { signal: ctrl.signal })
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
  }, [teamId, period]);

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
    if (lbAbortRef.current) lbAbortRef.current.abort();
    const ctrl = new AbortController();
    lbAbortRef.current = ctrl;
    setLeaderboard(null);
    authFetch(`/api/team/${teamId}/leaderboard/${period}`, { signal: ctrl.signal })
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
  }, [teamId, period]);

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

  const clients = useMemo(() => data?.clients ?? [], [data]);
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
  const totalHours = (summary.totalBillable ?? 0) + (summary.totalNonBillable ?? 0);

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
        "Util%":   b.committed > 0
          ? Math.round((b.booked / b.committed) * 1000) / 10
          : 0,
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
          "Util%":   committed > 0 ? Math.round((utilized / committed) * 1000) / 10 : 0,
        };
      });
  }, [eod, data]);

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

  // Chart 2 — Hours by Org, horizontal, sorted by total desc
  const hoursByOrg = useMemo(
    () => [...chartClients]
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
      .map((o) => ({
        name:  o.name,
        Hours: Number((o.total ?? 0).toFixed(1)),
      })),
    [chartClients]
  );

  // Chart 3 — Utilization rate per org
  const utilByOrg = useMemo(
    () => chartClients.map((o) => ({
      name: o.name,
      rate: Number((o.efficiency ?? 0).toFixed(1)),
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
  const matchedRows  = data?.matchedRows ?? 0;
  const totalRows    = data?.totalRows ?? 0;
  const fromCache    = !!data?.fromCache;
  const cacheAge     = data?.cacheAge ?? 0;
  const letter = (displayLabel ?? "").replace(/^Team\s+/i, "") || teamId?.slice(-1).toUpperCase();

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
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
                Lead: {displayLead}{rosterCount > 0 ? ` · ${rosterCount} ${rosterCount === 1 ? "member" : "members"}` : ""}
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
                background: period === p.key ? (p.key === "review" ? "#7C3AED" : C.blue) : "transparent",
                color: period === p.key ? "#fff" : C.sec,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

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
          <div style={{ fontSize: 11, color: C.muted }}>{periodLabel} · {today}</div>
        </div>
      </div>

      <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
        {period === "review" ? (
          <WeeklyReviewSection teamId={teamId} />
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
              ✓ Filtered by team roster: <strong>{rosterCount}</strong> member{rosterCount === 1 ? "" : "s"}{" — "}
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
            />
            <KpiCard label="Total Billable"  value={summary.totalBillable}  color={C.teal} />
            <KpiCard
              label="Utilization Rate"
              value={summary.overallEfficiency}
              color={utilColor(summary.overallEfficiency ?? 0)}
              suffix="%"
            />
            <KpiCard label="Non-Billable" value={summary.totalNonBillable} color={C.orange} />
            <KpiCard label="Total Hours"  value={totalHours}                color={C.purple} />
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
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <ChartCard title={`Committed vs Utilized Hours by Month (${currentYear})`}>
            {loading ? (
              <div className="kpi-skeleton" style={{ height: 260 }} />
            ) : monthlyEod.length === 0 ? (
              <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic" }}>
                No data for this period
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={monthlyEod} barGap={4} barCategoryGap="25%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="left" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} unit="%" />
                  <Tooltip content={<DarkTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11, color: C.sec }} />
                  <Bar yAxisId="left" dataKey="Committed" fill={C.blue}  radius={[4, 4, 0, 0]} />
                  <Bar yAxisId="left" dataKey="Utilized"  fill={C.green} radius={[4, 4, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="Util%" stroke={C.orange} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <ChartCard title="Hours by Organization">
            {loading ? (
              <div className="kpi-skeleton" style={{ height: 260 }} />
            ) : hoursByOrg.length === 0 ? (
              <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic" }}>
                No organization data
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={hoursByOrg} layout="vertical" barCategoryGap="25%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                  <XAxis type="number" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis dataKey="name" type="category" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={120} />
                  <Tooltip content={<DarkTooltip />} />
                  <Bar dataKey="Hours" fill={C.blue} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <ChartCard title="Utilization Rate by Organization">
            {loading ? (
              <div className="kpi-skeleton" style={{ height: 260 }} />
            ) : utilByOrg.length === 0 ? (
              <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic" }}>
                No organization data
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={utilByOrg} barCategoryGap="30%" margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fill: C.muted, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    unit="%"
                    domain={[0, 130]}
                    ticks={[0, 25, 50, 75, 95, 120]}
                  />
                  <Tooltip content={<DarkTooltip />} formatter={(v) => [`${Number(v).toFixed(1)}%`, "Util"]} />
                  <Bar dataKey="rate" radius={[4, 4, 0, 0]}>
                    {utilByOrg.map((entry, i) => (
                      <Cell key={i} fill={utilColor(entry.rate)} />
                    ))}
                    <LabelList
                      dataKey="rate"
                      position="top"
                      formatter={(v) => `${Number(v).toFixed(0)}%`}
                      style={{ fill: C.pri, fontSize: 10 }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

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
                <ResponsiveContainer width="100%" height={210}>
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
          </ChartCard>
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
            <PerfTable orgs={clients} />
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
    </div>
  );
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
              <span style={{ fontSize: 10, color: utilColor(m.utilPct ?? 0), fontFamily: "'DM Mono', monospace" }}>
                {(m.utilPct ?? 0).toFixed(1)}%
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
          background: businessHours ? `${C.orange}10` : `${C.muted}10`,
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
            {typeof m.utilPct === "number" ? ` (${m.utilPct.toFixed(0)}% util)` : ""}
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
  const [sort, setSort] = useState({ col: "utilPct", dir: "asc" });
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
    borderBottom: `1px solid ${C.border}40`,
  };

  // Identify top-3 most underutilized for red accent
  const lowUtilSet = new Set();
  if (sorted.length > 0) {
    [...sorted]
      .filter((m) => (m.utilPct ?? 0) < 75)
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
                  ["utilPct",    "Util %"],
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
                      {(m.totalHours ?? 0).toFixed(1)}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.teal }}>
                      {(m.billable ?? 0).toFixed(1)}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.blue }}>
                      {(m.committed ?? 0) > 0 ? (m.committed ?? 0).toFixed(1) : "—"}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: utilColor(util) }}>
                      {(m.committed ?? 0) > 0 ? `${util.toFixed(1)}%` : "—"}
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
          </table>
        </div>
      )}
    </div>
  );
}
