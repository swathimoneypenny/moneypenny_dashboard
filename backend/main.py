import os
import sys
import csv
import io
import time
import asyncio
sys.path.insert(0, os.path.dirname(__file__))

from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq

load_dotenv()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Schedule warmup but don't block startup
    asyncio.create_task(_run_warmup_background())
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_cache_control(request: Request, call_next):
    response: Response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/team/") or path.startswith("/api/client/"):
        response.headers["Cache-Control"] = "private, max-age=60"
    return response

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
    "team_m": ["Pavithira", "Bhuvaneshwari", "Reshma"],
    "team_n": [],
    "team_t": [],
}


# ── Admin-hierarchy → team map ────────────────────────────────────
# Derived from /api/debug/admin-groups. Maps team_id → ADMINUSERID of the lead.
# This is the *source of truth*: any timesheet user whose ADMINUSERID matches one
# of these values, OR who IS one of these admins, belongs to that team.
TEAM_ADMIN_MAP: dict[str, str] = {
    "team_a": "372147",  # Kokila Ramachandran    (8 members)
    "team_b": "376614",  # Buelaangel T           (4 members)
    "team_c": "382697",  # Grace God's            (4 members)
    "team_d": "372151",  # Chandralekha Vijay Anand (7 members)
    "team_e": "375803",  # Shaalini Selvam        (1 member)
    "team_f": "372158",  # Inbamozhi Nithyanandham (7 members)
    "team_g": "372164",  # Hema Narashiman        (3 members)
    "team_h": "372150",  # Deepali Vimalchand Jain (11 members)
    "team_i": "372171",  # Radhika Sasikumar      (6 members)
    "team_j": "372159",  # Logeshwari Balaji      (6 members)
    "team_k": "372190",  # Karthika Rajasekaran   (9 members)
    "team_l": "372170",  # Nasreen Fayashussain   (6 members)
    "team_t": "372148",  # Pragathi Selvaraj      (13 members)
    # team_m (Pavithira) and team_n (Vinodhini) have no direct reports per ADMINUSERID;
    # they fall through to TEAM_ROSTERS substring matching.
}


# Cached {userid → team_label} lookup. Rebuilt whenever USERS_CACHE refreshes.
_USERID_TEAM_MAP_CACHE: dict = {"map": {}, "users_at": None}


def _build_userid_to_team_map(users: list) -> dict[str, str]:
    """For every user, derive their team label via:
      1. Their USERID matches an admin in TEAM_ADMIN_MAP → they are that team's lead.
      2. Their ADMINUSERID matches an admin in TEAM_ADMIN_MAP → they are a member.
    Returns {userid: team_label} where team_label is the value from TEAM_LETTER_MAP."""
    admin_to_team_id = {admin_id: tid for tid, admin_id in TEAM_ADMIN_MAP.items()}
    out: dict[str, str] = {}
    for u in users:
        uid = str(u.get("USERID", ""))
        admin_id = str(u.get("ADMINUSERID") or "").strip()
        team_id = admin_to_team_id.get(admin_id)
        if team_id:
            out[uid] = TEAM_LETTER_MAP[team_id]["label"]
    # The lead themselves belongs to their own team.
    for team_id, admin_id in TEAM_ADMIN_MAP.items():
        out[admin_id] = TEAM_LETTER_MAP[team_id]["label"]
    return out


def get_userid_to_team_map() -> dict[str, str]:
    """Cached lookup keyed by USERS_CACHE timestamp — rebuilds only on refresh."""
    cache_marker = USERS_CACHE.get("at")
    if _USERID_TEAM_MAP_CACHE.get("users_at") != cache_marker:
        users = USERS_CACHE.get("data") or []
        if not users:
            return _USERID_TEAM_MAP_CACHE.get("map") or {}
        _USERID_TEAM_MAP_CACHE["map"]      = _build_userid_to_team_map(users)
        _USERID_TEAM_MAP_CACHE["users_at"] = cache_marker
        print(f"[admin-map] rebuilt userid→team lookup: {len(_USERID_TEAM_MAP_CACHE['map'])} entries")
    return _USERID_TEAM_MAP_CACHE["map"]


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

# Shared parsed-rows cache keyed by (start_date, end_date).
# Every team and client endpoint hitting the same period reuses this — one upstream call serves them all.
_rows_cache: dict = {}
ROWS_CACHE_SECS = 1800  # 30 min — matches _team_cache TTL

# Per-key in-flight events to coalesce concurrent fetches for the same (start, end).
import threading as _threading
_rows_inflight: dict = {}
_rows_inflight_lock = _threading.Lock()


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
        committed_val = _safe_float(row[1])
        booked_val    = _safe_float(row[2])
        eod_status    = str(row[11]).strip() if len(row) > 11 else ""
        eod_notes     = str(row[12]).strip() if len(row) > 12 else ""
        util_pct      = round(booked_val / committed_val * 100, 1) if committed_val > 0 else 0.0

        note_delays = (
            len([x for x in eod_notes.split("\n") if x.strip()])
            if eod_notes not in ("", "nan") else 0
        )
        if note_delays == 0 and committed_val > 0 and booked_val < committed_val * 0.75:
            delays = 1
        else:
            delays = note_delays

        result.append({
            "date":      date_raw[:10],
            "committed": committed_val,
            "booked":    booked_val,
            "utilPct":   util_pct,
            "eodStatus": eod_status,
            "notes":     eod_notes,
            "delays":    delays,
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


def _get_users_cached():
    """Return cached users list; fetch once per USERS_TTL_SECS."""
    now = datetime.now()
    if USERS_CACHE["data"] is not None and USERS_CACHE["at"] \
            and (now - USERS_CACHE["at"]).total_seconds() < USERS_TTL_SECS:
        return USERS_CACHE["data"]
    t0 = time.perf_counter()
    for attempt in range(2):
        try:
            resp = requests.get(
                "https://secure.timesheets.com/api/public/v1/users?maxrows=300",
                headers=ts_headers(),
                timeout=15,
            )
            if resp.status_code == 420:
                if attempt == 0:
                    print("[fetch_timesheet] users rate limited, waiting 60s...")
                    time.sleep(60)
                    continue
                return None
            if resp.status_code != 200:
                print(f"[fetch_timesheet] users API status={resp.status_code} body={resp.text[:200]}")
                return None
            users = resp.json()["data"]["users"]["Data"]
            USERS_CACHE["data"] = users
            USERS_CACHE["at"]   = now
            print(f"[PERF] users fetch {time.perf_counter()-t0:.2f}s (cached for 1h)")
            return users
        except Exception as e:
            print(f"[fetch_timesheet] users error attempt {attempt}: {e}")
            if attempt == 0:
                time.sleep(5)
    return None


def fetch_timesheet(start_date: str, end_date: str):
    """POST the report endpoint for a date range. Users list comes from cache."""
    users = _get_users_cached()
    if users is None:
        return None

    body = (
        f"StartDate={start_date}&EndDate={end_date}"
        "&AllAccountCodes=1&GroupType=None&ReportType=Detailed"
        "&AllCustomers=1&AllProjects=1&Signed=0,1&Approved=0,1"
        "&Billable=0,1&RecordStatus=0,1"
    )
    for u in users:
        body += f"&UserList={u['USERID']}"

    t0 = time.perf_counter()
    for attempt in range(2):
        try:
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
            print(f"[PERF] report fetch {time.perf_counter()-t0:.2f}s range={start_date}..{end_date}")
            return report_resp.json()
        except Exception as e:
            print(f"[fetch_timesheet] report error attempt {attempt}: {e}")
            if attempt == 0:
                time.sleep(5)
    return None


def get_cached_rows(start: str, end: str) -> list[dict]:
    """Shared parsed-rows cache. All team + client endpoints route through here.
    Coalesces concurrent fetches for the same key so the upstream sees at most
    one /report POST per (start, end) per TTL window."""
    key = f"{start}_{end}"
    now = datetime.now()

    entry = _rows_cache.get(key)
    if entry and (now - entry["at"]).total_seconds() < ROWS_CACHE_SECS:
        age = int((now - entry["at"]).total_seconds())
        print(f"[rows_cache] HIT  {key} age={age}s rows={len(entry['rows'])}")
        return entry["rows"]

    # Request coalescing — only one upstream POST per key at a time.
    with _rows_inflight_lock:
        ev = _rows_inflight.get(key)
        if ev is None:
            ev = _threading.Event()
            _rows_inflight[key] = ev
            do_fetch = True
        else:
            do_fetch = False

    if not do_fetch:
        print(f"[rows_cache] COALESCED {key} — waiting on in-flight fetch")
        ev.wait(timeout=180)
        entry = _rows_cache.get(key)
        if entry:
            print(f"[rows_cache] COALESCED resolved {key} rows={len(entry['rows'])}")
            return entry["rows"]
        print(f"[rows_cache] COALESCED resolved {key} but cache still empty")
        return []

    print(f"[rows_cache] MISS {key} — fetching upstream")
    try:
        t0 = time.perf_counter()
        data = fetch_timesheet(start, end)
        rows = parse_rows(data)
        print(f"[PERF] parse_rows {time.perf_counter()-t0:.2f}s rows={len(rows)} range={start}..{end}")
        if data is not None:  # don't cache outright failures
            _rows_cache[key] = {"rows": rows, "at": datetime.now()}
        return rows
    finally:
        with _rows_inflight_lock:
            _rows_inflight.pop(key, None)
        ev.set()


async def get_cached_rows_async(start: str, end: str) -> list[dict]:
    return await asyncio.to_thread(get_cached_rows, start, end)


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
    # One lookup per parse, not per row. Resolves USERID → team label via admin chain.
    uid_to_team = get_userid_to_team_map()
    for group in data["report"]["ReportData"]:
        if not group.get("Records") or not group["Records"].get("Data"):
            continue
        for row in group["Records"]["Data"]:
            hours = float(row.get("HOURS", 0))
            if hours <= 0:
                continue
            userid = str(row.get("USERID", ""))
            date_raw = (
                row.get("WORKDATE")
                or row.get("DATE")
                or row.get("TIMESHEETDATE")
                or row.get("DATESHORT")
                or ""
            )
            # Admin-hierarchy takes precedence; legacy DEPARTMENT/GROUPNAME as fallback.
            team = (
                uid_to_team.get(userid)
                or row.get("DEPARTMENT")
                or row.get("GROUPNAME")
                or ""
            )
            rows.append({
                "userId":   userid,
                "name":     row.get("FULLNAME", "Unknown"),
                "hours":    hours,
                "billable": str(row.get("BILLABLE", "0")) == "1",
                "customer": row.get("CUSTOMERNAME", ""),
                "project":  row.get("PROJECTNAME", ""),
                "desc":     row.get("WORKDESCRIPTION", ""),
                "team":     team,
                "date":     str(date_raw)[:10],
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
USERS_TTL_SECS = 3600  # 1 hour — users change rarely

TEAMS_CACHE: dict = {"data": None, "at": None}
TEAMS_TTL_SECS = 600  # 10 minutes


def _fetch_users_raw():
    """Cached /users fetch — uses the shared USERS_CACHE."""
    users = _get_users_cached()
    if users is None:
        raise RuntimeError("users fetch failed")
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
        # collect up to 3 unique work notes, capped at 80 chars each
        note = r.get("desc", "").strip()
        if note and len(staff[n]["notes"]) < 3:
            trimmed = note[:80]
            if trimmed not in staff[n]["notes"]:
                staff[n]["notes"].append(trimmed)

    staff_list = [
        {
            "staff":       k,
            "committed":   round(v["committed"],   1),
            "billable":    round(v["billable"],    1),
            "nonBillable": round(v["nonBillable"], 1),
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
            "totalCommitted":    round(total_committed, 1),
            "totalBillable":     round(total_billable,  1),
            "totalNonBillable":  round(total_non,       1),
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
    rows  = await asyncio.to_thread(get_cached_rows, start, end)
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


async def _team_response(team_id: str, period: str):
    """Build a complete team response. Filter by staff roster (name keywords).
    If no roster is configured, return needsRosterSetup=True without scanning.
    EOD sheet + timesheet rows are fetched in parallel."""
    t_total = time.perf_counter()
    cfg = TEAM_LETTER_MAP.get(team_id)
    if not cfg:
        return {"error": "Team not found", "teamId": team_id}

    roster    = TEAM_ROSTERS.get(team_id, [])
    admin_id  = TEAM_ADMIN_MAP.get(team_id)
    sheet_id  = cfg.get("sheetId")
    sheet_gid = cfg.get("gid")
    start, end, label = date_range_for_period(period)
    team_label = cfg.get("label", team_id)
    # A team is "configured" if it has either a manual roster OR an admin-hierarchy entry.
    is_configured = bool(roster) or bool(admin_id)

    async def _eod_task():
        eod_rows: list = []
        eod_error: str | None = None
        eod_committed = 0.0
        if sheet_id:
            try:
                eod_rows = await asyncio.to_thread(get_eod_data, sheet_id, None, sheet_gid)
                eod_committed = await asyncio.to_thread(get_committed_from_eod, sheet_id, start, end, sheet_gid)
            except EodSheetError as e:
                eod_error = e.reason
            except Exception as e:
                eod_error = f"EOD fetch failed: {e}"
        else:
            eod_error = "EOD source not configured for this team."
        return eod_rows, eod_error, eod_committed

    # ── Not configured at all: skip the timesheet scan, only fetch EOD ────────
    if not is_configured:
        eod_rows, eod_error, eod_committed = await _eod_task()

        print(f"[_team_response] team={team_id} period={period} needsRosterSetup=True ({time.perf_counter()-t_total:.2f}s)")
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
            "unconfigured":     True,
            "message":          "Team Roster Not Configured",
            "detectUrl":        f"/api/team/{team_id}/detect-roster",
            "staffFound":       [],
            "clients":          [],
            "organizations":    [],
            "summary": {
                "totalCommitted":    round(eod_committed, 1),
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

    # ── Roster configured: fetch rows AND EOD in parallel ─────────
    rows_task = asyncio.create_task(get_cached_rows_async(start, end))
    eod_task  = asyncio.create_task(_eod_task())
    rows, (eod_rows, eod_error, eod_committed) = await asyncio.gather(rows_task, eod_task)
    fetch_failed = not rows and len(rows) == 0
    # Distinguish a real empty period from an upstream failure: only flag failure
    # if the rows cache is also empty (i.e. the latest fetch returned None).
    cache_entry = _rows_cache.get(f"{start}_{end}")
    fetch_failed = cache_entry is None
    if fetch_failed:
        print(f"[_team_response] team={team_id} FETCH FAILED — returning fetchError=True (not cached)")

    orgs: dict = {}
    total_rows = 0
    matched_rows = 0
    staff_names_found: set = set()

    # Match priority: manual roster (substring) → admin hierarchy (row['team'] equality).
    def _row_matches(row) -> bool:
        if roster:
            return staff_in_team((row.get("name") or "").strip(), roster)
        return (row.get("team") or "").strip().lower() == team_label.strip().lower()

    for row in rows:
        h = float(row.get("hours", 0))
        if h <= 0:
            continue
        total_rows += 1

        fullname = (row.get("name") or "").strip()
        if not _row_matches(row):
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
            "billable":    round(h["billable"], 1),
            "nonBillable": round(h["nonBillable"], 1),
            "total":       round(total, 1),
            "efficiency":  eff,
            "gap":         0,
            "staffCount":  len(h["staff"]),
            "delays":      0,
            "status":      status,
        })
    # Strip internal / placeholder / zero-hour client rows
    EXCLUDE_CLIENTS = {
        "internal / admin", "choose customer",
        "breaks for teams", "zzz", "",
    }
    clients_data = [
        c for c in clients_data
        if not any(exc and exc in c["name"].lower() for exc in EXCLUDE_CLIENTS)
        and c["total"] > 0
    ]
    clients_data.sort(key=lambda x: x["billable"], reverse=True)

    print(f"[DEBUG] team={team_id} roster={roster} staffFound={sorted(staff_names_found)[:10]}")

    total_b  = round(sum(c["billable"]    for c in clients_data), 1)
    total_nb = round(sum(c["nonBillable"] for c in clients_data), 1)
    total    = round(total_b + total_nb, 1)

    # EOD values came from the parallel asyncio.gather above; just count delays.
    total_delays = sum(int(e.get("delays") or 0) for e in eod_rows)

    # ── Monthly trend from timesheet rows (team-matched) ──────────
    # Always populate this so Chart 1 has data even when no EOD sheet is configured.
    monthly_buckets: dict = {}
    for row in rows:
        if not _row_matches(row):
            continue
        d = (row.get("date") or "")[:10]
        if len(d) < 7:
            continue
        # date strings are mostly YYYY-MM-DD; some upstream returns M/D/YYYY
        if "/" in d:
            parts = d.split("/")
            if len(parts) >= 3:
                yr = parts[2] if len(parts[2]) == 4 else "20" + parts[2][-2:]
                mo = parts[0].zfill(2)
                key = f"{yr}-{mo}"
            else:
                continue
        else:
            key = d[:7]
        h = float(row.get("hours", 0) or 0)
        billable = bool(row.get("billable"))
        b = monthly_buckets.setdefault(key, {"committed": 0.0, "utilized": 0.0})
        b["committed"] += h
        if billable:
            b["utilized"] += h
    monthly_trend = [
        {
            "monthKey":  k,
            "committed": round(v["committed"], 1),
            "utilized":  round(v["utilized"], 1),
        }
        for k, v in sorted(monthly_buckets.items())
    ]

    print(f"[_team_response] team={team_id} period={period} "
          f"rosterCount={len(roster)} totalRows={total_rows} matchedRows={matched_rows} "
          f"orgs={len(clients_data)} eodRows={len(eod_rows)} months={len(monthly_trend)}")

    return {
        "team":             cfg.get("label", team_id),
        "teamId":           team_id,
        "teamLabel":        cfg.get("label", team_id),
        "lead":             cfg.get("leadName", ""),
        "leadName":         cfg.get("leadName", ""),
        "period":           label,
        "rosterCount":      len(roster) if roster else len(staff_names_found),
        "totalRows":        total_rows,
        "matchedRows":      matched_rows,
        "needsRosterSetup": False,
        "fetchError":       fetch_failed,
        "staffFound":       sorted(staff_names_found)[:20],
        "clients":          clients_data,
        "organizations":    [{**c, "org": c["name"]} for c in clients_data],
        "summary": {
            "totalCommitted":    round(eod_committed, 1),
            "totalBillable":     total_b,
            "totalNonBillable":  total_nb,
            "overallEfficiency": round(total_b / total * 100, 1) if total > 0 else 0,
            "totalDelays":       total_delays,
        },
        "monthlyTrend":       monthly_trend,
        "monthlyTrendSource": "timesheet",
        "matchSource":        "roster" if roster else "admin_hierarchy",
        "adminUserId":        admin_id,
        "eod":         eod_rows,
        "eodError":    eod_error,
        "hasEodSheet": bool(sheet_id),
        "lastUpdated": datetime.now().strftime("%Y-%m-%d %H:%M IST"),
        "filter": {
            "teamId":      team_id,
            "label":       cfg.get("label"),
            "leadName":    cfg.get("leadName", ""),
            "rosterCount": len(roster) if roster else len(staff_names_found),
            "memberCount": len(staff_names_found),
            "rowsIn":      total_rows,
            "rowsAfter":   matched_rows,
            "hasSheet":    bool(sheet_id),
            "eodRows":     len(eod_rows),
            "eodError":    eod_error,
            "status":      "userid",
            "matchSource": "roster" if roster else "admin_hierarchy",
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
    """Group last-30-days timesheet staff by their DEPARTMENT/GROUPNAME.
    Returns a best_match for the requested team plus every other department so
    the admin can pick manually when auto-match is unreliable."""
    today = datetime.now()
    start = (today - timedelta(days=30)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")
    rows  = get_cached_rows(start, end)

    # name -> {hours, departments: set}
    staff: dict = {}
    # department -> {name -> hours}
    by_dept: dict = {}

    for row in rows:
        h = float(row.get("hours", 0))
        if h <= 0:
            continue
        name = (row.get("name") or "").strip()
        if not name:
            continue
        dept = (row.get("team") or "").strip()
        entry = staff.setdefault(name, {"hours": 0.0, "departments": set()})
        entry["hours"] += h
        if dept:
            entry["departments"].add(dept)
            d = by_dept.setdefault(dept, {})
            d[name] = d.get(name, 0.0) + h

    def _dept_members(dept_staff: dict) -> list[dict]:
        return [
            {"name": n, "hours": round(h, 1)}
            for n, h in sorted(dept_staff.items(), key=lambda kv: -kv[1])
        ]

    all_departments = [
        {
            "department":   dept,
            "member_count": len(members),
            "total_hours":  round(sum(members.values()), 1),
            "members":      _dept_members(members),
        }
        for dept, members in sorted(by_dept.items(), key=lambda kv: -sum(kv[1].values()))
    ]

    expected = (TEAM_DEPT_MAP.get(team_id) or "").strip().lower()
    letter   = team_id.replace("team_", "").lower()  # e.g. "a"

    best_dept = None
    confidence = "low"
    # 1. exact match (case-insensitive)
    if expected:
        for d in all_departments:
            if d["department"].strip().lower() == expected:
                best_dept = d
                confidence = "high"
                break
    # 2. medium: contains "team <letter>" / starts with letter token
    if best_dept is None and letter:
        contains = f"team {letter}"
        for d in all_departments:
            dl = d["department"].strip().lower()
            if dl == letter or contains in dl or dl.startswith(letter + " ") or dl.endswith(" " + letter):
                best_dept = d
                confidence = "medium"
                break

    best_match = {
        "department": best_dept["department"] if best_dept else "",
        "confidence": confidence,
        "members":    best_dept["members"] if best_dept else [],
    }

    unassigned = [
        {"name": n, "hours": round(s["hours"], 1)}
        for n, s in sorted(staff.items(), key=lambda kv: -kv[1]["hours"])
        if not s["departments"]
    ]

    return {
        "team_id":         team_id,
        "currentRoster":   TEAM_ROSTERS.get(team_id, []),
        "best_match":      best_match,
        "all_departments": all_departments,
        "unassigned":      unassigned,
        "totalStaff":      len(staff),
        "howToFix":        "Copy names into TEAM_ROSTERS[team_id] in backend/main.py, then restart or POST /api/clear-cache.",
    }


async def _run_warmup_background():
    """Lightweight startup warmup: load users + monthly rows + all EOD sheets in parallel."""
    await asyncio.sleep(2)  # let server bind first
    print("[warmup] starting…")
    t0 = time.perf_counter()
    try:
        start, end, _ = date_range_for_period("monthly")
        rows_task = asyncio.to_thread(get_cached_rows, start, end)
        eod_tasks = []
        for team_id, cfg in TEAM_LETTER_MAP.items():
            sid = cfg.get("sheetId")
            gid = cfg.get("gid")
            if sid:
                eod_tasks.append(asyncio.to_thread(get_eod_data, sid, None, gid))
        await asyncio.gather(rows_task, *eod_tasks, return_exceptions=True)
        print(f"[warmup] done in {time.perf_counter()-t0:.2f}s")
    except Exception as e:
        print(f"[warmup] failed: {e}")


@app.post("/api/warmup")
async def warmup_endpoint():
    """Trigger a synchronous warmup of the rows cache + all EOD sheets."""
    t0 = time.perf_counter()
    start, end, _ = date_range_for_period("monthly")
    rows_task = asyncio.to_thread(get_cached_rows, start, end)
    eod_tasks = []
    for team_id, cfg in TEAM_LETTER_MAP.items():
        sid = cfg.get("sheetId")
        gid = cfg.get("gid")
        if sid:
            eod_tasks.append(asyncio.to_thread(get_eod_data, sid, None, gid))
    results = await asyncio.gather(rows_task, *eod_tasks, return_exceptions=True)
    rows_loaded = isinstance(results[0], list) and len(results[0]) > 0
    eod_ok = sum(1 for r in results[1:] if isinstance(r, list))
    return {
        "rowsLoaded":   rows_loaded,
        "rowsCount":    len(results[0]) if isinstance(results[0], list) else 0,
        "eodSheetsOk":  eod_ok,
        "eodSheets":    len(eod_tasks),
        "tookSeconds":  round(time.perf_counter() - t0, 2),
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
    rows = get_cached_rows(start, end)

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


# ── DEBUG: dump raw upstream rows for field discovery ──────────────
def _debug_fetch_raw(start_date: str, end_date: str, group_type: str = "None"):
    """One-off upstream POST with configurable GroupType. Bypasses every cache."""
    users = _get_users_cached()
    if users is None:
        return {"error": "users fetch failed"}
    body_parts = [
        f"StartDate={start_date}",
        f"EndDate={end_date}",
        "AllAccountCodes=1",
        "ReportType=Detailed",
        f"GroupType={group_type}",
        "AllCustomers=1",
        "AllProjects=1",
        "Signed=0,1",
        "Approved=0,1",
        "Billable=0,1",
        "RecordStatus=0,1",
    ]
    body = "&".join(body_parts)
    for u in users:
        body += f"&UserList={u['USERID']}"
    try:
        resp = requests.post(
            "https://secure.timesheets.com/api/public/v1/report/project/customizable",
            headers={**ts_headers(), "Content-Type": "application/x-www-form-urlencoded"},
            data=body,
            timeout=60,
        )
        if resp.status_code != 200:
            return {"error": f"status={resp.status_code}", "body": resp.text[:400]}
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


_TEAMISH_FIELDS = [
    # Common Timesheets.com fields
    "DEPARTMENT", "DEPARTMENTID", "DEPARTMENTNAME",
    "GROUPNAME", "GROUPVALUE", "GROUPID", "GROUP",
    "OFFICEID", "OFFICE", "OFFICENAME", "LOCATION", "LOCATIONNAME",
    "TEAM", "TEAMNAME", "TEAMID",
    "ADMINUSERID", "ADMINFULLNAME", "ADMINFIRSTNAME", "ADMINLASTNAME",
    "MANAGER", "MANAGERNAME", "MANAGERID",
    "DIVISION", "REGION", "BRANCH", "BRANCHNAME",
    "COSTCENTER", "COSTCENTERID", "BUSINESSUNIT", "BU",
    "CUSTOMFIELD1", "CUSTOMFIELD2", "CUSTOMFIELD3", "CUSTOMFIELD4", "CUSTOMFIELD5",
    "CATEGORY", "CATEGORYNAME",
]


def _summarize_raw(data) -> dict:
    """Return: (a) first raw row + its wrapping group, (b) every key seen on rows,
    (c) unique values for plausibly team-related fields (capped)."""
    if not isinstance(data, dict):
        return {"error": data.get("error") if isinstance(data, dict) else "no data"}
    if not data.get("report") or not data["report"].get("ReportData"):
        return {"error": "no report data", "topLevelKeys": sorted(data.keys())}

    first_row = None
    first_group_meta = None
    row_keys: set = set()
    group_keys: set = set()
    uniq: dict = {f: set() for f in _TEAMISH_FIELDS}
    row_count = 0
    group_count = 0

    for group in data["report"]["ReportData"]:
        group_count += 1
        # Every key on the group object except Records (which holds the rows)
        for k in group.keys():
            if k != "Records":
                group_keys.add(k)
        if first_group_meta is None:
            first_group_meta = {k: v for k, v in group.items() if k != "Records"}

        recs = group.get("Records") or {}
        rows = recs.get("Data") or []
        for row in rows:
            row_count += 1
            row_keys.update(row.keys())
            if first_row is None:
                first_row = row
            for f in _TEAMISH_FIELDS:
                v = row.get(f)
                if v is not None and v != "":
                    uniq[f].add(str(v))

    return {
        "groupCount":   group_count,
        "rowCount":     row_count,
        "groupKeys":    sorted(group_keys),
        "rowKeys":      sorted(row_keys),
        "firstGroup":   first_group_meta,
        "firstRow":     first_row,
        "uniqueValues": {
            f: sorted(list(v))[:25]
            for f, v in uniq.items() if v
        },
    }


def _collect_team_field_values(records: list, key_substrings: tuple) -> dict:
    """Return {field_key: sorted_unique_values[:25]} for any field whose key matches
    one of the explicit candidates OR contains one of the substrings (case-insensitive)."""
    explicit = (
        "DEPARTMENT", "DEPARTMENTID", "DEPARTMENTNAME",
        "GROUPNAME", "GROUPVALUE", "GROUPID", "GROUP",
        "OFFICEID", "OFFICE", "OFFICENAME",
        "LOCATIONNAME", "LOCATION",
        "TEAM", "TEAMNAME", "TEAMID",
        "DIVISION",
    )
    all_keys: set = set()
    for r in records:
        if isinstance(r, dict):
            all_keys.update(r.keys())
    matched: set = set(k for k in all_keys if k.upper() in explicit)
    for k in all_keys:
        ku = k.upper()
        if any(sub in ku for sub in key_substrings):
            matched.add(k)
    out: dict = {}
    for f in sorted(matched):
        vals: set = set()
        for r in records:
            if not isinstance(r, dict):
                continue
            v = r.get(f)
            if v is None or v == "":
                continue
            vals.add(str(v))
        if vals:
            out[f] = sorted(vals)[:25]
    return out


@app.get("/api/debug/raw-timesheet")
def debug_raw_timesheet():
    """One-shot diagnostic: fetch last 7 days, return first 3 raw timesheet rows + 3 raw user
    records UNTOUCHED, plus every key on each + unique values for any TEAM/DEPT/GROUP/OFFICE/DIVISION
    field. Used to identify which upstream field actually holds the team label."""
    today = datetime.now()
    start = (today - timedelta(days=7)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")

    data = fetch_timesheet(start, end)

    timesheet_rows: list = []
    group_meta_samples: list = []
    group_keys: set = set()
    if isinstance(data, dict) and data.get("report") and data["report"].get("ReportData"):
        for group in data["report"]["ReportData"]:
            for k in group.keys():
                if k != "Records":
                    group_keys.add(k)
            if len(group_meta_samples) < 3:
                group_meta_samples.append({k: v for k, v in group.items() if k != "Records"})
            recs = (group.get("Records") or {}).get("Data") or []
            timesheet_rows.extend(recs)

    users = _get_users_cached() or []
    KEY_SUBSTRS = ("TEAM", "DEPT", "GROUP", "OFFICE", "DIVISION")

    return {
        "range":                  {"start": start, "end": end},
        "timesheet_sample_rows":  timesheet_rows[:3],
        "timesheet_row_count":    len(timesheet_rows),
        "timesheet_row_keys":     sorted({k for r in timesheet_rows for k in (r.keys() if isinstance(r, dict) else [])}),
        "timesheet_group_keys":   sorted(group_keys),
        "timesheet_group_samples": group_meta_samples,
        "timesheet_field_values": _collect_team_field_values(timesheet_rows, KEY_SUBSTRS),
        "user_sample_rows":       users[:3],
        "user_row_count":         len(users),
        "user_row_keys":          sorted({k for u in users for k in (u.keys() if isinstance(u, dict) else [])}),
        "user_field_values":      _collect_team_field_values(users, KEY_SUBSTRS),
        "hint": (
            "Look for a field in user_field_values OR timesheet_field_values whose values "
            "look like the team labels in TEAM_DEPT_MAP. If it's on users, parse_rows() will "
            "need a userid→team join from the cached users response."
        ),
    }


@app.get("/api/debug/admin-groups")
def debug_admin_groups():
    """Group every cached user by ADMINUSERID. Each group is a candidate team:
    the admin is the lead, the members are direct reports. Sorted by member count desc."""
    users = _get_users_cached() or []
    if not users:
        return {"error": "users fetch failed"}

    by_id = {str(u.get("USERID")): u for u in users}

    groups: dict = {}
    for u in users:
        raw = u.get("ADMINUSERID")
        admin_id = "" if raw is None else str(raw).strip()
        if not admin_id or admin_id.lower() in ("none", "null", "0"):
            admin_id = "(none)"
        groups.setdefault(admin_id, []).append({
            "userid":   str(u.get("USERID", "")),
            "fullname": u.get("FULLNAME", ""),
        })

    out = []
    for admin_id, members in groups.items():
        admin_user = by_id.get(admin_id) if admin_id != "(none)" else None
        out.append({
            "admin_userid":   admin_id,
            "admin_name":     (admin_user.get("FULLNAME", "") if admin_user else
                               ("(no admin set)" if admin_id == "(none)" else "(orphan / unresolved)")),
            "admin_resolved": admin_user is not None,
            "member_count":   len(members),
            "members":        sorted(members, key=lambda m: m["fullname"]),
        })

    out.sort(key=lambda g: -g["member_count"])

    return {
        "total_users":  len(users),
        "group_count":  len(out),
        "groups":       out,
        "hint": (
            "Each entry with admin_resolved=true is a candidate team. "
            "Tell me which admin_userid maps to which team_letter and I'll wire up TEAM_ADMIN_MAP."
        ),
    }


@app.get("/api/debug/raw-row")
def debug_raw_row():
    """Probe the upstream report endpoint with three GroupType variants and dump
    the first raw row + every key seen + unique values for any plausibly
    team-related field. Helps identify which upstream key holds the team name."""
    today = datetime.now()
    start = (today - timedelta(days=7)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")

    t0 = time.perf_counter()
    data_none = _debug_fetch_raw(start, end, "None")
    t1 = time.perf_counter()
    data_dept = _debug_fetch_raw(start, end, "Department")
    t2 = time.perf_counter()
    data_cust = _debug_fetch_raw(start, end, "Customer")
    t3 = time.perf_counter()

    return {
        "range": {"start": start, "end": end},
        "timings": {
            "groupType_None":       round(t1 - t0, 2),
            "groupType_Department": round(t2 - t1, 2),
            "groupType_Customer":   round(t3 - t2, 2),
        },
        "groupType_None":       _summarize_raw(data_none),
        "groupType_Department": _summarize_raw(data_dept),
        "groupType_Customer":   _summarize_raw(data_cust),
        "hint": (
            "Inspect 'firstGroup', 'firstRow', 'rowKeys', and 'uniqueValues' to identify "
            "which upstream field carries the team/department label. Compare across the "
            "three GroupType variants — some fields only appear when the report is grouped."
        ),
    }


@app.get("/api/team/{team_id}/{period}")
async def get_team_data(team_id: str, period: str):
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

    t0 = time.perf_counter()
    result = await _team_response(team_id, period)
    print(f"[PERF] team={team_id} {period} total={time.perf_counter()-t0:.2f}s")
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


_trend_cache: dict = {}
TREND_CACHE_SECS = 600  # 10 min


@app.get("/api/client/{client_name}/trend")
async def client_trend(client_name: str):
    cache_key = f"trend:{client_name}"
    now = datetime.now()
    entry = _trend_cache.get(cache_key)
    if entry and (now - entry["at"]).total_seconds() < TREND_CACHE_SECS:
        return entry["data"]
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
        rows = await asyncio.to_thread(get_cached_rows, s, e)
        cn   = client_name.lower()
        client_rows = [r for r in rows if cn in r["customer"].lower() or cn in r["desc"].lower()]
        total = sum(r["hours"] for r in client_rows if r["billable"])
        trend.append({"month": month_start.strftime("%b %Y"), "hours": round(total, 1)})
    result = {"trend": trend}
    _trend_cache[cache_key] = {"data": result, "at": datetime.now()}
    return result


async def _client_data(client_name: str, period: str):
    cache_key = f"client:{client_name}:{period}"
    cached = cache_get(cache_key)
    if cached:
        return cached
    t0 = time.perf_counter()
    start, end, label = date_range_for_period(period)
    rows   = await asyncio.to_thread(get_cached_rows, start, end)
    result = build_client_report(rows, client_name, label)
    print(f"[PERF] client={client_name} {period} total={time.perf_counter()-t0:.2f}s")
    cache_set(cache_key, result)
    return result


@app.get("/api/clear-cache")
@app.post("/api/clear-cache")
async def clear_cache():
    _cache.clear()
    _team_cache.clear()
    _rows_cache.clear()
    _trend_cache.clear()
    return {"ok": True, "status": "all caches cleared", "time": datetime.now().isoformat()}


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
