import { useEffect, useMemo, useState } from "react";
import { C, authFetch } from "../config";

// TL-confirmed palette (2026-06-05):
const YN_COLOR = {
  yes:   "#10B981",
  no:    "#EF4444",
  na:    "#6B7280",
  other: "#9DB1CC",
  flag:  "#F59E0B",
};

const BOOL_COLUMNS = [
  { key: "reviewed_procedure",    label: "Reviewed Procedure" },
  { key: "updated_escalation",    label: "Updated Escalation" },
  { key: "assigned_reading",      label: "Assigned Reading" },
  { key: "assigned_quiz",         label: "Assigned Quiz" },
  { key: "checked_tsheet",        label: "Checked Tsheet" },
  { key: "checked_meeting_notes", label: "Checked Mtg Notes" },
  { key: "meeting_notes_shared",  label: "Mtg Notes Shared" },
];

function YnPill({ value }) {
  const v = String(value || "na").toLowerCase();
  if (v === "yes") return <span style={{ color: YN_COLOR.yes, fontWeight: 700 }}>✓</span>;
  if (v === "no")  return <span style={{ color: YN_COLOR.no,  fontWeight: 700 }}>✗</span>;
  if (v === "na")  return <span style={{ color: YN_COLOR.na }}>—</span>;
  return <span style={{ color: YN_COLOR.other, fontSize: 11 }}>{value}</span>;
}

function StatCard({ label, value, sublabel, color }) {
  return (
    <div
      style={{
        background: `linear-gradient(180deg, ${C.card} 0%, ${C.surface} 100%)`,
        border: `1px solid ${C.border}`,
        borderTop: `3px solid ${color || C.blue}`,
        borderRadius: 10,
        padding: "14px 16px",
        flex: "1 1 140px",
        minWidth: 130,
      }}
    >
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || C.pri, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
        {value}
      </div>
      {sublabel && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{sublabel}</div>
      )}
    </div>
  );
}

function ChecklistSummaryCards({ summary }) {
  if (!summary) return null;
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <StatCard label="Weeks tracked" value={summary.total_weeks ?? 0}         color={C.blue} />
      <StatCard
        label="Open flags"
        value={summary.open_flags ?? 0}
        color={(summary.open_flags ?? 0) > 0 ? YN_COLOR.flag : C.muted}
        sublabel={(summary.nil_flags_count ?? 0) > 0 ? `+ ${summary.nil_flags_count} NIL` : null}
      />
      <StatCard label="Whale updates" value={summary.whale_links_count ?? 0}   color={C.teal} />
    </div>
  );
}

// Reusable dropdown — used here AND in the cross-team Admin Hour view.
export function WeekDropdown({ weeks, selected, onChange }) {
  const list = Array.isArray(weeks) ? weeks : [];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
      <label
        style={{
          fontSize: 11,
          color: C.muted,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          fontWeight: 600,
        }}
      >
        Filter by week
      </label>
      <select
        value={selected || "all"}
        onChange={(e) => onChange && onChange(e.target.value)}
        style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          color: C.pri,
          padding: "6px 12px",
          fontSize: 13,
          fontFamily: "'DM Sans', sans-serif",
          cursor: "pointer",
          minWidth: 200,
          outline: "none",
        }}
      >
        <option value="all">All weeks</option>
        {list.map((w) => (
          <option key={w} value={w}>{w}</option>
        ))}
      </select>
    </div>
  );
}


// "Nothing-to-flag" values that still get shown but rendered muted (gray)
// instead of orange — TLs use them to mark a row as actively reviewed.
const _NIL_FLAG_TOKENS = new Set(["nil", "n/a", "na", "none", "-", "—"]);

function isNilFlag(text) {
  return _NIL_FLAG_TOKENS.has((text || "").trim().toLowerCase());
}

function FlagCard({ flag, nil }) {
  const accent = nil ? "#6B7280" : YN_COLOR.flag;
  const icon   = nil ? "○" : "⚠️";
  return (
    <div
      style={{
        padding: "12px 14px",
        background: nil ? "rgba(107, 122, 149, 0.06)" : `${YN_COLOR.flag}14`,
        border: nil ? `1px solid ${C.border}` : `1px solid ${YN_COLOR.flag}55`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 8,
        marginBottom: 8,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: C.muted,
          fontFamily: "'DM Mono', monospace",
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ color: accent }}>{icon}</span>
        <span>{flag.week} · {flag.client}</span>
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: nil ? 500 : 600,
          fontStyle: nil ? "italic" : "normal",
          color: nil ? C.muted : C.pri,
        }}
      >
        {nil ? `${flag.flag} (no issues this week)` : flag.flag}
      </div>
    </div>
  );
}

function OpenFlagsList({ summary }) {
  const flags     = summary?.flags || [];
  const realFlags = flags.filter((f) => !isNilFlag(f.flag));
  const nilFlags  = flags.filter((f) => isNilFlag(f.flag));
  const [showNil, setShowNil] = useState(false);
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: C.pri,
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span>🚩 Open Flags</span>
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 500 }}>
          {realFlags.length} real{nilFlags.length > 0 ? ` · ${nilFlags.length} NIL` : ""}
        </span>
      </div>

      {realFlags.length === 0 && nilFlags.length === 0 && (
        <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12 }}>
          (none this period)
        </div>
      )}

      {realFlags.length > 0 && (
        <div style={{ marginBottom: nilFlags.length > 0 ? 12 : 0 }}>
          {realFlags.map((f, i) => (
            <FlagCard key={`real-${i}`} flag={f} nil={false} />
          ))}
        </div>
      )}

      {realFlags.length === 0 && nilFlags.length > 0 && (
        <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12, marginBottom: 10 }}>
          No real flags this period — every reviewed row was marked NIL.
        </div>
      )}

      {nilFlags.length > 0 && (
        <div>
          <button
            onClick={() => setShowNil((v) => !v)}
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              color: C.sec,
              padding: "6px 12px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 11,
              fontFamily: "'DM Sans', sans-serif",
              fontWeight: 600,
            }}
          >
            {showNil ? "▾" : "▸"} {showNil ? "Hide" : "Show"} {nilFlags.length} NIL entr{nilFlags.length === 1 ? "y" : "ies"}
          </button>
          {showNil && (
            <div style={{ marginTop: 10 }}>
              {nilFlags.map((f, i) => (
                <FlagCard key={`nil-${i}`} flag={f} nil />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Normalize the polymorphic whale_links input into [{label, url}].
// Accepts the new backend shape ([{label, url}]) AND the legacy string list
// shape from cached responses still in flight. Empty / non-URL entries are
// dropped. Labels fall back to "Whale" / "Whale N" when the source cell had
// only URLs with no preceding text.
function _normalizeWhaleLinks(input, urlFallback) {
  let raw = [];
  if (Array.isArray(input)) {
    raw = input;
  } else if (typeof urlFallback === "string") {
    raw = (urlFallback.match(/https?:\/\/[^\s,;'"\)]+/gi) || [])
      .map((u) => u.replace(/[.,;:)]+$/, ""));
  }
  const out = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (/^https?:\/\//i.test(item)) out.push({ label: "", url: item });
    } else if (item && typeof item === "object" && typeof item.url === "string"
               && /^https?:\/\//i.test(item.url)) {
      out.push({ label: (item.label || "").trim(), url: item.url });
    }
  }
  // Backfill blank labels — match the backend numbering pattern.
  const blanks = out.filter((x) => !x.label);
  if (blanks.length === 1 && out.length === 1) out[0].label = "Whale SOP";
  else if (blanks.length > 0) {
    let n = 1;
    for (const x of out) if (!x.label) x.label = `Whale ${n++}`;
  }
  return out;
}


// Compact cell used in the dense detail table. Shows the TL-typed label
// (e.g. "Reconciliation SOP") as a hyperlink. Multi-link cells stack.
function WhaleLinkCell({ urls, url }) {
  const list = _normalizeWhaleLinks(urls, url);
  if (list.length === 0) {
    return <span style={{ color: C.muted, fontSize: 11 }}>—</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {list.map((link, i) => (
        <a
          key={i}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          title={link.url}
          style={{
            color: C.teal,
            fontSize: 11,
            textDecoration: "none",
            borderBottom: `1px dashed ${C.teal}`,
            whiteSpace: "nowrap",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "inline-block",
          }}
        >
          🐳 {link.label}
        </a>
      ))}
    </div>
  );
}

// ── Per-client view helpers ─────────────────────────────────────────
// The /api/team/{id}/checklist payload is week-major (weeks[].entries[]).
// TLs reason client-major ("what happened on Portnoy this week?"). This
// helper inverts the shape: one rollup per logical "row" across every visible
// week, with the LATEST status winning per bool column.
//
// "Logical row" = one client for solo entries; ALL siblings collapsed into one
// row for multi-client entries (where the upstream CSV row listed 3 clients
// in one cell). That way the heatmap, procedure cards, and training table all
// show a single combined entry — "EZ Ledger, Putman, Manzelli" — instead of
// three identical rows.
function buildPerClientView(weeks) {
  const map = new Map();
  for (const w of weeks || []) {
    for (const e of w.entries || []) {
      const rawClient   = (e.client || "").trim();
      const clientLabel = rawClient || "(Team-wide)";
      const isTeamWide  = !rawClient;
      const isMulti     = !!e.is_multi_client_row
                          && Array.isArray(e.siblings)
                          && e.siblings.length > 1;

      // Multi-client siblings share one logical row (keyed by the sorted
      // sibling set so order in the cell doesn't fragment the grouping).
      const key = isMulti
        ? `MULTI__${[...e.siblings].sort().join("||")}`
        : clientLabel;

      let row = map.get(key);
      if (!row) {
        const clientList = isMulti ? e.siblings.slice() : [clientLabel];
        row = {
          // Display label — combined names for multi, plain name for solo.
          client:        isMulti ? clientList.join(", ") : clientLabel,
          clientList,
          isMultiClient: isMulti,
          isTeamWide:    !isMulti && isTeamWide,
          siblings:      isMulti ? clientList.slice() : [],
          weeks: [],
          tasks: {},
          // Per-week list of per-client update blocks. Used by
          // ProcedureUpdatesCards to render one block per client inside the
          // combined multi-client card. Shape: {week: [{client, updated, new}]}
          weekUpdatesMap: {},
          // Flat list kept so the "has any updates" filter still works.
          updates: [],
          trainingPreparers: [],
          trainingTL: [],
          whaleLinks: [],
        };
        map.set(key, row);
      }

      if (!row.weeks.includes(w.week)) row.weeks.push(w.week);

      // Bool columns: multi-client siblings come from the same CSV row so
      // their values agree (the parser broadcasts). For solo clients across
      // multiple weeks, the latest entry wins (later iteration overwrites).
      for (const col of BOOL_COLUMNS) {
        row.tasks[col.key] = e[col.key] || "na";
      }

      // Per-client update text — preserve which client got which slice when
      // _split_numbered_updates produced distinct chunks.
      const upd = (e.updated_procedure || "").trim();
      const nu  = (e.new_procedure || "").trim();
      if (upd || nu) {
        if (!row.weekUpdatesMap[w.week]) row.weekUpdatesMap[w.week] = [];
        row.weekUpdatesMap[w.week].push({
          client:  clientLabel,
          updated: upd,
          new:     nu,
        });
        row.updates.push({ week: w.week, updated: upd, new: nu });
      }

      // Training (dedupe identical broadcasts across siblings).
      const tp = (e.training_preparers || "").trim();
      const tt = (e.training_myself || "").trim();
      if (tp && !row.trainingPreparers.includes(tp)) row.trainingPreparers.push(tp);
      if (tt && !row.trainingTL.includes(tt))        row.trainingTL.push(tt);

      // Whale links — dedupe (siblings share the same Whale list). Accept
      // either the new [{label, url}] shape or legacy strings.
      const links = Array.isArray(e.whale_links) ? e.whale_links
                  : (e.whale_link ? [e.whale_link] : []);
      const seenUrls = new Set(
        row.whaleLinks.map((x) => (typeof x === "string" ? x : x?.url))
      );
      for (const item of links) {
        const url = typeof item === "string" ? item : item?.url;
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          row.whaleLinks.push(item);
        }
      }
    }
  }
  return Array.from(map.values());
}


// Heatmap cell glyphs — colored square per (client × task).
function HeatCell({ value, taskLabel, client }) {
  const v = String(value || "na").toLowerCase();
  const meta = v === "yes" ? { glyph: "✓", color: "#10B981" }
             : v === "no"  ? { glyph: "✗", color: "#EF4444" }
             : v === "na"  ? { glyph: "—", color: "#6B7280" }
             : { glyph: String(value || "·"), color: YN_COLOR.other };
  const label = `${client} · ${taskLabel}: ${v.toUpperCase()}`;
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        fontSize: 16,
        fontWeight: 700,
        color: meta.color,
        fontFamily: "'DM Mono', monospace",
      }}
    >
      {meta.glyph}
    </span>
  );
}


function PerClientComplianceHeatmap({ rows }) {
  const [hoverRow, setHoverRow] = useState(null);
  if (!rows || rows.length === 0) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.pri, marginBottom: 4 }}>
          📊 Per-client Compliance Heatmap
        </div>
        <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12, marginTop: 4 }}>
          No client rows recorded this period.
        </div>
      </div>
    );
  }
  const headerTh = {
    position: "sticky",
    top: 0,
    background: C.card,
    fontSize: 11,
    fontWeight: 600,
    color: C.sec,
    padding: "12px 14px",
    borderBottom: `1px solid ${C.border}`,
    whiteSpace: "nowrap",
    textAlign: "center",
  };
  const stickyClient = {
    position: "sticky",
    left: 0,
    background: C.card,
    fontWeight: 600,
    fontSize: 13,
    color: C.pri,
    padding: "14px 14px",
    borderRight: `1px solid ${C.border}`,
    whiteSpace: "nowrap",
    zIndex: 1,
    textAlign: "left",
  };
  const cellPad = { padding: "14px 14px", textAlign: "center", borderBottom: `1px solid rgba(255,255,255,0.05)` };
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.pri, marginBottom: 12 }}>
        📊 Per-client Compliance Heatmap
      </div>
      <div style={{ overflowX: "auto", maxHeight: 360, border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...headerTh, ...stickyClient, textAlign: "left", zIndex: 2 }}>Client</th>
              {BOOL_COLUMNS.map((col) => (
                <th key={col.key} style={headerTh} title={col.label}>
                  {col.label.replace(" Procedure", "")
                            .replace("Checked ", "")
                            .replace("Updated ", "")
                            .replace("Assigned ", "")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isHover = hoverRow === row.client;
              const baseBg = isHover
                ? C.surface
                : (i % 2 === 0 ? "transparent" : C.surface);
              return (
                <tr
                  key={row.client}
                  onMouseEnter={() => setHoverRow(row.client)}
                  onMouseLeave={() => setHoverRow((r) => (r === row.client ? null : r))}
                  style={{ background: baseBg, transition: "background 0.12s" }}
                >
                  <td
                    style={{
                      ...stickyClient,
                      ...cellPad,
                      padding: "14px 14px",
                      background: baseBg,
                      fontStyle: row.isTeamWide ? "italic" : "normal",
                      color: row.isTeamWide ? C.muted : C.pri,
                      borderRight: `1px solid ${C.border}`,
                      borderBottom: `1px solid rgba(255,255,255,0.05)`,
                    }}
                  >
                    {row.client}
                    <div style={{ fontSize: 10, color: C.muted, fontFamily: "'DM Mono', monospace", marginTop: 2 }}>
                      {row.weeks.join(" · ")}
                    </div>
                  </td>
                  {BOOL_COLUMNS.map((col) => (
                    <td key={col.key} style={cellPad}>
                      <HeatCell value={row.tasks[col.key]} taskLabel={col.label} client={row.client} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 11, color: C.muted }}>
        <span><span style={{ color: "#10B981", fontWeight: 700 }}>✓</span> Yes</span>
        <span><span style={{ color: "#EF4444", fontWeight: 700 }}>✗</span> No</span>
        <span><span style={{ color: "#6B7280" }}>—</span> N/A</span>
      </div>
    </div>
  );
}


function FieldRow({ label, children }) {
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 8, alignItems: "flex-start" }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: C.muted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          minWidth: 70,
          paddingTop: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: C.pri, lineHeight: 1.5, flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

// Chip-style row used in the Procedure Updates cards. Shows the TL-typed
// label as the chip text — falls back to "Whale N" only when the source
// cell had no preceding label text.
function WhaleChipRow({ urls }) {
  const list = _normalizeWhaleLinks(urls);
  if (list.length === 0) return <span style={{ color: C.muted }}>—</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {list.map((link, i) => (
        <a
          key={i}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          title={link.url}
          style={{
            fontSize: 12,
            color: C.teal,
            textDecoration: "none",
            padding: "4px 10px",
            background: C.card,
            border: `1px solid ${C.teal}40`,
            borderRadius: 4,
            display: "inline-block",
            whiteSpace: "nowrap",
            maxWidth: 220,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          🐳 {link.label}
        </a>
      ))}
    </div>
  );
}

function ProcedureUpdatesCards({ rows }) {
  // Keep only rows with at least one real update or a Whale link. Multi-client
  // rows already collapsed in buildPerClientView, so each `row` is one card
  // group (one client OR one multi-client sibling set).
  const cards = (rows || []).filter(
    (r) =>
      r.updates.some((u) => (u.updated || "").trim() || (u.new || "").trim())
      || r.whaleLinks.length > 0,
  );
  if (cards.length === 0) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.pri, marginBottom: 4 }}>
          📝 Procedure Updates
        </div>
        <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12, marginTop: 4 }}>
          No procedure updates recorded this period.
        </div>
      </div>
    );
  }
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.pri, marginBottom: 12 }}>
        📝 Procedure Updates
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {cards.flatMap((row) => {
          // Build one card per week-with-content. Multi-client cards show one
          // per-client block per sibling; solo cards show a single Updated/New
          // pair. Whale links render ONCE on the first card per row group.
          const weeksWithUpdates = Object.keys(row.weekUpdatesMap);
          const blocks = weeksWithUpdates.length > 0
            ? weeksWithUpdates.map((wk) => ({
                week:         wk,
                clientBlocks: row.weekUpdatesMap[wk],
              }))
            : [{ week: row.weeks[0] || "—", clientBlocks: [] }];

          return blocks.map((b, j) => {
            const headerLabel = row.isMultiClient
              ? `🏢 ${row.clientList.join(" · ")}`
              : `🏢 ${row.client}`;

            // Detect broadcast: identical (updated, new) across siblings.
            const first = b.clientBlocks[0];
            const allSame = b.clientBlocks.length > 1 && first && b.clientBlocks.every(
              (cb) => cb.updated === first.updated && cb.new === first.new,
            );

            return (
              <div
                key={`${row.client}-${b.week}-${j}`}
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 10,
                  padding: 16,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: row.isTeamWide ? C.muted : C.pri,
                      fontStyle: row.isTeamWide ? "italic" : "normal",
                    }}
                  >
                    {headerLabel}
                    {row.isMultiClient && (
                      <span style={{ fontSize: 11, color: C.muted, fontWeight: 500, marginLeft: 8 }}>
                        · combined entry · ×{row.clientList.length}
                      </span>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      padding: "4px 10px",
                      borderRadius: 12,
                      background: C.card,
                      color: C.sec,
                      fontFamily: "'DM Mono', monospace",
                      letterSpacing: 0.4,
                    }}
                  >
                    {b.week}
                  </span>
                </div>

                {row.isMultiClient && b.clientBlocks.length > 0 && !allSame ? (
                  // Distinct per-client text — render one block per sibling.
                  b.clientBlocks.map((cb, k) => (
                    <div
                      key={`${cb.client}-${k}`}
                      style={{
                        paddingTop: k > 0 ? 10 : 0,
                        marginTop:  k > 0 ? 10 : 0,
                        borderTop:  k > 0 ? `1px dashed ${C.border}` : "none",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 11,
                          color: C.teal,
                          fontWeight: 700,
                          fontFamily: "'DM Mono', monospace",
                          letterSpacing: 0.4,
                          marginBottom: 6,
                          textTransform: "uppercase",
                        }}
                      >
                        {cb.client}
                      </div>
                      <FieldRow label="Updated">
                        {cb.updated ? cb.updated : <span style={{ color: C.muted }}>—</span>}
                      </FieldRow>
                      <FieldRow label="New">
                        {cb.new ? cb.new : <span style={{ color: C.muted }}>—</span>}
                      </FieldRow>
                    </div>
                  ))
                ) : (
                  // Solo client OR multi-client broadcast (identical text):
                  // render one Updated/New pair.
                  <>
                    <FieldRow label="Updated">
                      {first && first.updated
                        ? first.updated
                        : <span style={{ color: C.muted }}>—</span>}
                    </FieldRow>
                    <FieldRow label="New">
                      {first && first.new
                        ? first.new
                        : <span style={{ color: C.muted }}>—</span>}
                    </FieldRow>
                    {row.isMultiClient && allSame && (
                      <div style={{ fontSize: 10, color: C.muted, fontStyle: "italic", marginTop: 4 }}>
                        (applies to all {row.clientList.length} clients)
                      </div>
                    )}
                  </>
                )}

                {/* Whale links surface only on the FIRST card per row so we
                    don't repeat them per week (or per sibling). */}
                {j === 0 && row.whaleLinks.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                    <FieldRow label="Whale">
                      <WhaleChipRow urls={row.whaleLinks} />
                    </FieldRow>
                  </div>
                )}
              </div>
            );
          });
        })}
      </div>
    </div>
  );
}


function TrainingTopicsByClientTable({ rows }) {
  const [hoverRow, setHoverRow] = useState(null);
  // Show every client row — even ones with no training noted — so the user
  // can scan all reviewed clients in one place. "(No training noted)" fills
  // empty cells. Multi-client siblings already collapsed in buildPerClientView.
  const allRows = rows || [];
  if (allRows.length === 0) {
    return (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.pri, marginBottom: 4 }}>
          🎓 Training Topics
        </div>
        <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12, marginTop: 4 }}>
          No training topics recorded this period.
        </div>
      </div>
    );
  }
  const th = {
    padding: "12px 14px",
    fontSize: 11,
    color: C.sec,
    fontWeight: 600,
    borderBottom: `1px solid ${C.border}`,
    background: C.card,
    whiteSpace: "nowrap",
    textAlign: "left",
    position: "sticky",
    top: 0,
    zIndex: 1,
  };
  const td = {
    padding: "12px 14px",
    fontSize: 13,
    color: C.pri,
    borderBottom: `1px solid rgba(255,255,255,0.05)`,
    verticalAlign: "top",
  };
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.pri, marginBottom: 12 }}>
        🎓 Training Topics
      </div>
      <div style={{ overflowX: "auto", maxHeight: 360, border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr>
              <th style={th}>Client</th>
              <th style={th}>Preparers need</th>
              <th style={th}>TL needs</th>
            </tr>
          </thead>
          <tbody>
            {allRows.map((row, i) => {
              const both = row.trainingPreparers.length > 0 && row.trainingTL.length > 0;
              const rowKey = row.client;
              const hover = hoverRow === rowKey;
              const baseBg = hover
                ? C.surface
                : (i % 2 === 0 ? "transparent" : C.surface);
              const noTraining = row.trainingPreparers.length === 0 && row.trainingTL.length === 0;
              const isMulti = !!row.isMultiClient && (row.clientList || []).length > 1;
              return (
                <tr
                  key={rowKey}
                  onMouseEnter={() => setHoverRow(rowKey)}
                  onMouseLeave={() => setHoverRow((r) => (r === rowKey ? null : r))}
                  style={{
                    background: baseBg,
                    transition: "background 0.12s",
                  }}
                >
                  <td
                    style={{
                      ...td,
                      fontWeight: 600,
                      color: row.isTeamWide ? C.muted : C.pri,
                      fontStyle: row.isTeamWide ? "italic" : "normal",
                      borderLeft: both ? `3px solid ${YN_COLOR.flag}` : "3px solid transparent",
                    }}
                  >
                    {isMulti ? (
                      <>
                        <div>{row.clientList.join(", ")}</div>
                        <div style={{ fontSize: 10, color: C.muted, fontWeight: 500, marginTop: 2, fontStyle: "italic" }}>
                          combined entry · ×{row.clientList.length}
                        </div>
                      </>
                    ) : (
                      row.client
                    )}
                  </td>
                  <td style={td}>
                    {row.trainingPreparers.length === 0
                      ? <span style={{ color: C.muted, fontStyle: "italic", fontSize: 12 }}>
                          {noTraining ? "(No training noted)" : "—"}
                        </span>
                      : row.trainingPreparers.map((t, j) => (
                          <div key={j} style={{ marginBottom: j < row.trainingPreparers.length - 1 ? 4 : 0 }}>
                            {t}
                          </div>
                        ))}
                  </td>
                  <td style={td}>
                    {row.trainingTL.length === 0
                      ? <span style={{ color: C.muted, fontStyle: "italic", fontSize: 12 }}>
                          {noTraining ? "" : "—"}
                        </span>
                      : row.trainingTL.map((t, j) => (
                          <div key={j} style={{ marginBottom: j < row.trainingTL.length - 1 ? 4 : 0 }}>
                            {t}
                          </div>
                        ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function ChecklistTable({ weeks, expanded, onToggle }) {
  const rows = useMemo(() => {
    const out = [];
    for (const w of weeks || []) {
      for (const e of w.entries || []) {
        out.push({ week: w.week, ...e });
      }
    }
    return out;
  }, [weeks]);

  if (rows.length === 0) {
    return (
      <div style={{ color: C.muted, fontStyle: "italic", fontSize: 12, padding: 14 }}>
        No checklist rows yet.
      </div>
    );
  }

  const th = {
    padding: "10px 10px",
    fontSize: 10,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    borderBottom: `1px solid ${C.border}`,
    background: C.card,
    whiteSpace: "nowrap",
    textAlign: "left",
  };
  const td = {
    padding: "8px 10px",
    fontSize: 12,
    color: C.pri,
    borderBottom: `1px solid rgba(255,255,255,0.05)`,
    verticalAlign: "top",
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          padding: "12px 16px",
          color: C.pri,
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: "'DM Sans', sans-serif",
          textTransform: "uppercase",
          letterSpacing: 0.8,
        }}
      >
        <span style={{ color: C.sec }}>🗂 Detail Table ({rows.length} row{rows.length === 1 ? "" : "s"})</span>
        <span style={{ color: C.muted, fontSize: 14 }}>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div style={{ overflowX: "auto", borderTop: `1px solid ${C.border}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Week</th>
                <th style={th}>Client</th>
                <th style={{ ...th, textAlign: "center" }}>Reviewed</th>
                <th style={th}>Updated</th>
                <th style={th}>New</th>
                <th style={{ ...th, textAlign: "center" }}>Esc.</th>
                <th style={{ ...th, textAlign: "center" }}>Read</th>
                <th style={{ ...th, textAlign: "center" }}>Quiz</th>
                <th style={th}>Train Preparers</th>
                <th style={th}>Train TL</th>
                <th style={{ ...th, textAlign: "center" }}>Tsheet</th>
                <th style={{ ...th, textAlign: "center" }}>Mtg</th>
                <th style={{ ...th, textAlign: "center" }}>Shared</th>
                <th style={th}>Flag</th>
                <th style={{ ...th, textAlign: "center" }}>Whale</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const baseBg = i % 2 === 0 ? "transparent" : C.surface;
                const flagText = (r.flag_tm_ops || "").trim();
                const flagOpen = flagText && !["nil", "n/a", "na", "none", "-", "—"].includes(flagText.toLowerCase());
                return (
                  <tr key={i} style={{ background: baseBg }}>
                    <td style={{ ...td, fontFamily: "'DM Mono', monospace", color: C.sec, whiteSpace: "nowrap" }}>{r.week}</td>
                    <td style={{ ...td, fontWeight: 600 }}>
                      {r.client
                        ? r.client
                        : <span style={{ color: C.muted, fontStyle: "italic", fontWeight: 500 }}>Team-wide</span>}
                    </td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.reviewed_procedure} /></td>
                    <td style={td}>{r.updated_procedure || <span style={{ color: C.muted }}>—</span>}</td>
                    <td style={td}>{r.new_procedure || <span style={{ color: C.muted }}>—</span>}</td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.updated_escalation} /></td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.assigned_reading} /></td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.assigned_quiz} /></td>
                    <td style={td}>{r.training_preparers || <span style={{ color: C.muted }}>—</span>}</td>
                    <td style={td}>{r.training_myself || <span style={{ color: C.muted }}>—</span>}</td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.checked_tsheet} /></td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.checked_meeting_notes} /></td>
                    <td style={{ ...td, textAlign: "center" }}><YnPill value={r.meeting_notes_shared} /></td>
                    <td style={td}>
                      {flagOpen ? (
                        <span style={{ color: YN_COLOR.flag, fontWeight: 600 }}>{flagText}</span>
                      ) : (
                        <span style={{ color: C.muted }}>NIL</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "center" }}><WhaleLinkCell urls={r.whale_links} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


export default function WeeklyChecklistSection({ teamId }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [tableOpen, setTableOpen] = useState(false);
  const [selectedWeek, setSelectedWeek] = useState("all");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!teamId) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const url = selectedWeek && selectedWeek !== "all"
      ? `/api/team/${teamId}/checklist?week=${encodeURIComponent(selectedWeek)}`
      : `/api/team/${teamId}/checklist`;
    authFetch(url, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => {
        if (ctrl.signal.aborted) return;
        setState({ loading: false, data: j, error: j?.error || null });
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setState({ loading: false, data: null, error: err?.message || String(err) });
      });
    return () => ctrl.abort();
  }, [teamId, selectedWeek, refreshNonce]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await authFetch("/api/checklist/clear-cache", { method: "POST" });
    } catch { /* ignore — refetch still works against cached data */ }
    setRefreshNonce((n) => n + 1);
    setRefreshing(false);
  }

  const data = state.data;
  const summary = data?.summary;
  const weeks = data?.weeks || [];
  const perClientRows = useMemo(() => buildPerClientView(weeks), [weeks]);

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 4,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.pri }}>
            📋 Weekly Admin Checklist
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            Live (60s cache). Click ⟳ to force-fetch after editing the sheet.
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing || state.loading}
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            color: refreshing ? C.muted : C.teal,
            padding: "6px 14px",
            borderRadius: 6,
            cursor: refreshing || state.loading ? "wait" : "pointer",
            fontSize: 11,
            fontFamily: "'DM Sans', sans-serif",
            fontWeight: 700,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            opacity: refreshing || state.loading ? 0.6 : 1,
            whiteSpace: "nowrap",
          }}
          title="Clear server-side cache + re-fetch this team's checklist"
        >
          {refreshing ? "⟳ Refreshing…" : "⟳ Refresh"}
        </button>
      </div>
      <div style={{ height: 12 }} />

      <WeekDropdown
        weeks={data?.available_weeks || []}
        selected={selectedWeek}
        onChange={setSelectedWeek}
      />

      {state.loading && (
        <div style={{ padding: 30, textAlign: "center", color: C.muted, fontSize: 12 }}>
          <span
            style={{
              display: "inline-block",
              width: 14, height: 14,
              border: `2px solid ${C.border}`,
              borderTopColor: C.teal,
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
              marginRight: 10,
              verticalAlign: "middle",
            }}
          />
          Loading checklist…
        </div>
      )}

      {!state.loading && state.error && (
        <div
          style={{
            padding: "12px 14px",
            background: `${YN_COLOR.flag}14`,
            border: `1px solid ${YN_COLOR.flag}55`,
            borderLeft: `3px solid ${YN_COLOR.flag}`,
            borderRadius: 6,
            color: C.sec,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: YN_COLOR.flag }}>Checklist unavailable:</strong>{" "}
          {data?.error_detail || state.error}
        </div>
      )}

      {!state.loading && !state.error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <ChecklistSummaryCards summary={summary} />
          <PerClientComplianceHeatmap rows={perClientRows} />
          <ProcedureUpdatesCards     rows={perClientRows} />
          <TrainingTopicsByClientTable rows={perClientRows} />
          <OpenFlagsList summary={summary} />
          <ChecklistTable weeks={weeks} expanded={tableOpen} onToggle={() => setTableOpen((v) => !v)} />
        </div>
      )}
    </div>
  );
}
