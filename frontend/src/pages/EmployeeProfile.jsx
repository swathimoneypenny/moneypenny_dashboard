import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { C, authFetch } from "../config";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
  LabelList,
} from "recharts";

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

function KpiCard({ label, value, color, suffix = "h", decimals = 1 }) {
  const display = typeof value === "number"
    ? (decimals === 0 ? Math.round(value).toString() : value.toFixed(decimals))
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
      }}
    >
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 14, fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 38, fontWeight: 700, color, fontFamily: "'DM Mono', monospace", letterSpacing: -1, lineHeight: 1 }}>
        {display}
        {suffix && (
          <span style={{ fontSize: 16, fontWeight: 400, marginLeft: 4, color: C.sec }}>{suffix}</span>
        )}
      </div>
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>{title}</div>
      {children}
    </div>
  );
}

const today = new Date().toLocaleDateString("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export default function EmployeeProfile({ teamId, teamName, employeeName, onBack, onContextUpdate }) {
  const [period, setPeriod] = useState("monthly");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState(null);
  const abortRef = useRef(null);

  const fetchData = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    authFetch(
      `/api/team/${teamId}/employee/${encodeURIComponent(employeeName)}/${period}`,
      { signal: ctrl.signal },
    )
      .then((r) => r.json())
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        console.error("[EmployeeProfile] fetch failed", err);
        setData({});
        setLoading(false);
      });
  }, [teamId, employeeName, period]);

  useEffect(() => {
    fetchData();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchData]);

  // Push chatbot context
  useEffect(() => {
    if (!data || !onContextUpdate) return;
    const lines = (data.recentWork ?? []).slice(0, 5).map(
      (r) => `• ${r.date} ${r.client}: ${r.hours}h ${r.billable ? "[billable]" : "[non-billable]"} — ${r.desc?.slice(0, 80) || ""}`,
    );
    const ctx = `Employee: ${data.name ?? employeeName} (${data.team_name ?? teamName}) — ${data.period ?? ""}
Total ${data.totalHours ?? 0}h | Billable ${data.billableHours ?? 0}h | Non-bill ${data.nonBillableHours ?? 0}h | Util ${data.utilizationPct ?? 0}%
Top clients: ${(data.topClients ?? []).map((c) => `${c.client} (${c.hours}h)`).join(", ")}
Recent:
${lines.join("\n")}`;
    onContextUpdate(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const dailyChart = useMemo(() => {
    const dh = data?.dailyHours ?? [];
    return dh.map((d) => {
      const date = String(d.date ?? "");
      const day  = date.length >= 10 ? Number(date.slice(8, 10)) : "";
      return {
        date: String(day || date.slice(-2) || ""),
        Billable: Number(d.billable) || 0,
        NonBillable: Number(d.nonBillable) || 0,
      };
    });
  }, [data]);

  const dailyChartHasData = useMemo(
    () => dailyChart.some((d) => (d.Billable ?? 0) > 0 || (d.NonBillable ?? 0) > 0),
    [dailyChart],
  );

  const topClientsChart = useMemo(
    () => (data?.topClients ?? [])
      .slice()
      .sort((a, b) => (Number(b.hours) || 0) - (Number(a.hours) || 0))
      .slice(0, 5)
      .map((c) => {
        const hours    = Number(c.hours) || 0;
        const billable = Number(c.billable) || 0;
        const ratio    = hours > 0 ? billable / hours : 0;
        const color    = ratio >= 0.95 ? C.green : ratio >= 0.75 ? C.orange : C.red;
        return { name: c.client, Hours: Number(hours.toFixed(1)), color };
      }),
    [data],
  );

  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";
  const name        = data?.name ?? employeeName;
  const teamLabel   = data?.team_name ?? teamName;

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
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.blue; e.currentTarget.style.color = C.pri; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.sec; }}
        >
          ← Back
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: gradientFor(name),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              fontWeight: 700,
              color: "#fff",
            }}
          >
            {initials(name)}
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.pri, letterSpacing: -0.3 }}>
              {name}
            </div>
            <div style={{ fontSize: 12, color: C.sec, marginTop: 2 }}>
              <span
                style={{
                  background: `${C.blue}22`,
                  color: C.blue,
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                }}
              >
                {teamLabel}
              </span>
            </div>
          </div>
        </div>

        {/* Period selector */}
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
                background: period === p.key ? C.blue : "transparent",
                color: period === p.key ? "#fff" : C.sec,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ textAlign: "right", marginLeft: "auto" }}>
          <div style={{ fontSize: 13, fontWeight: 700, background: "linear-gradient(135deg,#00c896,#3d8ef0)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            MoneyPenny LLC
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>{periodLabel} · {today}</div>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
        {/* KPIs */}
        {loading ? (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="kpi-skeleton" style={{ flex: "1 1 200px", minWidth: 180, height: 124, borderRadius: 12 }} />
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <KpiCard label="Total Hours"     value={data?.totalHours}     color={C.purple} />
            <KpiCard label="Billable Hours"  value={data?.billableHours}  color={C.teal} />
            <KpiCard label="Billable %"      value={data?.billablePct}    color={C.green} suffix="%" />
            <KpiCard label="Utilization %"   value={data?.utilizationPct} color={utilColor(data?.utilizationPct ?? 0)} suffix="%" />
          </div>
        )}

        {/* Daily Hours chart */}
        <ChartCard title="Daily Hours">
          {loading ? (
            <div className="kpi-skeleton" style={{ height: 260 }} />
          ) : !dailyChartHasData ? (
            <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic" }}>
              No data for this period.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={dailyChart} margin={{ top: 4, right: 8, left: -18, bottom: 36 }}>
                <CartesianGrid vertical={false} stroke={C.border} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: C.muted, fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                  angle={-45}
                  textAnchor="end"
                  height={50}
                />
                <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip content={<DarkTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11, color: C.sec }} />
                <Bar dataKey="Billable"    stackId="a" fill={C.teal}   radius={[0, 0, 0, 0]} />
                <Bar dataKey="NonBillable" stackId="a" fill={C.orange} radius={[4, 4, 0, 0]} name="Non-Billable" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Top Clients chart */}
        <ChartCard title="Top Clients">
          {loading ? (
            <div className="kpi-skeleton" style={{ height: 200 }} />
          ) : topClientsChart.length === 0 ? (
            <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, fontStyle: "italic" }}>
              No client hours yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={topClientsChart} layout="vertical" margin={{ top: 4, right: 56, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                <XAxis type="number" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis dataKey="name" type="category" tick={{ fill: C.muted, fontSize: 11 }} axisLine={false} tickLine={false} width={140} />
                <Tooltip content={<DarkTooltip />} />
                <Bar dataKey="Hours" radius={[0, 4, 4, 0]} barSize={28}>
                  {topClientsChart.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                  <LabelList
                    dataKey="Hours"
                    position="right"
                    formatter={(v) => `${Number(v).toFixed(1)}h`}
                    style={{ fill: C.pri, fontSize: 11 }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Recent Work */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>
            Recent Work
          </div>
          {loading ? (
            <div className="kpi-skeleton" style={{ height: 200 }} />
          ) : (data?.recentWork?.length ?? 0) === 0 ? (
            <div style={{ color: C.muted, fontSize: 13, fontStyle: "italic", padding: "16px 0" }}>
              No recent work in this period.
            </div>
          ) : (
            <div style={{ overflowX: "auto", maxHeight: 480, overflowY: "auto", borderRadius: 8, border: `1px solid ${C.border}` }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
                  <tr>
                    {["Date", "Client", "Hours", "Billable", "Description"].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "12px 14px",
                          fontSize: 11,
                          color: C.muted,
                          textTransform: "uppercase",
                          letterSpacing: 0.8,
                          textAlign: h === "Hours" ? "right" : "left",
                          borderBottom: `1px solid ${C.border}`,
                          background: C.card,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.recentWork.map((r, i) => {
                    const expanded = expandedRow === i;
                    const desc = r.desc ?? "";
                    const isLong = desc.length > 80;
                    const shown = expanded || !isLong ? desc : `${desc.slice(0, 80)}…`;
                    const baseBg = i % 2 === 0 ? "transparent" : C.surface;
                    return (
                      <tr
                        key={i}
                        onClick={() => isLong && setExpandedRow(expanded ? null : i)}
                        style={{ background: baseBg, cursor: isLong ? "pointer" : "default", transition: "background 0.12s" }}
                      >
                        <td style={{ padding: "10px 14px", fontSize: 12, color: C.sec, fontFamily: "'DM Mono', monospace", borderBottom: `1px solid ${C.border}40` }}>
                          {r.date}
                        </td>
                        <td style={{ padding: "10px 14px", fontSize: 12, color: C.pri, borderBottom: `1px solid ${C.border}40` }}>
                          {r.client}
                        </td>
                        <td style={{ padding: "10px 14px", fontSize: 12, color: C.teal, fontFamily: "'DM Mono', monospace", textAlign: "right", borderBottom: `1px solid ${C.border}40` }}>
                          {Number(r.hours ?? 0).toFixed(1)}
                        </td>
                        <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}40` }}>
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              color: r.billable ? C.teal : C.orange,
                              background: r.billable ? `${C.teal}18` : `${C.orange}18`,
                              padding: "3px 8px",
                              borderRadius: 20,
                              letterSpacing: 0.5,
                            }}
                          >
                            {r.billable ? "BILLABLE" : "NON-BILL"}
                          </span>
                        </td>
                        <td style={{ padding: "10px 14px", fontSize: 12, color: C.sec, borderBottom: `1px solid ${C.border}40`, maxWidth: 480 }}>
                          {shown}
                          {isLong && (
                            <span style={{ color: C.muted, marginLeft: 8, fontSize: 10 }}>
                              {expanded ? "(click to collapse)" : "(click to expand)"}
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
      </div>
    </div>
  );
}
