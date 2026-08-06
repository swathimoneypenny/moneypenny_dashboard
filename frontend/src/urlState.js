// Query-param <-> view-state mapping for shareable dashboard links.
//
// There is no router in this app: App.jsx drives navigation from a single
// `view` object in useState. These helpers translate that object to and from
// the query string using the native History API, so a URL like
//   /?view=team&team=team_b&period=month
// opens that screen directly.
//
// Every function here is total: a malformed or unknown param must fall back to
// the home screen rather than throw, because this runs during first render.

// URL spelling -> internal period key used by TeamDashboard / ClientDashboard.
// Both spellings are accepted on the way in so old links keep working.
const PERIOD_IN = {
  today: "today",
  week: "weekly",
  weekly: "weekly",
  month: "monthly",
  monthly: "monthly",
};

// Internal period key -> the short spelling we put in the URL.
const PERIOD_OUT = {
  today: "today",
  weekly: "week",
  monthly: "month",
};

export const HOME_VIEW = { page: "home" };

/** "team_b" -> "Team B". Display-only fallback until the API returns a label. */
export function teamLabelFromId(teamId) {
  if (typeof teamId !== "string") return "";
  const match = /^team_([a-z0-9]+)$/i.exec(teamId.trim());
  if (!match) return teamId;
  return `Team ${match[1].toUpperCase()}`;
}

/** Parse the query string into a `view` object. Never throws. */
export function readViewFromUrl(search) {
  try {
    const params = new URLSearchParams(
      typeof search === "string" ? search : window.location.search
    );
    const view = (params.get("view") || "").trim().toLowerCase();
    const periodParam = (params.get("period") || "").trim().toLowerCase();
    const period = PERIOD_IN[periodParam]; // undefined when absent/unknown

    if (view === "team") {
      const teamId = (params.get("team") || "").trim();
      if (!teamId) return { ...HOME_VIEW };
      return {
        page: "team",
        teamId,
        teamName: teamLabelFromId(teamId),
        period,
      };
    }

    if (view === "client") {
      const clientName = (params.get("client") || "").trim();
      if (!clientName) return { ...HOME_VIEW };
      return { page: "client", clientName, period };
    }

    // Unknown view=, or no params at all -> default front page.
    return { ...HOME_VIEW };
  } catch {
    return { ...HOME_VIEW };
  }
}

/**
 * Serialise a `view` to a query string (without the leading "?").
 * Only team and client screens are shareable; everything else returns "" so
 * the URL never claims to point at a screen it cannot restore.
 */
export function viewToSearch(view) {
  try {
    const params = new URLSearchParams();

    if (view?.page === "team" && view.teamId) {
      params.set("view", "team");
      params.set("team", view.teamId);
    } else if (view?.page === "client" && view.clientName) {
      params.set("view", "client");
      params.set("client", view.clientName);
    } else {
      return "";
    }

    // `custom` is deliberately not serialised — its date range lives in local
    // component state, so restoring the key alone would show a different window.
    const period = PERIOD_OUT[view.period];
    if (period) params.set("period", period);

    return params.toString();
  } catch {
    return "";
  }
}

/**
 * Point the address bar at `view` without adding a history entry, so the Back
 * button still leaves the dashboard instead of walking back through clicks.
 */
export function syncUrlToView(view) {
  try {
    const search = viewToSearch(view);
    const next = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) {
      window.history.replaceState(null, "", next);
    }
  } catch {
    // A failed URL update must never break the page.
  }
}
