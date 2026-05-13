export const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

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

export const C = {
  bg:      "#060d1a",
  surface: "#0b1929",
  card:    "#0e2040",
  border:  "#1a3356",

  teal:   "#00c896",
  blue:   "#3d8ef0",
  green:  "#1db954",
  red:    "#e53e3e",
  orange: "#ed8936",
  purple: "#9f7aea",

  pri:   "#edf2f7",
  sec:   "#6b93b8",
  muted: "#3d6080",

  statusGreen:  "#0d2a1a",
  statusRed:    "#2d1010",
  statusOrange: "#2d1e08",
};
