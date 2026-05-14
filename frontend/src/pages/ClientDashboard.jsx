import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { C, API_BASE, authFetch } from "../config";
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
  { key: "today",   label: "Today",      endpoint: "today" },
  { key: "weekly",  label: "This Week",  endpoint: "weekly" },
  { key: "monthly", label: "This Month", endpoint: "monthly" },
];

function utilColor(pct) {
  if (pct < 75)  return C.red;
  if (pct < 95)  return C.teal;
  if (pct <= 120) return C.green;
  return C.orange;
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
        maxWidth: 300,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: C.sec }}>
        {p.fullDateLabel || p.fullDate || `Day ${p.day}`}
      </div>
      <div style={{ marginBottom: 4, fontFamily: "'DM Mono', monospace" }}>
        Total: {total}
      </div>
      {(p.Completed ?? 0) > 0 && (
        <div style={{ color: "#3DC58B", fontSize: 11 }}>Completed: {p.Completed}</div>
      )}
      {(p.Fresh ?? 0) > 0 && (
        <div style={{ color: "#F0B947", fontSize: 11 }}>Fresh (0-2d): {p.Fresh}</div>
      )}
      {(p.Aging ?? 0) > 0 && (
        <div style={{ color: "#F2895A", fontSize: 11 }}>Aging (3-7d): {p.Aging}</div>
      )}
      {(p.Overdue ?? 0) > 0 && (
        <div style={{ color: "#E25C5C", fontSize: 11 }}>Overdue (8+d): {p.Overdue}</div>
      )}
      {p.queryPreview && (
        <div style={{ marginTop: 6, color: C.muted, fontSize: 11, fontStyle: "italic", lineHeight: 1.4 }}>
          “{p.queryPreview.slice(0, 60)}{p.queryPreview.length > 60 ? "…" : ""}”
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
      queryPreview: d.queryPreview || "",
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
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Staff Member</th>
            {[
              ["committed",   "Committed"],
              ["billable",    "Billable (h)"],
              ["nonBillable", "Non-Bill (h)"],
              ["utilPct",     "Util %"],
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
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: utilColor(util) }}>{util.toFixed(1)}%</td>
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
            <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: utilColor(totalUtil), borderTop: `2px solid ${C.border}` }}>{totalUtil.toFixed(1)}%</td>
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

// ── Main ─────────────────────────────────────────────────────────
export default function ClientDashboard({ clientName, onBack, onContextUpdate }) {
  const [period, setPeriod] = useState("monthly");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [trend, setTrend] = useState([]);
  const [trendLoading, setTrendLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const trendCacheRef = useRef({});
  const mainAbortRef  = useRef(null);
  const trendAbortRef = useRef(null);

  const fetchMain = useCallback(() => {
    if (mainAbortRef.current) mainAbortRef.current.abort();
    const ctrl = new AbortController();
    mainAbortRef.current = ctrl;
    const p = PERIODS.find((pp) => pp.key === period) ?? PERIODS[2];
    setLoading(true);
    authFetch(`/api/client/${encodeURIComponent(clientName)}/${p.endpoint}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setData({ summary: {}, staff: [] });
        setLoading(false);
      });
  }, [clientName, period]);

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
    const ctx = `Client: ${clientName} — ${data.period ?? ""}
Total: Committed ${summary.totalCommitted ?? "N/A"}h | Billable ${summary.totalBillable ?? 0}h | Non-Bill ${summary.totalNonBillable ?? 0}h | Util ${utilRate}%

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

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";

  const summary = data?.summary ?? {};

  const staff = useMemo(
    () => (data?.staff ?? []).map((s) => ({
      ...s,
      utilPct: s.committed > 0 ? (s.billable / s.committed) * 100 : 0,
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

  const staffUtil = useMemo(
    () => staff.map((s) => ({
      name: (s.staff ?? "").split(" ")[0],
      util: s.utilPct,
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
      committed:   summary.totalCommitted   ?? 0,
    }),
    [summary.totalBillable, summary.totalNonBillable, summary.totalCommitted, totalHours]
  );

  const agingSummary   = data?.delaysAgeSummary ?? null;
  const delaysByDay    = data?.delaysByDay ?? [];
  const agingChart     = useMemo(() => buildAgingChartData(delaysByDay), [delaysByDay]);
  const agingTotalOpen = (agingSummary?.totalOpen ?? 0);
  const agingHasAnyData = useMemo(
    () => agingChart.some((d) => (d.Completed + d["In Progress"] + d["Awaiting Response"]) > 0),
    [agingChart],
  );

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
                background: period === p.key ? C.blue : "transparent",
                color: period === p.key ? "#fff" : C.sec,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

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

      {/* Body */}
      <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
        {/* KPIs (skeleton or real) */}
        {loading ? (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {[1, 2, 3, 4, 5, 6].map((i) => <KpiSkeleton key={i} />)}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <KpiCard label="Total Committed" value={summary.totalCommitted} color={C.blue} />
            <KpiCard label="Total Billable"  value={summary.totalBillable}  color={C.teal} />
            <KpiCard
              label="Utilization Rate"
              value={summary.overallEfficiency}
              color={utilColor(summary.overallEfficiency ?? 0)}
              suffix="%"
            />
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

          {/* Utilization by Staff */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
              Utilization Rate by Staff
            </div>
            {loading ? (
              <div style={{ height: 220 }} className="kpi-skeleton" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={staffUtil} barCategoryGap="30%">
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} unit="%" />
                  <Tooltip content={<DarkTooltip />} formatter={(v) => [`${v.toFixed(1)}%`, "Util"]} />
                  <Bar dataKey="util" radius={[4, 4, 0, 0]}>
                    {staffUtil.map((entry, i) => (
                      <Cell key={i} fill={utilColor(entry.util)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Open Questions & Delays — Aging Report (from parent team's EOD sheet) */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
              Open Questions & Delays — Aging Report
            </div>
            {loading ? (
              <div style={{ height: 220 }} className="kpi-skeleton" />
            ) : !data?.hasEodSheet ? (
              <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic", textAlign: "center", padding: 16 }}>
                No EOD sheet configured for this team.
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
                  <BarChart data={agingChart} margin={{ top: 4, right: 8, left: -18, bottom: 36 }}>
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
                    <Bar dataKey="Completed" stackId="a" fill="#3DC58B" />
                    <Bar dataKey="Fresh"     stackId="a" fill="#F0B947" />
                    <Bar dataKey="Aging"     stackId="a" fill="#F2895A" />
                    <Bar dataKey="Overdue"   stackId="a" fill="#E25C5C" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
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
                  { label: "Committed",    value: hoursBreakdown.committed,   color: C.blue },
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
                          {label !== "Total Logged" && (
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
    </div>
  );
}
