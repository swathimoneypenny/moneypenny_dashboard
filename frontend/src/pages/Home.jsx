import { useState, useEffect, useMemo, useRef } from "react";
import { TEAMS as STATIC_TEAMS, C, API_BASE, authFetch, clearToken } from "../config";
import { LiveIndicator, useAutoRefresh } from "../components/LiveIndicator";

const API = API_BASE;
const HOVER_PREFETCH_DELAY_MS = 220;
const _prefetched = new Set();

function prefetch(url) {
  if (_prefetched.has(url)) return;
  _prefetched.add(url);
  // Fire-and-forget; browser will cache the response per Cache-Control headers
  // and the server's _team_cache / _client cache will be warm.
  authFetch(url).catch(() => {
    _prefetched.delete(url);
  });
}

const GRADIENTS = [
  "linear-gradient(135deg,#4a9eff,#a78bfa)",
  "linear-gradient(135deg,#00d4a1,#4a9eff)",
  "linear-gradient(135deg,#f59e0b,#ef4444)",
  "linear-gradient(135deg,#a78bfa,#ef4444)",
  "linear-gradient(135deg,#22c55e,#00d4a1)",
  "linear-gradient(135deg,#4a9eff,#22c55e)",
  "linear-gradient(135deg,#f59e0b,#a78bfa)",
  "linear-gradient(135deg,#ef4444,#f59e0b)",
];

function initials(name) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function gradientFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

const today = new Date().toLocaleDateString("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

function Header({ onOpenAdminHour }) {
  function signOut() {
    clearToken();
    if (typeof window !== "undefined") window.location.reload();
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "20px 32px",
        background: C.surface,
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ fontSize: 28 }}>💰</span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.pri, letterSpacing: -0.3 }}>
            MoneyPenny Dashboard
          </div>
          <div style={{ fontSize: 12, color: C.sec }}>Live Performance Intelligence</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {onOpenAdminHour && (
          <button
            onClick={onOpenAdminHour}
            title="Cross-team weekly review overview"
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              color: C.sec,
              borderRadius: 8,
              padding: "8px 14px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "'DM Sans', sans-serif",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#3DC58B"; e.currentTarget.style.color = "#3DC58B"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.sec; }}
          >
            ⏰ Admin Hour
          </button>
        )}
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.teal }}>MoneyPenny LLC</div>
          <div style={{ fontSize: 11, color: C.muted }}>{today}</div>
        </div>
        <button
          onClick={signOut}
          title="Sign out"
          style={{
            background: "transparent",
            border: `1px solid ${C.border}`,
            color: C.sec,
            borderRadius: 8,
            padding: "8px 12px",
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "'DM Sans', sans-serif",
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.red; e.currentTarget.style.color = C.red; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.sec; }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="skeleton" style={{ width: 44, height: 44, borderRadius: 10, flexShrink: 0 }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="skeleton" style={{ height: 14, width: "70%" }} />
          <div className="skeleton" style={{ height: 11, width: "45%" }} />
        </div>
      </div>
      <div className="skeleton" style={{ height: 22, width: "40%", borderRadius: 20 }} />
    </div>
  );
}

function TeamCard({ team, onClick }) {
  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef(null);
  const grad = gradientFor(team.id);
  const letter = (team.label ?? "").replace(/^Team\s+/i, "") || team.id?.slice(-1).toUpperCase();
  const leadShort = team.leadName ?? team.lead ?? "";
  const leadFull  = team.leadFullName ?? team.lead ?? leadShort;
  const leadCount = team.leadCount ?? 1;
  const execCount = team.execCount ?? Math.max(0, (team.memberCount ?? 0) - leadCount);

  function handleEnter() {
    setHovered(true);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      prefetch(`/api/team/${team.id}/monthly`);
    }, HOVER_PREFETCH_DELAY_MS);
  }
  function handleLeave() {
    setHovered(false);
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  return (
    <div
      onClick={onClick}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{
        position: "relative",
        background: `linear-gradient(180deg, ${C.card} 0%, ${C.surface} 100%)`,
        border: `1px solid ${hovered ? C.blue : C.border}`,
        borderRadius: 14,
        padding: "22px 22px 20px",
        cursor: "pointer",
        transition: "transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease",
        transform: hovered ? "translateY(-4px)" : "none",
        boxShadow: hovered
          ? `0 0 0 1px ${C.blue}40, 0 12px 32px rgba(0,0,0,0.4), 0 0 24px ${C.blue}20`
          : "0 1px 2px rgba(0,0,0,0.3)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        minHeight: 168,
        overflow: "hidden",
      }}
    >
      {/* Accent ribbon */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 4,
          height: "100%",
          background: grad,
          opacity: hovered ? 1 : 0.7,
          transition: "opacity 0.18s",
        }}
      />

      {/* Top row: letter avatar + title */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 12,
            background: grad,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            fontWeight: 700,
            color: "#fff",
            flexShrink: 0,
            letterSpacing: 0.5,
            boxShadow: "inset 0 -8px 16px rgba(0,0,0,0.18)",
          }}
        >
          {letter}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: C.pri,
              letterSpacing: -0.4,
              lineHeight: 1.15,
            }}
          >
            {team.label ?? team.name}
          </div>
          <div
            style={{
              fontSize: 13,
              color: C.sec,
              marginTop: 4,
              fontWeight: 500,
            }}
          >
            {leadShort ? `${leadShort}'s Team` : team.name}
          </div>
        </div>
        <span
          style={{
            color: hovered ? C.blue : C.muted,
            fontSize: 18,
            opacity: hovered ? 1 : 0.4,
            transition: "all 0.18s",
            marginTop: 4,
          }}
        >
          →
        </span>
      </div>

      {/* Lead + member counts */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "auto" }}>
        <div style={{ fontSize: 12, color: C.muted, textTransform: "uppercase", letterSpacing: 0.8 }}>
          Lead
        </div>
        <div style={{ fontSize: 13, color: C.pri, fontWeight: 500 }}>{leadFull}</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: C.muted,
            marginTop: 4,
          }}
        >
          <span style={{ color: C.teal, fontWeight: 600 }}>
            {leadCount} {leadCount === 1 ? "Team Lead" : "Team Leads"}
          </span>
          <span style={{ color: C.muted }}>•</span>
          <span style={{ color: C.blue, fontWeight: 600 }}>
            {execCount} {execCount === 1 ? "Executive" : "Executives"}
          </span>
        </div>
      </div>

      {team.missingLead && (
        <div
          style={{
            fontSize: 10,
            color: C.orange,
            background: `${C.orange}14`,
            border: `1px solid ${C.orange}40`,
            borderRadius: 4,
            padding: "3px 6px",
            alignSelf: "flex-start",
          }}
        >
          ⚠ Lead not found in timesheets
        </div>
      )}
    </div>
  );
}

function ClientCard({ client, onClick }) {
  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef(null);
  const grad = gradientFor(client.name);

  function handleEnter() {
    setHovered(true);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      prefetch(`/api/client/${encodeURIComponent(client.name)}/monthly`);
    }, HOVER_PREFETCH_DELAY_MS);
  }
  function handleLeave() {
    setHovered(false);
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  return (
    <div
      onClick={onClick}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      style={{
        background: C.card,
        border: `1px solid ${hovered ? C.blue : C.border}`,
        borderRadius: 12,
        padding: 20,
        cursor: "pointer",
        transition: "all 0.18s ease",
        transform: hovered ? "translateY(-3px)" : "none",
        boxShadow: hovered ? `0 0 0 1px ${C.blue}40, 0 8px 24px rgba(74,158,255,0.15)` : "none",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: grad,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            fontWeight: 700,
            color: "#fff",
            flexShrink: 0,
          }}
        >
          {initials(client.name)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: C.pri,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {client.name}
          </div>
        </div>
        <span style={{ color: C.muted, fontSize: 16, opacity: hovered ? 1 : 0.5, transition: "opacity 0.18s" }}>→</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            background: `${C.teal}18`,
            border: `1px solid ${C.teal}40`,
            color: C.teal,
            borderRadius: 20,
            padding: "3px 10px",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "'DM Mono', monospace",
          }}
        >
          {(client.totalHours ?? 0).toFixed(1)}h
        </span>
        <span style={{ fontSize: 11, color: C.muted }}>total hours</span>
      </div>
    </div>
  );
}

function SearchBar({ value, onChange, placeholder }) {
  return (
    <div style={{ position: "relative", maxWidth: 360 }}>
      <span
        style={{
          position: "absolute",
          left: 12,
          top: "50%",
          transform: "translateY(-50%)",
          color: C.muted,
          fontSize: 15,
          pointerEvents: "none",
        }}
      >
        🔍
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          padding: "9px 14px 9px 36px",
          color: C.pri,
          fontSize: 14,
          outline: "none",
          fontFamily: "'DM Sans', sans-serif",
        }}
      />
    </div>
  );
}

function TeamTab({ onSelectTeam }) {
  const [search, setSearch] = useState("");
  const [teams, setTeams]   = useState(STATIC_TEAMS);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const fetchTeams = (silent = false) => {
    if (!silent) setLoading(true);
    return authFetch(`/api/teams`)
      .then((r) => r.json())
      .then((d) => {
        const list = (d?.teams ?? []).map((t) => ({
          id:            t.id,
          label:         t.label,
          name:          t.label,
          leadName:      t.leadName,
          leadFullName:  t.leadFullName,
          lead:          t.leadFullName ?? t.leadName,
          memberCount:   t.memberCount,
          leadCount:     t.leadCount,
          execCount:     t.execCount,
          hasSheet:      t.hasSheet,
          missingLead:   t.missingLead,
        }));
        if (list.length > 0) setTeams(list);
        setLastRefreshed(new Date());
        if (!silent) setLoading(false);
      })
      .catch((err) => {
        console.error("[Home] /api/teams failed", err);
        if (!silent) setLoading(false);
      });
  };

  useEffect(() => {
    fetchTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Static badge (no period selector on Home → no auto-refresh)
  const tickNow = useAutoRefresh(null, false, lastRefreshed);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return teams;
    return teams.filter(
      (t) =>
        (t.label ?? "").toLowerCase().includes(q) ||
        (t.leadName ?? "").toLowerCase().includes(q) ||
        (t.leadFullName ?? "").toLowerCase().includes(q)
    );
  }, [search, teams]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <SearchBar value={search} onChange={setSearch} placeholder="Search teams or leads…" />
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.sec, fontSize: 12 }}>
            <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
            Discovering teams…
          </div>
        )}
        <div style={{ marginLeft: "auto" }}>
          <LiveIndicator
            lastRefreshed={lastRefreshed}
            now={tickNow}
            isLive={false}
            onRefresh={() => fetchTeams(false)}
          />
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 18,
        }}
      >
        {filtered.map((team) => (
          <TeamCard key={team.id} team={team} onClick={() => onSelectTeam(team)} />
        ))}
      </div>
    </div>
  );
}

function ClientTab({ onSelectClient }) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const fetchClients = (silent = false) => {
    if (!silent) setLoading(true);
    return authFetch(`/api/active-clients`)
      .then((r) => r.json())
      .then((data) => {
        const sorted = (data.clients ?? []).sort(
          (a, b) => (b.totalHours ?? 0) - (a.totalHours ?? 0)
        );
        setClients(sorted);
        setLastRefreshed(new Date());
        if (!silent) setLoading(false);
      })
      .catch(() => {
        // keep loading state on error — never show empty state
      });
  };

  useEffect(() => {
    fetchClients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tickNow = useAutoRefresh(null, false, lastRefreshed);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return clients.filter((c) => c.name.toLowerCase().includes(q));
  }, [clients, search]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <SearchBar value={search} onChange={setSearch} placeholder="Search clients…" />
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: C.sec, fontSize: 12 }}>
            <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
            Fetching live data…
          </div>
        )}
        <div style={{ marginLeft: "auto" }}>
          <LiveIndicator
            lastRefreshed={lastRefreshed}
            now={tickNow}
            isLive={false}
            onRefresh={() => fetchClients(false)}
          />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        {loading
          ? Array.from({ length: 12 }).map((_, i) => <SkeletonCard key={i} />)
          : filtered.map((client) => (
              <ClientCard
                key={client.name}
                client={client}
                onClick={() => onSelectClient(client)}
              />
            ))}
      </div>
    </div>
  );
}

export default function Home({ onSelectTeam, onSelectClient, onOpenAdminHour }) {
  const [tab, setTab] = useState("team");

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column" }}>
      <Header onOpenAdminHour={onOpenAdminHour} />

      <div style={{ padding: "28px 32px", flex: 1 }}>
        {/* Tab toggle */}
        <div
          style={{
            display: "flex",
            gap: 4,
            background: C.surface,
            borderRadius: 10,
            padding: 4,
            width: "fit-content",
            marginBottom: 28,
            border: `1px solid ${C.border}`,
          }}
        >
          {["team", "client"].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "8px 22px",
                borderRadius: 7,
                border: "none",
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 600,
                fontFamily: "'DM Sans', sans-serif",
                transition: "all 0.15s ease",
                background: tab === t ? C.blue : "transparent",
                color: tab === t ? "#fff" : C.sec,
              }}
            >
              {t === "team" ? "Team View" : "Client View"}
            </button>
          ))}
        </div>

        {tab === "team" ? (
          <TeamTab onSelectTeam={onSelectTeam} />
        ) : (
          <ClientTab onSelectClient={onSelectClient} />
        )}
      </div>
    </div>
  );
}
