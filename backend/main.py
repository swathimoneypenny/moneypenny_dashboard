import os
import sys
import csv
import io
import time
sys.path.insert(0, os.path.dirname(__file__))

from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq

load_dotenv()


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TIMESHEET_API_KEY   = os.getenv("TIMESHEET_API_KEY")
TIMESHEET_API_TOKEN = os.getenv("TIMESHEET_API_TOKEN")
ABS_SHEET_ID        = os.getenv("ABS_SHEET_ID")
groq_client         = Groq(api_key=os.getenv("GROQ_API_KEY"))

# ── Strict team mapping (Team Letter → Lead first name + EOD sheet) ─
# This is the authoritative source. Lead names are matched against
# timesheet users by FIRSTNAME (case-insensitive, lenient). Sheet ID + gid
# come from the URLs provided by the user.
TEAM_LETTER_MAP: dict[str, dict] = {
    "team_a": {"label": "Team A", "leadName": "Kokila",       "sheetId": "1ImF5ourEmcuszZaT7sQwd6XPSSov1CRAj-IWOl4tSHg", "gid": "1246554173"},
    "team_b": {"label": "Team B", "leadName": "Buelaangel",   "sheetId": None,                                            "gid": None},
    "team_c": {"label": "Team C", "leadName": "Grace",        "sheetId": "1YyC9iLWPP84KAmUPxO7FZG8a414QWud9V8Apq2QjtKg", "gid": "0"},
    "team_d": {"label": "Team D", "leadName": "Chandralekha", "sheetId": "1qUjeGSxxg8t7wDO_sy1H1q5XtoyPa7ey4_6XUNJcDeo", "gid": "73103774"},
    "team_e": {"label": "Team E", "leadName": "Shaalini",     "sheetId": "1L1ehxcPORi08LW_2725UI0Rtz17xqS780WG4erXLQf4", "gid": None},
    "team_f": {"label": "Team F", "leadName": "Inbamozhi",    "sheetId": "1KaYjE6vHZJBfrOUBBLZuGExKGOVWWELngDfzXDbv_a4", "gid": "1280455358"},
    "team_g": {"label": "Team G", "leadName": "Hema",         "sheetId": "1rjOjxuIHESYrqCmc0fQhtK7YSQsF_CsqlqbB0LPh5cQ", "gid": "132754161"},
    "team_h": {"label": "Team H", "leadName": "Deepali",      "sheetId": "1FPyae90xO8phccxB3DnQUWyF5Gz6qA9bGl4YY_awS94", "gid": "1490637527"},
    "team_i": {"label": "Team I", "leadName": "Radhika",      "sheetId": "18Ekx8uNL8r9gvKB4hwoOdv-yC05DvqS2a4hwlwltRBI", "gid": "641800524"},
    "team_j": {"label": "Team J", "leadName": "Logeshwari",   "sheetId": "19hygU7Txm5As_vPVI9xOuMRz7XXsyudxMAtGr3kHVqU", "gid": "132754161"},
    "team_k": {"label": "Team K", "leadName": "Karthika",     "sheetId": "1zb3sQ7Qgr3G8P3CoyFEbekzNmoB6WjELizXV0l0U7WQ", "gid": "0"},
    "team_l": {"label": "Team L", "leadName": "Nasreen",      "sheetId": "1XOh8DTk6K6EP2lm0BzylHS--cxiNUsSCB2AXXRVH4p4", "gid": "1374236313"},
    "team_m": {"label": "Team M", "leadName": "Pavithira",    "sheetId": "1aRDAD4rn6_Aezvf3MNNLTtE6di17Zd5JtUnHvGzMaaY", "gid": "422051761"},
    "team_n": {"label": "Team N", "leadName": "Vinodhini",    "sheetId": "1J4lTpCDnFaSyasFzK0sRF-4l6mboMu9zi_MCOs5oPDo", "gid": "476568108"},
    "team_t": {"label": "Team T", "leadName": "Pragathi",     "sheetId": "1C-62S_nZC-S6bMnyl8GYZFoQbYJ8U_qI2TcZmbnxp_g", "gid": "132754161"},
}

# Order in which teams appear on the Home page (matches the user's spec).
TEAM_ORDER = ["team_a", "team_b", "team_c", "team_d", "team_e", "team_f",
              "team_t", "team_g", "team_h", "team_i", "team_j", "team_k",
              "team_l", "team_m", "team_n"]


# ── Team rosters (staff-name keyword filter) ─────────────────────
# Manually configured per team. Each entry is a list of partial name keywords
# (case-insensitive substring match against the timesheet FULLNAME).
# If a team's roster is empty, all timesheet rows pass through ("include all").
TEAM_ROSTERS: dict[str, list[str]] = {
    "team_a": [],
    "team_b": ["Buelaangel", "Akshaya Devi", "Ivanjalin", "Varshini", "Yamini"],
    "team_c": [],
    "team_d": [],
    "team_e": [],
    "team_f": [],
    "team_g": ["Hema", "Deepali", "Holly", "Uma", "Jayashree", "Kokila"],
    "team_h": [],
    "team_i": [],
    "team_j": [],
    "team_k": [],
    "team_l": [],
    "team_m": ["Pavithira", "Logeshwari", "Swetha", "Hema N", "Indra"],
    "team_n": [],
    "team_t": [],
}


def staff_in_team(fullname: str, roster: list[str]) -> bool:
    """Bidirectional fuzzy match. Empty roster ⇒ include all."""
    if not roster:
        return True
    name_lower = (fullname or "").lower().strip()
    if not name_lower:
        return False
    name_parts = [p for p in name_lower.split() if len(p) > 2]
    for r in roster:
        r_lower = (r or "").lower().strip()
        if not r_lower:
            continue
        # Roster keyword anywhere in fullname
        if r_lower in name_lower:
            return True
        # Any fullname part appears inside the roster keyword (reverse)
        if any(p in r_lower for p in name_parts):
            return True
    return False

# ── In-memory cache ───────────────────────────────────────────────
_cache: dict = {}
CACHE_SECS = 300

# Team-specific cache (30 min TTL) so team dashboards reload instantly after warm-up
_team_cache: dict = {}
TEAM_CACHE_SECS = 1800


def cache_get(key: str):
    entry = _cache.get(key)
    if entry and (datetime.now() - entry["ts"]).total_seconds() < CACHE_SECS:
        return entry["data"]
    return None


def cache_set(key: str, data):
    _cache[key] = {"data": data, "ts": datetime.now()}


def team_cache_get(team_id: str, period: str):
    key = f"{team_id}_{period}"
    entry = _team_cache.get(key)
    if entry and (datetime.now() - entry["at"]).total_seconds() < TEAM_CACHE_SECS:
        return entry["data"]
    return None


def team_cache_set(team_id: str, period: str, data):
    _team_cache[f"{team_id}_{period}"] = {"data": data, "at": datetime.now()}


# ── EOD Sheet helpers ─────────────────────────────────────────────
def _safe_float(val: str) -> float:
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return 0.0


class EodSheetError(Exception):
    """Raised when an EOD sheet fetch fails. Carries a UI-friendly reason."""
    def __init__(self, reason: str, status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.status = status


def get_eod_data(sheet_id: str, tab: str | None = None, gid: str | None = None) -> list[dict]:
    if not sheet_id:
        return []
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv"
    if gid:
        url += f"&gid={gid}"
    elif tab:
        url += f"&sheet={requests.utils.quote(tab)}"
    resp = requests.get(url, timeout=15)
    if resp.status_code == 401 or resp.status_code == 403:
        raise EodSheetError(
            "EOD source not accessible. Share the sheet as 'Anyone with the link can view'.",
            resp.status_code,
        )
    if resp.status_code == 404:
        raise EodSheetError("EOD source not found (404). Verify the sheet URL.", 404)
    resp.raise_for_status()

    reader = csv.reader(io.StringIO(resp.text))
    rows = list(reader)
    result = []
    start = 1 if rows and not _safe_float(rows[0][0] if rows[0] else "") else 0
    for row in rows[start:]:
        while len(row) < 13:
            row.append("")
        date_raw = str(row[0]).strip()
        if not date_raw or date_raw.lower() in ("", "nan", "date"):
            continue
        committed  = _safe_float(row[1])
        booked     = _safe_float(row[2])
        eod_status = str(row[11]).strip() if len(row) > 11 else ""
        notes      = str(row[12]).strip() if len(row) > 12 else ""
        util_pct   = round(booked / committed * 100, 1) if committed > 0 else 0.0
        delays_val = _safe_float(row[13]) if len(row) > 13 else 0.0
        result.append({
            "date":      date_raw[:10],
            "committed": committed,
            "booked":    booked,
            "utilPct":   util_pct,
            "eodStatus": eod_status,
            "notes":     notes,
            "delays":    delays_val,
        })
    return result


def get_committed_from_eod(sheet_id: str, start: str, end: str, gid: str | None = None) -> float:
    """Sum committed hours from EOD rows whose date falls in [start, end] (YYYY-MM-DD)."""
    if not sheet_id:
        return 0.0
    try:
        rows = get_eod_data(sheet_id, gid=gid)
    except Exception:
        return 0.0
    total = 0.0
    for r in rows:
        d = str(r.get("date") or "").strip()[:10]
        if not d:
            continue
        if start <= d <= end:
            total += float(r.get("committed") or 0)
    return round(total, 2)


def get_eod_delays_by_org(sheet_id: str) -> dict:
    """Fetch the 'ABS - Delay qsn' tab and count delay rows per client (org)."""
    if not sheet_id:
        return {}
    try:
        tab = "ABS - Delay qsn"
        url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet={requests.utils.quote(tab)}"
        resp = requests.get(url, timeout=15)
        if resp.status_code != 200:
            return {}
        reader = csv.reader(io.StringIO(resp.text))
        rows = list(reader)
        counts: dict = {}
        for row in rows[1:]:
            if len(row) < 3:
                continue
            client = str(row[2]).strip()
            if not client or client.lower() in ("", "nan", "n/a", "client"):
                continue
            counts[client] = counts.get(client, 0) + 1
        return counts
    except Exception:
        return {}


# ── Timesheet helpers ─────────────────────────────────────────────
def ts_headers() -> dict:
    return {
        "apikey":              TIMESHEET_API_KEY,
        "x-ts-authorization": TIMESHEET_API_TOKEN,
    }


def fetch_timesheet(start_date: str, end_date: str):
    for attempt in range(2):
        try:
            users_resp = requests.get(
                "https://secure.timesheets.com/api/public/v1/users?maxrows=300",
                headers=ts_headers(),
                timeout=15,
            )
            if users_resp.status_code == 420:
                if attempt == 0:
                    print("[fetch_timesheet] rate limited, waiting 60s...")
                    time.sleep(60)
                    continue
                return None
            if users_resp.status_code != 200:
                print(f"[fetch_timesheet] users API status={users_resp.status_code} body={users_resp.text[:200]}")
                return None

            users = users_resp.json()["data"]["users"]["Data"]
            body = (
                f"StartDate={start_date}&EndDate={end_date}"
                "&AllAccountCodes=1&GroupType=None&ReportType=Detailed"
                "&AllCustomers=1&AllProjects=1&Signed=0,1&Approved=0,1"
                "&Billable=0,1&RecordStatus=0,1"
            )
            for u in users:
                body += f"&UserList={u['USERID']}"

            report_resp = requests.post(
                "https://secure.timesheets.com/api/public/v1/report/project/customizable",
                headers={**ts_headers(), "Content-Type": "application/x-www-form-urlencoded"},
                data=body,
                timeout=60,
            )
            if report_resp.status_code == 420:
                if attempt == 0:
                    print("[fetch_timesheet] report rate limited, waiting 60s...")
                    time.sleep(60)
                    continue
                return None
            if report_resp.status_code != 200:
                print(f"[fetch_timesheet] report status={report_resp.status_code} body={report_resp.text[:200]}")
                return None

            return report_resp.json()

        except Exception as e:
            print(f"[fetch_timesheet] error attempt {attempt}: {e}")
            if attempt == 0:
                time.sleep(5)
    return None


def date_range_for_period(period: str):
    today = datetime.now()
    if period == "today":
        s = today.strftime("%Y-%m-%d")
        return s, s, today.strftime("%b %d, %Y")
    if period == "weekly":
        start = today - timedelta(days=today.weekday())
        s = start.strftime("%Y-%m-%d")
        e = today.strftime("%Y-%m-%d")
        return s, e, f"{start.strftime('%b %d')} – {today.strftime('%b %d, %Y')}"
    start = today.replace(day=1)
    s = start.strftime("%Y-%m-%d")
    e = today.strftime("%Y-%m-%d")
    return s, e, today.strftime("%B %Y")


# Aliases used by the debug endpoint
def get_date_range(period: str):
    return date_range_for_period(period)


def parse_rows(data) -> list[dict]:
    rows = []
    if not data or not data.get("report") or not data["report"].get("ReportData"):
        return rows
    for group in data["report"]["ReportData"]:
        if not group.get("Records") or not group["Records"].get("Data"):
            continue
        for row in group["Records"]["Data"]:
            hours = float(row.get("HOURS", 0))
            if hours <= 0:
                continue
            rows.append({
                "userId":   str(row.get("USERID", "")),
                "name":     row.get("FULLNAME", "Unknown"),
                "hours":    hours,
                "billable": str(row.get("BILLABLE", "0")) == "1",
                "customer": row.get("CUSTOMERNAME", ""),
                "project":  row.get("PROJECTNAME", ""),
                "desc":     row.get("WORKDESCRIPTION", ""),
                "team":     row.get("DEPARTMENT", row.get("GROUPNAME", "")),
            })
    return rows


def iter_rows(data) -> list[dict]:
    return parse_rows(data)


# ── Team membership / department mapping ─────────────────────────
# Legacy hardcoded data — kept only for the chatbot context strings.
TEAM_MEMBERS: dict[str, list[str]] = {
    "team_m": ["pavithira", "bhuvaneswari", "reshma"],
}

TEAM_DEPT_MAP: dict[str, str] = {
    "team_a": "Team A", "team_b": "Team B", "team_c": "Team C",
    "team_d": "Team D", "team_e": "Team E", "team_f": "Team F",
    "team_g": "Team G", "team_h": "Team H", "team_i": "Team I",
    "team_j": "Team J", "team_k": "Team K", "team_l": "Team L",
    "team_n": "Team N", "team_t": "Team T",
}


# ── Dynamic team discovery from timesheet user hierarchy ─────────
# Each user has ADMINUSERID pointing at their manager. For each team letter
# (A..N, T) we look up the lead by first-name in the live user list, then take
# their direct reports as the team roster.
USERS_CACHE: dict = {"data": None, "at": None}
USERS_TTL_SECS = 1800  # 30 minutes — users change rarely

TEAMS_CACHE: dict = {"data": None, "at": None}
TEAMS_TTL_SECS = 600  # 10 minutes


def _fetch_users_raw():
    """Fetch /users with caching."""
    now = datetime.now()
    if USERS_CACHE["data"] is not None and USERS_CACHE["at"] \
            and (now - USERS_CACHE["at"]).total_seconds() < USERS_TTL_SECS:
        return USERS_CACHE["data"]
    headers = {
        "apikey":              TIMESHEET_API_KEY,
        "x-ts-authorization": TIMESHEET_API_TOKEN,
    }
    resp = requests.get(
        "https://secure.timesheets.com/api/public/v1/users?maxrows=300",
        headers=headers,
        timeout=20,
    )
    resp.raise_for_status()
    users = resp.json()["data"]["users"]["Data"]
    USERS_CACHE["data"] = users
    USERS_CACHE["at"]   = now
    return users


def _normalize_name(s: str) -> str:
    return (s or "").lower().replace(" ", "").replace("'", "")


def _find_lead(users: list[dict], lead_name: str) -> dict | None:
    """Find a user matching the given lead name. Strict-first matching:
       1) FIRSTNAME exact, 2) FIRSTNAME starts-with target,
       3) FULLNAME contains target. Never lets target be a prefix of FIRSTNAME
       (avoids 'Deepali' matching 'Deepa')."""
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


def discover_teams() -> list[dict]:
    """Resolve the hardcoded letter→lead map against live timesheet users.

    For each TEAM_LETTER_MAP entry, find the lead user and collect every user
    whose ADMINUSERID points to that lead. Returns teams in TEAM_ORDER.
    """
    now = datetime.now()
    if TEAMS_CACHE["data"] is not None and TEAMS_CACHE["at"] \
            and (now - TEAMS_CACHE["at"]).total_seconds() < TEAMS_TTL_SECS:
        return TEAMS_CACHE["data"]

    try:
        users = _fetch_users_raw()
    except Exception as e:
        print(f"[discover_teams] users fetch failed: {e}")
        return []

    teams: list[dict] = []
    for team_id in TEAM_ORDER:
        cfg = TEAM_LETTER_MAP[team_id]
        lead = _find_lead(users, cfg["leadName"])
        if not lead:
            # Lead not found in live users — include team with empty roster so UI
            # still shows the card; filtering will produce 0 rows (honest failure).
            print(f"[discover_teams] WARN lead '{cfg['leadName']}' not found for {team_id}")
            teams.append({
                "id":            team_id,
                "label":         cfg["label"],
                "leadName":      cfg["leadName"],
                "leadFullName":  cfg["leadName"],
                "leadUserId":    None,
                "memberUserIds": [],
                "memberNames":   [],
                "memberCount":   0,
                "sheetId":       cfg["sheetId"],
                "gid":           cfg["gid"],
                "missingLead":   True,
            })
            continue
        lead_id = str(lead["USERID"])
        lead_full = lead.get("FULLNAME", cfg["leadName"])
        members = [u for u in users if str(u.get("ADMINUSERID") or "") == lead_id]
        # Include the lead in member set so the lead's own hours count toward the team
        member_users = [lead] + members
        teams.append({
            "id":            team_id,
            "label":         cfg["label"],
            "leadName":      cfg["leadName"],
            "leadFullName":  lead_full,
            "leadUserId":    lead_id,
            "memberUserIds": [str(u["USERID"]) for u in member_users],
            "memberNames":   [u.get("FULLNAME", "") for u in member_users],
            "memberCount":   len(member_users),
            "sheetId":       cfg["sheetId"],
            "gid":           cfg["gid"],
            "missingLead":   False,
        })

    TEAMS_CACHE["data"] = teams
    TEAMS_CACHE["at"]   = now
    return teams


def _teams_index() -> dict[str, dict]:
    """team_id → team dict, cached."""
    return {t["id"]: t for t in discover_teams()}


def rows_for_team(rows: list, team_id: str) -> tuple[list, str, dict | None]:
    """Per-team filter. STRICT — never falls back to "all rows".

    Returns (matched_rows, status, team_meta).
    status:
      - "userid":  filtered strictly by discovered USERID roster (real teams)
      - "unknown_team": team_id wasn't found in discovered teams → returns []
    """
    teams = _teams_index()
    team = teams.get(team_id)
    if not team:
        return [], "unknown_team", None
    member_ids = set(team.get("memberUserIds", []))
    matched = [r for r in rows if r.get("userId") in member_ids]
    return matched, "userid", team


# ── Report builders ───────────────────────────────────────────────
def build_team_report(rows: list, period_label: str, eod_rows: list) -> dict:
    orgs: dict = {}
    for r in rows:
        org = r["customer"] or "Internal"
        if org not in orgs:
            orgs[org] = {"committed": 0.0, "billable": 0.0, "nonBillable": 0.0}
        orgs[org]["committed"]  += r["hours"]
        if r["billable"]:
            orgs[org]["billable"] += r["hours"]
        else:
            orgs[org]["nonBillable"] += r["hours"]

    org_list = [
        {
            "org":        k,
            "committed":  round(v["committed"],  2),
            "billable":   round(v["billable"],   2),
            "nonBillable":round(v["nonBillable"],2),
        }
        for k, v in orgs.items()
    ]

    total_committed = sum(o["committed"]   for o in org_list)
    total_billable  = sum(o["billable"]    for o in org_list)
    total_non       = sum(o["nonBillable"] for o in org_list)
    overall_eff     = round(total_billable / total_committed * 100, 1) if total_committed > 0 else 0

    return {
        "period": period_label,
        "summary": {
            "totalCommitted":    round(total_committed, 2),
            "totalBillable":     round(total_billable,  2),
            "totalNonBillable":  round(total_non,       2),
            "overallEfficiency": overall_eff,
        },
        "organizations": org_list,
        "trend": eod_rows[-10:] if eod_rows else [],
    }


def build_client_report(rows: list, client_name: str, period_label: str) -> dict:
    cn = client_name.lower()
    client_rows = [
        r for r in rows
        if cn in r["customer"].lower() or cn in r["desc"].lower()
    ]

    staff: dict = {}
    for r in client_rows:
        n = r["name"]
        if n not in staff:
            staff[n] = {"billable": 0.0, "nonBillable": 0.0, "committed": 0.0, "notes": []}
        staff[n]["committed"] += r["hours"]
        if r["billable"]:
            staff[n]["billable"] += r["hours"]
        else:
            staff[n]["nonBillable"] += r["hours"]
        # collect up to 5 unique work notes
        note = r.get("desc", "").strip()
        if note and note not in staff[n]["notes"] and len(staff[n]["notes"]) < 5:
            staff[n]["notes"].append(note)

    staff_list = [
        {
            "staff":       k,
            "committed":   round(v["committed"],   2),
            "billable":    round(v["billable"],    2),
            "nonBillable": round(v["nonBillable"], 2),
            "notes":       v["notes"],
        }
        for k, v in staff.items()
    ]

    total_committed = sum(s["committed"]   for s in staff_list)
    total_billable  = sum(s["billable"]    for s in staff_list)
    total_non       = sum(s["nonBillable"] for s in staff_list)
    overall_eff     = round(total_billable / total_committed * 100, 1) if total_committed > 0 else 0

    return {
        "period": period_label,
        "summary": {
            "totalCommitted":    round(total_committed, 2),
            "totalBillable":     round(total_billable,  2),
            "totalNonBillable":  round(total_non,       2),
            "overallEfficiency": overall_eff,
        },
        "staff": staff_list,
    }


# ── Endpoints ─────────────────────────────────────────────────────

@app.get("/api/teams")
def list_teams():
    """Return the configured teams in the canonical order for the Home page."""
    teams = discover_teams()
    out = []
    for t in teams:
        lead_count = 1 if t.get("leadUserId") else 0
        exec_count = max(0, t.get("memberCount", 0) - lead_count)
        out.append({
            "id":           t["id"],
            "label":        t["label"],
            "leadName":     t.get("leadName"),
            "leadFullName": t.get("leadFullName"),
            "memberCount":  t.get("memberCount", 0),
            "leadCount":    lead_count,
            "execCount":    exec_count,
            "hasSheet":     bool(t.get("sheetId")),
            "missingLead":  t.get("missingLead", False),
        })
    return {"teams": out, "count": len(out)}


@app.get("/api/active-clients")
async def active_clients():
    cached = cache_get("active_clients")
    if cached:
        return cached
    today = datetime.now()
    start = (today - timedelta(days=30)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")
    data  = fetch_timesheet(start, end)
    rows  = parse_rows(data)
    client_hours: dict = {}
    for r in rows:
        c = r["customer"]
        if not c or c.strip() in ("", "N/A"):
            continue
        client_hours[c] = client_hours.get(c, 0) + r["hours"]
    clients = [
        {"name": name, "totalHours": round(hours, 1)}
        for name, hours in sorted(client_hours.items(), key=lambda x: -x[1])
    ]
    result = {"clients": clients, "count": len(clients)}
    cache_set("active_clients", result)
    return result


def _team_response(team_id: str, period: str):
    """Build a complete team response. Filter by staff roster (name keywords).
    If no roster is configured, return needsRosterSetup=True without scanning."""
    cfg = TEAM_LETTER_MAP.get(team_id)
    if not cfg:
        return {"error": "Team not found", "teamId": team_id}

    roster    = TEAM_ROSTERS.get(team_id, [])
    sheet_id  = cfg.get("sheetId")
    sheet_gid = cfg.get("gid")
    start, end, label = date_range_for_period(period)

    # ── No roster: skip the expensive timesheet scan ──────────────
    if not roster:
        eod_rows: list = []
        eod_error: str | None = None
        eod_committed = 0.0
        if sheet_id:
            try:
                eod_rows = get_eod_data(sheet_id, gid=sheet_gid)
                eod_committed = get_committed_from_eod(sheet_id, start, end, gid=sheet_gid)
            except EodSheetError as e:
                eod_error = e.reason
            except Exception as e:
                eod_error = f"EOD fetch failed: {e}"

        print(f"[_team_response] team={team_id} period={period} needsRosterSetup=True")
        return {
            "team":             cfg.get("label", team_id),
            "teamId":           team_id,
            "teamLabel":        cfg.get("label", team_id),
            "lead":             cfg.get("leadName", ""),
            "leadName":         cfg.get("leadName", ""),
            "period":           label,
            "rosterCount":      0,
            "totalRows":        0,
            "matchedRows":      0,
            "needsRosterSetup": True,
            "staffFound":       [],
            "clients":          [],
            "organizations":    [],
            "summary": {
                "totalCommitted":    round(eod_committed, 2),
                "totalBillable":     0,
                "totalNonBillable":  0,
                "overallEfficiency": 0,
                "totalDelays":       sum(int(e.get("delays") or 0) for e in eod_rows),
            },
            "eod":         eod_rows,
            "eodError":    eod_error,
            "lastUpdated": datetime.now().strftime("%Y-%m-%d %H:%M IST"),
            "filter": {
                "teamId":      team_id,
                "label":       cfg.get("label"),
                "leadName":    cfg.get("leadName", ""),
                "rosterCount": 0,
                "memberCount": 0,
                "rowsIn":      0,
                "rowsAfter":   0,
                "hasSheet":    bool(sheet_id),
                "eodRows":     len(eod_rows),
                "eodError":    eod_error,
                "status":      "no_roster",
                "unfiltered":  True,
            },
        }

    # ── Roster configured: scan timesheet for that team's staff ───
    data = fetch_timesheet(start, end)
    fetch_failed = data is None
    rows = parse_rows(data)
    if fetch_failed:
        print(f"[_team_response] team={team_id} FETCH FAILED — returning fetchError=True (not cached)")

    orgs: dict = {}
    total_rows = 0
    matched_rows = 0
    staff_names_found: set = set()

    for row in rows:
        h = float(row.get("hours", 0))
        if h <= 0:
            continue
        total_rows += 1

        fullname = (row.get("name") or "").strip()
        if not staff_in_team(fullname, roster):
            continue

        matched_rows += 1
        staff_names_found.add(fullname)
        billable = bool(row.get("billable"))
        customer = (row.get("customer") or "").strip()
        if not customer or customer == "SNMP":
            customer = "Internal / Admin"

        r = orgs.setdefault(customer, {
            "billable":    0.0,
            "nonBillable": 0.0,
            "staff":       set(),
        })
        if billable:
            r["billable"] += h
        else:
            r["nonBillable"] += h
        r["staff"].add(fullname)

    clients_data = []
    for org_name, h in orgs.items():
        total = h["billable"] + h["nonBillable"]
        eff = round(h["billable"] / total * 100, 1) if total > 0 else 0
        if eff > 95:
            status = "OVER TARGET"
        elif eff >= 75:
            status = "ON TARGET"
        elif eff < 50:
            status = "CRITICAL"
        else:
            status = "BELOW TARGET"
        clients_data.append({
            "name":        org_name,
            "committed":   0,
            "billable":    round(h["billable"], 2),
            "nonBillable": round(h["nonBillable"], 2),
            "total":       round(total, 2),
            "efficiency":  eff,
            "gap":         0,
            "staffCount":  len(h["staff"]),
            "delays":      0,
            "status":      status,
        })
    clients_data.sort(key=lambda x: x["billable"], reverse=True)

    total_b  = round(sum(c["billable"]    for c in clients_data), 2)
    total_nb = round(sum(c["nonBillable"] for c in clients_data), 2)
    total    = round(total_b + total_nb, 2)

    eod_rows = []
    eod_error: str | None = None
    eod_committed = 0.0
    total_delays = 0
    if sheet_id:
        try:
            eod_rows = get_eod_data(sheet_id, gid=sheet_gid)
            eod_committed = get_committed_from_eod(sheet_id, start, end, gid=sheet_gid)
            total_delays = sum(int(e.get("delays") or 0) for e in eod_rows)
        except EodSheetError as e:
            eod_error = e.reason
        except Exception as e:
            eod_error = f"EOD fetch failed: {e}"
    else:
        eod_error = "EOD source not configured for this team."

    print(f"[_team_response] team={team_id} period={period} "
          f"rosterCount={len(roster)} totalRows={total_rows} matchedRows={matched_rows} "
          f"orgs={len(clients_data)} eodRows={len(eod_rows)}")

    return {
        "team":             cfg.get("label", team_id),
        "teamId":           team_id,
        "teamLabel":        cfg.get("label", team_id),
        "lead":             cfg.get("leadName", ""),
        "leadName":         cfg.get("leadName", ""),
        "period":           label,
        "rosterCount":      len(roster),
        "totalRows":        total_rows,
        "matchedRows":      matched_rows,
        "needsRosterSetup": False,
        "fetchError":       fetch_failed,
        "staffFound":       sorted(staff_names_found)[:20],
        "clients":          clients_data,
        "organizations":    [{**c, "org": c["name"]} for c in clients_data],
        "summary": {
            "totalCommitted":    round(eod_committed, 2),
            "totalBillable":     total_b,
            "totalNonBillable":  total_nb,
            "overallEfficiency": round(total_b / total * 100, 1) if total > 0 else 0,
            "totalDelays":       total_delays,
        },
        "eod":         eod_rows,
        "eodError":    eod_error,
        "lastUpdated": datetime.now().strftime("%Y-%m-%d %H:%M IST"),
        "filter": {
            "teamId":      team_id,
            "label":       cfg.get("label"),
            "leadName":    cfg.get("leadName", ""),
            "rosterCount": len(roster),
            "memberCount": len(roster),
            "rowsIn":      total_rows,
            "rowsAfter":   matched_rows,
            "hasSheet":    bool(sheet_id),
            "eodRows":     len(eod_rows),
            "eodError":    eod_error,
            "status":      "userid",
            "unfiltered":  False,
        },
    }


# ── Roster endpoints (declared before /{period} so FastAPI doesn't shadow them) ─
@app.get("/api/team/{team_id}/roster")
def get_roster(team_id: str):
    roster = TEAM_ROSTERS.get(team_id, [])
    return {
        "team_id":    team_id,
        "roster":     roster,
        "configured": len(roster) > 0,
    }


@app.post("/api/team/{team_id}/roster")
async def update_roster(team_id: str, request: dict):
    names = request.get("names", [])
    TEAM_ROSTERS[team_id] = names
    for p in ("today", "weekly", "monthly"):
        _team_cache.pop(f"{team_id}_{p}", None)
    return {"team_id": team_id, "roster": names, "updated": True}


@app.get("/api/team/{team_id}/detect-roster")
def detect_roster(team_id: str):
    """Return every staff member with timesheet activity in the last 30 days,
    so an admin can pick names to populate TEAM_ROSTERS for a team."""
    today = datetime.now()
    start = (today - timedelta(days=30)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")
    data  = fetch_timesheet(start, end)
    rows  = parse_rows(data)

    staff_hours: dict = {}
    for row in rows:
        h = float(row.get("hours", 0))
        if h <= 0:
            continue
        name = (row.get("name") or "").strip()
        if name:
            staff_hours[name] = round(staff_hours.get(name, 0) + h, 2)

    return {
        "team_id":       team_id,
        "currentRoster": TEAM_ROSTERS.get(team_id, []),
        "allStaff":      sorted(staff_hours.items(), key=lambda x: x[1], reverse=True),
        "totalStaff":    len(staff_hours),
        "howToFix":      "Add staff first names to TEAM_ROSTERS[team_id] in main.py",
    }


@app.post("/api/team/{team_id}/set-roster")
async def set_roster(team_id: str, request: dict):
    names = request.get("names", [])
    TEAM_ROSTERS[team_id] = names
    for p in ("today", "weekly", "monthly"):
        _team_cache.pop(f"{team_id}_{p}", None)
    return {"team_id": team_id, "roster": names, "message": "Roster updated, cache cleared"}


@app.get("/api/team/{team_id}/debug")
def debug_team(team_id: str):
    cfg = TEAM_LETTER_MAP.get(team_id)
    start, end, label = get_date_range("monthly")
    data = fetch_timesheet(start, end)
    rows = parse_rows(data)

    roster = TEAM_ROSTERS.get(team_id, [])
    team_rows = [r for r in rows if staff_in_team(r.get("name", ""), roster)]
    team_customers: dict = {}
    for row in team_rows:
        c = (row.get("customer") or "").strip()
        h = float(row.get("hours", 0))
        if c and h > 0:
            team_customers[c] = team_customers.get(c, 0) + h

    return {
        "team":             team_id,
        "period":           label,
        "label":            (cfg or {}).get("label"),
        "leadName":         (cfg or {}).get("leadName"),
        "rosterCount":      len(roster),
        "roster":           roster,
        "totalRows":        len(rows),
        "teamRows":         len(team_rows),
        "sheetId":          (cfg or {}).get("sheetId"),
        "sheetGid":         (cfg or {}).get("gid"),
        "topTeamCustomers": sorted(team_customers.items(), key=lambda x: x[1], reverse=True)[:10],
    }


@app.get("/api/team/{team_id}/{period}")
def get_team_data(team_id: str, period: str):
    if period not in ("today", "weekly", "monthly"):
        return {"error": "Invalid period. Use today | weekly | monthly."}

    cache_key = f"{team_id}_{period}"
    now = datetime.now()
    entry = _team_cache.get(cache_key)
    if entry and (now - entry["at"]).total_seconds() < TEAM_CACHE_SECS:
        cached = dict(entry["data"])
        cached["fromCache"] = True
        cached["cacheAge"]  = int((now - entry["at"]).total_seconds())
        return cached

    result = _team_response(team_id, period)
    result["fromCache"] = False
    result["cacheAge"]  = 0
    # Don't poison the cache with failed upstream fetches — let the next request retry.
    if not result.get("fetchError"):
        _team_cache[cache_key] = {"data": result, "at": now}
    return result


@app.get("/api/client/{client_name}/today")
async def client_today(client_name: str):
    return await _client_data(client_name, "today")


@app.get("/api/client/{client_name}/weekly")
async def client_weekly(client_name: str):
    return await _client_data(client_name, "weekly")


@app.get("/api/client/{client_name}/monthly")
async def client_monthly(client_name: str):
    return await _client_data(client_name, "monthly")


@app.get("/api/client/{client_name}/trend")
async def client_trend(client_name: str):
    cache_key = f"trend:{client_name}"
    cached = cache_get(cache_key)
    if cached:
        return cached
    today = datetime.now()
    trend = []
    for i in range(5, -1, -1):
        month_start = (today.replace(day=1) - timedelta(days=i * 28)).replace(day=1)
        next_month  = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1)
        month_end   = next_month - timedelta(days=1)
        if month_end > today:
            month_end = today
        s = month_start.strftime("%Y-%m-%d")
        e = month_end.strftime("%Y-%m-%d")
        data = fetch_timesheet(s, e)
        rows = parse_rows(data)
        cn   = client_name.lower()
        client_rows = [r for r in rows if cn in r["customer"].lower() or cn in r["desc"].lower()]
        total = sum(r["hours"] for r in client_rows if r["billable"])
        trend.append({"month": month_start.strftime("%b %Y"), "hours": round(total, 1)})
    result = {"trend": trend}
    cache_set(cache_key, result)
    return result


async def _client_data(client_name: str, period: str):
    cache_key = f"client:{client_name}:{period}"
    cached = cache_get(cache_key)
    if cached:
        return cached
    start, end, label = date_range_for_period(period)
    data   = fetch_timesheet(start, end)
    rows   = parse_rows(data)
    result = build_client_report(rows, client_name, label)
    cache_set(cache_key, result)
    return result


@app.get("/api/clear-cache")
@app.post("/api/clear-cache")
async def clear_cache():
    _cache.clear()
    _team_cache.clear()
    return {"ok": True, "status": "all caches cleared", "time": datetime.now().isoformat()}


@app.get("/api/clear-cache")
def clear_cache_get():
    _cache.clear()
    _team_cache.clear()
    return {"status": "all caches cleared"}


# ── EOD Sheet endpoints ───────────────────────────────────────────

@app.get("/api/eod/{team_id}/verify")
def verify_eod(team_id: str):
    team = _teams_index().get(team_id)
    if not team or not team.get("sheetId"):
        return {"status": "error", "message": f"No sheet configured for {team_id}"}
    try:
        rows = get_eod_data(team["sheetId"], gid=team.get("gid"))
        return {
            "status":     "connected",
            "sheetId":    team["sheetId"],
            "gid":        team.get("gid"),
            "rowCount":   len(rows),
            "latestDate": rows[-1]["date"] if rows else None,
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/eod/{team_id}/data")
def eod_data(team_id: str):
    team = _teams_index().get(team_id)
    if not team or not team.get("sheetId"):
        return {"rows": [], "error": "No sheet configured"}
    cache_key = f"eod:{team_id}"
    cached = cache_get(cache_key)
    if cached:
        return cached
    try:
        rows   = get_eod_data(team["sheetId"], gid=team.get("gid"))
        result = {"rows": rows[-30:], "total": len(rows)}
        cache_set(cache_key, result)
        return result
    except Exception as e:
        return {"rows": [], "error": str(e)}


# ── AI Chat ───────────────────────────────────────────────────────

@app.post("/api/chat")
async def chat(request: dict):
    messages = request.get("messages", [])
    context  = request.get("context", "")

    system_prompt = f"""You are MoneyPenny AI analyzing real timesheet data.

REAL DATA RIGHT NOW:
{context}

Answer questions directly using ONLY this data.
- If asked "why does X have low hours" → look at their numbers and notes
- If notes say what they worked on → mention it specifically
- Give specific numbers, not generic advice
- Format: 1-2 sentences with the actual numbers, then brief reason
- Never say "I don't have information" — everything is in the data above
- Keep response under 100 words, bullet points if listing multiple things

Status thresholds: BELOW TARGET <75% | ON TARGET 75-95% | OVER TARGET 95-120% | CRITICAL >120%"""

    response = groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "system", "content": system_prompt}, *messages],
        max_tokens=150,
        temperature=0.3,
    )
    return {"reply": response.choices[0].message.content}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
