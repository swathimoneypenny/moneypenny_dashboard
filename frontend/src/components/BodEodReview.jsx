import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, Cell, ReferenceLine, LabelList,
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
  const [activeCategory, setActiveCategory] = useState("monthly"); // monthly | daily | weekly | special
  const [showRawSheet, setShowRawSheet]     = useState(false);     // Team T: raw daily sheet collapsed by default

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

  // Team T's BOD/EOD sheet uses a different column layout AND a free-text
  // status format (not the standard Not-Started/In-Process/Completed file
  // pipeline). The committed/booked columns (1,2) still parse correctly, but
  // the structured file-status cards + category tabs would read misaligned
  // columns — so for Team T we hide those and render the verbatim sheet grid.
  const isTeamT = teamId === "team_t";

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

  // Dates currently in view — used to slice the raw sheet grid to the same
  // window the rest of the dashboard is showing.
  const visibleDates = useMemo(
    () => new Set(filteredEntries.map((e) => (e.date || "").trim())),
    [filteredEntries],
  );

  // Period stats. CRITICAL: committed_hours / booked_hours on each entry
  // are CUMULATIVE running totals (sheet column B/C is "8, 16, 24, ..."
  // not "8, 8, 8, ..."). Summing them was the bug — you'd get N*(N+1)*4
  // for an 8h-per-day target. Correct math:
  //   today  → that day's DAILY delta (latest.daily_*)
  //   month  → latest row's CUMULATIVE value (= month-to-date)
  //   week   → sum of daily deltas in the window
  //   custom → sum of daily deltas in the window
  const periodStats = useMemo(() => {
    if (!filteredEntries.length) return { committed: 0, booked: 0, variance: 0 };
    if (period === "today") {
      const e = filteredEntries[filteredEntries.length - 1];
      const c = Number(e.daily_committed) || 0;
      const b = Number(e.daily_booked)    || 0;
      return { committed: c, booked: b, variance: b - c };
    }
    if (period === "month") {
      // Committed = today's cumulative target (climbs even before EOD).
      // Booked = most recent cumulative booked > 0 — today's row reads 0
      // until EOD lands, but the user wants "what we've actually booked
      // so far" which is yesterday's number until today EOD's posted.
      const latest = filteredEntries[filteredEntries.length - 1];
      const lastBooked = [...filteredEntries].reverse().find(
        (x) => Number(x.cumulative_booked ?? x.booked_hours) > 0
      ) || latest;
      const c = Number(latest.cumulative_committed ?? latest.committed_hours) || 0;
      const b = Number(lastBooked.cumulative_booked ?? lastBooked.booked_hours) || 0;
      return { committed: c, booked: b, variance: b - c };
    }
    // week / custom — sum of dailies (mathematically equal to last_cum −
    // first_cum + first_daily, but expressed simpler).
    let c = 0, b = 0;
    for (const e of filteredEntries) {
      c += Number(e.daily_committed) || 0;
      b += Number(e.daily_booked)    || 0;
    }
    return { committed: c, booked: b, variance: b - c };
  }, [filteredEntries, period]);

  // File-status count row — driven by the latest day's EOD actuals
  // (falls back to BOD plan if EOD isn't filled yet today). Same 6
  // categories as the comparison bar chart so the dashboard tells one
  // consistent story.
  const fileCountStats = useMemo(() => {
    if (!filteredEntries.length) return null;
    const latest = filteredEntries[filteredEntries.length - 1];
    const eod = latest?.eod?.monthly_actual || {};
    const bod = latest?.bod?.monthly_plan   || {};
    const pick = (k) => {
      const v = eod[k] !== undefined ? eod[k] : bod[k];
      return typeof v === "number" ? v : (v ? Number(v) || 0 : 0);
    };
    return {
      total:       pick("Total Files"),
      notStarted:  pick("Not Started"),
      inProcess:   pick("In Process"),
      review:      pick("Review"),
      postedQuery: pick("Posted Query"),
      completed:   pick("Completed"),
      date:        latest?.date,
    };
  }, [filteredEntries]);

  const latestEntry = filteredEntries.length
    ? filteredEntries[filteredEntries.length - 1]
    : null;

  // Today's row often has no EOD yet (TL hasn't filed by mid-day). Walk
  // backwards to find the latest entry that actually has EOD data so the
  // CategorySection's EOD card + observations show meaningful content
  // instead of "Not yet recorded". BOD card keeps using `latestEntry`
  // since BOD plans are filed in the morning and reflect today's intent.
  const latestWithEOD = useMemo(() => {
    if (!filteredEntries.length) return null;
    for (let i = filteredEntries.length - 1; i >= 0; i--) {
      const e = filteredEntries[i];
      const hasEodMonthly = e.eod?.monthly_actual && Object.keys(e.eod.monthly_actual).length > 0;
      const hasBooked     = (Number(e.cumulative_booked ?? e.booked_hours) || 0) > 0;
      if (hasEodMonthly || hasBooked) return e;
    }
    return filteredEntries[filteredEntries.length - 1];
  }, [filteredEntries]);

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

      {/* File-status row — 6 cards driven by latest day's EOD actuals.
          Hidden for Team T (different sheet layout → would misalign). */}
      {!isTeamT && fileCountStats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10 }}>
          <FileStatusCard
            label="Total Files"   value={fileCountStats.total}       icon="📁" color={C.pri}
            onClick={() => openStageModal({ stage: "Total Files",   count: fileCountStats.total,       color: C.pri    }, latestEntry, setModal)}
          />
          <FileStatusCard
            label="Not Started"   value={fileCountStats.notStarted}  icon="⏸️" color={RED}
            onClick={() => openStageModal({ stage: "Not Started",   count: fileCountStats.notStarted,  color: RED      }, latestEntry, setModal)}
          />
          <FileStatusCard
            label="In Process"    value={fileCountStats.inProcess}   icon="⚙️" color={YELLOW}
            onClick={() => openStageModal({ stage: "In Process",    count: fileCountStats.inProcess,   color: YELLOW   }, latestEntry, setModal)}
          />
          <FileStatusCard
            label="Review"        value={fileCountStats.review}      icon="👁️" color={BLUE}
            onClick={() => openStageModal({ stage: "Review",        count: fileCountStats.review,      color: BLUE     }, latestEntry, setModal)}
          />
          <FileStatusCard
            label="Posted Query"  value={fileCountStats.postedQuery} icon="❓" color={PURPLE}
            onClick={() => openStageModal({ stage: "Posted Query",  count: fileCountStats.postedQuery, color: PURPLE   }, latestEntry, setModal)}
          />
          <FileStatusCard
            label="Completed"     value={fileCountStats.completed}   icon="✅" color={GREEN}
            onClick={() => openStageModal({ stage: "Completed",     count: fileCountStats.completed,   color: GREEN    }, latestEntry, setModal)}
          />
        </div>
      )}

      {/* 3 KPI cards — Committed / Booked / Variance. Efficiency dropped
          per spec (was noisy when 'today' wasn't yet EOD'd). Subtitle
          reads "Month-to-date" / "Today" / etc. so the user knows the
          number is a cumulative read, not a sum. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <ClickableKpi
          label="Committed (Target)"
          value={`${fmt1(periodStats.committed)}h`}
          color={BLUE}
          subtitle={kpiSubtitle("committed", period)}
          onClick={() => setModal({ open: true, type: "kpi", data: { which: "committed", periodStats, filteredEntries, period } })}
        />
        <ClickableKpi
          label="Booked (Actual)"
          value={`${fmt1(periodStats.booked)}h`}
          color={GREEN}
          subtitle={kpiSubtitle("booked", period)}
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
          <div style={{
            display: "flex", gap: 16, marginBottom: 12, fontSize: 11,
            color: C.pri, fontWeight: 700, flexWrap: "wrap",
          }}>
            <LegendItem color={BLUE}  label="Committed (Target)" />
            <LegendItem color={GREEN} label="Booked (Actual)" />
            <LegendItem color={RED}   label="Difference (Booked − Committed)" dashed />
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart
              data={filteredEntries.map((e) => ({
                ...e,
                variance_cumulative:
                  (Number(e.booked_hours)    || 0) -
                  (Number(e.committed_hours) || 0),
              }))}
              margin={{ top: 12, right: 20, left: 10, bottom: 24 }}
              onClick={(e) => {
                const p = e?.activePayload?.[0]?.payload;
                if (p) openDayModal(p, setModal);
              }}
              style={{ cursor: "pointer" }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: C.sec, fontSize: 10, fontWeight: 700 }} height={40}
                label={{ value: "Date", position: "insideBottom", offset: -2, fill: C.muted, fontSize: 11, fontWeight: 700 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 10, fontWeight: 700 }} tickFormatter={(v) => `${v}h`}
                label={{ value: "Hours", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11, fontWeight: 700 }} />
              <Tooltip
                cursor={{ stroke: ORANGE, strokeWidth: 1, strokeDasharray: "3 3" }}
                contentStyle={tooltipStyle()}
                formatter={(v, n) => {
                  const num = Number(v) || 0;
                  if (n === "Difference (Cumulative)") {
                    return [
                      `${num >= 0 ? "+" : ""}${num.toFixed(2)}h`,
                      num >= 0 ? "🟢 Ahead" : "🔴 Behind",
                    ];
                  }
                  return [`${num.toFixed(2)}h`, n];
                }}
              />
              {/* y=0 baseline for the variance line */}
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
              <Line
                type="monotone" dataKey="committed_hours" stroke={BLUE} strokeWidth={3}
                name="Committed (Cumulative)"
                dot={{ r: 5, fill: BLUE, stroke: "#FFFFFF", strokeWidth: 2, cursor: "pointer" }}
                activeDot={{ r: 8, fill: BLUE, stroke: "#FFFFFF", strokeWidth: 3 }}
              />
              <Line
                type="monotone" dataKey="booked_hours" stroke={GREEN} strokeWidth={3}
                name="Booked (Cumulative)"
                dot={{ r: 5, fill: GREEN, stroke: "#FFFFFF", strokeWidth: 2, cursor: "pointer" }}
                activeDot={{ r: 8, fill: GREEN, stroke: "#FFFFFF", strokeWidth: 3 }}
              />
              {/* Cumulative difference: red dashed, sits relative to y=0 */}
              <Line
                type="monotone" dataKey="variance_cumulative" stroke={RED} strokeWidth={2.5}
                strokeDasharray="5 5"
                name="Difference (Cumulative)"
                dot={{ r: 4, fill: RED, stroke: "#FFFFFF", strokeWidth: 1, cursor: "pointer" }}
                activeDot={{ r: 7, fill: RED, stroke: "#FFFFFF", strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
          <div style={{
            fontSize: 10, color: C.muted, fontStyle: "italic",
            marginTop: 6, textAlign: "center", letterSpacing: 0.3,
          }}>
            Click any point for that day's stats + reasons · running totals through each date
          </div>
        </div>
      )}

      {/* Team T: parsed visual dashboard (KPIs + status heatmap + task
          breakdown), computed client-side from the raw_grid since the sheet
          layout diverges from the template. Raw sheet kept behind a toggle. */}
      {isTeamT && client?.raw_grid?.headers?.length > 0 && (
        <TeamTVisual
          grid={client.raw_grid}
          visibleDates={visibleDates}
          showRawSheet={showRawSheet}
          setShowRawSheet={setShowRawSheet}
        />
      )}

      {/* Category breakdown — 4-tab switcher (Monthly / Daily / Weekly /
          Special Task). Each tab renders BOD vs EOD side-by-side for that
          specific status block, a per-category Plan vs Actual chart, and
          auto-generated Key Observations. Replaces the previous monthly-
          only BOD/EOD bars + Status Progression + Daily Variance.
          Hidden for Team T (different sheet layout → would misalign). */}
      {!isTeamT && latestEntry && (
        <CategorySection
          bodEntry={latestEntry}
          eodEntry={latestWithEOD || latestEntry}
          activeCategory={activeCategory}
          setActiveCategory={setActiveCategory}
          setModal={setModal}
        />
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

  if (v < 0) reasons.push(`⚠ Behind plan by ${Math.abs(v).toFixed(2)}h`);
  else if (v > 0) reasons.push(`✓ Ahead of plan by ${v.toFixed(2)}h`);
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

function FileStatusCard({ label, value, icon, color, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background:   C.card,
        border:       `1px solid ${color}33`,
        borderLeft:   `4px solid ${color}`,
        borderRadius: 10,
        padding:      14,
        cursor:       "pointer",
        textAlign:    "center",
        fontFamily:   "inherit",
        transition:   "transform 0.15s ease, background 0.15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = C.elevated;
        e.currentTarget.style.transform  = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = C.card;
        e.currentTarget.style.transform  = "translateY(0)";
      }}
    >
      <div style={{ fontSize: 22, marginBottom: 4 }}>{icon}</div>
      <div style={{
        fontSize: 26, fontWeight: 900, color,
        fontFamily: "'DM Mono', monospace", lineHeight: 1,
      }}>
        {Number(value || 0)}
      </div>
      <div style={{
        fontSize: 10, color: C.muted, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 0.5, marginTop: 6,
      }}>
        {label}
      </div>
    </button>
  );
}

// ── Team T parsed dashboard ────────────────────────────────────────
// Team T's BOD/EOD sheet packs the day's task plan as free text in the
// "BOD Status" column ("Total task - 18, Daily task - 6, TB - 5, TR - 5,
// Proforma - 2, Billing - 1, Reports - 3, K1 Recap - 1, Query asked - 2,
// In process - 4"), a clean status enum in "EOD Status" (Completed / In
// Progress / Awaiting Response / Delay with Client), and a numeric
// "No of returns completed". We parse those client-side off the raw_grid.

function _ttColIndex(headers, ...needles) {
  const norm = headers.map((h) => (h || "").toLowerCase());
  for (const n of needles) {
    const i = norm.findIndex((h) => h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

function _ttInt(text, re) {
  const m = re.exec(String(text || ""));
  return m ? parseInt(m[1], 10) || 0 : 0;
}

function parseTeamTTaskText(text) {
  return {
    total_tasks: _ttInt(text, /total task\s*[-:]\s*(\d+)/i),
    daily_task:  _ttInt(text, /daily task\s*[-:]\s*(\d+)/i),
    tb:          _ttInt(text, /\bTB\s*[-:]\s*(\d+)/i),
    tr:          _ttInt(text, /\bTR\s*[-:]\s*(\d+)/i),
    proforma:    _ttInt(text, /proforma\s*[-:]\s*(\d+)/i),
    billing:     _ttInt(text, /billing\s*[-:]\s*(\d+)/i),
    reports:     _ttInt(text, /reports?\s*[-:]\s*(\d+)/i),
    k1_recap:    _ttInt(text, /k1\s*recap\s*[-:]\s*(\d+)/i),
    queries:     _ttInt(text, /quer(?:y|ies)\s*asked\s*[-:]\s*(\d+)/i),
    in_process:  _ttInt(text, /in process\s*[-:]\s*(\d+)/i),
  };
}

function teamTStatusColor(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("complete"))                       return GREEN;
  if (s.includes("progress") || s.includes("process")) return YELLOW;
  if (s.includes("delay"))                          return ORANGE;
  if (s.includes("await") || s.includes("hold"))    return RED;
  return "rgba(255,255,255,0.12)"; // not yet filled
}

function teamTStatusEmoji(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("complete"))                          return "✅";
  if (s.includes("progress") || s.includes("process")) return "🔄";
  if (s.includes("delay"))                             return "⚠️";
  if (s.includes("await") || s.includes("hold"))       return "⏳";
  return "⬜";
}
const _TT_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function teamTDayName(dateStr) {
  const d = parseEntryDate(dateStr);
  return d ? _TT_DOW[d.getDay()] : "";
}

const TT_TASK_SERIES = [
  { key: "daily_task", name: "Daily",    fill: "#4A8FE7" },
  { key: "tb",         name: "TB",       fill: "#10B981" },
  { key: "tr",         name: "Tax Ret",  fill: "#F0B947" },
  { key: "proforma",   name: "Proforma", fill: "#9B7EE8" },
  { key: "billing",    name: "Billing",  fill: "#EC6F9C" },
  { key: "reports",    name: "Reports",  fill: "#6366F1" },
  { key: "k1_recap",   name: "K1 Recap", fill: "#14B8A6" },
];

function TeamTVisual({ grid, visibleDates, showRawSheet, setShowRawSheet }) {
  const headers = grid?.headers || [];
  const idx = useMemo(() => ({
    date:      0,
    committed: _ttColIndex(headers, "committed"),
    booked:    _ttColIndex(headers, "booked"),
    bodStatus: _ttColIndex(headers, "bod status"),
    eodStatus: headers.findIndex((h) => {
      const l = (h || "").toLowerCase();
      return l.includes("eod status") && !l.includes("detail");
    }),
    notes:     _ttColIndex(headers, "key points", "notes"),
    returns:   _ttColIndex(headers, "returns"),
  }), [headers]);

  const days = useMemo(() => {
    let rows = grid?.rows || [];
    if (visibleDates && visibleDates.size) {
      const f = rows.filter((r) => visibleDates.has((r[idx.date] || "").trim()));
      if (f.length) rows = f;
    }
    return rows.map((r) => {
      const cell = (i) => (i >= 0 && i < r.length ? r[i] : "") || "";
      // Task counts live in BOD Status; fall back to Key Points/Notes.
      const taskText = cell(idx.bodStatus) || cell(idx.notes);
      const parsed = parseTeamTTaskText(taskText);
      return {
        date:      (cell(idx.date) || "").trim(),
        committed: Number(cell(idx.committed)) || 0,
        booked:    Number(cell(idx.booked)) || 0,
        eodStatus: (cell(idx.eodStatus) || "").trim(),
        returns:   parseInt(cell(idx.returns), 10) || 0,
        ...parsed,
      };
    });
  }, [grid, visibleDates, idx]);

  const summary = useMemo(() => {
    const totalReturns = days.reduce((s, d) => s + d.returns, 0);
    const totalTasks   = days.reduce((s, d) => s + d.total_tasks, 0);
    const totalQueries = days.reduce((s, d) => s + d.queries, 0);
    const filled       = days.filter((d) => d.eodStatus);
    const completed    = filled.filter((d) => d.eodStatus.toLowerCase().includes("complete"));
    const compliance   = filled.length ? (completed.length / filled.length) * 100 : 0;
    return { totalReturns, totalTasks, totalQueries, compliance, daysCount: days.length };
  }, [days]);

  // Newest-first for the heatmap so the latest day reads first.
  const heatmapDays = useMemo(() => [...days].reverse().slice(0, 28), [days]);
  const hasReturns = summary.totalReturns > 0;

  return (
    <>
      {/* Parsed KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <ClickableKpi label="📋 Total Tasks (planned)" value={summary.totalTasks} color={BLUE}
          subtitle={`${summary.daysCount} day${summary.daysCount === 1 ? "" : "s"} in view`} onClick={() => {}} />
        <ClickableKpi label="✅ Returns Completed" value={summary.totalReturns} color={GREEN}
          subtitle={hasReturns ? "from 'No of returns completed'" : "column not filled yet"} onClick={() => {}} />
        <ClickableKpi label="❓ Queries Asked" value={summary.totalQueries} color={PURPLE}
          subtitle="parsed from daily plan" onClick={() => {}} />
        <ClickableKpi label="📊 EOD Completion" value={`${summary.compliance.toFixed(0)}%`} color={ORANGE}
          subtitle="days marked EOD Completed" onClick={() => {}} />
      </div>

      {/* Daily status CARDS — emoji + colour + task count + returns + hours */}
      <div style={panelStyle()}>
        <ChartHeader title="🗓 Daily EOD Status" hint="✅ Completed · 🔄 In Progress · ⏳ Awaiting · ⚠️ Delay · ⬜ not filled" />
        {heatmapDays.length === 0 ? (
          <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12 }}>No days in this window.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(142px, 1fr))", gap: 12 }}>
            {heatmapDays.map((d, i) => {
              const color = teamTStatusColor(d.eodStatus);
              return (
                <div key={i} style={{
                  background: `${color}1A`, border: `2px solid ${color}`,
                  borderRadius: 10, padding: 14, textAlign: "center",
                }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.pri }}>{d.date}</div>
                  <div style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>{teamTDayName(d.date)}</div>
                  <div style={{ fontSize: 30, margin: "8px 0 2px", lineHeight: 1 }}>{teamTStatusEmoji(d.eodStatus)}</div>
                  <div style={{ fontSize: 10, fontWeight: 800, color, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    {d.eodStatus || "Not Filled"}
                  </div>
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: C.pri, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
                      {d.total_tasks}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>tasks</div>
                  </div>
                  {d.returns > 0 && (
                    <div style={{ marginTop: 6, fontSize: 11, color: "#F0B947", fontWeight: 700 }}>📋 {d.returns} returns</div>
                  )}
                  <div style={{ marginTop: 6, fontSize: 11, color: BLUE, fontWeight: 700 }}>⏱ {d.booked.toFixed(1)}h</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Task breakdown stacked bar — segment numbers shown via LabelList */}
      {days.some((d) => TT_TASK_SERIES.some((s) => d[s.key] > 0)) && (
        <div style={panelStyle()}>
          <ChartHeader title="📊 Task Breakdown by Day" hint="X: Date · Y: Number of Tasks · Daily / TB / Tax Return / Proforma / Billing / Reports / K1 Recap" />
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={days} margin={{ top: 20, right: 30, left: 30, bottom: 64 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: C.sec, fontSize: 10, fontWeight: 700 }} angle={-45} textAnchor="end" height={72} interval={0}
                label={{ value: "Date", position: "insideBottom", offset: -2, fill: C.muted, fontSize: 11, fontWeight: 700 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 10, fontWeight: 700 }} allowDecimals={false}
                label={{ value: "Number of Tasks", angle: -90, position: "insideLeft", fill: C.muted, fontSize: 11, fontWeight: 700, style: { textAnchor: "middle" } }} />
              <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={tooltipStyle()} />
              <Legend verticalAlign="top" wrapperStyle={{ color: C.pri, fontWeight: 700, fontSize: 11, paddingBottom: 8 }} />
              {TT_TASK_SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} stackId="t" fill={s.fill} name={s.name}>
                  <LabelList dataKey={s.key} position="center" fill="#FFFFFF" fontSize={10}
                    formatter={(v) => (v > 0 ? v : "")} />
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Collapsible raw daily sheet */}
      <div>
        <button
          onClick={() => setShowRawSheet((v) => !v)}
          style={{
            background: "transparent", border: `1px solid ${C.border}`, color: C.pri,
            borderRadius: 8, padding: "8px 14px", cursor: "pointer",
            fontSize: 12, fontWeight: 800, letterSpacing: 0.4, fontFamily: "inherit",
          }}
        >
          {showRawSheet ? "▼ Hide Raw Daily Sheet" : "▶ Show Raw Daily Sheet (all columns)"}
        </button>
      </div>
      {showRawSheet && <RawSheetTable grid={grid} visibleDates={visibleDates} />}
    </>
  );
}

// Verbatim sheet grid for teams whose BOD/EOD layout diverges from the
// standard template. Renders every column from the sheet header, sliced to
// the dates currently in view (newest first), with horizontal scroll for the
// wide tax-team layout.
function RawSheetTable({ grid, visibleDates }) {
  const headers = grid?.headers || [];
  let rows = grid?.rows || [];
  if (visibleDates && visibleDates.size) {
    const filtered = rows.filter((r) => visibleDates.has((r[0] || "").trim()));
    if (filtered.length) rows = filtered;
  }
  rows = [...rows].reverse(); // newest first (sheet is chronological)
  if (!headers.length) return null;
  return (
    <div style={panelStyle()}>
      <ChartHeader
        title="📋 Daily Sheet — All Columns"
        hint={`${rows.length} day${rows.length === 1 ? "" : "s"} · Team T extended format`}
      />
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th
                  key={i}
                  style={{
                    position: i === 0 ? "sticky" : "static",
                    left: i === 0 ? 0 : undefined,
                    background: C.elevated,
                    color: C.pri,
                    fontWeight: 800,
                    textAlign: "left",
                    padding: "8px 10px",
                    borderBottom: `1px solid ${C.border}`,
                    whiteSpace: "nowrap",
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                    fontSize: 10,
                  }}
                >
                  {h || "—"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                {headers.map((_, ci) => (
                  <td
                    key={ci}
                    style={{
                      position: ci === 0 ? "sticky" : "static",
                      left: ci === 0 ? 0 : undefined,
                      background: ci === 0 ? C.card : "transparent",
                      color: ci === 0 ? C.pri : C.sec,
                      fontWeight: ci === 0 ? 800 : 600,
                      padding: "8px 10px",
                      verticalAlign: "top",
                      maxWidth: 280,
                      minWidth: ci === 0 ? 90 : undefined,
                      whiteSpace: "pre-wrap",
                      fontFamily: (ci === 1 || ci === 2) ? "'DM Mono', monospace" : "inherit",
                    }}
                  >
                    {r[ci] || ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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

function LegendItem({ color, label, dashed = false }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{
        width: 18, height: 3, background: dashed ? "transparent" : color,
        borderTop: dashed ? `2px dashed ${color}` : "none",
        borderRadius: 2,
      }} />
      {label}
    </span>
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
        {modal.type === "day" && d.daily_committed !== undefined && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 10 }}>
              <StatBox label="Today Target" value={`${fmt1(d.daily_committed)}h`} color={BLUE} />
              <StatBox label="Today Booked" value={`${fmt1(d.daily_booked)}h`}    color={GREEN} />
              <StatBox label="Today Variance"  value={`${(d.variance_hours || 0) >= 0 ? "+" : ""}${fmt1(d.variance_hours)}h`} color={(d.variance_hours || 0) >= 0 ? GREEN : RED} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginBottom: 16 }}>
              <StatBox label="Cumulative Target" value={`${fmt1(d.cumulative_committed ?? d.committed_hours)}h`} color={BLUE} />
              <StatBox label="Cumulative Booked" value={`${fmt1(d.cumulative_booked ?? d.booked_hours)}h`}       color={GREEN} />
            </div>
          </>
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
  // Daily breakdown rows show the per-day contribution (not the cumulative
  // running-total) so the user sees how each day moved the needle.
  const dailyC = Number(entry.daily_committed) || 0;
  const dailyB = Number(entry.daily_booked)    || 0;
  const v = which === "committed" ? dailyC
          : which === "booked"    ? dailyB
          :                         (dailyB - dailyC);
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
        {which === "variance" && num >= 0 ? "+" : ""}{num.toFixed(2)}h
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
            {typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Category section (tabs + side-by-side + chart + observations) ──

const CATEGORY_TABS = [
  { key: "monthly", label: "📋 Monthly",      color: BLUE   },
  { key: "daily",   label: "📌 Daily",        color: YELLOW },
  { key: "weekly",  label: "📅 Weekly",       color: PURPLE },
  { key: "special", label: "⭐ Special Task", color: ORANGE },
];

function getCategoryData(entry, category) {
  if (!entry) return { bod: {}, eod: {} };
  switch (category) {
    case "monthly":
      return {
        bod: entry.bod?.monthly_plan   || {},
        eod: entry.eod?.monthly_actual || {},
      };
    case "daily":
      return {
        bod: entry.bod?.daily_plan   || {},
        eod: entry.eod?.daily_actual || {},
      };
    case "weekly":
      return {
        bod: entry.bod?.weekly_plan   || {},
        eod: entry.eod?.weekly_actual || {},
      };
    case "special":
      return {
        bod: { text: entry.bod?.special_task_plan   || "" },
        eod: { text: entry.eod?.special_task_actual || "" },
      };
    default:
      return { bod: {}, eod: {} };
  }
}

function CategorySection({ bodEntry, eodEntry, activeCategory, setActiveCategory, setModal }) {
  const bodData = useMemo(() => getCategoryData(bodEntry, activeCategory).bod, [bodEntry, activeCategory]);
  const eodData = useMemo(() => getCategoryData(eodEntry, activeCategory).eod, [eodEntry, activeCategory]);
  const isSpecial = activeCategory === "special";
  const eodIsStale = bodEntry && eodEntry && bodEntry.date !== eodEntry.date;

  // Union of keys (preserves BOD order, then appends EOD-only keys) for
  // the per-category Plan vs Actual chart. Strings are dropped — only
  // numeric pairs make it onto the bar chart.
  const chartRows = useMemo(() => {
    if (isSpecial) return [];
    const seen = new Set();
    const order = [];
    for (const k of Object.keys(bodData)) { if (!seen.has(k)) { seen.add(k); order.push(k); } }
    for (const k of Object.keys(eodData)) { if (!seen.has(k)) { seen.add(k); order.push(k); } }
    return order
      .map((k) => ({
        category: k,
        Plan:     typeof bodData[k] === "number" ? bodData[k] : 0,
        Actual:   typeof eodData[k] === "number" ? eodData[k] : 0,
      }))
      .filter((r) => r.Plan > 0 || r.Actual > 0);
  }, [bodData, eodData, isSpecial]);

  // Observations use the entry with actual EOD data — otherwise today's
  // empty-EOD row would always produce "0 completed" warnings.
  const observations = useMemo(
    () => buildCategoryObservations({ bod: bodData, eod: eodData }, activeCategory, eodEntry),
    [bodData, eodData, activeCategory, eodEntry]
  );

  return (
    <>
      {/* Tab selector */}
      <div style={{
        background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
        padding: 8, display: "flex", gap: 4,
      }}>
        {CATEGORY_TABS.map((tab) => {
          const active = activeCategory === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveCategory(tab.key)}
              style={{
                flex: 1,
                background: active
                  ? `linear-gradient(135deg, ${tab.color}40 0%, ${tab.color}20 100%)`
                  : "transparent",
                color: C.pri,
                border: active ? `2px solid ${tab.color}` : "1px solid transparent",
                borderRadius: 8,
                padding: "10px 16px",
                fontWeight: 800,
                cursor: "pointer",
                fontSize: 13,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                fontFamily: "inherit",
                transition: "all 0.2s ease",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Stale-EOD chip — only when we fell back to a prior day for EOD */}
      {eodIsStale && (
        <div style={{
          fontSize: 11, color: YELLOW,
          background: "rgba(240,185,71,0.08)",
          border: `1px solid rgba(240,185,71,0.25)`,
          padding: "8px 12px", borderRadius: 8, fontWeight: 700,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          ⚠ Showing last EOD recorded: <span style={{ fontFamily: "'DM Mono', monospace" }}>{eodEntry.date}</span> — today's EOD ({bodEntry.date}) not yet filled
        </div>
      )}

      {/* Side-by-side BOD vs EOD cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <BodEodSideCard
          accent={BLUE}
          icon="🌅"
          label={`BOD — ${activeCategory.toUpperCase()} PLAN`}
          date={bodEntry?.date}
          data={bodData}
          isSpecial={isSpecial}
          emptyText={isSpecial ? "No special task planned" : `No ${activeCategory} plan recorded`}
          compareTo={null}
        />
        <BodEodSideCard
          accent={GREEN}
          icon="🌆"
          label={`EOD — ${activeCategory.toUpperCase()} ACTUAL`}
          date={eodEntry?.date}
          data={eodData}
          isSpecial={isSpecial}
          emptyText={isSpecial ? "No special task completed" : `No ${activeCategory} actual recorded`}
          compareTo={bodData}
        />
      </div>

      {/* Per-category Plan vs Actual bars (skip special) */}
      {!isSpecial && chartRows.length > 0 && (
        <div style={panelStyle()}>
          <ChartHeader
            title={`⚖️ ${activeCategory.toUpperCase()} · Plan vs Actual`}
            hint="Click any bar to see what changed and why"
          />
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={chartRows}
              margin={{ top: 12, right: 16, left: 0, bottom: 60 }}
              onClick={(e) => {
                const p = e?.activePayload?.[0]?.payload;
                if (p) openCategoryModal(p, eodEntry, setModal);
              }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="category"
                tick={{ fill: C.sec, fontSize: 11, fontWeight: 700 }}
                angle={-25}
                textAnchor="end"
                interval={0}
                height={70}
              />
              <YAxis tick={{ fill: C.muted, fontSize: 10, fontWeight: 700 }} />
              <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={tooltipStyle()} />
              <Legend wrapperStyle={{ color: C.pri, fontWeight: 700 }} />
              <Bar
                dataKey="Plan"
                fill={BLUE}
                radius={[6, 6, 0, 0]}
                style={{ cursor: "pointer" }}
                onClick={(p) => openCategoryModal(p?.payload || p, eodEntry, setModal)}
              />
              <Bar
                dataKey="Actual"
                fill={GREEN}
                radius={[6, 6, 0, 0]}
                style={{ cursor: "pointer" }}
                onClick={(p) => openCategoryModal(p?.payload || p, eodEntry, setModal)}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Key Observations */}
      <KeyObservations category={activeCategory} observations={observations} />
    </>
  );
}

function BodEodSideCard({ accent, icon, label, date, data, isSpecial, emptyText, compareTo }) {
  const entries = isSpecial ? [] : Object.entries(data || {});
  return (
    <div style={{
      background:   C.card,
      border:       `1px solid ${accent}33`,
      borderLeft:   `4px solid ${accent}`,
      borderRadius: 12,
      padding:      20,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16,
      }}>
        <h3 style={{
          color: accent, fontSize: 13, fontWeight: 800,
          textTransform: "uppercase", letterSpacing: 1, margin: 0,
        }}>
          {icon} {label}
        </h3>
        {date && (
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, fontFamily: "'DM Mono', monospace" }}>
            {date}
          </div>
        )}
      </div>

      {isSpecial ? (
        <div style={{
          padding: 14, background: `${accent}14`, borderRadius: 8,
          color: C.pri, fontSize: 13, fontWeight: 600, lineHeight: 1.5, minHeight: 60,
          whiteSpace: "pre-wrap",
        }}>
          {data.text
            ? data.text
            : <span style={{ color: C.muted, fontStyle: "italic", fontWeight: 600 }}>{emptyText}</span>}
        </div>
      ) : entries.length === 0 ? (
        <div style={{
          color: C.muted, fontStyle: "italic", padding: 12,
          fontSize: 12, fontWeight: 600,
        }}>
          {emptyText}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {entries.map(([k, v], i) => {
            const planValue = compareTo ? compareTo[k] : null;
            const diff =
              typeof v === "number" && typeof planValue === "number"
                ? v - planValue
                : null;
            return (
              <div key={i} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "10px 14px",
                background: `${accent}14`,
                border: `1px solid ${accent}26`,
                borderRadius: 6,
              }}>
                <span style={{ color: C.pri, fontSize: 12, fontWeight: 700 }}>{k}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    color: accent, fontSize: 16, fontWeight: 900,
                    fontFamily: "'DM Mono', monospace",
                  }}>
                    {formatCatValue(v)}
                  </span>
                  {diff !== null && diff !== 0 && (
                    <span style={{
                      fontSize: 10, fontWeight: 800,
                      color:      diff > 0 ? GREEN : RED,
                      background: diff > 0 ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)",
                      padding:    "2px 6px",
                      borderRadius: 4,
                      fontFamily: "'DM Mono', monospace",
                    }}>
                      {diff > 0 ? "+" : ""}{diff}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KeyObservations({ category, observations }) {
  const COLORS = {
    success: { bg: "rgba(16,185,129,0.08)",  border: GREEN  },
    warning: { bg: "rgba(240,185,71,0.08)",  border: YELLOW },
    info:    { bg: "rgba(74,143,231,0.08)",  border: BLUE   },
  };
  return (
    <div style={panelStyle()}>
      <h3 style={{
        color: C.pri, fontSize: 13, fontWeight: 800,
        textTransform: "uppercase", letterSpacing: 1, margin: "0 0 12px 0",
      }}>
        💡 Key Observations — {category.toUpperCase()}
      </h3>
      {observations.length === 0 ? (
        <div style={{ color: C.muted, fontStyle: "italic", padding: 12, fontWeight: 600, fontSize: 12 }}>
          No observations for this category
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {observations.map((o, i) => {
            const c = COLORS[o.type] || COLORS.info;
            return (
              <div key={i} style={{
                background: c.bg, borderLeft: `3px solid ${c.border}`,
                padding: "10px 14px", borderRadius: 6,
                color: C.pri, fontSize: 12, fontWeight: 600,
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>{o.icon}</span>
                <span>{o.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function buildCategoryObservations(catData, category, entry) {
  const obs = [];
  if (category === "monthly") {
    const total       = Number(catData.eod["Total Files"])   || 0;
    const completed   = Number(catData.eod["Completed"])     || 0;
    const inProcess   = Number(catData.eod["In Process"])    || 0;
    const review      = Number(catData.eod["Review"])        || 0;
    const query       = Number(catData.eod["Posted Query"])  || 0;
    const notStarted  = Number(catData.eod["Not Started"])   || 0;
    if (total > 0) {
      const pct = Math.round((completed / total) * 100);
      obs.push({
        icon: "📈",
        text: `Completion rate: ${pct}% (${completed} of ${total} files)`,
        type: pct >= 50 ? "success" : "warning",
      });
    }
    if (inProcess > 5)  obs.push({ icon: "⚠️", text: `${inProcess} files in process — possible bottleneck`, type: "warning" });
    if (review > 3)     obs.push({ icon: "👀", text: `${review} files pending review — needs attention`,    type: "warning" });
    if (query > 0)      obs.push({ icon: "❓", text: `${query} files waiting for client response`,           type: "info"    });
    if (notStarted > 0) obs.push({ icon: "⏸️", text: `${notStarted} files not yet started`,                  type: "info"    });
  } else if (category === "daily") {
    const planTasks   = Number(catData.bod["Daily Tasks"]) || 0;
    const actualTasks = Number(catData.eod["Daily Tasks"]) || 0;
    if (planTasks || actualTasks) {
      obs.push({
        icon: planTasks === actualTasks ? "✓" : "⚠️",
        text: `Daily tasks: planned ${planTasks}, completed ${actualTasks}`,
        type: planTasks === actualTasks ? "success" : "warning",
      });
    }
    // Generic per-key plan vs actual for whatever the TL filled in
    for (const [k, planV] of Object.entries(catData.bod)) {
      if (k === "Daily Tasks" || typeof planV !== "number") continue;
      const actualV = Number(catData.eod[k]) || 0;
      if (planV === actualV) continue;
      obs.push({
        icon: actualV >= planV ? "✓" : "⚠️",
        text: `${k}: planned ${planV}, actual ${actualV}`,
        type: actualV >= planV ? "success" : "warning",
      });
    }
  } else if (category === "weekly") {
    const planKeys = Object.entries(catData.bod).filter(([, v]) => typeof v === "number");
    if (planKeys.length === 0) {
      obs.push({ icon: "📅", text: `No weekly numeric targets recorded for ${entry?.date}`, type: "info" });
    } else {
      for (const [k, planV] of planKeys) {
        const actualV = Number(catData.eod[k]) || 0;
        obs.push({
          icon: actualV >= planV ? "✓" : "⚠️",
          text: `${k}: planned ${planV}, actual ${actualV}`,
          type: actualV >= planV ? "success" : "warning",
        });
      }
    }
  } else if (category === "special") {
    const planText   = (catData.bod.text || "").trim();
    const actualText = (catData.eod.text || "").trim();
    const noneish    = (s) => !s || s.toUpperCase() === "NIL" || s.toUpperCase() === "N/A";
    if (!noneish(actualText)) {
      obs.push({
        icon: "✓",
        text: `Special task completed: ${truncate(actualText, 100)}`,
        type: "success",
      });
    } else if (!noneish(planText)) {
      obs.push({
        icon: "⚠️",
        text: `Special task planned but not yet completed: ${truncate(planText, 80)}`,
        type: "warning",
      });
    } else {
      obs.push({ icon: "📭", text: "No special task on today's plan or EOD", type: "info" });
    }
  }
  if (entry?.notes && String(entry.notes).trim()) {
    obs.push({
      icon: "📝",
      text: `Note: ${truncate(entry.notes, 120)}`,
      type: "info",
    });
  }
  return obs;
}

function formatCatValue(v) {
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(v);
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
  return (Number(v) || 0).toFixed(2);
}

function periodLabel(p) {
  if (p === "today")  return "Today";
  if (p === "week")   return "This Week";
  if (p === "month")  return "This Month";
  if (p === "custom") return "Custom Range";
  return "";
}

function kpiSubtitle(which, p) {
  // Make it explicit that the number is cumulative / window-summed, not
  // a sum of cumulative rows (the bug we just fixed).
  if (p === "month") return which === "committed" ? "Month-to-date target" : "Month-to-date actual";
  if (p === "week")  return which === "committed" ? "Week-to-date target"  : "Week-to-date actual";
  if (p === "today") return which === "committed" ? "Today's target"       : "Today's actual";
  return which === "committed" ? "Custom range target" : "Custom range actual";
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
