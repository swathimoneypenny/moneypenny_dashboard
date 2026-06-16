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

      {/* BOD vs EOD side-by-side — latest day */}
      {latest && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <SidePanel
            color={BLUE}
            title={`🌅 BOD — Plan (${latest.date})`}
            adminRows={[
              ["Practice Protect", latest.bod.practice_protect],
              ["Email Checked",    latest.bod.email_checked],
              ["Staff Coverage",   latest.bod.staff_coverage],
            ]}
            blocks={[
              ["📋 Monthly Plan", latest.bod.monthly_plan],
              ["📌 Daily Plan",   latest.bod.daily_plan],
              ["📅 Weekly Plan",  latest.bod.weekly_plan],
            ]}
            footer={latest.bod.special_task_plan && (
              <FooterRow label="Special Task" value={latest.bod.special_task_plan} />
            )}
          />
          <SidePanel
            color={GREEN}
            title={`🌆 EOD — Actual (${latest.date})`}
            adminRows={[
              ["Whale Updates", latest.eod.whale_updates],
              ["Timesheets",    latest.eod.timesheets],
              ["Review",        latest.eod.review],
              ["Workflow",      latest.eod.workflow],
            ]}
            blocks={[
              ["📋 Monthly Actual", latest.eod.monthly_actual],
              ["📌 Daily Actual",   latest.eod.daily_actual],
              ["📅 Weekly Actual",  latest.eod.weekly_actual],
            ]}
            footer={latest.eod.special_task_actual && (
              <FooterRow label="Special Task" value={latest.eod.special_task_actual} />
            )}
          />
        </div>
      )}

      {/* BOD plan vs EOD actual variance bar chart */}
      {latest?.comparison && Object.keys(latest.comparison).length > 0 && (
        <div style={panelStyle()}>
          <SectionTitle>🔄 BOD Plan vs EOD Actual · {latest.date}</SectionTitle>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={Object.entries(latest.comparison).map(([k, v]) => ({
                category: shortLabel(k),
                Planned:  v.planned,
                Actual:   v.actual,
              }))}
              margin={{ top: 16, right: 20, left: 0, bottom: 50 }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="category"
                tick={{ fill: C.sec, fontSize: 10, fontWeight: 700 }}
                angle={-25}
                textAnchor="end"
                interval={0}
                height={60}
              />
              <YAxis tick={{ fill: C.muted, fontSize: 10, fontWeight: 700 }} />
              <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={tooltipStyle()} />
              <Legend wrapperStyle={{ color: C.pri, fontWeight: 700 }} />
              <Bar dataKey="Planned" fill={BLUE}  radius={[4, 4, 0, 0]} />
              <Bar dataKey="Actual"  fill={GREEN} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
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

function SidePanel({ color, title, adminRows, blocks, footer }) {
  const filteredAdmin = (adminRows || []).filter(([, v]) => v && String(v).trim() !== "");
  const filteredBlocks = (blocks || []).filter(([, v]) => v && Object.keys(v).length > 0);
  return (
    <div style={{
      ...panelStyle(),
      borderLeft: `4px solid ${color}`,
    }}>
      <h3 style={{
        color, fontSize: 13, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 0.6, margin: "0 0 12px 0",
      }}>
        {title}
      </h3>
      {filteredAdmin.length > 0 && (
        <div style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          {filteredAdmin.map(([k, v], i) => (
            <div key={i} style={{
              display: "flex", justifyContent: "space-between",
              fontSize: 11, color: C.pri, fontWeight: 600,
              padding: "4px 0",
            }}>
              <span style={{ color: C.sec }}>{k}</span>
              <span style={{ fontWeight: 800 }}>{v}</span>
            </div>
          ))}
        </div>
      )}
      {filteredBlocks.map(([title, data], i) => (
        <StatusBlock key={i} title={title} data={data} />
      ))}
      {footer}
    </div>
  );
}

function StatusBlock({ title, data }) {
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 11, color: C.sec, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6,
      }}>
        {title}
      </div>
      {Object.entries(data).map(([k, v], i) => (
        <div key={i} style={{
          display: "flex", justifyContent: "space-between",
          padding: "4px 0", fontSize: 11, color: C.pri, fontWeight: 600,
        }}>
          <span style={{ color: C.sec }}>{k}</span>
          <span style={{
            fontWeight: 800,
            fontFamily: typeof v === "number" ? "'DM Mono', monospace" : "inherit",
          }}>
            {typeof v === "number" ? formatNum(v) : v}
          </span>
        </div>
      ))}
    </div>
  );
}

function FooterRow({ label, value }) {
  return (
    <div style={{
      marginTop: 12, padding: 10,
      background: "rgba(255,255,255,0.04)", borderRadius: 6,
      fontSize: 11, color: C.pri, fontWeight: 600,
    }}>
      <strong style={{ color: C.sec, fontWeight: 800 }}>{label}:</strong> {value}
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

function formatNum(v) {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}

function shortLabel(s) {
  if (!s) return s;
  // Sheet labels can be verbose ("Total no. of files") — shorten for axis
  // ticks without losing meaning.
  return s
    .replace(/Total no\. of /i, "Total ")
    .replace(/^Number of /i, "")
    .slice(0, 26);
}
