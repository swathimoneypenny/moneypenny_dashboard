import { useEffect, useMemo, useState } from "react";
import { C, authFetch } from "../config";

// Whale SOPs dashboard tab. Backend endpoints under /api/whale/*.
// Graceful degradation: when the WHALE_API_TOKEN / WHALE_WORKSPACE_ID
// env vars aren't set on the server, the status endpoint returns
// {configured: false, message: "…awaiting credentials"} and this page
// renders a yellow banner explaining that without crashing.

function StatusBanner({ status, lastSyncSecs, onRefresh, refreshing }) {
  if (!status) return null;

  const configured = !!status.configured;
  const reachable  = !!status.reachable;
  const ok         = configured && reachable !== false;

  const bg     = ok ? "rgba(61,197,139,0.10)" : configured ? "rgba(226,92,92,0.10)" : "rgba(240,185,71,0.10)";
  const border = ok ? "#3DC58B" : configured ? "#E25C5C" : "#F0B947";
  const icon   = ok ? "✓" : configured ? "✗" : "⚠";

  return (
    <div style={{
      background:  bg,
      border:      `1px solid ${border}40`,
      borderLeft:  `4px solid ${border}`,
      borderRadius: 10,
      padding:     "14px 18px",
      marginBottom: 18,
      display:     "flex",
      alignItems:  "center",
      gap:         16,
      flexWrap:    "wrap",
    }}>
      <span style={{ fontSize: 22, color: border, fontWeight: 700, lineHeight: 1 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 220 }}>
        {!configured && (
          <>
            <div style={{ fontSize: 14, color: C.pri, fontWeight: 600 }}>
              Whale API not configured. Awaiting credentials from vendor.
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
              Set <code style={{ background: C.surface, padding: "1px 5px", borderRadius: 3 }}>WHALE_API_TOKEN</code> and{" "}
              <code style={{ background: C.surface, padding: "1px 5px", borderRadius: 3 }}>WHALE_WORKSPACE_ID</code>{" "}
              on the server.
              {" · "}
              token_set: <strong>{String(!!status.token_set)}</strong>
              {" · "}
              workspace_id_set: <strong>{String(!!status.workspace_id_set)}</strong>
            </div>
          </>
        )}
        {configured && reachable !== false && (
          <>
            <div style={{ fontSize: 14, color: C.pri, fontWeight: 600 }}>
              Connected to Whale workspace
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
              {typeof lastSyncSecs === "number"
                ? `Last sync ${lastSyncSecs < 60 ? `${lastSyncSecs}s` : `${Math.floor(lastSyncSecs / 60)}m`} ago`
                : "Awaiting first sync"}
            </div>
          </>
        )}
        {configured && reachable === false && (
          <>
            <div style={{ fontSize: 14, color: C.pri, fontWeight: 600 }}>
              Whale credentials set, but API not reachable
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
              {status.error || "—"}
            </div>
          </>
        )}
      </div>
      <button
        onClick={onRefresh}
        disabled={refreshing || !configured}
        style={{
          background: refreshing ? C.surface : "transparent",
          border: `1px solid ${C.border}`,
          color: configured ? C.sec : C.muted,
          borderRadius: 6,
          padding: "6px 14px",
          fontSize: 12,
          cursor: configured ? (refreshing ? "wait" : "pointer") : "not-allowed",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div style={{
      flex: "1 1 160px",
      background: C.card,
      border: `1px solid ${C.border}`,
      borderTop: `3px solid ${C.blue}`,
      borderRadius: 10,
      padding: "14px 18px",
      minWidth: 140,
    }}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: C.pri, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function SopDetailModal({ sop, onClose }) {
  useEffect(() => {
    if (!sop) return;
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sop, onClose]);
  if (!sop) return null;
  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        background: "rgba(0,0,0,0.72)",
        backdropFilter: "blur(4px)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderTop: `3px solid #7C3AED`,
          borderRadius: 12,
          padding: 24,
          maxWidth: 760,
          maxHeight: "85vh",
          overflow: "auto",
          width: "92%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>
              {sop.board_name} · {sop.library_title} · {sop.playbook_title}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.pri }}>
              {sop.title || "Untitled"}
            </div>
            {sop.last_updated && (
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                Last updated: {sop.last_updated}
              </div>
            )}
          </div>
          <button onClick={onClose} style={{
            background: "transparent",
            border: `1px solid ${C.border}`,
            color: C.sec,
            width: 32, height: 32,
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 16, lineHeight: 1,
            flexShrink: 0,
          }}>✕</button>
        </div>
        {sop.description && (
          <div style={{ fontSize: 13, color: C.sec, marginBottom: 14, fontStyle: "italic", lineHeight: 1.5 }}>
            {sop.description}
          </div>
        )}
        <div
          style={{ fontSize: 13, color: C.pri, lineHeight: 1.6, whiteSpace: "pre-wrap" }}
          // Whale returns HTML in `content` for many SOPs. Render as-is.
          // (No user-supplied input is interpolated here.)
          dangerouslySetInnerHTML={{ __html: sop.content || "<em>No content recorded.</em>" }}
        />
      </div>
    </div>
  );
}

function OutdatedListModal({ items, onClose, onOpenSop }) {
  useEffect(() => {
    if (!items) return;
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [items, onClose]);
  if (!items) return null;
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.border}`, borderTop: `3px solid #E25C5C`,
        borderRadius: 12, padding: 24, maxWidth: 760, maxHeight: "85vh", overflow: "auto",
        width: "92%", boxShadow: "0 20px 60px rgba(0,0,0,0.6)", fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.pri }}>
              Outdated Procedures ({items.length})
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
              Sorted by age — oldest first.
            </div>
          </div>
          <button onClick={onClose} style={{
            background: "transparent", border: `1px solid ${C.border}`, color: C.sec,
            width: 32, height: 32, borderRadius: 6, cursor: "pointer", fontSize: 16, lineHeight: 1, flexShrink: 0,
          }}>✕</button>
        </div>
        {items.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.muted, fontSize: 13, fontStyle: "italic" }}>
            No SOPs are older than the cutoff.
          </div>
        ) : (
          items.map((sop, i) => (
            <div key={sop.id || i}
              onClick={() => onOpenSop && onOpenSop(sop)}
              style={{
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderLeft: `3px solid #E25C5C`,
                borderRadius: 6,
                padding: "10px 12px",
                marginBottom: 8,
                cursor: "pointer",
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 13, color: C.pri, fontWeight: 600, flex: 1, minWidth: 0 }}>
                  {sop.title || "Untitled"}
                </div>
                <div style={{ fontSize: 11, color: "#E25C5C", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
                  {sop.days_old}d old
                </div>
              </div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {sop.board_name} · {sop.library_title} · {sop.playbook_title}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function WhaleSOPsPage({ onBack }) {
  const [status, setStatus]         = useState(null);
  const [sopsResp, setSopsResp]     = useState(null);
  const [audit, setAudit]           = useState(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [nowTick, setNowTick]       = useState(Date.now());
  const [search, setSearch]         = useState("");
  const [openSop, setOpenSop]       = useState(null);
  const [showOutdated, setShowOutdated] = useState(false);

  // 1-second tick so "last sync N mins ago" stays accurate
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadAll = async (forceRefresh = false) => {
    if (forceRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      // Status first — if not configured, skip the heavy /sops + /audit calls.
      const statusR = await authFetch("/api/whale/status").then((r) => r.json());
      setStatus(statusR);
      if (!statusR?.configured) {
        setSopsResp({ sops: [], count: 0 });
        setAudit({ outdated_sops: [], count: 0 });
        setLastSyncAt(Date.now());
        return;
      }
      const sopsUrl  = `/api/whale/sops${forceRefresh ? "?refresh=true" : ""}`;
      const [sopsR, auditR] = await Promise.all([
        authFetch(sopsUrl).then((r) => r.json()),
        authFetch("/api/whale/audit/outdated?months=6").then((r) => r.json()),
      ]);
      setSopsResp(sopsR);
      setAudit(auditR);
      setLastSyncAt(Date.now());
    } catch (e) {
      console.error("[whale] load failed", e);
      setStatus({ configured: false, message: String(e?.message || e) });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadAll(false); /* eslint-disable-next-line */ }, []);

  const lastSyncSecs = lastSyncAt ? Math.max(0, Math.floor((nowTick - lastSyncAt) / 1000)) : null;

  const sops = useMemo(() => Array.isArray(sopsResp?.sops) ? sopsResp.sops : [], [sopsResp]);

  // Group: { boardName: { libraryTitle: [sops] } }
  const tree = useMemo(() => {
    const out = {};
    const q = search.trim().toLowerCase();
    for (const s of sops) {
      if (q) {
        const blob = `${s.title || ""} ${s.description || ""} ${s.playbook_title || ""}`.toLowerCase();
        if (!blob.includes(q)) continue;
      }
      const b = s.board_name   || "Unfiled";
      const l = s.library_title || "Unfiled";
      out[b] = out[b] || {};
      out[b][l] = out[b][l] || [];
      out[b][l].push(s);
    }
    return out;
  }, [sops, search]);

  const avgAgeDays = useMemo(() => {
    let total = 0, n = 0;
    const now = Date.now();
    for (const s of sops) {
      if (!s.last_updated) continue;
      const t = Date.parse(String(s.last_updated).replace("Z", "+00:00"));
      if (Number.isNaN(t)) continue;
      total += Math.max(0, (now - t) / 86400000);
      n += 1;
    }
    return n ? Math.round(total / n) : null;
  }, [sops]);

  const boardCount   = useMemo(() => new Set(sops.map((s) => s.board_id || s.board_name)).size, [sops]);
  const libraryCount = useMemo(() => new Set(sops.map((s) => `${s.board_id}/${s.library_id}`)).size, [sops]);

  const outdated = Array.isArray(audit?.outdated_sops) ? audit.outdated_sops : [];

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      {/* Header */}
      <div style={{
        background: "linear-gradient(180deg,#0e2040 0%,#0b1929 100%)",
        borderBottom: `1px solid ${C.border}`,
        padding: "20px 32px",
        display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap",
      }}>
        <button onClick={onBack} style={{
          background: "transparent", border: `1px solid ${C.border}`, color: C.sec,
          borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 13,
        }}>← Back</button>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.pri, letterSpacing: -0.4 }}>
            📚 Whale SOPs
          </div>
          <div style={{ fontSize: 12, color: C.sec, marginTop: 2 }}>
            Programmatic browse + audit of Whale-hosted procedures
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "24px 32px", maxWidth: 1240, margin: "0 auto" }}>
        <StatusBanner
          status={status}
          lastSyncSecs={lastSyncSecs}
          onRefresh={() => loadAll(true)}
          refreshing={refreshing}
        />

        {loading && !status && (
          <div style={{ padding: 60, textAlign: "center", color: C.muted, fontSize: 13 }}>
            Checking Whale connection…
          </div>
        )}

        {status && (
          <>
            {/* Two-column main row: 40% audit, 60% browser */}
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 18 }}>
              {/* Audit (left) */}
              <div style={{ flex: "1 1 380px", minWidth: 320 }}>
                <div style={{
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  borderLeft: `4px solid #E25C5C`,
                  borderRadius: 10,
                  padding: "16px 18px",
                }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#E25C5C", textTransform: "uppercase", letterSpacing: 1 }}>
                      🔴 Outdated Procedures
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
                      {audit?.cutoff_months ?? 6} mo cutoff
                    </span>
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: C.pri, fontFamily: "'DM Mono', monospace", marginBottom: 12 }}>
                    {outdated.length}
                  </div>
                  {outdated.slice(0, 5).map((s, i) => (
                    <div key={s.id || i}
                      onClick={() => setOpenSop(s)}
                      style={{
                        background: C.surface,
                        border: `1px solid ${C.border}`,
                        borderRadius: 6,
                        padding: "8px 10px",
                        marginBottom: 6,
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                      }}>
                      <div style={{ fontSize: 12, color: C.pri, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.title || "Untitled"}
                      </div>
                      <span style={{ fontSize: 10, color: "#E25C5C", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
                        {s.days_old}d
                      </span>
                    </div>
                  ))}
                  {outdated.length > 5 && (
                    <button onClick={() => setShowOutdated(true)} style={{
                      background: "transparent",
                      border: `1px solid ${C.border}`,
                      color: C.sec,
                      borderRadius: 6,
                      padding: "6px 12px",
                      fontSize: 11,
                      cursor: "pointer",
                      marginTop: 4,
                      fontFamily: "'DM Sans', sans-serif",
                    }}>
                      See all {outdated.length} →
                    </button>
                  )}
                  {outdated.length === 0 && status.configured && status.reachable !== false && (
                    <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic", padding: "12px 0" }}>
                      No SOPs older than {audit?.cutoff_months ?? 6} months. 🎉
                    </div>
                  )}
                </div>
              </div>

              {/* Browser (right) */}
              <div style={{ flex: "2 1 520px", minWidth: 360 }}>
                <div style={{
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  borderLeft: `4px solid ${C.blue}`,
                  borderRadius: 10,
                  padding: "16px 18px",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: C.sec, textTransform: "uppercase", letterSpacing: 1 }}>
                      📂 SOP Browser
                    </span>
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search title or description…"
                      style={{
                        marginLeft: "auto",
                        background: C.surface,
                        border: `1px solid ${C.border}`,
                        borderRadius: 6,
                        color: C.pri,
                        padding: "5px 10px",
                        fontSize: 12,
                        fontFamily: "'DM Sans', sans-serif",
                        minWidth: 200,
                      }}
                    />
                  </div>
                  {Object.keys(tree).length === 0 ? (
                    <div style={{ fontSize: 12, color: C.muted, fontStyle: "italic", padding: "12px 0", textAlign: "center" }}>
                      {status.configured
                        ? (search ? `No SOPs match "${search}".` : "No SOPs loaded.")
                        : "SOPs will load once Whale credentials are configured."}
                    </div>
                  ) : (
                    Object.entries(tree).map(([boardName, libs]) => (
                      <BoardSection
                        key={boardName}
                        boardName={boardName}
                        libs={libs}
                        onOpenSop={setOpenSop}
                      />
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Stats row */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <StatCard label="Total SOPs"   value={sops.length} />
              <StatCard label="Boards"       value={boardCount} />
              <StatCard label="Libraries"    value={libraryCount} />
              <StatCard label="Avg age"      value={avgAgeDays != null ? `${avgAgeDays}d` : "—"} sub="days since last update" />
            </div>
          </>
        )}
      </div>

      <SopDetailModal sop={openSop} onClose={() => setOpenSop(null)} />
      <OutdatedListModal
        items={showOutdated ? outdated : null}
        onClose={() => setShowOutdated(false)}
        onOpenSop={(s) => { setShowOutdated(false); setOpenSop(s); }}
      />
    </div>
  );
}

function BoardSection({ boardName, libs, onOpenSop }) {
  const [open, setOpen] = useState(true);
  const totalSops = Object.values(libs).reduce((a, arr) => a + arr.length, 0);
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 4px",
          cursor: "pointer",
          fontSize: 13,
          color: C.pri,
          fontWeight: 600,
        }}>
        <span style={{ color: C.muted, fontSize: 14 }}>{open ? "▾" : "▸"}</span>
        {boardName}
        <span style={{ marginLeft: "auto", fontSize: 10, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
          {totalSops}
        </span>
      </div>
      {open && (
        <div style={{ paddingLeft: 18 }}>
          {Object.entries(libs).map(([libTitle, list]) => (
            <LibrarySection key={libTitle} libTitle={libTitle} sops={list} onOpenSop={onOpenSop} />
          ))}
        </div>
      )}
    </div>
  );
}

function LibrarySection({ libTitle, sops, onOpenSop }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 4px",
          cursor: "pointer",
          fontSize: 12,
          color: C.sec,
        }}>
        <span style={{ color: C.muted }}>{open ? "▾" : "▸"}</span>
        {libTitle}
        <span style={{ marginLeft: "auto", fontSize: 10, color: C.muted, fontFamily: "'DM Mono', monospace" }}>
          {sops.length}
        </span>
      </div>
      {open && (
        <div style={{ paddingLeft: 16, marginBottom: 4 }}>
          {sops.map((s, i) => (
            <div key={s.id || i}
              onClick={() => onOpenSop && onOpenSop(s)}
              style={{
                fontSize: 12,
                color: C.pri,
                padding: "4px 8px",
                cursor: "pointer",
                borderLeft: `2px solid ${C.border}`,
                marginBottom: 2,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.surface; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              {s.title || "Untitled"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
