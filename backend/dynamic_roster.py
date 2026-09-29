"""Dynamic team roster sourced from Timesheets.com.

Discovered via Phase-0 diagnostic (2026-08-10) against the live tenant:

  * There is NO group/department field. `/users` exposes exactly 13 fields and
    DEPARTMENT / DIVISION / LOCATION are empty strings for all 136 users.
    `/groups`, `/departments`, `/customers`, `/projects`, `/accountcodes`,
    `/roles` and `/customfields` all return 404. The only usable endpoints are
    `/users` and the report POST.

  * The team structure lives in `ADMINUSERID` — every user points at their
    supervisor. All 15 configured teams map 1:1 onto an ADMINUSERID group and
    the lead names match TEAM_LETTER_MAP exactly.

  * `JOBTITLE` is a clean role field ("Preparer" / "Team Lead" / "Training
    Lead" / "Manager" / "VP" / ...), so team-lead detection needs no string
    heuristics.

  * `USERSTATUS` is the active flag and "1" means active. Verified against 90
    days of timesheet activity: of the status=1 users, 78 logged hours and the
    5 that didn't are service accounts and US admin staff who don't track time;
    of the status=0 users, only 7 logged any hours and every one of them
    stopped by 2026-05-29, i.e. they had left.

There is deliberately NO fallback to a hardcoded roster inside the builders —
that policy lives in `get_dynamic_roster()`, which implements the three-tier
resolution (live -> stale cache -> hardcoded fallback).

This module never imports main.py. main.py injects its config and helpers
through `configure()` so there is no circular import.
"""

from __future__ import annotations

import json
import os
import re
import threading
import traceback
from collections import deque
from datetime import datetime, timedelta

import requests

TS_BASE = "https://secure.timesheets.com/api/public/v1"

# ── Tunables ──────────────────────────────────────────────────────
CACHE_TTL_SECONDS = 300           # 5 min — matches the spec's auto-sync window

# A client is attributed to every team holding at least this share of that
# client's hours. Winner-takes-all was rejected during Phase 0: 10 of 65
# customers split below 85%, and internal codes like SNMP / BREAKS FOR TEAMS
# are worked by every team (top team held only ~9%), so a single-winner rule
# assigns them arbitrarily and silently drops legitimate secondary owners
# (e.g. Neve Group is team_c 60% / team_t 32%).
#
# Both gates must pass. Share alone is not enough: with a 2-person team the
# denominator is small, so a couple of stray hours on another team's client can
# clear 10% (Team A picked up SoCo, Inspire Advisors and Scotts Law SD that way).
# An absolute-hours floor is what separates "this team works on it" from "someone
# logged a bit of time here once".
#
# Tunable without a deploy via ROSTER_CLIENT_SHARE_MIN / ROSTER_CLIENT_HOURS_MIN.
CLIENT_SHARE_THRESHOLD = float(os.getenv("ROSTER_CLIENT_SHARE_MIN", "0.10"))
CLIENT_MIN_HOURS       = float(os.getenv("ROSTER_CLIENT_HOURS_MIN", "20"))
CLIENT_LOOKBACK_DAYS   = 90

# Service/backup logins ("MPLLC3 BKP3"). They are real Timesheets users
# attached to a team lead but log no hours, so including them would put a
# permanently-idle row on five team dashboards. Surfaced in the diff report
# so the exclusion is visible rather than silent.
EXCLUDE_SERVICE_ACCOUNTS = os.getenv("ROSTER_INCLUDE_SERVICE_ACCOUNTS", "").strip().lower() not in ("1", "true", "yes")
_SERVICE_ACCOUNT_RE = re.compile(r"(?:^|\s)(?:MPLLC\d*|BKP\d*)(?:\s|$)", re.IGNORECASE)

# JOBTITLEs that mark someone as a lead of their own team rather than a
# rank-and-file member of their supervisor's team.
LEAD_JOB_TITLES = frozenset({"team lead", "training lead", "manager"})

# ── Manual member placement, overriding the ADMINUSERID hierarchy ──
# For people whose Timesheets.com reporting line does not reflect the team they
# actually work on. The override wins over ADMINUSERID and over JOBTITLE: the
# person is removed from whichever mapped team the hierarchy put them in, then
# added to the target team with the role stated here.
#
# This is a deliberate divergence from "Timesheets.com is the source of truth",
# so each entry records why, and every applied override is logged at startup.
# Keep this list SHORT — the right long-term fix is to correct ADMINUSERID in
# Timesheets.com, after which the entry can simply be deleted.
TEAM_MEMBER_OVERRIDES: dict[str, list[dict]] = {
    "team_g": [
        {
            "userid": "372101",
            "display_name": "Indra Vijayababu",
            "match_keyword": "indra vijayababu",
            "is_tl": False,          # explicitly NOT a lead, despite JOBTITLE
            "role": "preparer",
            "reason": ("Timesheets ADMINUSERID is 372099 (Vidya Laksmi Prakash, "
                       "Manager) and JOBTITLE reads 'Team Lead', but she works as "
                       "a Team G preparer under Hema (372164). Ops cannot change "
                       "the reporting line right now. Delete this entry once "
                       "ADMINUSERID is repointed to 372164."),
        },
    ],
    # Team I (2026-09-29): no overrides. Jayashree Boopathy already reports to
    # Krishna (372179) in Timesheets.com. The 2026-09-28 overrides that forced
    # Shivani Mohan and Jeevitha Elumalai into Team I were removed — per the
    # Whale PDF they are Team N (Core 4) and Team F (SoCo), which is also what
    # their ADMINUSERID says.
}


# People to keep out of every roster regardless of what Timesheets says.
# Use this ONLY as a stopgap for someone who has left but is still
# USERSTATUS=1 upstream: the correct fix is for ops to set USERSTATUS=0, after
# which the entry can be deleted. Matched on USERID (authoritative) or on the
# normalized full name (fallback, in case the id changes).
TEAM_MEMBER_EXCLUSIONS: dict[str, str] = {
    # Left MPLLC 2026-08. Still USERSTATUS=1 under Inbamozhi (team_f) at the
    # time of writing, so the roster would otherwise keep listing her.
    # Timesheets spells it "Iirfhana Fathima" (double i).
    "394462": "Iirfhana Fathima — left MPLLC 2026-08; ops to set USERSTATUS=0",
    # Former Team I TL, still USERSTATUS=1 upstream at the time of writing.
    "372171": "Radhika Sasikumar — left MPLLC 2026-09; ops to set USERSTATUS=0",
    # Removed from Team D 2026-09-29. Both still USERSTATUS=1 upstream.
    "378596": "Sharmila Gunasekaran — removed from Team D 2026-09-29 (no hours in 30 days); ops to set USERSTATUS=0",
    "372157": "Dharani Sekar — left Team D 2026-09-28; ops to set USERSTATUS=0",
}
EXCLUDED_NAMES = {"iirfhanafathima", "irfhanafathima"}


def is_excluded_member(u: dict) -> str | None:
    """Reason string if this user must never appear in a roster, else None."""
    uid = str(u.get("USERID") or "").strip()
    if uid in TEAM_MEMBER_EXCLUSIONS:
        return TEAM_MEMBER_EXCLUSIONS[uid]
    if _normalize_name(u.get("FULLNAME", "")) in EXCLUDED_NAMES:
        return "name-matched exclusion (left MPLLC)"
    return None


def _apply_member_overrides(teams: dict, users: list[dict]) -> list[dict]:
    """Force TEAM_MEMBER_OVERRIDES placements. Returns the applied entries.

    Runs AFTER the hierarchy build so it can relocate someone. Inactive users are
    still skipped — an override changes which team a person belongs to, not
    whether they are employed.
    """
    by_id = {str(u.get("USERID")): u for u in users}
    applied: list[dict] = []

    for team_id, overrides in TEAM_MEMBER_OVERRIDES.items():
        target = teams.get(team_id)
        if target is None:
            print(f"[DYNAMIC_ROSTER] override skipped — unknown team {team_id!r}")
            continue

        for ov in overrides:
            uid = str(ov.get("userid") or "").strip()
            user = by_id.get(uid)
            if not uid or user is None:
                print(f"[DYNAMIC_ROSTER] override skipped — USERID {uid!r} "
                      f"not in the Timesheets user list")
                continue
            if not is_active_user(user):
                print(f"[DYNAMIC_ROSTER] override skipped — {ov.get('display_name')} "
                      f"(USERID {uid}) is inactive in Timesheets")
                continue

            # Pull them out of whichever mapped team the hierarchy placed them in.
            moved_from = None
            for other_id, other in teams.items():
                if other_id == team_id:
                    continue
                before = len(other["members"])
                other["members"] = [m for m in other["members"]
                                    if m["timesheet_id"] != uid]
                if len(other["members"]) != before:
                    moved_from = other_id

            full = (user.get("FULLNAME") or "").strip()
            name = ov.get("display_name") or full
            if not any(m["timesheet_id"] == uid for m in target["members"]):
                target["members"].append({
                    "name": name,
                    "timesheet_id": uid,
                    "is_tl": bool(ov.get("is_tl", False)),
                    "job_title": ov.get("role") or (user.get("JOBTITLE") or "").strip(),
                    # Match on the real timesheet FULLNAME, not the display name,
                    # or their rows would never be attributed.
                    "match_keyword": (ov.get("match_keyword") or full).lower().strip(),
                    "overridden": True,
                    "override_reason": ov.get("reason", ""),
                })
            target["members"].sort(key=lambda m: (not m["is_tl"], m["name"]))
            applied.append({
                "team_id": team_id, "userid": uid, "name": name,
                "role": ov.get("role"), "is_tl": bool(ov.get("is_tl", False)),
                "moved_from": moved_from,
                "timesheet_admin_id": str(user.get("ADMINUSERID") or ""),
                "timesheet_job_title": (user.get("JOBTITLE") or "").strip(),
                "reason": ov.get("reason", ""),
            })
    return applied

# Retry ladder after a failed fetch: 60s, then every 5 min.
RETRY_FIRST_SECONDS  = 60
RETRY_STEADY_SECONDS = 300

# Outage alerts (ROSTER_ALERT_WEBHOOK_URL). Don't cry wolf on a single blip:
# "sync down" fires after this many consecutive failures (~6 min on the retry
# ladder), then at most once a day while the outage lasts. "Fallback activated"
# and "partial response rejected" fire once per outage, immediately.
ALERT_AFTER_FAILURES   = 3
ALERT_COOLDOWN_SECONDS = 24 * 3600

# Reject a fetch whose active headcount falls below this fraction of the last
# good one. A truncated /users response (upstream hiccup, maxrows change) would
# otherwise empty every team at once and log it as mass departures. A real
# reorg that big is accepted with POST /api/roster/refresh, which clears the
# cache this check compares against.
MIN_HEADCOUNT_RATIO = 0.5
MIN_HEADCOUNT_BASE  = 10

# /api/roster/fallback-drift calls the hardcoded fallback "significantly
# behind" once live and fallback differ by more than this many members.
FALLBACK_DRIFT_THRESHOLD = 10

CHANGE_HISTORY_MAX = 100
_HERE = os.path.dirname(os.path.abspath(__file__))


# ── Injected configuration (set by main.py at import time) ────────
_cfg: dict = {
    "team_letter_map":   {},
    "team_admin_map":    {},
    "team_order":        [],
    "fallback_rosters":  {},
    "fallback_members":  {},
    "fallback_clients":  {},
    "users_fetcher":     None,   # () -> list[dict] | None
    "rows_fetcher":      None,   # (start_iso, end_iso) -> list[dict]
    "is_internal_code":  None,   # (customer) -> bool
    "is_inactive_client": None,  # (customer) -> bool
    "is_hidden_for_team": None,  # (team_id, customer) -> bool
    "is_shared_client":  None,   # (customer) -> bool  — unowned, never auto-assigned
    "normalize_match":   None,   # (str) -> str
}


def configure(**kwargs) -> None:
    """Inject main.py's config and helpers. Unknown keys are ignored."""
    for k, v in kwargs.items():
        if k in _cfg:
            _cfg[k] = v


# ── Cache / health state ──────────────────────────────────────────
_lock = threading.Lock()

_roster_cache: dict = {
    "data":       None,      # last SUCCESSFUL payload
    "timestamp":  None,      # when it was fetched
    "users":      None,      # the /users list that payload was built from
}

_health: dict = {
    "current_source":         "uninitialized",
    "last_successful_fetch":  None,
    "last_attempt":           None,
    "last_error":             None,
    "consecutive_failures":   0,
    "next_retry":             None,
    "degraded_since":         None,
    "last_alert_at":          None,
    "alerted":                set(),   # alert kinds sent during this outage
}


def _now() -> datetime:
    return datetime.now()


# ── Helpers ───────────────────────────────────────────────────────
def _norm(s: str) -> str:
    fn = _cfg.get("normalize_match")
    if fn:
        return fn(s or "")
    return re.sub(r"[\s\-\.\(\)/,'_&]+", "", (s or "").lower())


def _normalize_name(s: str) -> str:
    return (s or "").lower().replace(" ", "").replace("'", "")


def is_service_account(fullname: str) -> bool:
    return bool(_SERVICE_ACCOUNT_RE.search(fullname or ""))


def is_active_user(u: dict) -> bool:
    """USERSTATUS == "1" means active. See module docstring for the evidence."""
    return str(u.get("USERSTATUS", "")).strip() == "1"


def is_lead_title(u: dict) -> bool:
    return str(u.get("JOBTITLE", "")).strip().lower() in LEAD_JOB_TITLES


def _find_lead(users: list[dict], lead_name: str) -> dict | None:
    """Mirror of main._find_lead — strict-first so 'Deepali' can't match 'Deepa'."""
    target = _normalize_name(lead_name)
    if not target:
        return None
    for u in users:
        if _normalize_name(u.get("FIRSTNAME", "")) == target:
            return u
    for u in users:
        fn = _normalize_name(u.get("FIRSTNAME", ""))
        if fn and fn.startswith(target):
            return u
    for u in users:
        if target in _normalize_name(u.get("FULLNAME", "")):
            return u
    return None


def _fetch_users() -> list[dict]:
    """Prefer main.py's cached+rate-limit-aware fetcher; fall back to a direct call."""
    fetcher = _cfg.get("users_fetcher")
    if fetcher:
        users = fetcher()
        if users:
            return users
        raise RuntimeError("users_fetcher returned no users")

    resp = requests.get(
        f"{TS_BASE}/users?maxrows=300",
        headers={
            "apikey": os.getenv("TIMESHEET_API_KEY"),
            "x-ts-authorization": os.getenv("TIMESHEET_API_TOKEN"),
        },
        timeout=30,
    )
    resp.raise_for_status()
    users = (resp.json().get("data", {}).get("users", {}) or {}).get("Data", [])
    if not users:
        raise RuntimeError("users endpoint returned an empty list")
    return users


# ── Roster construction ───────────────────────────────────────────
def build_dynamic_roster(users: list[dict] | None = None) -> dict:
    """Build the team structure from ADMINUSERID / JOBTITLE / USERSTATUS.

    Returns {team_id: {name, team_id, lead_user_id, lead_name, members[],
                       excluded[]}} where each member is
    {name, timesheet_id, is_tl, job_title, match_keyword}.
    """
    if users is None:
        users = _fetch_users()

    letter_map = _cfg["team_letter_map"] or {}
    admin_map  = _cfg["team_admin_map"] or {}
    order      = _cfg["team_order"] or list(letter_map.keys())

    by_admin: dict[str, list[dict]] = {}
    for u in users:
        by_admin.setdefault(str(u.get("ADMINUSERID") or "").strip(), []).append(u)

    teams: dict[str, dict] = {}
    claimed_lead_ids: set[str] = set()

    for team_id in order:
        cfg = letter_map.get(team_id)
        if cfg is None:
            continue

        # Prefer the pinned ADMINUSERID; fall back to resolving the lead by name.
        lead_id = str(admin_map.get(team_id) or "").strip()
        lead = None
        if lead_id:
            lead = next((u for u in users if str(u.get("USERID")) == lead_id), None)
        if lead is None:
            lead = _find_lead(users, cfg.get("leadName", ""))
            lead_id = str(lead.get("USERID")) if lead else ""

        if not lead_id:
            teams[team_id] = {
                "name": cfg.get("label", team_id),
                "team_id": team_id,
                "lead_user_id": None,
                "lead_name": cfg.get("leadName", ""),
                "members": [],
                "excluded": [],
                "missing_lead": True,
            }
            continue

        claimed_lead_ids.add(lead_id)
        roster_users = ([lead] if lead else []) + by_admin.get(lead_id, [])

        members, excluded = [], []
        seen: set[str] = set()
        for u in roster_users:
            uid = str(u.get("USERID", ""))
            if not uid or uid in seen:
                continue
            seen.add(uid)
            full = (u.get("FULLNAME") or "").strip()

            if EXCLUDE_SERVICE_ACCOUNTS and is_service_account(full):
                excluded.append({"name": full, "timesheet_id": uid, "reason": "service_account"})
                continue
            reason = is_excluded_member(u)
            if reason:
                excluded.append({"name": full, "timesheet_id": uid,
                                 "reason": "excluded", "detail": reason,
                                 "match_keyword": full.lower().strip()})
                continue
            if not is_active_user(u):
                # Kept out of the roster/count/display, but retained on the team
                # so their historical hours still attribute correctly — see
                # TEAM_ROSTERS_HISTORICAL in main.assign_row_to_team.
                excluded.append({"name": full, "timesheet_id": uid, "reason": "inactive",
                                 "match_keyword": full.lower().strip()})
                continue

            members.append({
                "name": full,
                "timesheet_id": uid,
                "is_tl": uid == lead_id,
                "job_title": (u.get("JOBTITLE") or "").strip(),
                # The full name is the roster keyword. main._kw_matches_name
                # requires every keyword token to prefix-match a name token, so
                # a complete name is both exact and maximally specific — it wins
                # the longest-keyword tiebreak in assign_row_to_team, which is
                # what the old hand-tuned partial keywords were fighting to do.
                "match_keyword": full.lower().strip(),
            })

        members.sort(key=lambda m: (not m["is_tl"], m["name"]))
        teams[team_id] = {
            "name": cfg.get("label", team_id),
            "team_id": team_id,
            "lead_user_id": lead_id,
            "lead_name": (lead.get("FULLNAME") or "") if lead else cfg.get("leadName", ""),
            "members": members,
            "excluded": excluded,
            "missing_lead": False,
        }

    # Leads who run a team Timesheets.com knows about but TEAM_LETTER_MAP does
    # not. Reported, never auto-added — a new team also needs a Google Sheet id
    # and a dashboard slot, which this API cannot supply.
    #
    # Manager tiers are skipped: Vidya Laksmi Prakash and Rajarajeswari
    # Sensuraman each have 6-9 direct reports, but every one of them is itself
    # a team lead. They're a layer above the teams, not an unconfigured team.
    # claimed_lead_ids covers leads whose JOBTITLE isn't a lead title — e.g.
    # Nasreen Fayashussain runs team_l but is titled "Preparer".
    lead_ids = {str(u.get("USERID", "")) for u in users if is_lead_title(u)} | claimed_lead_ids
    unmapped_teams = []
    for u in users:
        uid = str(u.get("USERID", ""))
        if (uid in claimed_lead_ids or not is_lead_title(u) or not is_active_user(u)
                or is_excluded_member(u)):
            continue
        # Service accounts and excluded leavers aren't a team's worth of people.
        reports = [r for r in by_admin.get(uid, [])
                   if is_active_user(r) and str(r.get("USERID", "")) not in lead_ids
                   and not is_service_account(r.get("FULLNAME", ""))
                   and not is_excluded_member(r)]
        if reports:
            unmapped_teams.append({
                "lead_name": (u.get("FULLNAME") or "").strip(),
                "lead_user_id": uid,
                "job_title": (u.get("JOBTITLE") or "").strip(),
                "member_count": len(reports),
                "members": sorted((r.get("FULLNAME") or "").strip() for r in reports),
            })

    # Manual placements win over the hierarchy — applied last so they can
    # relocate someone the ADMINUSERID chain already assigned.
    overrides_applied = _apply_member_overrides(teams, users)

    return {"teams": teams, "unmapped_teams": unmapped_teams,
            "member_overrides": overrides_applied}


# ── Client construction ───────────────────────────────────────────
def build_dynamic_team_clients(teams: dict, rows: list[dict] | None = None,
                               share_min: float | None = None,
                               hours_min: float | None = None) -> dict:
    """Attribute clients to teams from recent timesheet activity.

    Merge, not replace. Curated TEAM_CLIENTS entries carry estHrs / tz /
    meeting / tsMatch which Timesheets.com has no equivalent for, so curated
    entries are always kept verbatim and discovered clients are only ADDED
    when no curated entry for that team already covers them.
    """
    rows_fetcher = _cfg.get("rows_fetcher")
    if rows is None:
        if not rows_fetcher:
            return {"team_clients": {}, "discovered": {}, "orphans": [], "skipped": "no rows_fetcher configured"}
        end = _now()
        start = end - timedelta(days=CLIENT_LOOKBACK_DAYS)
        # NB: main.get_cached_rows takes ISO dates and owns its own long timeout.
        # timesheet.fetch_report must NOT be used here — it hardcodes timeout=15
        # inside a bare except, and a 90-day pull (51k rows / 41MB) always
        # exceeds it, so it returns None and every team silently gets 0 clients.
        rows = rows_fetcher(start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))
    if not rows:
        return {"team_clients": {}, "discovered": {}, "orphans": [], "skipped": "no rows returned"}

    uid_to_team: dict[str, str] = {}
    for tid, tdata in teams.items():
        for m in tdata["members"]:
            uid_to_team[m["timesheet_id"]] = tid

    is_internal = _cfg.get("is_internal_code") or (lambda c: False)
    is_inactive = _cfg.get("is_inactive_client") or (lambda c: False)
    is_hidden   = _cfg.get("is_hidden_for_team") or (lambda t, c: False)
    is_shared   = _cfg.get("is_shared_client") or (lambda c: False)

    # customer -> team -> hours
    pair_hours: dict[str, dict[str, float]] = {}
    for r in rows:
        hours = float(r.get("hours") or 0)
        if hours <= 0:
            continue
        customer = (r.get("customer") or "").strip()
        if not customer:
            continue
        tid = uid_to_team.get(str(r.get("userId") or ""))
        if not tid:
            continue
        # Internal codes (SNMP, BREAKS FOR TEAMS, Choose Customer, ...) are
        # worked by every team and belong in "Internal / Other", not on a
        # client list. Churned clients never come back.
        if is_internal(customer) or is_inactive(customer):
            continue
        # SHARED_CLIENTS are deliberately unowned — attributing one to a single
        # team would be exactly the bug this whole mechanism exists to avoid.
        if is_shared(customer):
            continue
        per_team = pair_hours.setdefault(customer, {})
        per_team[tid] = per_team.get(tid, 0.0) + hours

    share_gate = CLIENT_SHARE_THRESHOLD if share_min is None else share_min
    hours_gate = CLIENT_MIN_HOURS if hours_min is None else hours_min

    discovered: dict[str, list[dict]] = {}
    orphans: list[dict] = []
    for customer, per_team in pair_hours.items():
        total = sum(per_team.values())
        if total <= 0:
            continue
        claimed = False
        for tid, hrs in per_team.items():
            if hrs < hours_gate or (hrs / total) < share_gate:
                continue
            if is_hidden(tid, customer):
                continue
            claimed = True
            discovered.setdefault(tid, []).append({
                "name": customer,
                "hours": round(hrs, 1),
                "share": round(hrs / total, 3),
            })
        if not claimed:
            # Real logged hours that no team claims — every team's share fell
            # under the threshold, or the only qualifying team suppresses it.
            top = max(per_team.items(), key=lambda kv: kv[1])
            orphans.append({
                "name": customer,
                "hours": round(total, 1),
                "top_team": top[0],
                "top_share": round(top[1] / total, 3),
            })
    orphans.sort(key=lambda o: -o["hours"])
    for tid in discovered:
        discovered[tid].sort(key=lambda c: -c["hours"])

    curated = _cfg["fallback_clients"] or {}
    merged: dict[str, list[dict]] = {}
    additions: dict[str, list[dict]] = {}

    for tid in set(list(curated.keys()) + list(discovered.keys())):
        entries = [dict(e) for e in (curated.get(tid) or [])]

        def already_covered(customer: str) -> bool:
            cust_n = _norm(customer)
            if not cust_n:
                return True
            for e in entries:
                for alias in (e.get("tsMatch") or [e.get("name", "")]):
                    a = _norm(alias)
                    if a and a in cust_n:
                        return True
                if _norm(e.get("name", "")) and _norm(e["name"]) in cust_n:
                    return True
            return False

        for d in discovered.get(tid, []):
            if already_covered(d["name"]):
                continue
            entries.append({
                "name": d["name"],
                "tsMatch": [d["name"]],
                "estHrs": 0,          # unknown — committed resolves from the BOD/EOD sheet
                "tz": "",
                "meeting": "No scheduled meeting",
                "discovered": True,
                "discoveredHours": d["hours"],
                "discoveredShare": d["share"],
            })
            additions.setdefault(tid, []).append(d)

        merged[tid] = entries

    return {"team_clients": merged, "discovered": additions, "orphans": orphans, "skipped": None}


# ── Payload assembly ──────────────────────────────────────────────
def _build_payload(users: list[dict] | None = None) -> dict:
    if users is None:
        users = _fetch_users()
    built = build_dynamic_roster(users)
    teams = built["teams"]

    clients = build_dynamic_team_clients(teams)

    result: dict = {
        "TEAM_ROSTERS": {},
        # Former members (USERSTATUS=0), kept ONLY for matching historical
        # timesheet rows. Excluded from counts and from every display path, so
        # a 90-day report still credits a departed preparer's hours to the team
        # they were on without them showing up as current headcount.
        "TEAM_ROSTERS_HISTORICAL": {},
        "TEAM_MEMBERS": {},
        "TEAM_CLIENTS": clients["team_clients"],
        "TEAM_EXPECTED_COUNTS": {},
        "TEAM_ADMIN_MAP": {},
        "raw_teams": teams,
        "unmapped_teams": built["unmapped_teams"],
        "member_overrides": built.get("member_overrides") or [],
        "client_additions": clients["discovered"],
        "client_orphans": clients.get("orphans") or [],
        "client_note": clients["skipped"],
        "user_count": len(users),
    }

    for tid, tdata in teams.items():
        members = tdata["members"]
        result["TEAM_ROSTERS"][tid] = [m["match_keyword"] for m in members]
        result["TEAM_ROSTERS_HISTORICAL"][tid] = [
            e["match_keyword"] for e in tdata.get("excluded", [])
            if e.get("reason") == "inactive" and e.get("match_keyword")
        ]
        result["TEAM_MEMBERS"][tid] = [
            m["name"] + (" (TL)" if m["is_tl"] else "") for m in members
        ]
        result["TEAM_EXPECTED_COUNTS"][tid] = len(members)
        if tdata.get("lead_user_id"):
            result["TEAM_ADMIN_MAP"][tid] = tdata["lead_user_id"]

    return result


def _fallback_payload() -> dict:
    return {
        "TEAM_ROSTERS": {k: list(v) for k, v in (_cfg["fallback_rosters"] or {}).items()},
        "TEAM_ROSTERS_HISTORICAL": {},
        "TEAM_MEMBERS": {k: list(v) for k, v in (_cfg["fallback_members"] or {}).items()},
        "TEAM_CLIENTS": {k: [dict(e) for e in v] for k, v in (_cfg["fallback_clients"] or {}).items()},
        "TEAM_EXPECTED_COUNTS": {
            k: len(v) for k, v in (_cfg["fallback_rosters"] or {}).items()
        },
        "TEAM_ADMIN_MAP": dict(_cfg["team_admin_map"] or {}),
        "raw_teams": {},
        "unmapped_teams": [],
        "member_overrides": [],
        "client_additions": {},
        "client_orphans": [],
        "client_note": "hardcoded fallback — no live data",
        "user_count": 0,
    }


# ── Alerting ──────────────────────────────────────────────────────
def _post_slack(webhook: str, text: str) -> tuple[bool, str]:
    try:
        r = requests.post(webhook, json={"text": text}, timeout=10)
        if r.ok:
            return True, f"HTTP {r.status_code}"
        print(f"[DYNAMIC_ROSTER] Slack POST rejected: HTTP {r.status_code} {r.text[:100]}")
        return False, f"HTTP {r.status_code}: {r.text[:100]}"
    except Exception as e:
        print(f"[DYNAMIC_ROSTER] Slack POST failed: {e}")
        return False, f"{type(e).__name__}: {e}"


def _alert(kind: str, text: str, now: datetime, cooldown: float | None = None) -> None:
    """Outage alert, at most once per `kind` per outage (or per `cooldown`).
    Called under _lock, so the POST runs on a thread — a slow webhook must not
    stall every roster read. Silent no-op unless ROSTER_ALERT_WEBHOOK_URL is set."""
    webhook = os.getenv("ROSTER_ALERT_WEBHOOK_URL", "").strip()
    if not webhook:
        return
    last = _health.get("last_alert_at")
    if kind in _health["alerted"] and not (
            cooldown and last and (now - last).total_seconds() >= cooldown):
        return
    _health["alerted"].add(kind)
    _health["last_alert_at"] = now
    print(f"[DYNAMIC_ROSTER] alert ({kind}) → Slack")
    threading.Thread(target=_post_slack, args=(webhook, text), daemon=True).start()


def _outage_alerts(source: str, err: Exception | None, now: datetime) -> None:
    fails = _health.get("consecutive_failures", 0)
    since = _health.get("degraded_since") or now
    mins = int((now - since).total_seconds() // 60)
    last_error = _health.get("last_error") or "unknown"
    if isinstance(err, ImplausibleRoster):
        _alert("implausible", f":warning: MoneyPenny Dashboard: rejected a partial "
               f"Timesheets.com response — {err} Still serving the last good roster.", now)
    if source == "fallback":
        _alert("fallback", ":rotating_light: MoneyPenny Dashboard: *fallback mode "
               "activated* — Timesheets.com unreachable with no cached roster, serving "
               f"the hardcoded fallback. Last error: {last_error}", now)
    if fails >= ALERT_AFTER_FAILURES:
        what = ("hardcoded fallback roster" if source == "fallback"
                else "last cached roster — roster changes are not syncing")
        _alert("down", f":rotating_light: MoneyPenny Dashboard: Timesheets.com sync "
               f"*down* — {fails} consecutive failures over {mins} min. Serving the "
               f"{what}. Last error: {last_error}", now, cooldown=ALERT_COOLDOWN_SECONDS)


def _maybe_alert_recovered(now: datetime) -> None:
    """Close the loop on an outage we alerted about."""
    webhook = os.getenv("ROSTER_ALERT_WEBHOOK_URL", "").strip()
    since = _health.get("degraded_since")
    if not webhook or not since or not _health["alerted"]:
        return
    mins = int((now - since).total_seconds() // 60)
    threading.Thread(target=_post_slack, daemon=True, args=(
        webhook, f":white_check_mark: MoneyPenny Dashboard: Timesheets.com roster sync "
                 f"recovered after {mins} min.")).start()


def send_test_alert() -> dict:
    """Admin-triggered check that the outage webhook works. Never echoes the URL."""
    webhook = os.getenv("ROSTER_ALERT_WEBHOOK_URL", "").strip()
    if not webhook:
        return {"ok": False, "webhook_configured": False,
                "error": "ROSTER_ALERT_WEBHOOK_URL is not set in backend/.env"}
    ok, detail = _post_slack(webhook, ":test_tube: MoneyPenny Dashboard: test roster "
                                      "outage alert. If you can read this, alerts work.")
    return {"ok": ok, "webhook_configured": True, "detail": detail}


class ImplausibleRoster(RuntimeError):
    """A fetch that succeeded but can't be right (e.g. truncated user list)."""


def _record_success(now: datetime) -> None:
    _maybe_alert_recovered(now)
    _health.update({
        "current_source": "live",
        "last_successful_fetch": now,
        "last_attempt": now,
        "last_error": None,
        "consecutive_failures": 0,
        "next_retry": None,
        "degraded_since": None,
    })
    _health["alerted"] = set()


def _record_failure(now: datetime, err: Exception) -> None:
    fails = _health.get("consecutive_failures", 0) + 1
    delay = RETRY_FIRST_SECONDS if fails == 1 else RETRY_STEADY_SECONDS
    _health.update({
        "last_attempt": now,
        "last_error": f"{type(err).__name__}: {err}",
        "consecutive_failures": fails,
        "next_retry": now + timedelta(seconds=delay),
    })
    if _health.get("degraded_since") is None:
        _health["degraded_since"] = now
    print(f"[DYNAMIC_ROSTER] fetch failed (#{fails}): {type(err).__name__}: {err} "
          f"— next retry in {delay}s")
    if fails <= 2:
        traceback.print_exc()


# ── Public API ────────────────────────────────────────────────────
def get_dynamic_roster(force_refresh: bool = False) -> dict:
    """Three-tier resolution, always returns a usable payload.

      Tier 1  live         — fresh Timesheets.com data (< CACHE_TTL_SECONDS)
      Tier 2  stale_cache  — last successful fetch, any age
      Tier 3  fallback     — hardcoded FALLBACK_* dicts

    The envelope is {data, source, last_updated, cache_age_seconds}.
    """
    with _lock:
        now = _now()
        cached, cached_at = _roster_cache["data"], _roster_cache["timestamp"]

        # Tier 1 (cached and still fresh)
        if not force_refresh and cached and cached_at:
            age = (now - cached_at).total_seconds()
            if age < CACHE_TTL_SECONDS:
                _health["current_source"] = "live"
                return _envelope(cached, "live", cached_at, age)

        # Respect the retry ladder — don't hammer a down API on every request.
        nxt = _health.get("next_retry")
        err = None
        may_attempt = force_refresh or not nxt or now >= nxt

        if may_attempt:
            try:
                users = _fetch_users()
                payload = _build_payload(users)
                problem = _implausible(payload, cached)
                if problem:
                    raise ImplausibleRoster(problem)
                _roster_cache["data"] = payload
                _roster_cache["timestamp"] = now
                _roster_cache["users"] = users
                _record_success(now)
                _detect_changes(payload, now)
                return _envelope(payload, "live", now, 0.0)
            except Exception as e:
                _record_failure(now, e)
                err = e
        else:
            print(f"[DYNAMIC_ROSTER] holding off until {nxt:%H:%M:%S} "
                  f"({_health.get('consecutive_failures')} failures so far)")

        # Tier 2 — serve the last good payload however old it is.
        if cached and cached_at:
            age = (now - cached_at).total_seconds()
            _health["current_source"] = "stale_cache"
            _outage_alerts("stale_cache", err, now)
            return _envelope(cached, "stale_cache", cached_at, age)

        # Tier 3 — cold failure, nothing cached.
        _health["current_source"] = "fallback"
        _outage_alerts("fallback", err, now)
        return _envelope(_fallback_payload(), "fallback", None, None)


def _envelope(data: dict, source: str, ts: datetime | None, age: float | None) -> dict:
    return {
        "data": data,
        "source": source,
        "last_updated": ts.isoformat() if ts else None,
        "cache_age_seconds": int(age) if age is not None else None,
    }


def get_roster_status() -> dict:
    def iso(v):
        return v.isoformat() if isinstance(v, datetime) else None
    cached_at = _roster_cache["timestamp"]
    return {
        "current_source":        _health.get("current_source"),
        "last_successful_fetch": iso(_health.get("last_successful_fetch")),
        "last_attempt":          iso(_health.get("last_attempt")),
        "last_error":            _health.get("last_error"),
        "consecutive_failures":  _health.get("consecutive_failures", 0),
        "next_retry":            iso(_health.get("next_retry")),
        "degraded_since":        iso(_health.get("degraded_since")),
        "cache_age_seconds":     int((_now() - cached_at).total_seconds()) if cached_at else None,
        "cache_ttl_seconds":     CACHE_TTL_SECONDS,
        "has_cached_data":       _roster_cache["data"] is not None,
        "enabled":               is_enabled(),
        "exclude_service_accounts": EXCLUDE_SERVICE_ACCOUNTS,
    }


def clear_roster_cache() -> None:
    with _lock:
        _roster_cache["data"] = None
        _roster_cache["timestamp"] = None
        _roster_cache["users"] = None
        _health["next_retry"] = None


def _active_headcount(payload: dict | None) -> int:
    return sum(len(v) for v in ((payload or {}).get("TEAM_ROSTERS") or {}).values())


def _implausible(payload: dict, previous: dict | None) -> str | None:
    """Reason to distrust a freshly built payload, else None."""
    before, after = _active_headcount(previous), _active_headcount(payload)
    if before >= MIN_HEADCOUNT_BASE and after < before * MIN_HEADCOUNT_RATIO:
        return (f"implausible roster: active members fell {before} -> {after} "
                f"(below {int(MIN_HEADCOUNT_RATIO * 100)}%); keeping last good data. "
                f"If this is a real reorg, POST /api/roster/refresh to accept it.")
    return None


def is_enabled() -> bool:
    """Whether the dynamic roster is allowed to REPLACE the hardcoded config.

    Off by default: the Phase-0 diff is material (Team A drops from 5 members
    to 2 once departed staff are filtered out), so the cutover is a deliberate
    act. /api/roster/diff shows exactly what would change.
    """
    return os.getenv("DYNAMIC_ROSTER_ENABLED", "").strip().lower() in ("1", "true", "yes")


# ── Diff report ───────────────────────────────────────────────────
def build_diff() -> dict:
    """Compare the live dynamic roster against the hardcoded fallback.

    Roster keywords aren't directly comparable (hardcoded uses partial
    keywords like "jayashree b", dynamic uses full names), so members are
    compared by resolving each hardcoded keyword against the live user list
    with the same token-prefix rule main.py uses.
    """
    env = get_dynamic_roster()
    payload, source = env["data"], env["source"]
    if source == "fallback":
        return {"error": "no live data available", "source": source,
                "status": get_roster_status()}

    users = _roster_cache.get("users")
    if not users:
        try:
            users = _fetch_users()
        except Exception as e:
            return {"error": f"users fetch failed: {e}", "source": source}
    all_names = [(u.get("FULLNAME") or "").strip() for u in users]
    active_names = [(u.get("FULLNAME") or "").strip()
                    for u in users if is_active_user(u)]
    fallback_rosters = _cfg["fallback_rosters"] or {}
    teams_diff = _fallback_team_diff(payload, users)

    # ── Derived cross-team views (consumed by scripts/review_roster.py) ──
    dynamic_teams = {
        tid: [m["name"] for m in t.get("members", [])]
        for tid, t in payload["raw_teams"].items()
    }
    dynamic_clients = {
        tid: [c.get("name", "") for c in entries]
        for tid, entries in (payload.get("TEAM_CLIENTS") or {}).items()
    }
    members_added   = {tid: d["added"] for tid, d in teams_diff.items() if d["added"]}
    members_removed = {tid: d["removed"] for tid, d in teams_diff.items() if d["removed"]}
    clients_added   = {tid: [c["name"] for c in d["clients_added"]]
                       for tid, d in teams_diff.items() if d["clients_added"]}

    # A name dropped by one team and picked up by another is a MOVE, not an
    # unrelated add+remove. Surfacing these separately is the point of the
    # review — they're the changes that silently reassign someone's hours.
    added_index: dict[str, str] = {}
    for tid, names in members_added.items():
        for n in names:
            added_index[n] = tid
    members_moved = []
    for tid, names in members_removed.items():
        for n in names:
            dest = added_index.get(n)
            if dest and dest != tid:
                members_moved.append({"name": n, "from_team": tid, "to_team": dest})
    members_moved.sort(key=lambda m: m["name"])
    moved_names = {m["name"] for m in members_moved}

    # Clients legitimately worked by more than one team (>=10% share each).
    client_teams: dict[str, list[str]] = {}
    for tid, names in dynamic_clients.items():
        for n in names:
            if n:
                client_teams.setdefault(n, []).append(tid)
    shared_clients = [
        {"client": n, "teams": sorted(tids)}
        for n, tids in sorted(client_teams.items()) if len(tids) > 1
    ]

    warnings: list[str] = []
    for tid, d in sorted(teams_diff.items()):
        for kw in d["unresolved_keywords"]:
            warnings.append(
                f"{tid}: hardcoded keyword {kw!r} matches NO timesheet user "
                f"(likely a spelling error — it has never filtered anything)"
            )
        if d["new_count"] == 0:
            warnings.append(f"{tid}: dynamic roster is EMPTY — lead resolved no active members")
        if payload["raw_teams"].get(tid, {}).get("missing_lead"):
            warnings.append(f"{tid}: lead not found in the live user list")
        old, new = d["old_count"], d["new_count"]
        if old and new and abs(new - old) / old >= 0.5:
            warnings.append(f"{tid}: headcount changes by >=50% ({old} -> {new}) — confirm with the TL")
    for t in payload.get("unmapped_teams") or []:
        warnings.append(
            f"unmapped team: {t['lead_name']} ({t['job_title']}) has "
            f"{t['member_count']} active reports but no TEAM_LETTER_MAP entry"
        )
    if payload.get("client_note"):
        warnings.append(f"clients not derived from activity: {payload['client_note']}")

    return {
        "source": source,
        "generated_at": _now().isoformat(),
        "enabled": is_enabled(),
        "note": ("DYNAMIC_ROSTER_ENABLED is off — this is a preview of what would "
                 "change, the dashboard is still served from the hardcoded config."
                 if not is_enabled() else
                 "DYNAMIC_ROSTER_ENABLED is ON — the dynamic roster is live."),
        "totals": {
            "active_users":  len(active_names),
            "total_users":   len(all_names),
            "teams":         len(teams_diff),
            "members_old":   sum(len(v) for v in fallback_rosters.values()),
            "members_new":   sum(len(v) for v in payload["TEAM_ROSTERS"].values()),
            # Moves are counted once, not as both an add and a remove.
            "members_added":   sum(len(v) for v in members_added.values()) - len(moved_names),
            "members_removed": sum(len(v) for v in members_removed.values()) - len(moved_names),
            "members_moved":   len(members_moved),
            "clients_added":   sum(len(v) for v in clients_added.values()),
            "shared_clients":  len(shared_clients),
            "orphan_clients":  len(payload.get("client_orphans") or []),
            "warnings":        len(warnings),
        },
        "teams": teams_diff,
        "dynamic_teams": dynamic_teams,
        "dynamic_clients": dynamic_clients,
        "members_added": members_added,
        "members_removed": members_removed,
        "members_moved": members_moved,
        "clients_added": clients_added,
        "shared_clients": shared_clients,
        "orphan_clients": payload.get("client_orphans") or [],
        "warnings": warnings,
        "unmapped_teams": payload["unmapped_teams"],
        "member_overrides": payload.get("member_overrides") or [],
        "client_note": payload.get("client_note"),
    }


def _kw_matches(kw: str, fullname: str) -> bool:
    """main._kw_matches_name: every keyword token prefix-matches a name token."""
    k, n = (kw or "").lower().strip(), (fullname or "").lower().strip()
    if not k or not n:
        return False
    nt = [t for t in re.split(r"[\s\-\.,]+", n) if t]
    kt = [t for t in re.split(r"[\s\-\.,]+", k) if t]
    if not nt or not kt:
        return False
    return all(any(x.startswith(y) for x in nt) for y in kt)


def _fallback_team_diff(payload: dict, users: list[dict]) -> dict:
    """Per team: hardcoded fallback vs live members.

    Roster keywords aren't directly comparable (hardcoded uses partial
    keywords like "jayashree b", dynamic uses full names), so each hardcoded
    keyword is resolved against the full user list with the same token-prefix
    rule main.py uses.
    """
    all_names = [(u.get("FULLNAME") or "").strip() for u in users or []]
    fallback_rosters = _cfg["fallback_rosters"] or {}
    teams_diff = {}
    for tid in sorted(set(list(fallback_rosters.keys()) + list(payload["TEAM_ROSTERS"].keys()))):
        old_kws = fallback_rosters.get(tid, [])
        old_resolved, unresolved = set(), []
        for kw in old_kws:
            hits = [n for n in all_names if _kw_matches(kw, n)]
            if hits:
                old_resolved.update(hits)
            else:
                unresolved.append(kw)

        tdata = payload["raw_teams"].get(tid, {})
        new_names = {m["name"] for m in tdata.get("members", [])}

        teams_diff[tid] = {
            "label":            tdata.get("name", tid),
            "lead":             tdata.get("lead_name", ""),
            "old_count":        len(old_kws),
            "new_count":        len(new_names),
            "added":            sorted(new_names - old_resolved),
            "removed":          sorted(old_resolved - new_names),
            "unchanged":        sorted(new_names & old_resolved),
            "unresolved_keywords": unresolved,
            "excluded":         tdata.get("excluded", []),
            "clients_added":    payload["client_additions"].get(tid, []),
        }
    return teams_diff


# ── Roster change detection ───────────────────────────────────────
# Each successful fetch is compared, by Timesheets USERID, with the previous
# one. The previous snapshot and the change history are persisted so a
# backend restart neither loses the feed nor misses a change made while the
# process was down. Both files hold staff names, so they default to the
# gitignored backend/logs/ — this repo is public.
_changes: deque = deque(maxlen=CHANGE_HISTORY_MAX)
_change_state: dict = {"loaded": False, "snapshot": None, "last_change_at": None}


def _state_path() -> str:
    return os.getenv("ROSTER_STATE_FILE") or os.path.join(_HERE, "logs", "roster_state.json")


def _change_log_path() -> str:
    return os.getenv("ROSTER_CHANGE_LOG") or os.path.join(_HERE, "logs", "roster_changes.log")


def _load_change_state() -> None:
    _change_state["loaded"] = True
    try:
        with open(_state_path(), encoding="utf-8") as f:
            st = json.load(f)
        _change_state["snapshot"] = st.get("snapshot")
        _change_state["last_change_at"] = st.get("last_change_at")
        _changes.clear()
        _changes.extend(st.get("changes") or [])
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[ROSTER_CHANGES] could not load {_state_path()}: {e} — starting fresh")


def _save_change_state() -> None:
    path = _state_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"snapshot": _change_state["snapshot"],
                       "last_change_at": _change_state["last_change_at"],
                       "changes": list(_changes)}, f)
        os.replace(tmp, path)
    except Exception as e:
        print(f"[ROSTER_CHANGES] could not save {path}: {e}")


def _snapshot(payload: dict) -> dict:
    """{team_id: {lead_id, lead_name, members: {userid: name}}}"""
    snap = {}
    for tid, t in (payload.get("raw_teams") or {}).items():
        snap[tid] = {
            "lead_id": t.get("lead_user_id"),
            "lead_name": t.get("lead_name") or "",
            "members": {m["timesheet_id"]: m["name"] for m in t.get("members", [])},
        }
    return snap


def diff_snapshots(old: dict, new: dict) -> list[dict]:
    """Member adds / removals / moves and lead changes between two snapshots."""
    def where(snap):
        out = {}
        for tid, t in snap.items():
            for uid, name in t["members"].items():
                out.setdefault(uid, (tid, name))
        return out

    before, after = where(old), where(new)
    changes = []
    for uid, (tid, name) in after.items():
        if uid not in before:
            changes.append({"type": "added", "name": name, "timesheet_id": uid,
                            "from_team": None, "to_team": tid,
                            "message": f"{name} added to {tid}"})
        elif before[uid][0] != tid:
            changes.append({"type": "moved", "name": name, "timesheet_id": uid,
                            "from_team": before[uid][0], "to_team": tid,
                            "message": f"{name} moved from {before[uid][0]} to {tid}"})
    for uid, (tid, name) in before.items():
        if uid not in after:
            changes.append({"type": "removed", "name": name, "timesheet_id": uid,
                            "from_team": tid, "to_team": None,
                            "message": f"{name} removed from {tid} "
                                       f"(inactive or no longer under a mapped team lead)"})
    for tid in sorted(set(old) & set(new)):
        o, n = old[tid], new[tid]
        if (o.get("lead_id") or None) != (n.get("lead_id") or None):
            changes.append({"type": "lead_changed", "name": n.get("lead_name") or "",
                            "timesheet_id": n.get("lead_id"),
                            "from_team": tid, "to_team": tid,
                            "previous_lead": o.get("lead_name") or "",
                            "message": f"{tid} lead changed from "
                                       f"{o.get('lead_name') or 'none'} to "
                                       f"{n.get('lead_name') or 'none'}"})
    order = {"lead_changed": 0, "moved": 1, "added": 2, "removed": 3}
    changes.sort(key=lambda c: (order[c["type"]], c["name"]))
    return changes


def _detect_changes(payload: dict, now: datetime) -> list[dict]:
    """Record what changed since the last successful fetch. Called under _lock.
    The first fetch with no saved snapshot only establishes a baseline."""
    if not _change_state["loaded"]:
        _load_change_state()
    new = _snapshot(payload)
    old = _change_state["snapshot"]
    _change_state["snapshot"] = new
    changes = diff_snapshots(old, new) if old else []
    if changes:
        at = now.isoformat(timespec="seconds")
        for c in changes:
            c["at"] = at
            _changes.append(c)
            print(f"[ROSTER_CHANGE] {c['message']}")
        _change_state["last_change_at"] = at
        _write_change_log(changes, now)
        threading.Thread(target=_notify_changes, args=(changes,), daemon=True).start()
    if old != new:
        _save_change_state()
    return changes


def _write_change_log(changes: list[dict], now: datetime) -> None:
    path = _change_log_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            for c in changes:
                f.write(f"{now:%Y-%m-%d %H:%M} - {c['message']}\n")
    except Exception as e:
        print(f"[ROSTER_CHANGES] could not write {path}: {e}")


def _notify_changes(changes: list[dict]) -> None:
    """Slack summary of one batch. Only ROSTER_CHANGE_WEBHOOK_URL — deliberately
    NOT the outage webhook, which is kept for outages so daily roster shuffles
    don't drown it out. Silent no-op when unset."""
    webhook = os.getenv("ROSTER_CHANGE_WEBHOOK_URL", "").strip()
    if not webhook:
        return
    lines = [f"• {c['message']}" for c in changes[:20]]
    if len(changes) > 20:
        lines.append(f"• …and {len(changes) - 20} more (GET /api/roster/recent-changes)")
    _post_slack(webhook, ":busts_in_silhouette: MoneyPenny Dashboard: roster changes "
                         "detected in Timesheets.com\n" + "\n".join(lines))


def get_recent_changes(limit: int = CHANGE_HISTORY_MAX) -> dict:
    with _lock:
        if not _change_state["loaded"]:
            _load_change_state()
        items = list(reversed(_changes))[:max(0, limit)]
        return {"count": len(items), "last_change_at": _change_state["last_change_at"],
                "baseline_established": _change_state["snapshot"] is not None,
                "changes": items}


# ── Health + fallback drift ───────────────────────────────────────
def _drift_summary(teams_diff: dict) -> tuple[dict, int]:
    per_team, total = {}, 0
    for tid, d in teams_diff.items():
        n = len(d["added"]) + len(d["removed"]) + len(d["unresolved_keywords"])
        total += n
        per_team[tid] = n
    return per_team, total


def get_roster_health() -> dict:
    """One call for the admin health widget: sync state, per-team live vs
    fallback counts, recent changes and anything an admin should act on."""
    status = get_roster_status()
    now = _now()
    with _lock:
        payload, users = _roster_cache["data"], _roster_cache["users"]
        last_ok = _health.get("last_successful_fetch")
        nxt = _health.get("next_retry")
        if not _change_state["loaded"]:
            _load_change_state()
        changes = list(_changes)
        last_change_at = _change_state["last_change_at"]

    source = status["current_source"]
    age = status["cache_age_seconds"]
    # The loop ticks every TTL and a rebuild (90 days of rows) takes a while,
    # so allow two intervals before calling the cache stalled.
    fresh = age is not None and age <= 2 * CACHE_TTL_SECONDS + 60
    healthy = source == "live" and status["consecutive_failures"] == 0 and fresh

    if nxt:
        next_sync = nxt
    elif last_ok:
        next_sync = max(now, last_ok + timedelta(seconds=CACHE_TTL_SECONDS))
    else:
        next_sync = None

    team_counts, drift_total = {}, None
    if payload and users:
        teams_diff = _fallback_team_diff(payload, users)
        per_team, drift_total = _drift_summary(teams_diff)
        for tid, d in teams_diff.items():
            team_counts[tid] = {"live": d["new_count"], "fallback": d["old_count"],
                                "differs": per_team[tid] > 0}

    warnings: list[str] = []
    if not status["enabled"]:
        warnings.append("DYNAMIC_ROSTER_ENABLED is off — the dashboard uses the "
                        "hardcoded roster, not Timesheets.com.")
    if source == "fallback":
        warnings.append("Timesheets.com unreachable and nothing cached — using the "
                        "hardcoded fallback roster.")
    elif source == "stale_cache":
        warnings.append(f"Timesheets.com sync failing — serving the roster cached "
                        f"{(age or 0) // 60} min ago.")
    elif source == "live" and not fresh:
        warnings.append(f"Roster cache is {(age or 0) // 60} min old — the background "
                        f"sync may have stalled.")
    if status["consecutive_failures"]:
        warnings.append(f"{status['consecutive_failures']} consecutive sync failures; "
                        f"last error: {status['last_error']}")
    if drift_total is not None and drift_total > FALLBACK_DRIFT_THRESHOLD:
        warnings.append(f"Hardcoded fallback roster is {drift_total} member differences "
                        f"behind live data — see /api/roster/fallback-drift.")
    for tid, t in ((payload or {}).get("raw_teams") or {}).items():
        if t.get("missing_lead"):
            warnings.append(f"{tid}: team lead not found in Timesheets.com.")
        elif not t.get("members"):
            warnings.append(f"{tid}: no active members.")
    for t in (payload or {}).get("unmapped_teams") or []:
        warnings.append(f"Unmapped team: {t['lead_name']} has {t['member_count']} active "
                        f"report(s) but no dashboard team.")

    week_ago = (now - timedelta(days=7)).isoformat(timespec="seconds")
    return {
        "sync_healthy": healthy,
        "current_source": source,
        "enabled": status["enabled"],
        "last_sync": status["last_successful_fetch"],
        "next_sync": next_sync.isoformat() if isinstance(next_sync, datetime) else None,
        "sync_interval_seconds": CACHE_TTL_SECONDS,
        "cache_age_seconds": age,
        "consecutive_failures": status["consecutive_failures"],
        "last_error": status["last_error"],
        "degraded_since": status["degraded_since"],
        "warnings": warnings,
        "team_counts": team_counts,
        "fallback_drift_total": drift_total,
        "fallback_significantly_behind": (drift_total or 0) > FALLBACK_DRIFT_THRESHOLD,
        "recent_changes_count": sum(1 for c in changes if c.get("at", "") >= week_ago),
        "recent_changes_window_days": 7,
        "last_change_at": last_change_at,
    }


def build_fallback_drift() -> dict:
    """How far the hardcoded FALLBACK_TEAM_ROSTERS has fallen behind live data,
    with a ready-to-paste replacement generated from the live roster."""
    env = get_dynamic_roster()
    if env["source"] == "fallback":
        return {"error": "no live data available — cannot measure drift",
                "status": get_roster_status()}
    payload = env["data"]
    users = _roster_cache.get("users") or _fetch_users()
    teams_diff = _fallback_team_diff(payload, users)
    per_team, total = _drift_summary(teams_diff)

    out_of_date = {
        tid: {"differences": per_team[tid], "fallback_count": d["old_count"],
              "live_count": d["new_count"], "missing_from_fallback": d["added"],
              "no_longer_live": d["removed"],
              "keywords_matching_nobody": d["unresolved_keywords"]}
        for tid, d in teams_diff.items() if per_team[tid]
    }
    order = _cfg["team_order"] or sorted(payload["TEAM_ROSTERS"])
    rec_rosters = {t: payload["TEAM_ROSTERS"][t] for t in order if t in payload["TEAM_ROSTERS"]}
    rec_members = {t: payload["TEAM_MEMBERS"][t] for t in order if t in payload["TEAM_MEMBERS"]}

    def as_python(name: str, d: dict) -> str:
        lines = [f"{name}: dict[str, list[str]] = {{"]
        lines += [f"    {k!r}: {v!r}," for k, v in d.items()]
        return "\n".join(lines + ["}"])

    return {
        "source": env["source"],
        "live_as_of": env["last_updated"],
        "total_differences": total,
        "threshold": FALLBACK_DRIFT_THRESHOLD,
        "significantly_behind": total > FALLBACK_DRIFT_THRESHOLD,
        "teams_out_of_date": out_of_date,
        "teams_up_to_date": sorted(t for t in teams_diff if not per_team[t]),
        "recommended": {"FALLBACK_TEAM_ROSTERS": rec_rosters,
                        "FALLBACK_TEAM_MEMBERS": rec_members},
        "recommended_python": as_python("FALLBACK_TEAM_ROSTERS", rec_rosters),
        "notice": ("The fallback is only served when Timesheets.com is down with no "
                   "warm cache, so drift is harmless day to day — but during an outage "
                   "it IS the roster. Refresh FALLBACK_TEAM_ROSTERS in backend/main.py "
                   "from `recommended_python` monthly, or whenever this reports "
                   "significantly_behind."),
    }
