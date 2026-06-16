import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, Cell,
} from "recharts";
import { authFetch, C } from "../config";

// Per-client BOD vs EOD comparison dashboard. Data source: per-team
// BOD_EOD_TAB_GIDS in backend/main.py — each client = one tab on the team's
// Google Sheet, with one row per day capturing Committed/Booked hours + plan
// vs actual status blocks.

const BLUE   = "#4A8FE7";
const GREEN  = "#10B981";
const ORANGE = "#F2895A";
const RED    = "#EF4444";
const YELLOW = "#F0B947";

export default function BodEodReview({ teamId }) {
  const [payload, setPayload]               = useState(null);
  const [loading, setLoading]               = useState(true);
  const [err, setErr]                       = useState(null);
  const [selectedClient, setSelectedClient] = useState(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/team/${teamId}/bod-eod`);
      const j = await r.json();
      setPayload(j);
      if (j?.clients?.length && !selectedClient) {
        setSelectedClient(j.clients[0].client_name);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [teamId]);

  const client = useMemo(() => {
    if (!payload?.clients?.length) return null;
    return payload.clients.find((c) => c.client_name === selectedClient) || payload.clients[0];
  }, [payload, selectedClient]);

  const entries = client?.entries || [];
  const latest  = entries.length ? entries[entries.length - 1] : null;
  const summary = payload?.summary || {};
  const heatmap = client?.heatmap || { dates: [], categories: [], bod: {}, eod: {}, diff: {} };

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: C.sec, fontWeight: 700 }}>
        Loading BOD/EOD data…
      </div>
    );
  }

  if (err) {
    return (
      <div style={panelStyle()}>
        <div style={{ color: RED, fontWeight: 800, marginBottom: 6 }}>Failed to load BOD/EOD data</div>
        <div style={{ color: C.sec, fontSize: 12 }}>{err}</div>
      </div>
    );
  }

  if (payload?.error) {
    return (
      <div style={panelStyle()}>
        <div style={{ color: YELLOW, fontWeight: 800, marginBottom: 6 }}>
          {payload.error === "no_bod_eod_mapping"
            ? "BOD/EOD not configured for this team"
            : payload.error === "no_sheet_id"
            ? "No Google Sheet configured for this team"
            : payload.error_detail || payload.error}
        </div>
        {payload.error_detail && (
          <div style={{ color: C.sec, fontSize: 12 }}>{payload.error_detail}</div>
        )}
      </div>
    );
  }

  if (!payload?.clients?.length) {
    return (
      <div style={panelStyle()}>
        <div style={{ color: C.sec, fontWeight: 700 }}>
          No BOD/EOD data available for this team yet.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Team-level KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <KpiCard label="Total Committed" value={`${num(summary.total_committed)}h`} color={BLUE} />
        <KpiCard label="Total Booked"    value={`${num(summary.total_booked)}h`}    color={GREEN} />
        <KpiCard
          label="Variance"
          value={`${summary.variance >= 0 ? "+" : ""}${num(summary.variance)}h`}
          color={summary.variance >= 0 ? GREEN : RED}
        />
        <KpiCard
          label="Efficiency"
          value={`${Math.round(summary.efficiency_pct || 0)}%`}
          color={summary.efficiency_pct >= 80 ? GREEN : YELLOW}
        />
      </div>

      {/* Client selector + refresh */}
      <div style={{ ...panelStyle(), padding: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <label style={{
          color: C.pri, fontWeight: 800, fontSize: 11,
          textTransform: "uppercase", letterSpacing: 0.8,
        }}>
          Client
        </label>
        <select
          value={selectedClient || ""}
          onChange={(e) => setSelectedClient(e.target.value)}
          style={{
            background: "rgba(255,255,255,0.06)",
            color: C.pri,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "6px 12px",
            fontWeight: 700,
            minWidth: 240,
            cursor: "pointer",
          }}
        >
          {payload.clients.map((c) => (
            <option key={c.client_name} value={c.client_name}>{c.client_name}</option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        <span style={{ color: C.muted, fontSize: 11, fontWeight: 600 }}>
          {summary.clients_count} client{summary.clients_count === 1 ? "" : "s"} ·{" "}
          {summary.days_tracked} day{summary.days_tracked === 1 ? "" : "s"} tracked
        </span>
        <button
          onClick={load}
          style={{
            background: "transparent",
            border: `1px solid ${C.border}`,
            color: C.pri,
            borderRadius: 6,
            padding: "6px 12px",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.4,
          }}
          title="Refresh BOD/EOD data"
        >
          ⟳ Refresh
        </button>
      </div>

      {/* Committed vs Booked trend */}
      {entries.length > 0 && (
        <div style={panelStyle()}>
          <SectionTitle>📈 Committed vs Booked Hours · {client?.client_name}</SectionTitle>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={entries} margin={{ top: 12, right: 20, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: C.sec, fontSize: 10, fontWeight: 700 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 10, fontWeight: 700 }} tickFormatter={(v) => `${v}h`} />
              <Tooltip
                cursor={{ stroke: "rgba(255,255,255,0.20)" }}
                contentStyle={tooltipStyle()}
                formatter={(v, n) => [`${Number(v).toFixed(1)}h`, n]}
              />
              <Legend wrapperStyle={{ color: C.pri, fontWeight: 700 }} />
              <Line
                type="monotone"
                dataKey="committed_hours"
                stroke={BLUE}
                strokeWidth={3}
                name="Committed (Target)"
                dot={{ r: 4, fill: BLUE }}
                activeDot={{ r: 6, stroke: "#FFFFFF", strokeWidth: 2 }}
              />
              <Line
                type="monotone"
                dataKey="booked_hours"
                stroke={GREEN}
                strokeWidth={3}
                name="Booked (Actual)"
                dot={{ r: 4, fill: GREEN }}
                activeDot={{ r: 6, stroke: "#FFFFFF", strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Three heatmaps: BOD plan, EOD actual, Diff. Built from the
          backend-shipped client.heatmap payload — same date axis + same
          canonical category rows across all three so they line up. */}
      {heatmap.dates.length > 0 && heatmap.categories.length > 0 && (
        <>
          <Heatmap
            title={`BOD — Daily Plans · ${client?.client_name}`}
            icon="🌅"
            colorRgb="74, 143, 231"
            dates={heatmap.dates}
            categories={heatmap.categories}
            data={heatmap.bod}
          />
          <Heatmap
            title={`EOD — Daily Actuals · ${client?.client_name}`}
            icon="🌆"
            colorRgb="16, 185, 129"
            dates={heatmap.dates}
            categories={heatmap.categories}
            data={heatmap.eod}
          />
          <Heatmap
            title={`Comparison — Diff (EOD Actual − BOD Plan) · ${client?.client_name}`}
            icon="⚖️"
            colorRgb=""
            dates={heatmap.dates}
            categories={heatmap.categories}
            data={heatmap.diff}
            isDiff
          />
        </>
      )}

      {/* Latest-day notes / EOD-only fields that don't fit the heatmap */}
      {latest && (
        ((latest.bod && (latest.bod.special_task_plan || latest.bod.practice_protect || latest.bod.email_checked || latest.bod.staff_coverage))
        || (latest.eod && (latest.eod.special_task_actual || latest.eod.whale_updates || latest.eod.timesheets || latest.eod.review || latest.eod.workflow))
        || latest.notes || latest.mpllc_reply || latest.training) && (
          <div style={panelStyle()}>
            <SectionTitle>🗒️ Latest Day Notes · {latest.date}</SectionTitle>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <NotesGroup color={BLUE} title="🌅 BOD" items={[
                ["Practice Protect", latest.bod.practice_protect],
                ["Email Checked",    latest.bod.email_checked],
                ["Staff Coverage",   latest.bod.staff_coverage],
                ["Special Task",     latest.bod.special_task_plan],
              ]} />
              <NotesGroup color={GREEN} title="🌆 EOD" items={[
                ["Whale Updates", latest.eod.whale_updates],
                ["Timesheets",    latest.eod.timesheets],
                ["Review",        latest.eod.review],
                ["Workflow",      latest.eod.workflow],
                ["Special Task",  latest.eod.special_task_actual],
              ]} />
            </div>
            {(latest.notes || latest.mpllc_reply || latest.training) && (
              <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                {latest.notes      && <NotesGroup title="Notes"       items={[["", latest.notes]]} />}
                {latest.mpllc_reply && <NotesGroup title="MPLLC Reply" items={[["", latest.mpllc_reply]]} />}
                {latest.training   && <NotesGroup title="Training"     items={[["", latest.training]]} />}
              </div>
            )}
          </div>
        )
      )}

      {/* Daily history */}
      {entries.length > 0 && (
        <div style={panelStyle()}>
          <SectionTitle>📜 Daily History · {client?.client_name}</SectionTitle>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.04)" }}>
                  <Th align="left">Date</Th>
                  <Th align="right">Committed</Th>
                  <Th align="right">Booked</Th>
                  <Th align="right">Variance</Th>
                  <Th align="right">Efficiency</Th>
                </tr>
              </thead>
              <tbody>
                {[...entries].reverse().map((e, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <Td>{e.date}</Td>
                    <Td align="right" mono>{e.committed_hours.toFixed(1)}h</Td>
                    <Td align="right" mono>{e.booked_hours.toFixed(1)}h</Td>
                    <Td align="right" mono color={e.variance_hours >= 0 ? GREEN : RED}>
                      {e.variance_hours >= 0 ? "+" : ""}{e.variance_hours.toFixed(1)}h
                    </Td>
                    <Td align="right" mono color={e.efficiency_pct >= 80 ? GREEN : YELLOW}>
                      {Math.round(e.efficiency_pct)}%
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function KpiCard({ label, value, color }) {
  return (
    <div style={{
      background:   C.card,
      borderLeft:   `4px solid ${color}`,
      border:       `1px solid ${C.border}`,
      borderRadius: 12,
      padding:      "14px 16px",
    }}>
      <div style={{
        fontSize: 10, color: C.muted, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 1, marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 22, color, fontWeight: 800, fontFamily: "'DM Mono', monospace" }}>
        {value}
      </div>
    </div>
  );
}

// ── Heatmap ─────────────────────────────────────────────────────────
// Sticky-left category column, dates across the top. Cell intensity scales
// against the max abs value in the whole grid so a 100-file day still
// distinguishes from a 3-file day.
function Heatmap({ title, icon, colorRgb, dates, categories, data, isDiff = false }) {
  // Max-abs scale across the whole grid.
  let maxAbs = 0;
  for (const cat of categories) {
    const row = data[cat] || {};
    for (const d of dates) {
      const v = row[d];
      if (typeof v === "number" && Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
  }
  if (maxAbs === 0) maxAbs = 1;

  const fmt = (v) => {
    if (v === undefined || v === null) return "—";
    if (isDiff && v > 0) return `+${stripTrailing(v.toFixed(1))}`;
    return stripTrailing(v.toFixed(1));
  };

  const cellBg = (v) => {
    if (v === undefined || v === null) return "rgba(255,255,255,0.02)";
    if (isDiff) {
      if (v === 0) return "rgba(255,255,255,0.04)";
      const a = 0.18 + Math.min(Math.abs(v) / maxAbs, 1) * 0.55;
      return v > 0
        ? `rgba(16, 185, 129, ${a})`
        : `rgba(239, 68, 68, ${a})`;
    }
    const a = 0.12 + (v / maxAbs) * 0.6;
    return `rgba(${colorRgb}, ${a})`;
  };

  return (
    <div style={panelStyle()}>
      <SectionTitle>{icon} {title}</SectionTitle>
      <div style={{ overflowX: "auto" }}>
        <table style={{
          borderCollapse: "separate",
          borderSpacing: 2,
          width: "100%",
          minWidth: 720,
        }}>
          <thead>
            <tr>
              <th style={{
                padding: "8px 10px",
                textAlign: "left",
                color: C.pri,
                fontSize: 11,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                background: "rgba(255,255,255,0.04)",
                position: "sticky",
                left: 0,
                zIndex: 1,
                minWidth: 150,
              }}>
                Category
              </th>
              {dates.map((d) => (
                <th key={d} style={{
                  padding: "6px 6px",
                  textAlign: "center",
                  color: C.pri,
                  fontSize: 10,
                  fontWeight: 800,
                  background: "rgba(255,255,255,0.04)",
                  whiteSpace: "nowrap",
                  fontFamily: "'DM Mono', monospace",
                }}>
                  {shortDate(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat}>
                <td style={{
                  padding: "8px 10px",
                  color: C.pri,
                  fontSize: 12,
                  fontWeight: 700,
                  background: "rgba(255,255,255,0.04)",
                  position: "sticky",
                  left: 0,
                  zIndex: 1,
                  whiteSpace: "nowrap",
                }}>
                  {cat}
                </td>
                {dates.map((d) => {
                  const v = data[cat]?.[d];
                  return (
                    <td key={d}
                      title={v === undefined || v === null ? `${cat} · ${d}: no data` : `${cat} · ${d}: ${fmt(v)}`}
                      style={{
                        padding: "8px 4px",
                        textAlign: "center",
                        background: cellBg(v),
                        color: v === undefined || v === null ? C.muted : C.pri,
                        fontSize: 11,
                        fontWeight: 800,
                        fontFamily: "'DM Mono', monospace",
                        borderRadius: 4,
                        minWidth: 52,
                      }}
                    >
                      {fmt(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isDiff ? (
        <div style={{
          display: "flex", justifyContent: "center", gap: 24,
          marginTop: 12, fontSize: 11, color: C.sec, fontWeight: 700,
          flexWrap: "wrap",
        }}>
          <LegendSwatch color="rgba(16, 185, 129, 0.7)">Actual &gt; Plan (positive)</LegendSwatch>
          <LegendSwatch color="rgba(239, 68, 68, 0.7)">Actual &lt; Plan (negative)</LegendSwatch>
          <LegendSwatch color="rgba(255,255,255,0.04)">On target / missing</LegendSwatch>
        </div>
      ) : (
        <div style={{
          display: "flex", justifyContent: "center", gap: 12,
          marginTop: 12, fontSize: 11, color: C.muted, fontWeight: 700,
        }}>
          <span>0</span>
          <div style={{
            width: 160, height: 12, borderRadius: 4,
            background: `linear-gradient(90deg, rgba(${colorRgb},0.12) 0%, rgba(${colorRgb},0.72) 100%)`,
          }} />
          <span>{stripTrailing(maxAbs.toFixed(1))}</span>
        </div>
      )}
    </div>
  );
}

function LegendSwatch({ color, children }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 16, height: 12, background: color, borderRadius: 3 }} />
      {children}
    </span>
  );
}

function NotesGroup({ color, title, items }) {
  const visible = (items || []).filter(([, v]) => v && String(v).trim() !== "");
  if (visible.length === 0) return null;
  return (
    <div style={{
      padding: 12, background: "rgba(255,255,255,0.04)",
      borderRadius: 8,
      borderLeft: color ? `4px solid ${color}` : `1px solid ${C.border}`,
    }}>
      <div style={{
        fontSize: 11, color: color || C.sec, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6,
      }}>
        {title}
      </div>
      {visible.map(([k, v], i) => (
        <div key={i} style={{ fontSize: 11, color: C.pri, fontWeight: 600, marginBottom: 4 }}>
          {k && <span style={{ color: C.sec, fontWeight: 800, marginRight: 6 }}>{k}:</span>}
          {v}
        </div>
      ))}
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <h3 style={{
      color: C.pri, fontSize: 13, fontWeight: 800,
      textTransform: "uppercase", letterSpacing: 0.6, margin: "0 0 12px 0",
    }}>
      {children}
    </h3>
  );
}

function Th({ children, align = "left" }) {
  return (
    <th style={{
      padding: 10,
      textAlign: align,
      fontWeight: 800,
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      color: C.pri,
      borderBottom: `2px solid ${C.border}`,
    }}>
      {children}
    </th>
  );
}

function Td({ children, align = "left", mono = false, color }) {
  return (
    <td style={{
      padding: 10,
      textAlign: align,
      fontWeight: 700,
      color: color || C.pri,
      fontFamily: mono ? "'DM Mono', monospace" : "inherit",
      fontSize: 12,
    }}>
      {children}
    </td>
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function panelStyle() {
  return {
    background:   C.card,
    border:       `1px solid ${C.border}`,
    borderRadius: 12,
    padding:      20,
  };
}

function tooltipStyle() {
  return {
    background: "#050810",
    border:     `1px solid ${C.borderStrong}`,
    borderRadius: 8,
    color:      C.pri,
    fontWeight: 700,
    fontSize:   12,
  };
}

function num(v) {
  return (Number(v) || 0).toFixed(1);
}

function stripTrailing(s) {
  // ".0" suffix is noise on integer file counts but keep it for hours
  return /^-?\d+\.0$/.test(s) ? s.slice(0, -2) : s;
}

function shortDate(d) {
  if (!d) return d;
  // Sheet ships M/D/YYYY or MM/DD/YYYY — render MM/DD for the heatmap header
  const m = /^(\d{1,2})[/-](\d{1,2})/.exec(String(d));
  if (!m) return String(d).slice(0, 5);
  return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}`;
}
