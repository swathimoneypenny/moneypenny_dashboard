import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, Cell,
} from "recharts";
import { authFetch, C } from "../config";

// Per-client BOD vs EOD comparison dashboard. Data source: backend
// /api/team/{id}/bod-eod endpoint, which ships per-client daily entries
// with normalized status-block categories. This file owns its own period
// sub-filter (today/week/month/custom) — distinct from the outer
// TeamDashboard period — because the BOD/EOD view always shows the same
// dataset and just slices it by date.

const BLUE       = "#4A8FE7";
const GREEN      = "#10B981";
const ORANGE     = "#F2895A";
const RED        = "#EF4444";
const YELLOW     = "#F0B947";
const PURPLE     = "#9B7EE8";

const STAGE_COLORS = {
  "Not Started":   RED,
  "In Process":    YELLOW,
  "Review":        BLUE,
  "Posted Query":  PURPLE,
  "Completed":     GREEN,
};
const STAGE_ORDER = ["Not Started", "In Process", "Review", "Posted Query", "Completed"];
const COMPARE_CATEGORIES = ["Total Files", "Not Started", "In Process", "Review", "Posted Query", "Completed"];

export default function BodEodReview({ teamId }) {
  const [payload, setPayload]               = useState(null);
  const [loading, setLoading]               = useState(true);
  const [err, setErr]                       = useState(null);
  const [selectedClient, setSelectedClient] = useState(null);
  const [period, setPeriod]                 = useState("month");  // today | week | month | custom
  const [customStart, setCustomStart]       = useState("");
  const [customEnd, setCustomEnd]           = useState("");
  const [modal, setModal]                   = useState({ open: false, type: null, data: null });

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

  const allEntries = client?.entries || [];

  // Filter entries by period. "Today" = latest entry only. "Week" / "Month"
  // = entries within that window from now. "Custom" = inclusive range.
  // Falls back to all entries when a window matches nothing — empty state
  // would otherwise look broken when the user lands mid-day.
  const filteredEntries = useMemo(() => {
    if (!allEntries.length) return [];
    if (period === "today") {
      return [allEntries[allEntries.length - 1]];
    }
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    let from = null;
    let to = null;
    if (period === "week") {
      from = new Date(now.getTime() - 7 * dayMs);
      to   = now;
    } else if (period === "month") {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to   = now;
    } else if (period === "custom") {
      if (!customStart || !customEnd) return allEntries;
      from = new Date(customStart);
      to   = new Date(customEnd);
      to.setHours(23, 59, 59, 999);
    }
    if (!from || !to) return allEntries;
    const within = allEntries.filter((e) => {
      const d = parseEntryDate(e.date);
      return d && d >= from && d <= to;
    });
    return within.length ? within : allEntries;
  }, [allEntries, period, customStart, customEnd]);

  // Period stats. "Today" reads off the single latest entry; everything
  // else sums across the window — both committed and booked are
  // cumulative-by-day on the sheet, so summing is correct only across a
  // single client's window, but matches how the user reads "monthly total
  // committed" on the spreadsheet.
  const periodStats = useMemo(() => {
    if (period === "today") {
      const e = filteredEntries[filteredEntries.length - 1] || {};
      return {
        committed: Number(e.committed_hours) || 0,
        booked:    Number(e.booked_hours)    || 0,
        variance:  Number(e.variance_hours)  || 0,
      };
    }
    let committed = 0, booked = 0;
    for (const e of filteredEntries) {
      committed += Number(e.committed_hours) || 0;
      booked    += Number(e.booked_hours)    || 0;
    }
    return { committed, booked, variance: booked - committed };
  }, [filteredEntries, period]);

  const latestEntry = filteredEntries.length
    ? filteredEntries[filteredEntries.length - 1]
    : null;

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
      </div>
    );
  }
  if (!payload?.clients?.length) {
    return (
      <div style={panelStyle()}>
        <div style={{ color: C.sec, fontWeight: 700 }}>No BOD/EOD data available for this team yet.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Top filter bar — Client + Period + Custom date range. Internal to
          this view; the outer TeamDashboard period selector still drives
          which tab is active. */}
      <div style={{ ...panelStyle(), padding: 14, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <FilterLabel>Client</FilterLabel>
        <select
          value={selectedClient || ""}
          onChange={(e) => setSelectedClient(e.target.value)}
          style={{
            background: "rgba(255,255,255,0.06)", color: C.pri,
            border: `1px solid ${C.border}`, borderRadius: 8,
            padding: "8px 14px", fontWeight: 700, minWidth: 220, cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {payload.clients.map((c) => (
            <option key={c.client_name} value={c.client_name}>{c.client_name}</option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { key: "today",  label: "Today" },
            { key: "week",   label: "This Week" },
            { key: "month",  label: "This Month" },
            { key: "custom", label: "📅 Custom" },
          ].map((p) => (
            <PeriodPill
              key={p.key}
              active={period === p.key}
              onClick={() => setPeriod(p.key)}
            >
              {p.label}
            </PeriodPill>
          ))}
        </div>

        {period === "custom" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              style={dateInputStyle()}
            />
            <span style={{ color: C.muted, fontWeight: 700 }}>to</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              style={dateInputStyle()}
            />
          </div>
        )}

        <div style={{ flex: 1 }} />
        <span style={{ color: C.muted, fontSize: 11, fontWeight: 600 }}>
          {filteredEntries.length} day{filteredEntries.length === 1 ? "" : "s"} shown
        </span>
        <button
          onClick={load}
          style={{
            background: "transparent", border: `1px solid ${C.border}`, color: C.pri,
            borderRadius: 6, padding: "6px 12px", cursor: "pointer",
            fontSize: 11, fontWeight: 800, letterSpacing: 0.4, fontFamily: "inherit",
          }}
        >
          ⟳ Refresh
        </button>
      </div>

      {/* 3 KPI cards — Committed / Booked / Variance. Efficiency dropped
          per spec (was noisy when 'today' wasn't yet EOD'd). */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <ClickableKpi
          label="Committed (Target)"
          value={`${fmt1(periodStats.committed)}h`}
          color={BLUE}
          subtitle={periodLabel(period)}
          onClick={() => setModal({ open: true, type: "kpi", data: { which: "committed", periodStats, filteredEntries, period } })}
        />
        <ClickableKpi
          label="Booked (Actual)"
          value={`${fmt1(periodStats.booked)}h`}
          color={GREEN}
          subtitle={periodLabel(period)}
          onClick={() => setModal({ open: true, type: "kpi", data: { which: "booked", periodStats, filteredEntries, period } })}
        />
        <ClickableKpi
          label="Variance"
          value={`${periodStats.variance >= 0 ? "+" : ""}${fmt1(periodStats.variance)}h`}
          color={periodStats.variance >= 0 ? GREEN : RED}
          subtitle={periodStats.variance >= 0 ? "✓ Ahead of plan" : "⚠ Behind plan"}
          onClick={() => setModal({ open: true, type: "kpi", data: { which: "variance", periodStats, filteredEntries, period } })}
        />
      </div>

      {/* Committed vs Booked line chart — click anywhere on the chart
          (or a dot) to open that day's detail modal. */}
      {filteredEntries.length > 0 && (
        <div style={panelStyle()}>
          <ChartHeader
            title="📈 Committed vs Booked Hours"
            hint="Click any point to see daily breakdown & reasons"
          />
          <ResponsiveContainer width="100%" height={280}>
            <LineChart
              data={filteredEntries}
              margin={{ top: 12, right: 20, left: 0, bottom: 4 }}
              onClick={(e) => {
                const p = e?.activePayload?.[0]?.payload;
                if (p) openDayModal(p, setModal);
              }}
              style={{ cursor: "pointer" }}
            >
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
                type="monotone" dataKey="committed_hours" stroke={BLUE} strokeWidth={3}
                name="Committed (Target)"
                dot={{ r: 5, fill: BLUE, cursor: "pointer" }}
                activeDot={{ r: 7, stroke: "#FFFFFF", strokeWidth: 2 }}
              />
              <Line
                type="monotone" dataKey="booked_hours" stroke={GREEN} strokeWidth={3}
                name="Booked (Actual)"
                dot={{ r: 5, fill: GREEN, cursor: "pointer" }}
                activeDot={{ r: 7, stroke: "#FFFFFF", strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* BOD plan vs EOD actual — grouped bars per category. Latest day
          only (per spec). Click any bar pair to drill in. */}
      {latestEntry && (
        <div style={panelStyle()}>
          <ChartHeader
            title={`🔄 BOD Plan vs EOD Actual · ${latestEntry.date}`}
            hint="Click any bar to see what changed and why"
          />
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={buildComparisonData(latestEntry)}
              onClick={(e) => {
                const p = e?.activePayload?.[0]?.payload;
                if (p) openCategoryModal(p, latestEntry, setModal);
              }}
              margin={{ top: 12, right: 16, left: 0, bottom: 4 }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="category" tick={{ fill: C.sec, fontSize: 11, fontWeight: 700 }} interval={0} />
              <YAxis tick={{ fill: C.muted, fontSize: 10, fontWeight: 700 }} />
              <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={tooltipStyle()} />
              <Legend wrapperStyle={{ color: C.pri, fontWeight: 700 }} />
              <Bar
                dataKey="Plan"
                fill={BLUE}
                radius={[6, 6, 0, 0]}
                style={{ cursor: "pointer" }}
                onClick={(p) => openCategoryModal(p?.payload || p, latestEntry, setModal)}
              />
              <Bar
                dataKey="Actual"
                fill={GREEN}
                radius={[6, 6, 0, 0]}
                style={{ cursor: "pointer" }}
                onClick={(p) => openCategoryModal(p?.payload || p, latestEntry, setModal)}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* File Status Progression — 5 colored stage boxes for the latest day. */}
      {latestEntry && (() => {
        const eodActuals = latestEntry?.eod?.monthly_actual || {};
        const stages = STAGE_ORDER.map((s) => ({
          stage: s,
          count: Number(eodActuals[s]) || 0,
          color: STAGE_COLORS[s],
        }));
        const anyData = stages.some((s) => s.count > 0);
        if (!anyData) return null;
        return (
          <div style={panelStyle()}>
            <ChartHeader title={`📊 File Status Progression · ${latestEntry.date}`} hint="Click any stage for a breakdown" />
            <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              {stages.map((s, i) => (
                <StageBox key={i} stage={s} onClick={() => openStageModal(s, latestEntry, setModal)} />
              ))}
            </div>
          </div>
        );
      })()}

      {/* Daily Variance — one bar per day, green/red. */}
      {filteredEntries.length > 0 && (
        <div style={panelStyle()}>
          <ChartHeader
            title="⚖️ Daily Variance (Booked − Committed)"
            hint="Click any bar to see reasons for that day's variance"
          />
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              data={filteredEntries.map((e) => ({
                date:     e.date,
                variance: Number(e.variance_hours) || 0,
                _src:     e,
              }))}
              margin={{ top: 12, right: 16, left: 0, bottom: 4 }}
              onClick={(e) => {
                const src = e?.activePayload?.[0]?.payload?._src;
                if (src) openDayModal(src, setModal);
              }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: C.sec, fontSize: 10, fontWeight: 700 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 10, fontWeight: 700 }} tickFormatter={(v) => `${v}h`} />
              <Tooltip
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
                contentStyle={tooltipStyle()}
                formatter={(v) => [`${Number(v).toFixed(1)}h`, "Variance"]}
              />
              <Bar
                dataKey="variance"
                radius={[6, 6, 0, 0]}
                style={{ cursor: "pointer" }}
                onClick={(p) => { const src = p?.payload?._src || p?._src; if (src) openDayModal(src, setModal); }}
              >
                {filteredEntries.map((e, i) => (
                  <Cell
                    key={i}
                    fill={(Number(e.variance_hours) || 0) >= 0 ? GREEN : RED}
                    style={{ cursor: "pointer" }}
                    onClick={() => openDayModal(e, setModal)}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Unified detail modal */}
      {modal.open && (
        <DetailModal
          modal={modal}
          onClose={() => setModal({ open: false, type: null, data: null })}
        />
      )}
    </div>
  );
}

// ── Click handlers ─────────────────────────────────────────────────

function openDayModal(entry, setModal) {
  if (!entry) return;
  const reasons = buildDayReasons(entry);
  setModal({ open: true, type: "day", data: { ...entry, reasons } });
}

function openCategoryModal(catData, entry, setModal) {
  if (!catData || !catData.category) return;
  const plan   = Number(catData.Plan) || 0;
  const actual = Number(catData.Actual) || 0;
  const diff   = actual - plan;
  const reasons = buildCategoryReasons(catData.category, plan, actual, diff);
  setModal({
    open: true,
    type: "category",
    data: { category: catData.category, plan, actual, diff, reasons, date: entry?.date },
  });
}

function openStageModal(stage, entry, setModal) {
  if (!stage) return;
  const eodActuals = entry?.eod?.monthly_actual || {};
  const total = STAGE_ORDER.reduce((s, k) => s + (Number(eodActuals[k]) || 0), 0);
  const pct = total > 0 ? (stage.count / total * 100).toFixed(0) : 0;
  const reasons = buildStageReasons(stage.stage, stage.count, total, pct, entry);
  setModal({
    open: true,
    type: "stage",
    data: { ...stage, total, pct, reasons, date: entry?.date },
  });
}

// ── Reason builders ────────────────────────────────────────────────

function buildDayReasons(e) {
  const reasons = [];
  const v   = Number(e.variance_hours) || 0;
  const eod = e.eod?.monthly_actual || {};
  const bod = e.bod?.monthly_plan   || {};
  const completed = Number(eod["Completed"]) || 0;
  const planCompleted = Number(bod["Completed"]) || 0;
  const inProcess = Number(eod["In Process"]) || 0;
  const review    = Number(eod["Review"]) || 0;
  const notStarted = Number(eod["Not Started"]) || 0;

  if (v < 0) reasons.push(`⚠ Behind plan by ${Math.abs(v).toFixed(1)}h`);
  else if (v > 0) reasons.push(`✓ Ahead of plan by ${v.toFixed(1)}h`);
  else reasons.push(`✓ On target`);

  if (completed === 0 && v < 0) reasons.push("No files completed this day");
  if (planCompleted > 0 && completed < planCompleted)
    reasons.push(`Completed ${completed} of ${planCompleted} planned (${planCompleted - completed} short)`);
  if (inProcess > 5)  reasons.push(`${inProcess} files stuck in process — possible bottleneck`);
  if (review > 3)     reasons.push(`${review} files pending review`);
  if (notStarted > 0 && v < 0) reasons.push(`${notStarted} files not started yet`);

  if (e.eod?.workflow && String(e.eod.workflow).trim()) {
    reasons.push(`Workflow note: ${truncate(e.eod.workflow, 120)}`);
  }
  if (e.notes && String(e.notes).trim()) {
    reasons.push(`TL notes: ${truncate(e.notes, 120)}`);
  }
  return reasons;
}

function buildCategoryReasons(category, plan, actual, diff) {
  const reasons = [`Planned: ${plan} · Actual: ${actual}`];
  if (diff === 0) {
    reasons.push("✓ On target");
    return reasons;
  }
  if (category === "Completed") {
    if (diff > 0) reasons.push(`✓ Completed ${diff} more than planned`);
    else          reasons.push(`⚠ Completed ${Math.abs(diff)} fewer than planned`);
  } else if (category === "In Process") {
    if (diff > 0) reasons.push(`⚠ ${diff} more in process — bottleneck likely`);
    else          reasons.push(`✓ Cleared ${Math.abs(diff)} from process backlog`);
  } else if (category === "Not Started") {
    if (diff > 0) reasons.push(`⚠ ${diff} additional files not started`);
    else          reasons.push(`✓ Started ${Math.abs(diff)} files`);
  } else if (category === "Review") {
    if (diff > 0) reasons.push(`⚠ ${diff} extra files awaiting review`);
    else          reasons.push(`✓ Cleared ${Math.abs(diff)} from review queue`);
  } else if (category === "Posted Query") {
    if (diff > 0) reasons.push(`⚠ ${diff} more queries posted — client response wait`);
    else          reasons.push(`✓ Resolved ${Math.abs(diff)} queries`);
  } else if (category === "Total Files") {
    if (diff > 0) reasons.push(`📥 ${diff} new files received during the day`);
    else          reasons.push(`📤 ${Math.abs(diff)} files dropped out of scope`);
  }
  return reasons;
}

function buildStageReasons(stage, count, total, pct, entry) {
  const reasons = [`${count} files in "${stage}" (${pct}% of ${total} tracked)`];
  if (stage === "Not Started" && count > 0) {
    reasons.push(`Files awaiting kickoff — flag if blocking downstream work`);
  } else if (stage === "In Process" && count > 5) {
    reasons.push(`Possible bottleneck — staff capacity check`);
  } else if (stage === "Review" && count > 3) {
    reasons.push(`Review queue building — reviewer availability?`);
  } else if (stage === "Posted Query" && count > 0) {
    reasons.push(`Waiting on client response — chase if aged`);
  } else if (stage === "Completed") {
    const planned = Number(entry?.bod?.monthly_plan?.["Completed"]) || 0;
    if (planned > 0) {
      const diff = count - planned;
      if (diff >= 0) reasons.push(`✓ Met or exceeded plan (${planned})`);
      else           reasons.push(`⚠ Short of plan by ${Math.abs(diff)}`);
    }
  }
  return reasons;
}

// ── Sub-components ─────────────────────────────────────────────────

function ClickableKpi({ label, value, color, subtitle, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: C.card, borderLeft: `4px solid ${color}`, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: "16px 18px", cursor: "pointer",
        textAlign: "left", fontFamily: "inherit",
        transition: "transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.4)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "none";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <div style={{
        fontSize: 10, color: C.muted, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 1, marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 24, color, fontWeight: 800, fontFamily: "'DM Mono', monospace" }}>
        {value}
      </div>
      {subtitle && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4, fontWeight: 600 }}>
          {subtitle}
        </div>
      )}
      <div style={{
        fontSize: 10, color: C.muted, fontWeight: 700, fontStyle: "italic",
        marginTop: 6, letterSpacing: 0.3,
      }}>
        CLICK FOR DETAILS →
      </div>
    </button>
  );
}

function PeriodPill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active
          ? "linear-gradient(135deg, #F2895A 0%, #FF9D6E 100%)"
          : "rgba(255,255,255,0.06)",
        color: C.pri,
        border: `1px solid ${active ? "transparent" : C.border}`,
        borderRadius: 8,
        padding: "8px 14px",
        fontWeight: 800,
        letterSpacing: 0.4,
        fontSize: 12,
        cursor: "pointer",
        fontFamily: "inherit",
        boxShadow: active ? "0 4px 16px rgba(242,137,90,0.35)" : "none",
      }}
    >
      {children}
    </button>
  );
}

function StageBox({ stage, onClick }) {
  const bg = `${stage.color}22`;
  const hover = `${stage.color}33`;
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, background: bg, borderLeft: `4px solid ${stage.color}`,
        borderRadius: 8, padding: 16, cursor: "pointer",
        textAlign: "center", border: "none", fontFamily: "inherit",
        transition: "background 0.15s ease",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = hover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = bg; }}
    >
      <div style={{
        fontSize: 28, fontWeight: 900, color: stage.color,
        fontFamily: "'DM Mono', monospace", lineHeight: 1,
      }}>
        {stage.count}
      </div>
      <div style={{
        fontSize: 11, color: C.pri, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 0.6, marginTop: 8,
      }}>
        {stage.stage}
      </div>
    </button>
  );
}

function ChartHeader({ title, hint }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: 12, gap: 12, flexWrap: "wrap",
    }}>
      <h3 style={{
        color: C.pri, fontSize: 13, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 0.6, margin: 0,
      }}>
        {title}
      </h3>
      {hint && (
        <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>
          {hint}
        </span>
      )}
    </div>
  );
}

function FilterLabel({ children }) {
  return (
    <label style={{
      color: C.pri, fontWeight: 800, fontSize: 11,
      textTransform: "uppercase", letterSpacing: 0.8,
    }}>
      {children}
    </label>
  );
}

// ── Modal ──────────────────────────────────────────────────────────

function DetailModal({ modal, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = modal.data || {};
  const title = (() => {
    if (modal.type === "kpi")      return `${d.which === "committed" ? "💼 Committed" : d.which === "booked" ? "💰 Booked" : "⚖️ Variance"} · ${periodLabel(d.period)}`;
    if (modal.type === "day")      return `📅 ${d.date}`;
    if (modal.type === "category") return `🔄 ${d.category} · ${d.date}`;
    if (modal.type === "stage")    return `📊 ${d.stage} · ${d.date}`;
    return "Details";
  })();
  const accent = (() => {
    if (modal.type === "kpi") return d.which === "committed" ? BLUE : d.which === "booked" ? GREEN : (d.periodStats?.variance >= 0 ? GREEN : RED);
    if (modal.type === "category") return d.diff >= 0 ? GREEN : RED;
    if (modal.type === "stage") return d.color || BLUE;
    if (modal.type === "day") return (d.variance_hours || 0) >= 0 ? GREEN : RED;
    return ORANGE;
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0A0F1C", borderRadius: 12,
          borderLeft: `4px solid ${accent}`, border: `1px solid ${C.borderStrong}`,
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          maxWidth: 720, width: "100%", maxHeight: "90vh",
          overflow: "auto", padding: 24, color: C.pri,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.pri }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              background: "transparent", color: C.pri, border: `1px solid ${C.border}`,
              borderRadius: 6, padding: "6px 10px", cursor: "pointer",
              fontWeight: 800, fontSize: 12, fontFamily: "inherit",
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Stat box header — varies per type */}
        {modal.type === "kpi" && d.periodStats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
            <StatBox label="Committed" value={`${fmt1(d.periodStats.committed)}h`} color={BLUE} />
            <StatBox label="Booked"    value={`${fmt1(d.periodStats.booked)}h`}    color={GREEN} />
            <StatBox label="Variance"  value={`${d.periodStats.variance >= 0 ? "+" : ""}${fmt1(d.periodStats.variance)}h`} color={d.periodStats.variance >= 0 ? GREEN : RED} />
          </div>
        )}
        {modal.type === "day" && d.committed_hours !== undefined && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
            <StatBox label="Committed" value={`${fmt1(d.committed_hours)}h`} color={BLUE} />
            <StatBox label="Booked"    value={`${fmt1(d.booked_hours)}h`}    color={GREEN} />
            <StatBox label="Variance"  value={`${(d.variance_hours || 0) >= 0 ? "+" : ""}${fmt1(d.variance_hours)}h`} color={(d.variance_hours || 0) >= 0 ? GREEN : RED} />
          </div>
        )}
        {modal.type === "category" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
            <StatBox label="Plan"   value={d.plan} color={BLUE} />
            <StatBox label="Actual" value={d.actual} color={GREEN} />
            <StatBox label="Diff"   value={`${d.diff >= 0 ? "+" : ""}${d.diff}`} color={d.diff >= 0 ? GREEN : RED} />
          </div>
        )}
        {modal.type === "stage" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 16 }}>
            <StatBox label="Count"   value={d.count} color={d.color} />
            <StatBox label="% Share" value={`${d.pct}%`} color={d.color} />
          </div>
        )}

        {/* KPI per-day breakdown */}
        {modal.type === "kpi" && Array.isArray(d.filteredEntries) && d.filteredEntries.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <SectionLabel>Daily breakdown</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflow: "auto" }}>
              {d.filteredEntries.map((e, i) => (
                <DayRow key={i} entry={e} which={d.which} />
              ))}
            </div>
          </div>
        )}

        {/* Reasons block */}
        {Array.isArray(d.reasons) && d.reasons.length > 0 && (
          <div style={{
            background: "rgba(239,68,68,0.06)", borderLeft: `3px solid ${accent}`,
            padding: 14, borderRadius: 8, marginBottom: 16,
          }}>
            <SectionLabel>🔍 Reasons / Analysis</SectionLabel>
            {d.reasons.map((r, i) => (
              <div key={i} style={{ color: C.pri, fontSize: 12, fontWeight: 600, padding: "4px 0" }}>
                • {r}
              </div>
            ))}
          </div>
        )}

        {/* BOD vs EOD detail for day modal */}
        {modal.type === "day" && d.bod && d.eod && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <BodEodSidePanel
              color={BLUE}
              title="🌅 BOD Plan"
              data={d.bod.monthly_plan}
            />
            <BodEodSidePanel
              color={GREEN}
              title="🌆 EOD Actual"
              data={d.eod.monthly_actual}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.04)", borderLeft: `3px solid ${color}`,
      borderRadius: 8, padding: "10px 12px",
    }}>
      <div style={{
        fontSize: 10, color: C.muted, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 18, color, fontWeight: 800, fontFamily: "'DM Mono', monospace" }}>
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 800, color: C.pri,
      textTransform: "uppercase", letterSpacing: 1, marginBottom: 8,
    }}>
      {children}
    </div>
  );
}

function DayRow({ entry, which }) {
  const v = which === "committed" ? entry.committed_hours
          : which === "booked"    ? entry.booked_hours
          :                         entry.variance_hours;
  const num = Number(v) || 0;
  const color = which === "variance" ? (num >= 0 ? GREEN : RED)
              : which === "booked"   ? GREEN
              :                        BLUE;
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "8px 10px", background: "rgba(255,255,255,0.04)", borderRadius: 6,
    }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: C.pri }}>{entry.date}</span>
      <span style={{ fontSize: 13, fontWeight: 800, color, fontFamily: "'DM Mono', monospace" }}>
        {which === "variance" && num >= 0 ? "+" : ""}{num.toFixed(1)}h
      </span>
    </div>
  );
}

function BodEodSidePanel({ color, title, data }) {
  const entries = Object.entries(data || {}).filter(([, v]) => v !== undefined && v !== null);
  return (
    <div style={{
      background: "rgba(255,255,255,0.04)", borderLeft: `3px solid ${color}`,
      borderRadius: 8, padding: 12,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 800, color, textTransform: "uppercase",
        letterSpacing: 0.5, marginBottom: 8,
      }}>
        {title}
      </div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>—</div>
      ) : entries.map(([k, v], i) => (
        <div key={i} style={{
          display: "flex", justifyContent: "space-between",
          fontSize: 11, color: C.pri, fontWeight: 600, padding: "3px 0",
        }}>
          <span style={{ color: C.sec }}>{k}</span>
          <span style={{
            fontWeight: 800,
            fontFamily: typeof v === "number" ? "'DM Mono', monospace" : "inherit",
          }}>
            {typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(1)) : v}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────

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
    background:   "#050810",
    border:       `1px solid ${C.borderStrong}`,
    borderRadius: 8,
    color:        C.pri,
    fontWeight:   700,
    fontSize:     12,
  };
}

function dateInputStyle() {
  return {
    background: "rgba(255,255,255,0.06)", color: C.pri,
    border: `1px solid ${C.border}`, borderRadius: 6,
    padding: "6px 10px", fontWeight: 700, fontSize: 12,
    fontFamily: "inherit",
  };
}

function fmt1(v) {
  return (Number(v) || 0).toFixed(1);
}

function periodLabel(p) {
  if (p === "today")  return "Today";
  if (p === "week")   return "This Week";
  if (p === "month")  return "This Month";
  if (p === "custom") return "Custom Range";
  return "";
}

function parseEntryDate(s) {
  if (!s) return null;
  // Sheets emit M/D/YYYY or MM/DD/YYYY
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(String(s));
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  let [, mm, dd, yy] = m;
  let year = parseInt(yy, 10);
  if (year < 100) year += 2000;
  const d = new Date(year, parseInt(mm, 10) - 1, parseInt(dd, 10));
  return isNaN(d.getTime()) ? null : d;
}

function buildComparisonData(entry) {
  const plan   = entry?.bod?.monthly_plan   || {};
  const actual = entry?.eod?.monthly_actual || {};
  return COMPARE_CATEGORIES.map((cat) => ({
    category: cat,
    Plan:     Number(plan[cat])   || 0,
    Actual:   Number(actual[cat]) || 0,
  }));
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
