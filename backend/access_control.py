"""Role-based access control for the MoneyPenny dashboard.

Every email maps to exactly one of:
  role='admin'       → all teams, plus the team switcher and admin endpoints
  role='team_lead'   → their team only
  role='team_member' → their team only

Team leads and team members currently have identical permissions within their
team (user requirement, 2026-08).

WHY THE ROUTE POLICY BELOW IS DEFAULT-DENY
------------------------------------------
Scoping only `/api/team/{team_id}/...` is not enough. This app has 68 API
routes and just 17 sit under that prefix. The rest would have left a team
member able to read every other team's data:

  * /api/client/{name}/*            — a client's full preparer list, all teams
  * /api/debug/*                    — 17 routes incl. raw timesheet rows,
                                      per-user hours, employee raw dumps
  * /api/checklist/cross-team*      — cross-team by definition
  * /api/audit/*, /api/roster/diff  — every team's roster and attribution
  * /api/eod/{team_id}/*            — team-scoped but a DIFFERENT prefix, so a
    /api/sheets/health/{team_id}      path regex anchored on /api/team/ misses it
  * /api/clear-cache, /api/warmup,  — mutating/admin operations
    /api/roster/refresh

So non-admins get an explicit allowlist and everything else is admin-only.
Adding a new endpoint therefore defaults to admin-only rather than silently
exposing it — the failure mode is a 403 to fix, not a data leak to discover.
"""

from __future__ import annotations

import re

# ── Email → role + team ───────────────────────────────────────────
# Matching is case-insensitive; input is normalized to lowercase.
# Verified 2026-08-17: all 73 addresses below exist as EMAILADDRESS values in
# Timesheets.com, so none of these users is locked out by a typo.
USER_ACCESS: dict[str, dict] = {
    # === ADMINS (all teams) ===
    "pbreslin@moneypennyllc.com":            {"role": "admin", "team": None, "name": "Penny Breslin"},
    "damien_greathead@moneypennyllc.com":    {"role": "admin", "team": None, "name": "Damien Greathead"},
    "raj_v@moneypennyllc.com":               {"role": "admin", "team": None, "name": "Raj P V"},
    "swathi_suresh@moneypennyllc.com":       {"role": "admin", "team": None, "name": "Swathi Suresh"},
    "sharmila@moneypennyllc.com":            {"role": "admin", "team": None, "name": "Sharmila"},
    "nirmala@moneypennyllc.com":             {"role": "admin", "team": None, "name": "Nirmala"},
    "vidyalakshmi@moneypennyllc.com":        {"role": "admin", "team": None, "name": "Vidyalakshmi"},
    "rajarajeswari_s@moneypennyllc.com":     {"role": "admin", "team": None, "name": "Rajarajeswari S"},
    "swetha_k@moneypennyllc.com":            {"role": "admin", "team": None, "name": "Swetha K"},
    "megan_s@moneypennyllc.com":             {"role": "admin", "team": None, "name": "Megan Smesny"},

    # === TEAM A ===
    "kokila_r@moneypennyllc.com":            {"role": "team_lead",   "team": "team_a", "name": "Kokila R"},
    "umamaheshwari_e@moneypennyllc.com":     {"role": "team_member", "team": "team_a", "name": "Uma Maheshwari E"},

    # === TEAM B ===
    "buelaangel_t@moneypennyllc.com":        {"role": "team_lead",   "team": "team_b", "name": "Buela Angel T"},
    "pavithra_srinivasan@moneypennyllc.com": {"role": "team_member", "team": "team_b", "name": "Pavithra Srinivasan"},
    "varshini_natarajan@moneypennyllc.com":  {"role": "team_member", "team": "team_b", "name": "Varshini Natarajan"},
    "ivanjalin_i@moneypennyllc.com":         {"role": "team_member", "team": "team_b", "name": "Ivanjalin I"},

    # === TEAM C ===
    "grace_g@moneypennyllc.com":             {"role": "team_lead",   "team": "team_c", "name": "Grace G"},
    "mahalakshmi_thiruthanidiraviam@moneypennyllc.com": {"role": "team_member", "team": "team_c", "name": "Mahalakshmi Thiruthanidiraviam"},
    "keerthana_loganathan@moneypennyllc.com":{"role": "team_member", "team": "team_c", "name": "Keerthana Loganathan"},
    "jeevtha_santhira@moneypennyllc.com":    {"role": "team_member", "team": "team_c", "name": "Jeevtha Santhira"},

    # === TEAM D ===
    "chandralekha_vijay@moneypennyllc.com":  {"role": "team_lead",   "team": "team_d", "name": "Chandralekha Vijay"},
    "sharmila_gunasekaran@moneypennyllc.com":{"role": "team_member", "team": "team_d", "name": "Sharmila Gunasekaran"},
    "swetha_sagada@moneypennyllc.com":       {"role": "team_member", "team": "team_d", "name": "Swetha Sagada"},
    "sandhiya_jothi@moneypennyllc.com":      {"role": "team_member", "team": "team_d", "name": "Sandhiya Jothi"},
    "sirisha_mallireddy@moneypennyllc.com":  {"role": "team_member", "team": "team_d", "name": "Sirisha Mallireddy"},
    "krithiga_dhandapani@moneypennyllc.com": {"role": "team_member", "team": "team_d", "name": "Krithiga Dhandapani"},
    "yamini_s@moneypennyllc.com":            {"role": "team_member", "team": "team_d", "name": "Yamini S"},
    "dharani_s@moneypennyllc.com":           {"role": "team_member", "team": "team_d", "name": "Dharani S"},
    "abirami_radha@moneypennyllc.com":       {"role": "team_member", "team": "team_d", "name": "Abirami Radha"},

    # === TEAM E ===
    "shaalini_selvam@moneypennyllc.com":     {"role": "team_lead",   "team": "team_e", "name": "Shaalini Selvam"},
    "preethi_vkumar@moneypennyllc.com":      {"role": "team_member", "team": "team_e", "name": "Preethi V Kumar"},

    # === TEAM F ===
    "inbamozhi_n@moneypennyllc.com":         {"role": "team_lead",   "team": "team_f", "name": "Inbamozhi N"},
    "sarika_mani@moneypennyllc.com":         {"role": "team_member", "team": "team_f", "name": "Sarika Mani"},
    "irfhana_fathima@moneypennyllc.com":     {"role": "team_member", "team": "team_f", "name": "Irfhana Fathima"},

    # === TEAM G ===
    "hema_n@moneypennyllc.com":              {"role": "team_lead",   "team": "team_g", "name": "Hema N"},
    "indra_v@moneypennyllc.com":             {"role": "team_member", "team": "team_g", "name": "Indra V"},
    "amalabharathi_b@moneypennyllc.com":     {"role": "team_member", "team": "team_g", "name": "Amala Bharathi B"},
    "nidishablessy_biju@moneypennyllc.com":  {"role": "team_member", "team": "team_g", "name": "Nidishablessy Biju"},
    "pechiammal_selvam@moneypennyllc.com":   {"role": "team_member", "team": "team_g", "name": "Pechiammal Selvam"},

    # === TEAM H ===
    "deepali_vj@moneypennyllc.com":          {"role": "team_lead",   "team": "team_h", "name": "Deepali VJ"},
    "madumitha_loganadin@moneypennyllc.com": {"role": "team_member", "team": "team_h", "name": "Madumitha Loganadin"},
    "yashika_bhaskar@moneypennyllc.com":     {"role": "team_member", "team": "team_h", "name": "Yashika Bhaskar"},

    # === TEAM I ===
    "radhika_s@moneypennyllc.com":           {"role": "team_lead",   "team": "team_i", "name": "Radhika S"},
    "jayashree_boopathy@moneypennyllc.com":  {"role": "team_member", "team": "team_i", "name": "Jayashree Boopathy"},
    "jeevitha_elumalai@moneypennyllc.com":   {"role": "team_member", "team": "team_i", "name": "Jeevitha Elumalai"},
    # NOT GRANTED, flagged for a decision: Shivani Mohan
    # (shivani_mohan@moneypennyllc.com) is an ACTIVE Team I member in the live
    # roster but was absent from the supplied whitelist, so she cannot log in.
    # Granting access is your call, not something to infer — uncomment to allow.
    # "shivani_mohan@moneypennyllc.com":     {"role": "team_member", "team": "team_i", "name": "Shivani Mohan"},

    # === TEAM J ===
    "logeshwari_b@moneypennyllc.com":        {"role": "team_lead",   "team": "team_j", "name": "Logeshwari B"},
    "monikka_balaji@moneypennyllc.com":      {"role": "team_member", "team": "team_j", "name": "Monikka Balaji"},
    "dhanalakshmi_rukmangathan@moneypennyllc.com": {"role": "team_member", "team": "team_j", "name": "Dhanalakshmi Rukmangathan"},
    "nisha_m@moneypennyllc.com":             {"role": "team_member", "team": "team_j", "name": "Nisha M"},
    "sindhu_selvaraj@moneypennyllc.com":     {"role": "team_member", "team": "team_j", "name": "Sindhu Selvaraj"},

    # === TEAM K ===
    "karthika_rajasekaran@moneypennyllc.com":{"role": "team_lead",   "team": "team_k", "name": "Karthika Rajasekaran"},
    "janipriya_saravanan@moneypennyllc.com": {"role": "team_member", "team": "team_k", "name": "Janipriya Saravanan"},
    "rohitha_pacharu@moneypennyllc.com":     {"role": "team_member", "team": "team_k", "name": "Rohitha Pacharu"},
    "keerthana_sathiyaseelan@moneypennyllc.com": {"role": "team_member", "team": "team_k", "name": "Keerthana Sathiyaseelan"},
    "abinaya_sureshbabu@moneypennyllc.com":  {"role": "team_member", "team": "team_k", "name": "Abinaya Sureshbabu"},
    "kalpithaa_janarthanan@moneypennyllc.com": {"role": "team_member", "team": "team_k", "name": "Kalpithaa Janarthanan"},

    # === TEAM L ===
    "nasreen_f@moneypennyllc.com":           {"role": "team_lead",   "team": "team_l", "name": "Nasreen F"},
    "swathi_yogeswaran@moneypennyllc.com":   {"role": "team_member", "team": "team_l", "name": "Swathi Yogeswaran"},
    "krishna_narayanan@moneypennyllc.com":   {"role": "team_member", "team": "team_l", "name": "Krishna Narayanan"},
    "razia_hussain@moneypennyllc.com":       {"role": "team_member", "team": "team_l", "name": "Razia Hussain"},

    # === TEAM M ===
    "pavithira_vm@moneypennyllc.com":        {"role": "team_lead",   "team": "team_m", "name": "Pavithira VM"},
    "bhuvaneswari_balaji@moneypennyllc.com": {"role": "team_member", "team": "team_m", "name": "Bhuvaneswari Balaji"},
    "reshma_lakshmanaboopathi@moneypennyllc.com": {"role": "team_member", "team": "team_m", "name": "Reshma Lakshmanaboopathi"},

    # === TEAM N ===
    "vinodhini@moneypennyllc.com":           {"role": "team_lead",   "team": "team_n", "name": "Vinodhini"},
    "snega_murali@moneypennyllc.com":        {"role": "team_member", "team": "team_n", "name": "Snega Murali"},

    # === TEAM T ===
    "pragathi_s@moneypennyllc.com":          {"role": "team_lead",   "team": "team_t", "name": "Pragathi S"},
    "dharani_parthiban@moneypennyllc.com":   {"role": "team_member", "team": "team_t", "name": "Dharani Parthiban"},
    "fathima_saleem@moneypennyllc.com":      {"role": "team_member", "team": "team_t", "name": "Fathima Saleem"},
    "akshaya_manojkumar@moneypennyllc.com":  {"role": "team_member", "team": "team_t", "name": "Akshaya Manojkumar"},
    "shiyamala_saravanan@moneypennyllc.com": {"role": "team_member", "team": "team_t", "name": "Shiyamala Saravanan"},
    "prithvi_balu@moneypennyllc.com":        {"role": "team_member", "team": "team_t", "name": "Prithvi Balu"},
    "swetha_subramaniyan@moneypennyllc.com": {"role": "team_member", "team": "team_t", "name": "Swetha Subramaniyan"},
    "reshma_hameeth@moneypennyllc.com":      {"role": "team_member", "team": "team_t", "name": "Reshma Hameeth"},
}


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def get_user_access(email: str) -> dict | None:
    return USER_ACCESS.get(normalize_email(email))


def is_authorized(email: str) -> bool:
    return get_user_access(email) is not None


def is_admin(email: str) -> bool:
    access = get_user_access(email)
    return bool(access and access["role"] == "admin")


def get_user_team(email: str) -> str | None:
    access = get_user_access(email)
    return access["team"] if access else None


def can_access_team(email: str, requested_team_id: str) -> bool:
    access = get_user_access(email)
    if not access:
        return False
    if access["role"] == "admin":
        return True
    return access["team"] == requested_team_id


# ── Route policy ──────────────────────────────────────────────────
# No auth at all.
PUBLIC_PREFIXES = (
    "/api/auth/",
    "/api/health",
)

# Any authenticated user, no team scoping — these carry no per-team data.
ANY_USER_EXACT = frozenset({
    "/api/auth/me",
})

# Any authenticated user; the handler itself narrows the payload by role.
ANY_USER_PREFIXES = (
    "/api/teams",          # filtered to the caller's own team for non-admins
    "/api/chat",           # chatbot; team context is scoped by the caller
    "/api/meeting-status",
)

# Paths carrying a team id, keyed by the regex that extracts it. Every prefix
# that embeds a team_id must appear here — /api/eod/ and /api/sheets/health/
# are easy to miss because they are not under /api/team/.
TEAM_SCOPED_PATTERNS = (
    re.compile(r"^/api/team/(?P<team>team_[a-z]+)(?:/|$)"),
    re.compile(r"^/api/eod/(?P<team>team_[a-z]+)(?:/|$)"),
    re.compile(r"^/api/sheets/health/(?P<team>team_[a-z]+)(?:/|$)"),
)

# Client dashboards are cross-team by nature: a client's page lists every
# preparer who touched it, from any team. Non-admins may open only clients
# their own team is responsible for — enforced with a callback into main.py,
# which owns TEAM_CLIENTS.
CLIENT_SCOPED_PATTERN = re.compile(r"^/api/client/(?P<client>[^/]+)(?:/|$)")

# Everything else — debug dumps, cross-team audits, cache/warmup mutations,
# roster diffs, whale boards — is admin-only by default.


def classify_path(path: str) -> tuple[str, str | None]:
    """(kind, detail) where kind is one of:
         "public" | "any_user" | "team" | "client" | "admin_only"
    """
    if any(path.startswith(p) for p in PUBLIC_PREFIXES):
        return "public", None
    if path in ANY_USER_EXACT or any(path.startswith(p) for p in ANY_USER_PREFIXES):
        return "any_user", None
    for pat in TEAM_SCOPED_PATTERNS:
        m = pat.match(path)
        if m:
            return "team", m.group("team")
    m = CLIENT_SCOPED_PATTERN.match(path)
    if m:
        return "client", m.group("client")
    return "admin_only", None


def summarize() -> dict:
    """Startup banner data."""
    by_team: dict[str, int] = {}
    admins = []
    for email, a in USER_ACCESS.items():
        if a["role"] == "admin":
            admins.append(email)
        else:
            by_team[a["team"]] = by_team.get(a["team"], 0) + 1
    return {
        "total_users": len(USER_ACCESS),
        "admins": len(admins),
        "teams": len(by_team),
        "per_team": dict(sorted(by_team.items())),
    }
