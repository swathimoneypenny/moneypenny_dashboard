import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { C, authFetch } from "../config";
import { LiveIndicator, useAutoRefresh, timeAgo, formatTimeIST } from "../components/LiveIndicator";
import BarDetailModal from "../components/BarDetailModal";
import SimpleBreakdownModal from "../components/SimpleBreakdownModal";
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
  { key: "custom",  label: "📅 Custom Range" },
];

// Default custom range = last 7 days ending today. Mirrors TeamDashboard.
function _defaultCustomRange() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 6);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(start), to: fmt(today) };
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

function KpiCard({ label, value, color, suffix = "h", decimals = 1, onClick }) {
  const display = typeof value === "number"
    ? (decimals === 0 ? Math.round(value).toString() : value.toFixed(decimals))
    : "—";
  const clickable = typeof onClick === "function";
  return (
    <div
      onClick={clickable ? onClick : undefined}
      onMouseEnter={(e) => {
        if (!clickable) return;
        e.currentTarget.style.transform   = "translateY(-2px)";
        e.currentTarget.style.boxShadow   = `0 8px 24px rgba(0,0,0,0.4), inset 0 0 24px ${color}1F`;
        e.currentTarget.style.borderColor = `${color}55`;
      }}
      onMouseLeave={(e) => {
        if (!clickable) return;
        e.currentTarget.style.transform   = "translateY(0)";
        e.currentTarget.style.boxShadow   = `0 2px 8px rgba(0,0,0,0.25), inset 0 0 24px ${color}0F`;
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
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 14, fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: 38, fontWeight: 700, color, fontFamily: "'DM Mono', monospace", letterSpacing: -1, lineHeight: 1 }}>
        {display}
        {suffix && (
          <span style={{ fontSize: 16, fontWeight: 400, marginLeft: 4, color: C.sec }}>{suffix}</span>
        )}
      </div>
      {clickable && (
        <div
          style={{
            position: "absolute",
            bottom: 6, right: 10,
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

function ChartCard({ title, children }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.sec, marginBottom: 16 }}>{title}</div>
      {children}
    </div>
  );
}

// Billable / Non-Billable / Internal — three-bar comparison card. Penny removed
// the "Utilization %" KPI 2026-06-12 in favour of this absolute-hours view, and
// asked 2026-06-15 to split Internal (SNMP / BREAKS / Training / Admin / etc.)
// out of Non-Billable so the orange bar reflects only client non-billable time.
// Same orange-left-border styling as SimpleNonBillableCard below so the two
// cards read as a pair.
const _BILLABLE_GREEN      = "#3DC58B";
const _NON_BILLABLE_ORANGE = "#F2895A";
const _INTERNAL_PURPLE     = "#9B7EE8";

// Internal-customer name set (matches backend _INTERNAL_CATEGORY_NAMES). Used
// only by the BreakdownModal to filter `allEntries` client-side when a bar
// click resolves to a category — totals already arrive pre-split from the
// backend, so this exists purely for the drill-down list view.
const _INTERNAL_CATEGORY_NAMES = new Set([
  "snmp",
  "breaks for teams",
  "choose customer",
  "internal",
  "internal / other",
  "training",
  "admin",
  "cleanup",
  "allocation",
]);
function _isInternalCategory(name) {
  if (!name) return false;
  return _INTERNAL_CATEGORY_NAMES.has(String(name).trim().toLowerCase());
}


// Drill-down modal opened by clicking a bar in the Billable vs Non-Billable
// chart. Aggregates the employee's allEntries by project (≈ "service item")
// and by client, plus lists every entry. Closes on overlay click, X button,
// or Escape. Penny's 2026-06-12 spec.
function BreakdownModal({ open, type, data, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Three drill-down modes — internal categories are excluded from the
  // billable / non-billable filters so each bucket's modal list adds up to
  // the bar height the user just clicked.
  const isBillable    = type === "billable";
  const isNonBillable = type === "non-billable";
  const isInternal    = type === "internal";
  const accent = isInternal
    ? _INTERNAL_PURPLE
    : (isBillable ? _BILLABLE_GREEN : _NON_BILLABLE_ORANGE);
  const title = isInternal
    ? "📊 Internal Breakdown"
    : (isBillable ? "📊 Billable Breakdown" : "📊 Non-Billable Breakdown");

  // Pull from allEntries (full set) when present so totals match the chart
  // bars exactly; fall back to recentWork (top 30) for back-compat with any
  // cached response in flight.
  const source = Array.isArray(data?.allEntries) && data.allEntries.length > 0
    ? data.allEntries
    : (data?.recentWork ?? []);
  const filtered = source.filter((r) => {
    const internal = _isInternalCategory(r.client);
    if (isInternal)    return internal;
    if (isBillable)    return !internal && !!r.billable;
    if (isNonBillable) return !internal && !r.billable;
    return false;
  });

  // The chart's authoritative totals — show these so the modal header matches
  // the bar height the user just clicked.
  const headerTotal = isInternal
    ? Number(data?.internalHours ?? 0)
    : (isBillable
        ? Number(data?.billableHours ?? 0)
        : Number(data?.nonBillableHours ?? 0));

  // Aggregate by project (closest field to "service item") and by client.
  const byProject = new Map();
  const byClient  = new Map();
  for (const r of filtered) {
    const h   = Number(r.hours) || 0;
    if (h <= 0) continue;
    const proj   = (r.project || "").trim() || "(no project)";
    const client = (r.client  || "").trim() || "(no client)";
    byProject.set(proj,   (byProject.get(proj)   || 0) + h);
    byClient.set(client,  (byClient.get(client)  || 0) + h);
  }
  const projectList = [...byProject.entries()]
    .map(([name, hours]) => ({ name, hours: Number(hours.toFixed(1)) }))
    .sort((a, b) => b.hours - a.hours);
  const clientList = [...byClient.entries()]
    .map(([name, hours]) => ({ name, hours: Number(hours.toFixed(1)) }))
    .sort((a, b) => b.hours - a.hours);

  const sectionHeader = {
    fontSize:       11,
    fontWeight:     700,
    color:          C.muted,
    textTransform:  "uppercase",
    letterSpacing:  0.6,
    marginBottom:   10,
  };
  const row = {
    display:        "flex",
    justifyContent: "space-between",
    alignItems:     "center",
    padding:        "8px 12px",
    background:     C.card,
    borderRadius:   6,
    gap:            12,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position:       "fixed",
        inset:          0,
        background:     "rgba(0,0,0,0.65)",
        zIndex:         1000,
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        padding:        20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background:   C.surface,
          border:       `1px solid ${C.border}`,
          borderLeft:   `4px solid ${accent}`,
          borderRadius: 12,
          width:        "100%",
          maxWidth:     720,
          maxHeight:    "85vh",
          overflowY:    "auto",
          padding:      24,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display:        "flex",
            justifyContent: "space-between",
            alignItems:     "flex-start",
            marginBottom:   20,
            gap:            12,
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.pri }}>{title}</h2>
            <div
              style={{
                fontSize:   12,
                color:      C.muted,
                marginTop:  4,
                fontFamily: "'DM Mono', monospace",
              }}
            >
              {headerTotal.toFixed(1)}h total · {filtered.length} entr{filtered.length === 1 ? "y" : "ies"}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background:   "transparent",
              border:       `1px solid ${C.border}`,
              color:        C.sec,
              padding:      "4px 12px",
              borderRadius: 6,
              cursor:       "pointer",
              fontSize:     12,
              fontFamily:   "'DM Sans', sans-serif",
            }}
            aria-label="Close"
          >
            ✕ Close
          </button>
        </div>

        {/* Reason / context banner per category — small explainer + suggestion
            line right under the header so the modal isn't just numbers. */}
        {(() => {
          const banner = isInternal
            ? {
                accent: _INTERNAL_PURPLE,
                hint:   "Internal time covers training, breaks, admin, SNMP / allocation work.",
                tip:    "Keep an eye on this share — typical guidance is <30% of total hours.",
              }
            : isBillable
              ? {
                  accent: _BILLABLE_GREEN,
                  hint:   "Direct billable client work — revenue-generating hours.",
                  tip:    "Higher is better; aim for the team's billable-% target.",
                }
              : {
                  accent: _NON_BILLABLE_ORANGE,
                  hint:   "Client work that isn't directly billable (reviews, admin on the client's account).",
                  tip:    "Track to improve billable utilization — move into scoped work where possible.",
                };
          return (
            <div
              style={{
                background:   `${banner.accent}1A`,
                borderLeft:   `3px solid ${banner.accent}`,
                borderRadius: 6,
                padding:      "10px 12px",
                marginBottom: 20,
              }}
            >
              <div style={{ fontSize: 12, color: "#FFFFFF", fontWeight: 700, marginBottom: 4 }}>
                {banner.hint}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", fontWeight: 600 }}>
                💡 {banner.tip}
              </div>
            </div>
          );
        })()}

        {filtered.length === 0 ? (
          <div style={{ color: C.muted, fontStyle: "italic", fontSize: 13, padding: "20px 0", textAlign: "center" }}>
            No {isInternal ? "internal" : (isBillable ? "billable" : "non-billable")} entries this period.
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 22 }}>
              <div style={sectionHeader}>By Service Item / Project</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {projectList.map((s, i) => (
                  <div key={i} style={row}>
                    <span style={{ color: C.pri, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.name}
                    </span>
                    <span style={{ color: accent, fontWeight: 700, fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>
                      {s.hours}h
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 22 }}>
              <div style={sectionHeader}>By Client</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {clientList.map((c, i) => (
                  <div key={i} style={row}>
                    <span style={{ color: C.pri, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.name}
                    </span>
                    <span style={{ color: accent, fontWeight: 700, fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>
                      {c.hours}h
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div style={sectionHeader}>All Entries ({filtered.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {filtered.map((r, i) => (
                  <div key={i} style={{ ...row, alignItems: "flex-start" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: C.pri, fontSize: 12, fontWeight: 600 }}>
                        {r.client || "(no client)"}
                        {r.project ? (
                          <span style={{ color: C.muted, fontWeight: 400, marginLeft: 6 }}>
                            · {r.project}
                          </span>
                        ) : null}
                      </div>
                      {r.desc && (
                        <div
                          style={{
                            color:          C.muted,
                            fontSize:       11,
                            marginTop:      2,
                            overflow:       "hidden",
                            textOverflow:   "ellipsis",
                            whiteSpace:     "nowrap",
                            fontStyle:      "italic",
                          }}
                          title={r.desc}
                        >
                          {r.desc}
                        </div>
                      )}
                    </div>
                    <div
                      style={{
                        color:      accent,
                        fontWeight: 700,
                        fontFamily: "'DM Mono', monospace",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {Number(r.hours).toFixed(1)}h
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BillableVsNonBillableCard({ data, loading, onBarClick }) {
  const totalHours    = Number(data?.totalHours    ?? data?.total_hours    ?? 0) || 0;
  const billableHours = Number(data?.billableHours ?? data?.billable_hours ?? 0) || 0;
  const reportedNb    = Number(data?.nonBillableHours ?? data?.non_billable_hours ?? NaN);
  const internalHours = Number(data?.internalHours ?? data?.internal_hours ?? 0) || 0;
  // Fall back to (Total − Billable − Internal) only when the backend payload
  // pre-dates the 2026-06-15 split and didn't ship a nonBillableHours field.
  const nonBillable = Number.isFinite(reportedNb)
    ? reportedNb
    : Math.max(0, totalHours - billableHours - internalHours);
  const grandTotal = totalHours || (billableHours + nonBillable + internalHours);

  const wrapperStyle = {
    background:   C.card,
    border:       `1px solid ${C.border}`,
    borderLeft:   `4px solid ${_NON_BILLABLE_ORANGE}`,
    borderRadius: 12,
    padding:      "18px 20px",
  };
  const headerStyle = {
    fontSize:      13,
    fontWeight:    700,
    color:         C.pri,
    margin:        0,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };

  if (loading) {
    return (
      <div style={wrapperStyle}>
        <div style={headerStyle}>📊 Hours Breakdown</div>
        <div className="kpi-skeleton" style={{ height: 200, marginTop: 12 }} />
      </div>
    );
  }

  const chartData = [
    { name: "Billable",     type: "billable",     hours: Number(billableHours.toFixed(1)), fill: _BILLABLE_GREEN },
    { name: "Non-Billable", type: "non-billable", hours: Number(nonBillable.toFixed(1)),   fill: _NON_BILLABLE_ORANGE },
    { name: "Internal",     type: "internal",     hours: Number(internalHours.toFixed(1)), fill: _INTERNAL_PURPLE },
  ];

  return (
    <div style={wrapperStyle}>
      <div
        style={{
          display:        "flex",
          justifyContent: "space-between",
          alignItems:     "center",
          marginBottom:   14,
          flexWrap:       "wrap",
          gap:            8,
        }}
      >
        <h3 style={headerStyle}>📊 Billable vs Non-Billable vs Internal</h3>
        <div
          style={{
            fontSize:   12,
            color:      C.muted,
            fontFamily: "'DM Mono', monospace",
          }}
        >
          {grandTotal.toFixed(1)}h total
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          data={chartData}
          margin={{ top: 24, right: 16, bottom: 4, left: 4 }}
          barCategoryGap="25%"
          onClick={(e) => {
            // Recharts onClick fires for clicks anywhere in the chart and
            // exposes the activePayload[].payload of the bar that was hit.
            // Using the chart-level handler is more reliable than per-Bar
            // onClick (which only fires on the colored segment, not the
            // background of the category column).
            const p = e?.activePayload?.[0]?.payload;
            if (!p || !onBarClick) return;
            onBarClick(p.type);
          }}
          style={{ cursor: onBarClick ? "pointer" : "default" }}
        >
          <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ fill: C.sec, fontSize: 12, fontWeight: 600 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: C.muted, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${v}h`}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            content={<DarkTooltip />}
            formatter={(v, _name) => [`${Number(v).toFixed(1)}h`, ""]}
          />
          <Bar dataKey="hours" radius={[6, 6, 0, 0]} maxBarSize={120}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={entry.fill} />
            ))}
            <LabelList
              dataKey="hours"
              position="top"
              formatter={(v) => `${Number(v).toFixed(1)}h`}
              style={{ fill: C.pri, fontSize: 12, fontWeight: 700, fontFamily: "'DM Mono', monospace" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {onBarClick && (
        <div
          style={{
            fontSize: 10,
            color: C.muted,
            textAlign: "center",
            marginTop: 6,
            letterSpacing: 0.3,
            fontStyle: "italic",
          }}
        >
          Click a bar for the per-client / per-project breakdown
        </div>
      )}
    </div>
  );
}


// Non-Billable Hours card — Penny's 2026-06-10 feedback, simplified per
// her 2026-06-12 follow-up. ALWAYS renders. If the backend payload includes
// nonBillableBreakdown (one bar per customer category), use it. Otherwise
// fall back to a single "Non-Billable" bar computed as (totalHours -
// billableHours) so the card is never blank for an employee with non-billable
// time, even before any sheet-level breakdown data has rolled in.
const _NB_PALETTE = [
  "#F2895A",  // orange (matches the team-level non-billable color)
  "#F0B947",  // yellow
  "#9B7EE8",  // purple
  "#4A8FE7",  // blue
  "#3DC58B",  // green
  "#E25C5C",  // red
  "#6B7A95",  // muted slate
];

// One labelled horizontal-bar section used by SimpleNonBillableCard for the
// CLIENT NON-BILLABLE block and the INTERNAL ACTIVITIES block. Keeping them
// in one component lets us share styling without duplicating chart wiring.
function CategoryBarSection({ title, total, color, breakdown, onBarClick }) {
  if (!breakdown || breakdown.length === 0) return null;
  const data = breakdown.map((b) => ({ category: b.category, hours: Number(b.hours) || 0 }));
  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          display:        "flex",
          justifyContent: "space-between",
          alignItems:     "center",
          marginBottom:   10,
          gap:            8,
        }}
      >
        <span
          style={{
            fontSize:      11,
            fontWeight:    700,
            color:         C.muted,
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize:   13,
            fontWeight: 700,
            color,
            fontFamily: "'DM Mono', monospace",
          }}
        >
          {total.toFixed(1)}h
        </span>
      </div>
      <ResponsiveContainer width="100%" height={Math.max(120, data.length * 36)}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 60, bottom: 4, left: 4 }}
          onClick={(e) => {
            const p = e?.activePayload?.[0]?.payload;
            if (p && onBarClick) onBarClick(p.category);
          }}
          style={{ cursor: onBarClick ? "pointer" : "default" }}
        >
          <CartesianGrid stroke={C.border} strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="category"
            tick={{ fill: C.sec, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={150}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            content={<DarkTooltip />}
            formatter={(v) => [`${Number(v).toFixed(1)}h`, title]}
          />
          <Bar
            dataKey="hours"
            radius={[0, 4, 4, 0]}
            maxBarSize={22}
            fill={color}
            style={{ cursor: onBarClick ? "pointer" : "default" }}
            onClick={(payload) => {
              // Per-bar handler — more reliable than chart-level in
              // Recharts 3.x.
              if (payload && onBarClick) onBarClick(payload.category);
            }}
          >
            <LabelList
              dataKey="hours"
              position="right"
              formatter={(v) => `${Number(v).toFixed(1)}h`}
              style={{ fill: C.sec, fontSize: 11, fontFamily: "'DM Mono', monospace" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SimpleNonBillableCard({ data, loading, onCategoryClick }) {
  const totalHours    = Number(data?.totalHours    ?? data?.total_hours    ?? 0) || 0;
  const billableHours = Number(data?.billableHours ?? data?.billable_hours ?? 0) || 0;
  const internalHours = Number(data?.internalHours ?? data?.internal_hours ?? 0) || 0;
  const reportedNb    = Number(data?.nonBillableHours ?? data?.non_billable_hours ?? NaN);
  const derivedNb     = Math.max(0, totalHours - billableHours - internalHours);
  const nonBillable   = Number.isFinite(reportedNb) ? reportedNb : derivedNb;

  const nbBreakdown = Array.isArray(data?.nonBillableBreakdown)
    ? data.nonBillableBreakdown
    : Array.isArray(data?.non_billable_breakdown)
      ? data.non_billable_breakdown
      : [];

  const wrapperStyle = {
    background:   C.card,
    border:       `1px solid ${C.border}`,
    borderLeft:   `4px solid ${_NON_BILLABLE_ORANGE}`,
    borderRadius: 12,
    padding:      "18px 20px",
  };
  const headerStyle = {
    fontSize:       13,
    fontWeight:     700,
    color:          C.pri,
    margin:         0,
    textTransform:  "uppercase",
    letterSpacing:  0.5,
  };

  if (loading) {
    return (
      <div style={wrapperStyle}>
        <div style={headerStyle}>📊 Non-Billable Hours Breakdown</div>
        <div className="kpi-skeleton" style={{ height: 160, marginTop: 12 }} />
      </div>
    );
  }

  // Penny 2026-06-15 follow-up: the combined "Non-Billable & Internal"
  // card was reverted — Internal already has its own KPI card and
  // SimpleBreakdownModal drill-down. This card again shows ONLY client
  // non-billable categories, like before.
  if (nbBreakdown.length === 0 && nonBillable <= 0) {
    return (
      <div style={wrapperStyle}>
        <div style={headerStyle}>📊 Non-Billable Hours Breakdown</div>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 8, fontStyle: "italic" }}>
          No client non-billable hours logged this period.
        </div>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      <div
        style={{
          display:        "flex",
          justifyContent: "space-between",
          alignItems:     "center",
          marginBottom:   4,
          flexWrap:       "wrap",
          gap:            8,
        }}
      >
        <h3 style={headerStyle}>📊 Non-Billable Hours Breakdown</h3>
        <div
          style={{
            fontSize:   13,
            fontWeight: 700,
            color:      _NON_BILLABLE_ORANGE,
            fontFamily: "'DM Mono', monospace",
          }}
        >
          {nonBillable.toFixed(1)}h
        </div>
      </div>

      <CategoryBarSection
        title="Client Non-Billable"
        total={nonBillable}
        color={_NON_BILLABLE_ORANGE}
        breakdown={nbBreakdown}
        onBarClick={onCategoryClick ? (cat) => onCategoryClick("nonBillable", cat) : null}
      />
    </div>
  );
}

// Billable Hours Breakdown — horizontal green bars per client (excluding
// internal-category customers). Replaces the old Non-Billable Hours
// Breakdown card (Penny 2026-06-15 follow-up). Bar click drills into the
// clicked client's billable hours grouped by project.
function BillableBreakdownChart({ data, loading, onBarClick }) {
  const breakdown = useMemo(() => {
    const all = Array.isArray(data?.allEntries) ? data.allEntries : [];
    const bucket = {};
    for (const e of all) {
      if (_isInternalCategory(e.client)) continue;
      if (!e.billable) continue;
      const k = (e.client || "Unknown").trim() || "Unknown";
      bucket[k] = (bucket[k] || 0) + (Number(e.hours) || 0);
    }
    return Object.entries(bucket)
      .map(([client, hours]) => ({ client, hours: Number(hours.toFixed(1)) }))
      .filter((b) => b.hours > 0)
      .sort((a, b) => b.hours - a.hours);
  }, [data]);
  const totalBillable = breakdown.reduce((s, b) => s + b.hours, 0);

  const wrapperStyle = {
    background:   "#0A0F1C",
    border:       "1px solid rgba(255,255,255,0.10)",
    borderLeft:   `4px solid ${_BILLABLE_GREEN}`,
    borderRadius: 12,
    padding:      "18px 20px",
  };
  const headerStyle = {
    fontSize:      14,
    fontWeight:    800,
    color:         "#FFFFFF",
    margin:        0,
    textTransform: "uppercase",
    letterSpacing: 1,
  };

  if (loading) {
    return (
      <div style={wrapperStyle}>
        <h3 style={headerStyle}>📊 Billable Hours Breakdown</h3>
        <div className="kpi-skeleton" style={{ height: 180, marginTop: 12 }} />
      </div>
    );
  }
  if (breakdown.length === 0) {
    return (
      <div style={wrapperStyle}>
        <h3 style={headerStyle}>📊 Billable Hours Breakdown</h3>
        <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 12, marginTop: 10, fontStyle: "italic" }}>
          No billable hours logged this period.
        </div>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12, flexWrap: "wrap" }}>
        <h3 style={headerStyle}>📊 Billable Hours Breakdown</h3>
        <div
          style={{
            fontSize:   13,
            fontWeight: 800,
            color:      _BILLABLE_GREEN,
            fontFamily: "'DM Mono', monospace",
          }}
        >
          Total: {totalBillable.toFixed(1)}h
        </div>
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", fontStyle: "italic", marginBottom: 12 }}>
        Click any bar to see this client's billable time grouped by project.
      </div>
      <ResponsiveContainer width="100%" height={Math.max(180, breakdown.length * 40)}>
        <BarChart
          data={breakdown}
          layout="vertical"
          margin={{ top: 4, right: 60, bottom: 4, left: 4 }}
          onClick={(e) => {
            const p = e?.activePayload?.[0]?.payload;
            if (p && onBarClick) onBarClick(p.client);
          }}
          style={{ cursor: "pointer" }}
        >
          <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: "#FFFFFF", fontSize: 10, fontWeight: 600 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="client"
            tick={{ fill: "#FFFFFF", fontSize: 11, fontWeight: 600 }}
            axisLine={false}
            tickLine={false}
            width={150}
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
            labelStyle={{ color: "#FFFFFF", fontWeight: 800 }}
            itemStyle={{ color: "#FFFFFF" }}
            formatter={(v) => [`${Number(v).toFixed(1)}h`, "Billable"]}
          />
          <Bar
            dataKey="hours"
            fill={_BILLABLE_GREEN}
            radius={[0, 4, 4, 0]}
            maxBarSize={22}
            style={{ cursor: "pointer" }}
            onClick={(payload) => {
              if (payload && onBarClick) onBarClick(payload.client);
            }}
          >
            <LabelList
              dataKey="hours"
              position="right"
              formatter={(v) => `${Number(v).toFixed(1)}h`}
              style={{ fill: _BILLABLE_GREEN, fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono', monospace" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// SimpleBreakdownModal builder for a click on a green bar in
// BillableBreakdownChart — slices the employee's billable entries for that
// client and aggregates by `project`. Empty `project` falls into "(no
// project)" so a client with one un-projected entry still shows a row.
function _buildBillableClientModalProps(clientName, data) {
  if (!clientName) return null;
  const all = Array.isArray(data?.allEntries) ? data.allEntries : [];
  const want = clientName.trim().toLowerCase();
  const bucket = {};
  let total = 0;
  for (const e of all) {
    if (!e.billable) continue;
    if ((e.client || "").trim().toLowerCase() !== want) continue;
    const k = (e.project || "(no project)").trim() || "(no project)";
    const h = Number(e.hours) || 0;
    bucket[k] = (bucket[k] || 0) + h;
    total += h;
  }
  const items = Object.entries(bucket)
    .map(([name, value]) => ({ name, value: Number(value), color: _BILLABLE_GREEN }))
    .filter((it) => it.value > 0)
    .sort((a, b) => b.value - a.value);
  return {
    title:          `💰 ${clientName} · Billable`,
    subtitle:       `By project · ${data?.period || ""}`,
    total:          `${total.toFixed(1)}h`,
    accentColor:    _BILLABLE_GREEN,
    showPercentage: true,
    items,
  };
}

const today = new Date().toLocaleDateString("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

// ── Recent Work table: 7 cols (Date / Client / Project / Account Code /
// Hours / Billable / Description) with an Account-Code filter dropdown.
// Filtering happens client-side over the already-fetched rows so changing
// the filter is instant and doesn't re-hit the backend.
function RecentWorkSection({ rows, loading, acctFilter, setAcctFilter, expandedRow, setExpandedRow }) {
  const list = Array.isArray(rows) ? rows : [];
  const totalHours = useMemo(
    () => list.reduce((s, r) => s + (Number(r.hours) || 0), 0),
    [list],
  );
  const acctOptions = useMemo(() => {
    const stats = {};
    for (const r of list) {
      const code = (r.accountCode || "").trim() || "—";
      const entry = stats[code] || { code, count: 0, hours: 0 };
      entry.count += 1;
      entry.hours += Number(r.hours) || 0;
      stats[code] = entry;
    }
    return Object.values(stats)
      .map((s) => ({ ...s, hours: Number(s.hours.toFixed(1)) }))
      .sort((a, b) => b.hours - a.hours);
  }, [list]);
  const filtered = useMemo(() => {
    if (acctFilter === "all") return list;
    return list.filter((r) => ((r.accountCode || "").trim() || "—") === acctFilter);
  }, [list, acctFilter]);

  const HEADERS = [
    ["Date",         "left"],
    ["Client",       "left"],
    ["Project",      "left"],
    ["Account Code", "left"],
    ["Hours",        "right"],
    ["Billable",     "left"],
    ["Description",  "left"],
  ];

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#FFFFFF", letterSpacing: 0.4 }}>
          📋 Recent Work
        </div>
        {!loading && list.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }}>🔍 Filter by code:</span>
            <select
              value={acctFilter}
              onChange={(e) => setAcctFilter(e.target.value)}
              style={{
                background: "rgba(255,255,255,0.08)",
                color: "#FFFFFF",
                border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 12,
                cursor: "pointer",
                outline: "none",
                minWidth: 200,
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              <option value="all" style={{ background: "#0F1F3A", color: "#FFFFFF" }}>
                All ({list.length} entries · {totalHours.toFixed(1)}h)
              </option>
              {acctOptions.map((opt) => (
                <option key={opt.code} value={opt.code} style={{ background: "#0F1F3A", color: "#FFFFFF" }}>
                  {opt.code} · {opt.hours.toFixed(1)}h
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {!loading && acctFilter !== "all" && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginBottom: 10, fontStyle: "italic" }}>
          Showing {filtered.length} entr{filtered.length === 1 ? "y" : "ies"} for <strong style={{ color: "#C5B3FF", fontFamily: "'DM Mono', monospace" }}>{acctFilter}</strong>
          <button
            onClick={() => setAcctFilter("all")}
            style={{ marginLeft: 10, background: "transparent", border: "none", color: "#4A8FE7", cursor: "pointer", fontSize: 11 }}
          >
            (clear filter)
          </button>
        </div>
      )}

      {loading ? (
        <div className="kpi-skeleton" style={{ height: 200 }} />
      ) : list.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, fontStyle: "italic", padding: "16px 0" }}>
          No recent work in this period.
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, fontStyle: "italic", padding: "16px 0", textAlign: "center" }}>
          No entries match this filter.
        </div>
      ) : (
        <div style={{ overflowX: "auto", maxHeight: 480, overflowY: "auto", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", color: "#FFFFFF" }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
              <tr>
                {HEADERS.map(([h, a]) => (
                  <th
                    key={h}
                    style={{
                      padding: "12px 14px",
                      fontSize: 11,
                      color: "#FFFFFF",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                      textAlign: a,
                      background: "rgba(255,255,255,0.08)",
                      borderBottom: "1px solid rgba(255,255,255,0.12)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const expanded = expandedRow === i;
                const desc     = r.desc ?? "";
                const isLong   = desc.length > 80;
                const shown    = expanded || !isLong ? desc : `${desc.slice(0, 80)}…`;
                const baseBg   = i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.03)";
                return (
                  <tr
                    key={i}
                    onClick={() => isLong && setExpandedRow(expanded ? null : i)}
                    style={{ background: baseBg, cursor: isLong ? "pointer" : "default", transition: "background 0.12s" }}
                  >
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "rgba(255,255,255,0.75)", fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      {r.date || "—"}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "#FFFFFF", fontWeight: 500, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      {r.client || "—"}
                    </td>
                    <td
                      title={r.project || ""}
                      style={{
                        padding: "10px 14px",
                        fontSize: 12,
                        color: "rgba(255,255,255,0.85)",
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                        maxWidth: 180,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.project || "—"}
                    </td>
                    <td
                      title={r.accountCode || ""}
                      style={{
                        padding: "10px 14px",
                        fontSize: 11,
                        color: "#C5B3FF",
                        fontFamily: "'DM Mono', monospace",
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.accountCode || "—"}
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "#FFFFFF", fontFamily: "'DM Mono', monospace", fontWeight: 600, textAlign: "right", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      {Number(r.hours ?? 0).toFixed(2)}
                    </td>
                    <td style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: 0.5,
                          color: r.billable ? "#10B981" : "#F2895A",
                          background: r.billable ? "rgba(16,185,129,0.15)" : "rgba(242,137,90,0.15)",
                          padding: "3px 8px",
                          borderRadius: 20,
                        }}
                      >
                        {r.billable ? "BILLABLE" : "NON-BILL"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 14px", fontSize: 12, color: "#FFFFFF", maxWidth: 480, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      {shown || <span style={{ color: "rgba(255,255,255,0.5)" }}>—</span>}
                      {isLong && (
                        <span style={{ color: "rgba(255,255,255,0.55)", marginLeft: 8, fontSize: 10 }}>
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

      {/* Prominent TOTAL HOURS footer — sums the currently visible filter
          (or the full list when no account-code filter is applied). */}
      {!loading && filtered.length > 0 && (() => {
        const filteredTotal = filtered.reduce((s, r) => s + (Number(r.hours) || 0), 0);
        return (
          <div
            style={{
              marginTop:   12,
              padding:     "14px 18px",
              background:  "rgba(255,255,255,0.08)",
              borderTop:   `2px solid ${_NON_BILLABLE_ORANGE}`,
              borderRadius: "0 0 8px 8px",
              display:     "flex",
              justifyContent: "space-between",
              alignItems:  "center",
            }}
          >
            <span
              style={{
                fontSize: 12, fontWeight: 800, color: "#FFFFFF",
                textTransform: "uppercase", letterSpacing: 1,
              }}
            >
              TOTAL{acctFilter !== "all" ? ` (${acctFilter})` : ""}
            </span>
            <span
              style={{
                fontSize: 20, fontWeight: 800, color: "#FFFFFF",
                fontFamily: "'DM Mono', monospace",
              }}
            >
              {filteredTotal.toFixed(1)}h
            </span>
          </div>
        );
      })()}
    </div>
  );
}

export default function EmployeeProfile({ teamId, teamName, employeeName, onBack, onContextUpdate }) {
  const [period, setPeriod] = useState("monthly");
  const [customRange, setCustomRange]   = useState(_defaultCustomRange);
  const [pendingCustom, setPendingCustom] = useState(_defaultCustomRange);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState(null);
  const [acctFilter, setAcctFilter]   = useState("all");
  useEffect(() => { setExpandedRow(null); }, [acctFilter]);
  // KPI-card drill-down — uses SimpleBreakdownModal (compact list, no
  // search/sort/entries-table) like the Team / Client views. Now also driven
  // by the 3-bar comparison chart's onBarClick.
  const [kpiModal, setKpiModal] = useState({ open: false, type: null });
  // Billable Hours Breakdown chart click → drill into that client's
  // billable hours grouped by project. Single new state for the new chart.
  const [billableClientModal, setBillableClientModal] = useState({ open: false, client: null });
  const abortRef = useRef(null);

  const [lastRefreshed, setLastRefreshed] = useState(null);

  const fetchData = useCallback((silent = false) => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (period === "custom" && (!customRange.from || !customRange.to)) return;
    if (!silent) setLoading(true);
    const url = period === "custom"
      ? `/api/team/${teamId}/employee/${encodeURIComponent(employeeName)}/custom?from=${customRange.from}&to=${customRange.to}`
      : `/api/team/${teamId}/employee/${encodeURIComponent(employeeName)}/${period}`;
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
        console.error("[EmployeeProfile] fetch failed", err);
        setData({});
        if (!silent) setLoading(false);
      });
  }, [teamId, employeeName, period, customRange.from, customRange.to]);

  const isLive = period === "today";
  const refreshSilent = useCallback(() => fetchData(true), [fetchData]);
  const tickNow = useAutoRefresh(refreshSilent, isLive, lastRefreshed);

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
Total ${data.totalHours ?? 0}h | Billable ${data.billableHours ?? 0}h | Non-bill ${data.nonBillableHours ?? 0}h | Billable% ${data.billablePct ?? 0}%
Top clients: ${(data.topClients ?? []).map((c) => `${c.client} (${c.hours}h)`).join(", ")}
Recent:
${lines.join("\n")}`;
    onContextUpdate(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const periodLabel = period === "custom"
    ? (data?.period || `${customRange.from} – ${customRange.to}`)
    : (PERIODS.find((p) => p.key === period)?.label ?? "");
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
            <div style={{ fontSize: 12, color: C.sec, marginTop: 2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
              {data?.activeNow && data?.lastLoggedClient && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    color: "#3DC58B",
                    fontWeight: 500,
                  }}
                  title={formatTimeIST(data.lastLoggedAt)}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#3DC58B",
                      animation: "pulse-dot 2s infinite",
                    }}
                  />
                  Working on <strong style={{ color: C.pri }}>{data.lastLoggedClient}</strong>
                  <span style={{ color: C.muted }}>· last update {timeAgo(data.lastLoggedAt)}</span>
                </span>
              )}
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

        <LiveIndicator
          lastRefreshed={lastRefreshed}
          now={tickNow}
          isLive={isLive}
          onRefresh={() => fetchData(false)}
        />

        <div style={{ textAlign: "right", marginLeft: "auto" }}>
          <div style={{ fontSize: 13, fontWeight: 700, background: "linear-gradient(135deg,#00c896,#3d8ef0)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            MoneyPenny LLC
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>{periodLabel} · {today}</div>
          {data?.isProrated && data?.workingDaysTotal > 0 && (
            <div
              style={{
                fontSize: 10,
                color: C.teal,
                fontFamily: "'DM Mono', monospace",
                marginTop: 2,
                letterSpacing: 0.3,
              }}
              title={`Targets pro-rated by working days elapsed (${data.periodStart} → ${data.periodEnd})`}
            >
              Day {data.workingDaysElapsed}/{data.workingDaysTotal} · target {(data.committedHours ?? 0).toFixed(1)}h / {(data.committedHoursFull ?? 0).toFixed(1)}h full
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "24px 32px", display: "flex", flexDirection: "column", gap: 24 }}>
        {/* KPIs */}
        {loading ? (
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="kpi-skeleton" style={{ flex: "1 1 200px", minWidth: 180, height: 124, borderRadius: 12 }} />
            ))}
          </div>
        ) : (() => {
          // Compute non-billable hours / pct here so the KPI cards stay
          // pure presentational. Reads camelCase fields first, then falls
          // back to (totalHours - billableHours) for resilience against any
          // payload-shape edge case (snake_case, missing field, etc.).
          const totalH = Number(data?.totalHours    ?? data?.total_hours    ?? 0) || 0;
          const billH  = Number(data?.billableHours ?? data?.billable_hours ?? 0) || 0;
          const intH   = Number(data?.internalHours ?? data?.internal_hours ?? 0) || 0;
          const reported = Number(data?.nonBillableHours ?? data?.non_billable_hours ?? NaN);
          // Non-billable is CLIENT non-billable only (Penny 2026-06-15). When
          // the backend predates the split and didn't ship the field, derive
          // it as (Total − Billable − Internal) so the % still lines up.
          const nbH = Number.isFinite(reported) ? reported : Math.max(0, totalH - billH - intH);
          const nbPct = totalH > 0 ? (nbH / totalH * 100) : 0;
          return (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <KpiCard
                label="Total Hours"
                value={data?.totalHours}
                color={C.purple}
                onClick={() => setKpiModal({ open: true, type: "total" })}
              />
              <KpiCard
                label="Billable Hours"
                value={data?.billableHours}
                color={C.teal}
                onClick={() => setKpiModal({ open: true, type: "billable" })}
              />
              {/* Pure ratio cards stay non-clickable per spec — they don't
                  have a meaningful drill-down. */}
              <KpiCard label="Billable %"         value={data?.billablePct}   color={C.green}  suffix="%" />
              <KpiCard
                label="Non-Billable Hours"
                value={nbH}
                color="#F2895A"
                onClick={() => setKpiModal({ open: true, type: "nonBillable" })}
              />
              <KpiCard label="Non-Billable %"     value={nbPct}               color="#F2895A" suffix="%" />
              <KpiCard
                label="Internal Hours"
                value={intH}
                color={_INTERNAL_PURPLE}
                onClick={() => setKpiModal({ open: true, type: "internal" })}
              />
            </div>
          );
        })()}

        {/* Billable / Non-Billable / Internal — 3-bar comparison. Bar clicks
            now route into the same SimpleBreakdownModal the matching KPI
            card uses (one drill-down per category, no matter which surface
            opened it). Mapping: "billable"→billable, "non-billable"→
            nonBillable, "internal"→internal. */}
        <BillableVsNonBillableCard
          data={data}
          loading={loading}
          onBarClick={(type) => {
            const t = type === "non-billable" ? "nonBillable" : type;
            setKpiModal({ open: true, type: t });
          }}
        />

        {/* Billable Hours Breakdown — replaces the old "Non-Billable Hours
            Breakdown" card per Penny's 2026-06-15 ask. Horizontal green bars
            per client; click any bar to drill into that client's billable
            time grouped by project. */}
        <BillableBreakdownChart
          data={data}
          loading={loading}
          onBarClick={(client) => setBillableClientModal({ open: true, client })}
        />

        {/* Recent Work */}
        <RecentWorkSection
          rows={data?.recentWork}
          loading={loading}
          acctFilter={acctFilter}
          setAcctFilter={setAcctFilter}
          expandedRow={expandedRow}
          setExpandedRow={setExpandedRow}
        />
      </div>
      {billableClientModal.open && (() => {
        const props = _buildBillableClientModalProps(billableClientModal.client, data);
        if (!props) return null;
        return (
          <SimpleBreakdownModal
            open
            onClose={() => setBillableClientModal({ open: false, client: null })}
            {...props}
          />
        );
      })()}
      {kpiModal.open && (() => {
        const props = _buildEmployeeKpiModalProps(kpiModal.type, data);
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

// Per-KPI breakdown builder. Each card type slices the employee's allEntries
// list (already on the page) into the right view: by-client for Billable /
// Non-Billable, by-internal-category for Internal, or the 3-bucket overview
// for Total. Same Internal name set used in the backend lives in
// _INTERNAL_CATEGORY_NAMES at the top of this file so the totals reconcile.
function _buildEmployeeKpiModalProps(type, data) {
  const all = Array.isArray(data?.allEntries) ? data.allEntries : [];
  const totalH = Number(data?.totalHours ?? 0);
  const billH  = Number(data?.billableHours ?? 0);
  const nbH    = Number(data?.nonBillableHours ?? 0);
  const intH   = Number(data?.internalHours ?? 0);
  const period = data?.period || "";

  switch (type) {
    case "total": {
      const items = [
        { name: "Billable",     value: billH, color: _BILLABLE_GREEN      },
        { name: "Non-Billable", value: nbH,   color: _NON_BILLABLE_ORANGE },
        { name: "Internal",     value: intH,  color: _INTERNAL_PURPLE     },
      ].filter((it) => it.value > 0);
      return {
        title:          "📊 Total Hours Overview",
        subtitle:       period,
        total:          `${totalH.toFixed(1)}h`,
        accentColor:    "#FFFFFF",
        showPercentage: true,
        items,
      };
    }
    case "billable": {
      const bucket = {};
      for (const e of all) {
        if (_isInternalCategory(e.client)) continue;
        if (!e.billable) continue;
        const k = (e.client || "Unknown").trim() || "Unknown";
        bucket[k] = (bucket[k] || 0) + (Number(e.hours) || 0);
      }
      const items = Object.entries(bucket)
        .map(([name, value]) => ({ name, value: Number(value), color: _BILLABLE_GREEN }))
        .filter((it) => it.value > 0)
        .sort((a, b) => b.value - a.value);
      return {
        title:          "💰 Billable Breakdown",
        subtitle:       `By client · ${period}`,
        total:          `${billH.toFixed(1)}h`,
        accentColor:    _BILLABLE_GREEN,
        showPercentage: true,
        items,
      };
    }
    case "nonBillable": {
      const bucket = {};
      for (const e of all) {
        if (_isInternalCategory(e.client)) continue;
        if (e.billable) continue;
        const k = (e.client || "Unknown").trim() || "Unknown";
        bucket[k] = (bucket[k] || 0) + (Number(e.hours) || 0);
      }
      const items = Object.entries(bucket)
        .map(([name, value]) => ({ name, value: Number(value), color: _NON_BILLABLE_ORANGE }))
        .filter((it) => it.value > 0)
        .sort((a, b) => b.value - a.value);
      return {
        title:          "📋 Non-Billable Breakdown",
        subtitle:       `By client (excludes Internal) · ${period}`,
        total:          `${nbH.toFixed(1)}h`,
        accentColor:    _NON_BILLABLE_ORANGE,
        showPercentage: true,
        items,
      };
    }
    case "internal": {
      const bucket = {};
      for (const e of all) {
        if (!_isInternalCategory(e.client)) continue;
        const k = (e.client || "Unspecified").trim() || "Unspecified";
        bucket[k] = (bucket[k] || 0) + (Number(e.hours) || 0);
      }
      const items = Object.entries(bucket)
        .map(([name, value]) => ({ name, value: Number(value), color: _INTERNAL_PURPLE }))
        .filter((it) => it.value > 0)
        .sort((a, b) => b.value - a.value);
      return {
        title:          "🏢 Internal Hours Breakdown",
        subtitle:       `SNMP / Breaks / Admin / Training · ${period}`,
        total:          `${intH.toFixed(1)}h`,
        accentColor:    _INTERNAL_PURPLE,
        showPercentage: true,
        items,
      };
    }
    default:
      return null;
  }
}
