import { useState, useMemo, useEffect } from "react";

// Universal drill-down modal opened from a clickable chart bar / table row.
// Each consumer hands over a uniform `entries` shape so the same component
// can render Team-Org, Project, Account-Code, or Employee-Category breakdowns
// with no per-call wiring. Entries fields (all optional; null-safe rendering):
//   { date, employee, project, accountCode, hours, billable, desc }
//   billable: boolean OR string ("BILLABLE" / "NON-BILL") — both accepted.
export default function BarDetailModal({
  open,
  onClose,
  title,
  subtitle,
  entries,
  accentColor = "#F2895A",
  totalHours,
}) {
  const [sortBy, setSortBy] = useState("date_desc");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const list = Array.isArray(entries) ? entries : [];

  const searchFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((e) =>
      (e.employee    || "").toLowerCase().includes(q) ||
      (e.project     || "").toLowerCase().includes(q) ||
      (e.accountCode || "").toLowerCase().includes(q) ||
      (e.desc        || "").toLowerCase().includes(q) ||
      (e.client      || "").toLowerCase().includes(q),
    );
  }, [list, search]);

  const sorted = useMemo(() => {
    const arr = [...searchFiltered];
    switch (sortBy) {
      case "date_desc":     return arr.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      case "date_asc":      return arr.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      case "employee_asc":  return arr.sort((a, b) => (a.employee || "").localeCompare(b.employee || ""));
      case "project_asc":   return arr.sort((a, b) => (a.project  || "").localeCompare(b.project  || ""));
      case "code_asc":      return arr.sort((a, b) => (a.accountCode || "").localeCompare(b.accountCode || ""));
      case "hours_desc":    return arr.sort((a, b) => (Number(b.hours) || 0) - (Number(a.hours) || 0));
      case "hours_asc":     return arr.sort((a, b) => (Number(a.hours) || 0) - (Number(b.hours) || 0));
      default:              return arr;
    }
  }, [searchFiltered, sortBy]);

  const isBillable = (e) => e.billable === true || e.billable === "BILLABLE";

  const byEmployee = useMemo(() => _groupBy(sorted, (e) => e.employee || "Unknown"), [sorted]);
  const byProject  = useMemo(() => _groupBy(sorted, (e) => e.project  || "(no project)"), [sorted]);
  const byCode     = useMemo(() => _groupBy(sorted, (e) => e.accountCode || "—"), [sorted]);

  const computedTotal = useMemo(() => {
    if (typeof totalHours === "number") return totalHours;
    return sorted.reduce((s, e) => s + (Number(e.hours) || 0), 0);
  }, [sorted, totalHours]);
  const billableTotal = useMemo(
    () => sorted.filter(isBillable).reduce((s, e) => s + (Number(e.hours) || 0), 0),
    [sorted],
  );
  const nonBillTotal = Math.max(0, computedTotal - billableTotal);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0A0F1C",
          borderRadius: 12,
          borderLeft: `4px solid ${accentColor}`,
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          maxWidth: 1100, width: "100%", maxHeight: "90vh",
          overflow: "auto", padding: 24, color: "#FFFFFF",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#FFFFFF" }}>
              📊 {title}
            </h2>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 6, fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>
              {subtitle ? `${subtitle} · ` : ""}{computedTotal.toFixed(2)}h total · {sorted.length} {sorted.length === 1 ? "entry" : "entries"}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "1px solid rgba(255,255,255,0.2)",
              color: "#FFFFFF", fontSize: 13, cursor: "pointer", padding: "6px 12px",
              borderRadius: 6, fontWeight: 700, fontFamily: "inherit",
            }}
            aria-label="Close"
          >
            ✕ Close
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
          <StatBox label="Total Hours"   value={`${computedTotal.toFixed(2)}h`} color="#FFFFFF" />
          <StatBox label="Billable"      value={`${billableTotal.toFixed(2)}h`} color="#10B981" />
          <StatBox label="Non-Billable"  value={`${nonBillTotal.toFixed(2)}h`}  color="#F2895A" />
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="🔍 Search employee, project, code, notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: "1 1 240px", minWidth: 200, padding: "8px 12px",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6,
              color: "#FFFFFF", fontSize: 12, fontWeight: 600, outline: "none",
              fontFamily: "inherit",
            }}
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              background: "rgba(255,255,255,0.06)", color: "#FFFFFF",
              border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6,
              padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <option value="date_desc">📅 Newest first</option>
            <option value="date_asc">📅 Oldest first</option>
            <option value="employee_asc">👤 Employee A-Z</option>
            <option value="project_asc">📁 Project A-Z</option>
            <option value="code_asc">🔧 Account code A-Z</option>
            <option value="hours_desc">⏱ Hours high-low</option>
            <option value="hours_asc">⏱ Hours low-high</option>
          </select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 20 }}>
          <BreakdownBox title="👥 By Employee"     items={byEmployee} accentColor={accentColor} />
          <BreakdownBox title="📁 By Project"      items={byProject}  accentColor={accentColor} />
          <BreakdownBox title="🔧 By Account Code" items={byCode}     accentColor={accentColor} />
        </div>

        <div>
          <h3 style={{ fontSize: 12, fontWeight: 700, color: "#FFFFFF", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
            All Entries ({sorted.length})
          </h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: "#FFFFFF" }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.08)" }}>
                  <th style={_th}>Date</th>
                  <th style={_th}>Employee</th>
                  <th style={_th}>Project</th>
                  <th style={_th}>Account Code</th>
                  <th style={_th}>Notes</th>
                  <th style={{ ..._th, textAlign: "right" }}>Hours</th>
                  <th style={{ ..._th, textAlign: "center" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ ..._td, color: "rgba(255,255,255,0.5)", fontStyle: "italic", textAlign: "center" }}>
                      No entries match.
                    </td>
                  </tr>
                ) : sorted.map((e, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    <td style={_td}>{(e.date || "").slice(0, 10) || "—"}</td>
                    <td style={{ ..._td, fontWeight: 700 }}>{e.employee || "—"}</td>
                    <td style={_td}>{e.project || "—"}</td>
                    <td style={{ ..._td, color: "#C5B3FF", fontFamily: "'DM Mono', monospace" }}>{e.accountCode || "—"}</td>
                    <td style={{ ..._td, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.desc || ""}>
                      {e.desc || "—"}
                    </td>
                    <td style={{ ..._td, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>
                      {(Number(e.hours) || 0).toFixed(2)}
                    </td>
                    <td style={{ ..._td, textAlign: "center", color: isBillable(e) ? "#10B981" : "#F2895A", fontWeight: 700, fontSize: 10 }}>
                      {isBillable(e) ? "BILLABLE" : "NON-BILL"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function _groupBy(list, keyFn) {
  const m = {};
  for (const e of list) {
    const k = keyFn(e);
    const h = Number(e.hours) || 0;
    if (!m[k]) m[k] = { name: k, hours: 0, entries: 0 };
    m[k].hours += h;
    m[k].entries += 1;
  }
  return Object.values(m).sort((a, b) => b.hours - a.hours);
}

function StatBox({ label, value, color }) {
  return (
    <div style={{ padding: 14, background: "rgba(255,255,255,0.04)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)" }}>
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, color, fontWeight: 800, fontFamily: "'DM Mono', monospace", marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

function BreakdownBox({ title, items, accentColor }) {
  const list = Array.isArray(items) ? items : [];
  const visible = list.slice(0, 10);
  return (
    <div style={{ padding: 14, background: "rgba(255,255,255,0.04)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)", maxHeight: 240, overflowY: "auto" }}>
      <div style={{ fontSize: 11, color: "#FFFFFF", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
        {title}
      </div>
      {visible.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.5)", fontStyle: "italic", fontSize: 11 }}>No data</div>
      ) : visible.map((it, i) => (
        <div
          key={i}
          style={{
            display: "flex", justifyContent: "space-between", padding: "6px 0",
            borderBottom: i < visible.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
          }}
        >
          <span style={{ color: "#FFFFFF", fontSize: 11, fontWeight: 600, flex: 1, marginRight: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.name}>
            {it.name}
          </span>
          <span style={{ color: accentColor || "#FFFFFF", fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>
            {it.hours.toFixed(2)}h
          </span>
        </div>
      ))}
      {list.length > 10 && (
        <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 10, marginTop: 6, textAlign: "center" }}>
          + {list.length - 10} more
        </div>
      )}
    </div>
  );
}

const _th = {
  padding: "10px 12px", textAlign: "left", color: "#FFFFFF",
  fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: 1,
  whiteSpace: "nowrap",
};

const _td = {
  padding: "10px 12px", color: "#FFFFFF", fontWeight: 600, fontSize: 12,
};
