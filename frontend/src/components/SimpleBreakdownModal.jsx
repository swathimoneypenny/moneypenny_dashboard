import { useEffect } from "react";

// Compact list-only modal for KPI card drill-downs. Each call hands over a
// pre-built `items` list — the component renders ONLY: header, total chip,
// and a single column of name + value (+ optional percentage) rows. No
// search, sort, multi-section breakdown, or entries table — those live in
// BarDetailModal for the chart-bar drill-downs.
//
// Props:
//   open, onClose      — overlay/escape close behavior
//   title              — "📊 Organizations"
//   subtitle           — "5 active · This Month"
//   total              — pre-formatted string ("208.6h") or null to hide
//   items              — [{name, value:number, color?}]
//   accentColor        — left-border + total-chip color
//   showPercentage     — true → render `pct%` next to each value
export default function SimpleBreakdownModal({
  open,
  onClose,
  title,
  subtitle,
  total,
  items,
  accentColor = "#F2895A",
  showPercentage = false,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const list = Array.isArray(items) ? items : [];
  const sum  = list.reduce((s, it) => s + (Number(it.value) || 0), 0);

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
          background: "#13182A",
          borderRadius: 12,
          borderLeft: `4px solid ${accentColor}`,
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          maxWidth: 500, width: "100%", maxHeight: "80vh",
          overflow: "auto", padding: 24, color: "#FFFFFF",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#FFFFFF" }}>
              {title}
            </h2>
            {subtitle && (
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 6, fontWeight: 600 }}>
                {subtitle}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "1px solid rgba(255,255,255,0.2)",
              color: "#FFFFFF", fontSize: 12, cursor: "pointer", padding: "6px 10px",
              borderRadius: 6, fontWeight: 700, fontFamily: "inherit",
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {total != null && total !== "" && (
          <div
            style={{
              padding: "12px 14px", background: "rgba(255,255,255,0.04)",
              borderRadius: 8, marginBottom: 16,
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}
          >
            <span
              style={{
                fontSize: 11, color: "rgba(255,255,255,0.7)",
                fontWeight: 700, textTransform: "uppercase", letterSpacing: 1,
              }}
            >
              TOTAL
            </span>
            <span
              style={{
                fontSize: 22, color: accentColor,
                fontWeight: 800, fontFamily: "'DM Mono', monospace",
              }}
            >
              {total}
            </span>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {list.length === 0 ? (
            <div
              style={{
                color: "rgba(255,255,255,0.5)", fontStyle: "italic",
                textAlign: "center", padding: "20px 0",
              }}
            >
              No data available
            </div>
          ) : list.map((it, i) => {
            const v   = Number(it.value) || 0;
            const pct = sum > 0 ? (v / sum * 100).toFixed(1) : "0.0";
            const color = it.color || accentColor;
            return (
              <div
                key={i}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "12px 14px",
                  background: "rgba(255,255,255,0.04)",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.06)",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      width: 10, height: 10, background: color,
                      borderRadius: 2, flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      color: "#FFFFFF", fontSize: 13, fontWeight: 600,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                    title={it.name}
                  >
                    {it.name}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                  {showPercentage && (
                    <span
                      style={{
                        fontSize: 11, color: "rgba(255,255,255,0.55)",
                        fontWeight: 600, minWidth: 50, textAlign: "right",
                        fontFamily: "'DM Mono', monospace",
                      }}
                    >
                      {pct}%
                    </span>
                  )}
                  <span
                    style={{
                      color, fontSize: 14, fontWeight: 700,
                      fontFamily: "'DM Mono', monospace",
                      minWidth: 60, textAlign: "right",
                    }}
                  >
                    {typeof it.value === "number" ? `${v.toFixed(1)}h` : it.value}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
