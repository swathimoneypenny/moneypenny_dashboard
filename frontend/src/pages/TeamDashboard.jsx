import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { C, API_BASE } from "../config";
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
];

function utilColor(pct) {
  if (pct < 75)   return C.red;
  if (pct < 95)   return C.teal;
  if (pct <= 120) return C.green;
  return C.orange;
}

function statusInfo(pct) {
  if (pct < 75)   return { label: "BELOW TARGET", color: C.red,    bg: C.statusRed };
  if (pct < 95)   return { label: "ON TARGET",    color: C.teal,   bg: C.statusGreen };
  if (pct <= 120) return { label: "OVER TARGET",  color: C.green,  bg: C.statusGreen };
  return { label: "CRITICAL", color: C.orange, bg: C.statusOrange };
}

function delayColor(count) {
  if (count <= 0) return C.muted;
  if (count <= 2) return "#f6c343";
  if (count <= 5) return C.orange;
  return C.red;
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
            <th style={{ ...th, textAlign: "center" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((o, i) => {
            const eff = o.efficiency ?? 0;
            const gap = o.gap ?? 0;
            const st = statusInfo(eff);
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
                      }}
                    >
                      {initials(o.name ?? "?")}
                    </div>
                    <span style={{ fontWeight: 500, color: C.pri }}>{o.name}</span>
                  </div>
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: utilColor(eff) }}>{eff.toFixed(1)}%</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: gap >= 0 ? C.green : C.red }}>
                  {gap >= 0 ? "+" : ""}{gap.toFixed(1)}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.blue }}>{(o.committed ?? 0).toFixed(1)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: C.teal }}>{(o.billable ?? 0).toFixed(1)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "'DM Mono', monospace", color: delayColor(delays), fontWeight: 600 }}>{delays}</td>
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
            <td style={{ ...td, borderTop: `2px solid ${C.border}` }} />
          </tr>
        </tfoot>
      </table>
      </div>

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

// ── Main ───────────────────────────────────────────────────────────
export default function TeamDashboard({ teamId, teamName, onBack, onContextUpdate }) {
  const [period, setPeriod] = useState("monthly");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(() => {
    setLoading(true);
    fetch(`${API}/api/team/${teamId}/${period}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        console.error("[TeamDashboard] fetch failed", err);
        setData({ summary: {}, clients: [], eod: [] });
        setLoading(false);
      });
  }, [teamId, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

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

  // Chart 1 — EOD aggregated by month (handles M/D/YY and YYYY-MM-DD)
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

    return Object.values(buckets)
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
      .map((b) => ({
        month:     b.month,
        Committed: Math.round(b.committed * 10) / 10,
        Utilized:  Math.round(b.booked * 10) / 10,
        "Util%":   b.committed > 0
          ? Math.round((b.booked / b.committed) * 1000) / 10
          : 0,
      }));
  }, [eod]);

  // Chart 2 — Hours by Org, horizontal, sorted by total desc
  const hoursByOrg = useMemo(
    () => [...clients]
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
      .map((o) => ({
        name:  o.name,
        Hours: Number((o.total ?? 0).toFixed(1)),
      })),
    [clients]
  );

  // Chart 3 — Utilization rate per org
  const utilByOrg = useMemo(
    () => clients.map((o) => ({
      name: o.name,
      rate: Number((o.efficiency ?? 0).toFixed(1)),
    })),
    [clients]
  );

  // Chart 4 — Daily delays from EOD sheet (this month)
  const delaysData = useMemo(
    () => eod
      .map((row) => ({
        date:   row.date ? String(row.date).slice(5, 10) : "",
        delays: Number(row.delays ?? 0) || 0,
      }))
      .filter((d) => d.date),
    [eod]
  );

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

        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.teal }}>
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: C.teal,
              animation: "pulse-dot 2s infinite",
            }}
          />
          Live
        </div>

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

        {/* Setup-needed message */}
        {!loading && data?.needsRosterSetup && (
          <div
            style={{
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              padding: "48px 32px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 16 }}>⚙️</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.pri, marginBottom: 8 }}>
              Team Roster Not Configured
            </div>
            <div
              style={{
                fontSize: 13,
                color: C.muted,
                maxWidth: 420,
                margin: "0 auto",
                lineHeight: 1.8,
              }}
            >
              To show {displayLabel} data, add team member names to the roster.
            </div>
            <div
              style={{
                marginTop: 20,
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: "12px 16px",
                fontSize: 11,
                color: C.sec,
                fontFamily: "'DM Mono', monospace",
                textAlign: "left",
                maxWidth: 480,
                marginLeft: "auto",
                marginRight: "auto",
              }}
            >
              Visit: /api/team/{teamId}/detect-roster
              <br />
              to see all staff names, then add to TEAM_ROSTERS in main.py
            </div>
          </div>
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

        {!data?.needsRosterSetup && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <ChartCard title={`Committed vs Utilized Hours by Month (${currentYear})`}>
            {loading ? (
              <div className="kpi-skeleton" style={{ height: 260 }} />
            ) : monthlyEod.length === 0 ? (
              <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic" }}>
                No EOD data available
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

          <ChartCard title="Daily Delays — This Month">
            {loading ? (
              <div className="kpi-skeleton" style={{ height: 260 }} />
            ) : delaysData.length === 0 ? (
              <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic" }}>
                No EOD data available
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={delaysData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={C.border} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fill: C.sec, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<DarkTooltip />} formatter={(v) => [`${v} delays`, "Delays"]} />
                  <Bar dataKey="delays" name="Delays" radius={[4, 4, 0, 0]}>
                    {delaysData.map((d, i) => (
                      <Cell
                        key={i}
                        fill={d.delays === 0 ? C.green : d.delays <= 3 ? C.orange : C.red}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
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
      </div>
    </div>
  );
}
