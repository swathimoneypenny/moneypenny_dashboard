export const API_BASE = import.meta.env.VITE_API_URL ?? "";

// ── Auth ──────────────────────────────────────────────────────────
export const TOKEN_KEY = "mp_dashboard_token";

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

/**
 * Wrapped fetch that automatically:
 *   - prefixes API_BASE if the URL is a path (starts with "/")
 *   - injects Authorization: Bearer <token> from localStorage
 *   - on 401, clears the token + reloads → falls back to LoginPage
 */
export async function authFetch(url, opts = {}) {
  const fullUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
  const headers = new Headers(opts.headers || {});
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (opts.body && !headers.has("Content-Type") && !(opts.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(fullUrl, { ...opts, headers });
  if (res.status === 401) {
    clearToken();
    if (typeof window !== "undefined") window.location.reload();
  }
  return res;
}

export const TEAMS = [
  { id: "team_a", name: "Team A", lead: "" },
  { id: "team_b", name: "Team B", lead: "" },
  { id: "team_c", name: "Team C", lead: "" },
  { id: "team_d", name: "Team D", lead: "" },
  { id: "team_e", name: "Team E", lead: "" },
  { id: "team_f", name: "Team F", lead: "" },
  { id: "team_g", name: "Team G", lead: "" },
  { id: "team_h", name: "Team H", lead: "" },
  { id: "team_i", name: "Team I", lead: "" },
  { id: "team_j", name: "Team J", lead: "" },
  { id: "team_k", name: "Team K", lead: "" },
  { id: "team_l", name: "Team L", lead: "" },
  { id: "team_m", name: "Team M", lead: "Pavithira" },
  { id: "team_n", name: "Team N", lead: "" },
  { id: "team_t", name: "Team T", lead: "" },
];

// Dark theme palette — single source of truth, consumed across all dashboards.
// Surface tones get progressively lighter from bg → surface → card → elevated
// so layered panels remain visually distinct against the deep-navy background.
export const C = {
  // Backgrounds — pure dark, minimal blue saturation
  bg:       "#050810",  // page background — almost black
  surface:  "#0A0F1C",  // panels, inputs, table stripes
  card:     "#0E1421",  // primary card / chart container
  elevated: "#141C30",  // hover state, modal, popup
  overlay:  "rgba(255,255,255,0.04)",  // subtle wash for stat strips

  // Borders
  border:        "rgba(255,255,255,0.10)",
  borderStrong:  "rgba(255,255,255,0.20)",

  // Text
  pri:   "#FFFFFF",                  // primary — pure white
  sec:   "rgba(255,255,255,0.85)",   // secondary — body text
  muted: "rgba(255,255,255,0.55)",   // muted — captions, hints

  // Brand accent
  accent:      "#F2895A",
  accentLight: "rgba(242,137,90,0.15)",

  // Status / chart colors — preserved for legend & threshold consistency
  teal:   "#3DC58B",
  blue:   "#4A8FE7",
  green:  "#10B981",
  red:    "#EF4444",
  orange: "#F2895A",
  yellow: "#F0B947",
  purple: "#9B7EE8",

  statusGreen:  "rgba(16,185,129,0.14)",
  statusRed:    "rgba(239,68,68,0.14)",
  statusOrange: "rgba(242,137,90,0.14)",
  statusYellow: "rgba(240,185,71,0.16)",
};
