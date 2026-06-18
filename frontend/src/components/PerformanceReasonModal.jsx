import { useMemo, useEffect } from "react";

// Performance-by-Org row drill-down. Replaces the entries-table modal for
// this surface — the user wants WHY the org is below/above target and HOW
// to fix it, not the row-by-row timesheet listing. Reasons are auto-derived
// from the org bucket already shipped by the backend (committed, actual,
// billable, nonBillable, entries[]) so there's no extra fetch.
export default function PerformanceReasonModal({ open, onClose, org, periodLabel, workingDays }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const analysis = useMemo(() => {
    if (!org) return null;

    const committed   = Number(org.committed)   || 0;
    const billable    = Number(org.billable)    || 0;
    const nonBillable = Number(org.nonBillable) || 0;
    // Performance is measured against BILLABLE hours only — non-billable time
    // does not count toward the committed target (it's shown separately as
    // info). `totalBooked` (billable + non-billable) is kept only for the
    // reference row in the Hours Breakdown.
    const totalBooked = billable + nonBillable;
    const actual      = billable;
    const gap         = billable - committed;
    const efficiency  = committed > 0 ? (billable / committed * 100) : 0;

    // Status thresholds (updated 2026-06-18): CRITICAL means BADLY BEHIND, not
    // over-performing. Exceeding target is positive (EXCEEDED), never red.
    //   <50% CRITICAL · 50–80% BELOW · 80–100% ON TRACK · 100–120% ABOVE · >120% EXCEEDED
    let status      = "ON TRACK";
    let statusColor = "#10B981";
    if (committed <= 0)            { status = "NO TARGET";    statusColor = "#6B7A95"; }
    else if (efficiency < 50)      { status = "CRITICAL";     statusColor = "#EF4444"; }
    else if (efficiency < 80)      { status = "BELOW TARGET"; statusColor = "#F2895A"; }
    else if (efficiency <= 100)    { status = "ON TRACK";     statusColor = "#10B981"; }
    else if (efficiency <= 120)    { status = "ABOVE TARGET"; statusColor = "#4A8FE7"; }
    else                           { status = "EXCEEDED";     statusColor = "#9B7EE8"; }

    // Bucket entries by employee + by date.
    const entries = Array.isArray(org.entries) ? org.entries : [];
    const byEmployee = {};
    const byDate     = {};
    for (const e of entries) {
      const emp  = (e.employee || "Unknown").trim() || "Unknown";
      const date = (e.date || "").slice(0, 10);
      const h    = Number(e.hours) || 0;
      byEmployee[emp] = (byEmployee[emp] || 0) + h;
      if (date) byDate[date] = (byDate[date] || 0) + h;
    }
    const employeeList    = Object.entries(byEmployee).sort((a, b) => b[1] - a[1]);
    const activeEmployees = employeeList.filter(([, h]) => h > 0);
    const expectedEmps    = Math.max(
      Number(org.memberCount) || 0,
      Number(org.staffCount)  || 0,
      activeEmployees.length,
    );
    const inactiveCount = Math.max(0, expectedEmps - activeEmployees.length);

    const days = Math.max(1, Number(workingDays) || 1);
    const perEmpTarget  = 8 * days;
    const avgPerEmp     = activeEmployees.length > 0
      ? activeEmployees.reduce((s, [, h]) => s + h, 0) / activeEmployees.length
      : 0;

    // Low-activity days: bottom 5 (per-day total < 30% of expected daily
    // throughput across the team for this org).
    const dailyExpected = 8 * expectedEmps;
    const lowActivityDays = Object.entries(byDate)
      .filter(([, h]) => h < dailyExpected * 0.3)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, 5);

    const nonBillRatio = totalBooked > 0 ? nonBillable / totalBooked : 0;

    return {
      status, statusColor,
      committed, actual, totalBooked, gap, efficiency,
      billable, nonBillable, nonBillRatio,
      employeeList: activeEmployees,
      inactiveCount, expectedEmps,
      lowActivityDays,
      avgPerEmp, perEmpTarget, days,
    };
  }, [org, workingDays]);

  if (!open || !analysis) return null;

  const isBelow  = analysis.status === "BELOW TARGET" || analysis.status === "NO TARGET" || analysis.status === "CRITICAL";
  const isAbove  = analysis.status === "ABOVE TARGET" || analysis.status === "EXCEEDED";
  const showRecs = isBelow;

  // Status-adaptive summary line shown under the Performance Gap section.
  const STATUS_NOTE = {
    "EXCEEDED":     "Booked hours are significantly above target. This is great performance — verify if scope expansion needs re-quoting.",
    "ABOVE TARGET": "Above target performance. Keep up the good work.",
    "ON TRACK":     "Meeting target. Healthy utilization.",
    "BELOW TARGET": "Below target. Review allocation and identify bottlenecks.",
    "CRITICAL":     "Significantly behind target. Immediate attention required.",
    "NO TARGET":    "No committed target configured for this client this period.",
  };
  const statusNote = STATUS_NOTE[analysis.status] || "";

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
          background: "#0A0F1C",
          borderRadius: 12,
          borderLeft: `4px solid ${analysis.statusColor}`,
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          maxWidth: 720, width: "100%", maxHeight: "90vh",
          overflow: "auto", padding: 24, color: "#FFFFFF",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#FFFFFF" }}>
              🏢 {org?.name || ""}
            </h2>
            <div
              style={{
                fontSize:      12,
                color:         analysis.statusColor,
                marginTop:     6,
                fontWeight:    800,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              {analysis.status} · {periodLabel}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent", border: "1px solid rgba(255,255,255,0.20)",
              color: "#FFFFFF", fontSize: 13, cursor: "pointer", padding: "6px 12px",
              borderRadius: 6, fontWeight: 700, fontFamily: "inherit",
            }}
          >
            ✕ Close
          </button>
        </div>

        <SectionBox title="📊 Performance Gap" color={analysis.statusColor}>
          <DataRow label="Target (pro-rated)"  value={`${analysis.committed.toFixed(2)}h`} />
          <DataRow label="Actual Billable"     value={`${analysis.billable.toFixed(2)}h`} color="#10B981" highlight />
          <DataRow
            label="Gap"
            value={`${analysis.gap >= 0 ? "+" : ""}${analysis.gap.toFixed(2)}h ${analysis.gap < 0 ? "behind" : "ahead"}`}
            color={analysis.gap < 0 ? "#EF4444" : "#10B981"}
          />
          <DataRow
            label="Efficiency"
            value={`${analysis.efficiency.toFixed(1)}% (Target: 80%+)`}
            color={analysis.statusColor}
          />
          {statusNote && (
            <div style={{ marginTop: 10, color: analysis.statusColor, fontSize: 12, fontWeight: 700 }}>
              {statusNote}
            </div>
          )}
        </SectionBox>

        <SectionBox title="📊 Hours Breakdown (Info Only)" color="#6B7A95">
          <DataRow label="Billable (counts toward target)" value={`${analysis.billable.toFixed(2)}h`}    color="#10B981" />
          <DataRow label="Non-Billable (not counted)"      value={`${analysis.nonBillable.toFixed(2)}h`} color="#F2895A" />
          <DataRow label="Total Booked (reference)"        value={`${analysis.totalBooked.toFixed(2)}h`} />
        </SectionBox>

        {isBelow && (
          <SectionBox title="🔍 Reasons (Why Below Target)" color="#EF4444">
            {(() => {
              const items = [];
              if (analysis.inactiveCount > 0) {
                items.push(
                  <ReasonItem
                    key="inactive"
                    num={items.length + 1}
                    title={`${analysis.inactiveCount} of ${analysis.expectedEmps} assigned employees logged 0h on this client`}
                    detail={`Active: ${analysis.employeeList.length} · Inactive: ${analysis.inactiveCount}`}
                  />,
                );
              }
              if (analysis.avgPerEmp < analysis.perEmpTarget * 0.7) {
                items.push(
                  <ReasonItem
                    key="avg"
                    num={items.length + 1}
                    title={`Avg ${analysis.avgPerEmp.toFixed(2)}h per active employee (target ${analysis.perEmpTarget.toFixed(2)}h over ${analysis.days} working day${analysis.days === 1 ? "" : "s"})`}
                    detail="Active employees are under-booking time on this client"
                  />,
                );
              }
              if (analysis.nonBillRatio > 0.3 && analysis.nonBillable > 0) {
                items.push(
                  <ReasonItem
                    key="nb"
                    num={items.length + 1}
                    title={`Non-billable share: ${analysis.nonBillable.toFixed(2)}h (${(analysis.nonBillRatio * 100).toFixed(0)}% of booked time)`}
                    detail="Some of this could be redirected to billable client work"
                  />,
                );
              }
              if (analysis.lowActivityDays.length > 0) {
                items.push(
                  <ReasonItem
                    key="days"
                    num={items.length + 1}
                    title={`${analysis.lowActivityDays.length} day${analysis.lowActivityDays.length === 1 ? "" : "s"} with very low activity`}
                    detail={analysis.lowActivityDays.map(([d, h]) => `${d}: ${h.toFixed(2)}h`).join("  ·  ")}
                  />,
                );
              }
              if (items.length === 0) {
                return (
                  <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 12, fontStyle: "italic" }}>
                    Couldn't pin a single cause — the gap may be split across small per-day shortfalls. Check the active-employee list below for who could pick up more time.
                  </div>
                );
              }
              return items;
            })()}
          </SectionBox>
        )}

        {showRecs && (
          <SectionBox title="💡 How to Overcome" color="#10B981">
            <Suggestion>📌 Reassign or re-activate the {analysis.inactiveCount > 0 ? `${analysis.inactiveCount} inactive` : "lower-utilization"} employees to log time on this client</Suggestion>
            <Suggestion>📌 Hold per-employee daily booking to the 8h minimum</Suggestion>
            <Suggestion>📌 Schedule dedicated client work sessions on the low-activity days listed above</Suggestion>
            <Suggestion>📌 Move some non-billable / internal time into billable client work where the scope allows</Suggestion>
            <Suggestion>📌 Review SOPs for this client to identify repeated drag</Suggestion>
            <Suggestion>📌 Run a quick team huddle to surface blockers (open queries, missing access, slow approvals)</Suggestion>
          </SectionBox>
        )}

        {isAbove && (
          <SectionBox title={analysis.status === "EXCEEDED" ? "🎉 Notes" : "✅ Notes"} color={analysis.statusColor}>
            <div style={{ color: "rgba(255,255,255,0.85)", fontSize: 12, fontWeight: 600 }}>
              {analysis.status === "EXCEEDED"
                ? "Billable hours are significantly above the pro-rated target — great performance. Large positive gaps can also point to unscoped work that should be re-quoted, so verify whether scope has expanded."
                : "Above-target performance against the pro-rated target — keep it up. If the team feels over-allocated to this client, confirm the scope still matches the committed hours."}
            </div>
          </SectionBox>
        )}

        <SectionBox title="👥 Active Employees" color="#4A8FE7">
          {analysis.employeeList.length === 0 ? (
            <div style={{ color: "rgba(255,255,255,0.55)", fontStyle: "italic", fontSize: 12 }}>
              No employees logged time on this client this period.
            </div>
          ) : (
            analysis.employeeList.map(([name, hours], i) => (
              <DataRow
                key={i}
                label={name}
                value={`${hours.toFixed(2)}h`}
                color={hours >= analysis.perEmpTarget * 0.7 ? "#10B981" : "#F0B947"}
              />
            ))
          )}
        </SectionBox>
      </div>
    </div>
  );
}

function SectionBox({ title, color, children }) {
  return (
    <div
      style={{
        background:   "rgba(255,255,255,0.04)",
        borderRadius: 8,
        padding:      16,
        marginBottom: 16,
        borderLeft:   `3px solid ${color}`,
      }}
    >
      <div
        style={{
          fontSize:      11,
          color:         "#FFFFFF",
          fontWeight:    800,
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom:  10,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function DataRow({ label, value, color, highlight }) {
  return (
    <div
      style={{
        display: "flex", justifyContent: "space-between", padding: highlight ? "8px 10px" : "6px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)", gap: 10,
        background: highlight ? "rgba(16,185,129,0.10)" : "transparent",
        borderRadius: highlight ? 6 : 0,
      }}
    >
      <span style={{ color: highlight ? "#FFFFFF" : "rgba(255,255,255,0.85)", fontSize: 13, fontWeight: highlight ? 800 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label}>
        {label}
      </span>
      <span style={{ color: color || "#FFFFFF", fontSize: highlight ? 14 : 13, fontWeight: 800, fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>
        {value}
      </span>
    </div>
  );
}

function ReasonItem({ num, title, detail }) {
  return (
    <div
      style={{
        padding:      "10px 12px",
        background:   "rgba(239,68,68,0.10)",
        borderRadius: 6,
        marginBottom: 8,
        borderLeft:   "2px solid #EF4444",
      }}
    >
      <div style={{ fontSize: 13, color: "#FFFFFF", fontWeight: 700, marginBottom: 4 }}>
        {num}. {title}
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", fontWeight: 600 }}>
        {detail}
      </div>
    </div>
  );
}

function Suggestion({ children }) {
  return (
    <div
      style={{
        padding:      "8px 12px",
        background:   "rgba(16,185,129,0.10)",
        borderRadius: 6,
        marginBottom: 6,
        color:        "#FFFFFF",
        fontSize:     12,
        fontWeight:   600,
        borderLeft:   "2px solid #10B981",
      }}
    >
      {children}
    </div>
  );
}
