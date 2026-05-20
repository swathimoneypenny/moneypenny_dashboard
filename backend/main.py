import os
import re
import sys
import csv
import io
import time
import json
import hmac
import base64
import hashlib
import secrets
import asyncio
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(__file__))

from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
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


@app.middleware("http")
async def require_auth(request: Request, call_next):
    """Protect every /api/* route except /api/auth/* and a few exempt prefixes.
    If DASHBOARD_PASSWORD or DASHBOARD_SESSION_SECRET is unset, auth is disabled
    so local dev keeps working without env config."""
    path = request.url.path
    # Allow CORS preflight + non-API paths
    if request.method == "OPTIONS" or not path.startswith("/api/") or AUTH_DISABLED:
        return await call_next(request)
    if any(path.startswith(p) for p in AUTH_EXEMPT_PREFIXES):
        return await call_next(request)
    token = extract_bearer(request)
    if not verify_token(token or ""):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.post("/api/auth/login")
async def auth_login(req: dict):
    password = (req or {}).get("password") or ""
    if not DASHBOARD_PASSWORD or not DASHBOARD_SESSION_SECRET:
        return JSONResponse(
            {"error": "auth_disabled", "message": "Server has no DASHBOARD_PASSWORD / DASHBOARD_SESSION_SECRET configured."},
            status_code=503,
        )
    if not hmac.compare_digest(password, DASHBOARD_PASSWORD):
        return JSONResponse({"error": "invalid_password"}, status_code=401)
    return {"token": issue_token(), "expiresInSecs": TOKEN_TTL_SECS}


@app.get("/api/auth/verify")
async def auth_verify(request: Request):
    if AUTH_DISABLED:
        return {"valid": True, "authDisabled": True}
    token = extract_bearer(request)
    payload = verify_token(token or "") if token else None
    return {"valid": bool(payload), "exp": payload.get("exp") if payload else None}

TIMESHEET_API_KEY   = os.getenv("TIMESHEET_API_KEY")
TIMESHEET_API_TOKEN = os.getenv("TIMESHEET_API_TOKEN")
ABS_SHEET_ID        = os.getenv("ABS_SHEET_ID")
groq_client         = Groq(api_key=os.getenv("GROQ_API_KEY"))


# ── Auth ──────────────────────────────────────────────────────────
# Single shared password. The frontend sends it to /api/auth/login, the server
# returns a 30-day HMAC-signed token. Every protected endpoint requires
# Authorization: Bearer <token>.
DASHBOARD_PASSWORD       = os.getenv("DASHBOARD_PASSWORD", "")
DASHBOARD_SESSION_SECRET = os.getenv("DASHBOARD_SESSION_SECRET", "")
TOKEN_TTL_SECS           = 30 * 24 * 3600  # 30 days
AUTH_DISABLED            = not DASHBOARD_PASSWORD or not DASHBOARD_SESSION_SECRET

# Paths that DO NOT require auth.
AUTH_EXEMPT_PREFIXES = (
    "/api/auth/",
    "/docs", "/openapi.json", "/redoc",
    "/api/health",
)


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


def issue_token() -> str:
    """Return a signed token of the form <payload_b64>.<sig_b64>.
    Payload is JSON {iat, exp, sub}."""
    secret = DASHBOARD_SESSION_SECRET.encode("utf-8")
    now    = int(time.time())
    payload = {
        "iat": now,
        "exp": now + TOKEN_TTL_SECS,
        "sub": "manager",
        "jti": secrets.token_hex(8),
    }
    payload_b = _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    sig_b = _b64url(hmac.new(secret, payload_b.encode("ascii"), hashlib.sha256).digest())
    return f"{payload_b}.{sig_b}"


def verify_token(token: str) -> dict | None:
    """Return the decoded payload if valid + unexpired, else None."""
    if not token or "." not in token:
        return None
    try:
        payload_b, sig_b = token.split(".", 1)
        secret = DASHBOARD_SESSION_SECRET.encode("utf-8")
        expected = _b64url(hmac.new(secret, payload_b.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(expected, sig_b):
            return None
        payload = json.loads(_b64url_decode(payload_b).decode("utf-8"))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


def extract_bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization") or request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None

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


# ── Env-var overrides for EOD sheet IDs / gids ───────────────────
# Lets the manager set SHEET_TEAM_B / GID_TEAM_B etc. on Railway without
# editing the source. Any env var present here overrides the hardcoded value
# above. Useful for teams whose sheetId is None in TEAM_LETTER_MAP (e.g. team_b).
for _tid in list(TEAM_LETTER_MAP.keys()):
    _env_sid = os.getenv(f"SHEET_{_tid.upper()}")
    _env_gid = os.getenv(f"GID_{_tid.upper()}")
    if _env_sid:
        TEAM_LETTER_MAP[_tid]["sheetId"] = _env_sid
        print(f"[config] SHEET_{_tid.upper()} env override applied: {_env_sid[:8]}…")
    if _env_gid:
        TEAM_LETTER_MAP[_tid]["gid"] = _env_gid
        print(f"[config] GID_{_tid.upper()} env override applied: {_env_gid}")


# ── Team rosters (staff-name keyword filter) ─────────────────────
# Manually configured per team. Each entry is a list of partial name keywords
# (case-insensitive substring match against the timesheet FULLNAME).
# If a team's roster is empty, all timesheet rows pass through ("include all").
TEAM_ROSTERS: dict[str, list[str]] = {
    "team_a": ["kokila", "uma", "jayashree r", "jayashree b"],
    "team_b": ["buela", "ivanjalin", "varshini", "pavithra s"],
    "team_c": ["grace", "mahalakshmi", "jeevtha s", "keerthana"],
    "team_d": ["chandra", "yamini", "sharmila", "krithiga", "dharani s", "sandhiya", "sirisha", "swetha s"],
    "team_e": ["shaalini", "kaviya", "preethi"],
    "team_f": ["inbamozhi", "sarika"],
    "team_g": ["hema", "indra", "amala", "nidisha", "pechi"],
    "team_h": ["deepali", "yashika", "madu"],
    "team_i": ["radhika", "aparna s", "jeevitha", "sakthi s"],
    "team_j": ["logeswari", "nisha m", "dhana", "sindhu", "monikaa"],
    "team_k": ["karthika", "akshaya devi", "keerthana", "jani priya", "rohitha", "abinaya"],
    "team_l": ["nasreen", "krishna", "swathi", "sarika", "razia"],
    "team_m": ["pavithra", "bhuva", "Reshma Lakshmanaboopathi"],
    "team_n": ["vino", "shivani", "snega"],
    "team_t": ["pragathi", "reshma hameeth", "prithvi b", "akshaya manojkumar",
               "fathima", "naveena", "dharani p", "shiyamala devi"],
}

# Startup warning — Team T preparers haven't been provided by management yet.
# The single-entry roster will only match Pragathi herself; all other Team T
# work logged by preparers will fall through to Internal/Other or whichever
# team the ADMIN_MAP routes them to.
if len(TEAM_ROSTERS.get("team_t", [])) <= 1:
    print(f"[WARN] team_t roster has only {len(TEAM_ROSTERS['team_t'])} "
          f"member(s) configured ({TEAM_ROSTERS['team_t']}). Add Team T preparers "
          f"to TEAM_ROSTERS when available.")


# Customer/project names that should always be treated as internal work,
# never assigned to a team's client list. Any row whose customer fuzzy-matches
# one of these gets bucketed into "Internal / Other" for the employee's team.
INTERNAL_CODES = [
    "SNMP",
    "BREAKS FOR TEAMS",
    "Choose Customer",
    "Training",
    "Internal",
    "Admin",
]


# Customers found in timesheets but not yet assigned to any team's TEAM_CLIENTS.
# This list is documentation-only — these names still appear in
# /api/debug/unmapped-clients until they're added to the appropriate team.
UNCATEGORIZED_CLIENTS = [
    "ASC Custom Books",      # 135h, 37 rows
    "Portrai Me",            # 5.7h, 4 rows
    "Happy Soul",            # 2.8h, 9 rows
    "Kacey Fitzpatrick",     # 2.4h, 2 rows
]


# ── Authoritative team → client mapping ──────────────────────────
# Per-team list of clients. Used as the SOURCE OF TRUTH for which orgs appear
# under each team. tsMatch = case-insensitive substring keywords against
# CUSTOMERNAME (or WORKDESCRIPTION as fallback). estHrs = monthly commitment.
TEAM_CLIENTS: dict[str, list[dict]] = {
    "team_a": [
        {"name": "Bookkeeping Doctor",   "tsMatch": ["BKP Doctor", "Bookkeeping Doctor", "BKD", "Bkd"],         "estHrs": 80,  "tz": "EST", "meeting": "2nd & 3rd week Thursday 9am IST & every Wednesday 4:30pm IST"},
        {"name": "Ollin Balance",        "tsMatch": ["Ollin Balance", "Ollinbalance", "Ollin"],                  "estHrs": 160, "tz": "EST", "meeting": "4th week Tuesday 4:30pm IST"},
        {"name": "24hr Bookkeeper",      "tsMatch": ["24hr Bookkeeper", "24 hrs", "24hrs", "24 Hrs", "24 hr"], "estHrs": 160, "tz": "EST", "meeting": "No scheduled meeting"},
    ],
    "team_b": [
        {"name": "NisiVoccia",           "tsMatch": ["NisiVoccia"],                            "estHrs": 120, "tz": "EST", "meeting": "3rd week Thursday 6:30pm IST"},
        {"name": "Katy Advisors",        "tsMatch": ["Katy Advisors"],                         "estHrs": 80,  "tz": "CST", "meeting": "Every Wednesday 5pm IST"},
        {"name": "CBMS",                 "tsMatch": ["CBMS", "MyProsperityTree"],              "estHrs": 120, "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "Back Office People",   "tsMatch": ["Back Office People"],                    "estHrs": 80,  "tz": "PST", "meeting": "No scheduled meeting"},
    ],
    "team_c": [
        {"name": "Stay by Rafa",         "tsMatch": ["Stay by Rafa"],                          "estHrs": 80,  "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "Financial Synergy",    "tsMatch": ["Financial Synergy"],                     "estHrs": 120, "tz": "CST", "meeting": "No scheduled meeting"},
        {"name": "Neve",                 "tsMatch": ["Neve"],                                  "estHrs": 0,   "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "Sambrano Services",    "tsMatch": ["Sambrano"],                              "estHrs": 60,  "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "RDG Tax Group",        "tsMatch": ["RDG"],                                   "estHrs": 60,  "tz": "CST", "meeting": "No scheduled meeting"},
    ],
    "team_d": [
        {"name": "Financly",             "tsMatch": ["Financly"],                              "estHrs": 400, "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "AIS Solutions",        "tsMatch": ["AIS Solutions", "AIS"],                  "estHrs": 480, "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Smith Bookkeeping",    "tsMatch": ["Smith Bookkeeping"],                     "estHrs": 0,   "tz": "EST", "meeting": "No scheduled meeting"},
    ],
    "team_e": [
        {"name": "ACS",                  "tsMatch": ["ACS"],                                   "estHrs": 320, "tz": "PST", "meeting": "No scheduled meeting"},
    ],
    "team_f": [
        {"name": "Thrive",               "tsMatch": ["Thrive"],                                "estHrs": 320, "tz": "PST", "meeting": "No scheduled meeting"},
    ],
    "team_g": [
        {"name": "Ez Ledger",            "tsMatch": ["Ez Ledger", "EZ Ledger"],                "estHrs": 320, "tz": "EST", "meeting": "Every Friday 5:15pm IST"},
        {"name": "Proper Trust",         "tsMatch": ["Proper Trust", "Mintage", "Artesani"],   "estHrs": 160, "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "Putman Accountancy",   "tsMatch": ["Putman"],                                "estHrs": 80,  "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Manzelli Consulting",  "tsMatch": ["Manzelli Consulting"],                   "estHrs": 160, "tz": "EST", "meeting": "No scheduled meeting"},
    ],
    "team_h": [
        {"name": "JB Advisory",          "tsMatch": ["JB Advisory"],                           "estHrs": 320, "tz": "MST", "meeting": "Every Tuesday and Thursday 5:30pm IST"},
    ],
    "team_i": [
        {"name": "Core 4",               "tsMatch": ["Core 4"],                                "estHrs": 80,  "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Beacon Advisors",      "tsMatch": ["Beacon Advisors"],                       "estHrs": 80,  "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "Pokorny",              "tsMatch": ["Pokorny"],                               "estHrs": 60,  "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "SoCo",                 "tsMatch": ["SoCo", "SoCo Business"],                 "estHrs": 160, "tz": "CST", "meeting": "No scheduled meeting"},
        {"name": "Redmond",              "tsMatch": ["Redmond"],                               "estHrs": 80,  "tz": "PST", "meeting": "No scheduled meeting"},
    ],
    "team_j": [
        {"name": "GFA",                  "tsMatch": ["GFA", "Go Figure", "Go Figure Accounting"], "estHrs": 640, "tz": "EST", "meeting": "Monthly 3rd week Thursday 5:30pm IST"},
    ],
    "team_k": [
        {"name": "Portnoy CPA",          "tsMatch": ["Portnoy"],                               "estHrs": 320, "tz": "EST", "meeting": "Monthly"},
        {"name": "Empower Accounting",   "tsMatch": ["Empower Accounting", "Empower"],         "estHrs": 80,  "tz": "PST", "meeting": "Monthly 2nd Wednesday 9:45am IST"},
        {"name": "Modern CPAs",          "tsMatch": ["Modern CPAs", "Modern CPA"],             "estHrs": 320, "tz": "PST", "meeting": "Monthly"},
    ],
    "team_l": [
        {"name": "Taxsense",             "tsMatch": ["Taxsense"],                              "estHrs": 160, "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "Officeheads",          "tsMatch": ["Officeheads"],                           "estHrs": 80,  "tz": "CST", "meeting": "No scheduled meeting"},
        {"name": "Web Books",            "tsMatch": ["Web Books"],                             "estHrs": 80,  "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "Baker Bookkeeps",      "tsMatch": ["Baker Bookkeeps", "Baker"],              "estHrs": 80,  "tz": "CST", "meeting": "No scheduled meeting"},
        {"name": "LAH",                  "tsMatch": ["LAH"],                                   "estHrs": 80,  "tz": "EST", "meeting": "No scheduled meeting"},
    ],
    "team_m": [
        {"name": "ABS",                  "tsMatch": ["ABS"],                                   "estHrs": 80,  "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Radicle Science",      "tsMatch": ["Radicle"],                               "estHrs": 0,   "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Oh My ROI",            "tsMatch": ["Oh My ROI"],                             "estHrs": 0,   "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "Taxes with Jones",     "tsMatch": ["Taxes with Jones"],                      "estHrs": 0,   "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Equity Champions",     "tsMatch": ["Equity Champ"],                          "estHrs": 0,   "tz": "EST", "meeting": "Every Thursday 4:30pm IST"},
        {"name": "DAA CPA",              "tsMatch": ["DAA CPA", "DAA"],                        "estHrs": 0,   "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "MC Tax",               "tsMatch": ["MC Tax"],                                "estHrs": 0,   "tz": "CST", "meeting": "No scheduled meeting"},
        {"name": "SDC Group",            "tsMatch": ["SDC"],                                   "estHrs": 0,   "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Helvetica",            "tsMatch": ["Helvetica"],                             "estHrs": 0,   "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Shane Butler",         "tsMatch": ["Shane Butler"],                          "estHrs": 0,   "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Sybilline Records",    "tsMatch": ["Sybilline", "Sybylline"],                "estHrs": 0,   "tz": "PST", "meeting": "No scheduled meeting"},
    ],
    "team_n": [
        {"name": "BKP Repair",           "tsMatch": ["BKP Repair", "Bookkeeping Repair", "Bookkeeping Repair LLC"], "estHrs": 240, "tz": "PST", "meeting": "Bi-weekly Friday 10am IST"},
        {"name": "Tim Thompson",         "tsMatch": ["Tim Thompson"],                          "estHrs": 40,  "tz": "CST", "meeting": "No scheduled meeting"},
        {"name": "FitProfit Solutions",  "tsMatch": ["FitProfit"],                             "estHrs": 0,   "tz": "CST", "meeting": "No scheduled meeting"},
    ],
    "team_t": [
        {"name": "Wiebe Hinton Hambalek","tsMatch": ["Wiebe", "Hinton Hambalek"],              "estHrs": 960, "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "We Add Value",         "tsMatch": ["We Add Value"],                          "estHrs": 0,   "tz": "PST", "meeting": "No scheduled meeting"},
        {"name": "Financial Synergy TX", "tsMatch": ["Financial Synergy TX"],                  "estHrs": 0,   "tz": "CST", "meeting": "Last day of month 5pm IST"},
        {"name": "Jim Baltimore",        "tsMatch": ["Jim Baltimore"],                         "estHrs": 0,   "tz": "MST", "meeting": "No scheduled meeting"},
        {"name": "Tim Thompson TX",      "tsMatch": ["Tim Thompson TX"],                       "estHrs": 0,   "tz": "CST", "meeting": "No scheduled meeting"},
        {"name": "Joe Manzelli",         "tsMatch": ["Joe Manzelli"],                          "estHrs": 0,   "tz": "EST", "meeting": "No scheduled meeting"},
        {"name": "Business Fitness",     "tsMatch": ["Business Fitness"],                      "estHrs": 0,   "tz": "AEST","meeting": "No scheduled meeting"},
        {"name": "David Beck",           "tsMatch": ["David Beck"],                            "estHrs": 0,   "tz": "EST", "meeting": "No scheduled meeting"},
    ],
}


def is_internal_code(customer: str) -> bool:
    """True iff `customer` fuzzy-matches any entry in INTERNAL_CODES. Used to
    route internal/break/admin/training rows into "Internal / Other" without
    consulting TEAM_CLIENTS."""
    if not customer:
        return True  # empty customer name → treat as internal
    cust_norm = _normalize_for_match(customer)
    if not cust_norm:
        return True
    for code in INTERNAL_CODES:
        code_norm = _normalize_for_match(code)
        if not code_norm:
            continue
        if code_norm in cust_norm:
            return True
    return False


def _reverse_match(customer_norm: str, kw_norm: str, min_short_len: int = 4) -> bool:
    """True iff the customer name (normalized) is a substring of the keyword.
    Use this when the config's tsMatch entry is LONGER than the actual
    Timesheets.com customer name. Length guard prevents short customer names
    (e.g. "A", "B", 1-3 chars) from reverse-matching arbitrary keywords."""
    if not customer_norm or not kw_norm:
        return False
    if len(customer_norm) < min_short_len:
        return False
    if len(customer_norm) >= len(kw_norm):
        # Equal-length is already handled by forward containment;
        # longer-customer never reverse-matches a shorter kw.
        return False
    return customer_norm in kw_norm


def find_team_for_client(client_name: str) -> str | None:
    """Reverse-lookup: which team owns this client? Returns team_id or None.

    Forward direction (kw inside customer name) always wins over reverse
    direction (customer name inside kw), so "Tim Thompson" → team_n (forward
    match on "Tim Thompson") rather than team_t (reverse match on
    "Tim Thompson TX"). Within each direction, longest matching keyword wins.
    """
    if not (client_name or "").strip():
        return None
    cn_norm = _normalize_for_match(client_name)
    if not cn_norm:
        return None

    forward: tuple[int, str] | None = None
    reverse: tuple[int, str] | None = None
    for team_id, clients in TEAM_CLIENTS.items():
        for c in clients:
            for kw in c.get("tsMatch", []):
                kw_norm = _normalize_for_match(kw)
                if not kw_norm:
                    continue
                if kw_norm in cn_norm:
                    if forward is None or len(kw_norm) > forward[0]:
                        forward = (len(kw_norm), team_id)
                elif _reverse_match(cn_norm, kw_norm):
                    if reverse is None or len(kw_norm) > reverse[0]:
                        reverse = (len(kw_norm), team_id)
    if forward:
        return forward[1]
    if reverse:
        return reverse[1]
    return None


def _resolve_client_for_team(team_id: str, customer: str, desc: str = "") -> str | None:
    """Return the canonical client name from TEAM_CLIENTS[team_id] that matches
    `customer` (or `desc` as fallback). Same forward-beats-reverse precedence
    as find_team_for_client."""
    cfg = TEAM_CLIENTS.get(team_id) or []
    if not cfg:
        return None
    cust_norm = _normalize_for_match(customer)
    desc_norm = _normalize_for_match(desc)

    forward: tuple[int, str] | None = None
    reverse: tuple[int, str] | None = None
    for client in cfg:
        for kw in client.get("tsMatch", []):
            kw_norm = _normalize_for_match(kw)
            if not kw_norm:
                continue
            fwd = (cust_norm and kw_norm in cust_norm) or (desc_norm and kw_norm in desc_norm)
            if fwd:
                if forward is None or len(kw_norm) > forward[0]:
                    forward = (len(kw_norm), client["name"])
                continue
            if _reverse_match(cust_norm, kw_norm) or _reverse_match(desc_norm, kw_norm):
                if reverse is None or len(kw_norm) > reverse[0]:
                    reverse = (len(kw_norm), client["name"])
    if forward:
        return forward[1]
    if reverse:
        return reverse[1]
    return None


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


def _kw_matches_name(kw: str, fullname: str) -> bool:
    """Does roster keyword `kw` match `fullname` using word-token prefix?
    Every token in kw must be a prefix of some token in fullname; single-char
    tokens act as initials. Empty kw → no match.
    """
    k = (kw or "").lower().strip()
    n = (fullname or "").lower().strip()
    if not k or not n:
        return False
    n_tokens = [t for t in re.split(r"[\s\-\.,]+", n) if t]
    k_tokens = [t for t in re.split(r"[\s\-\.,]+", k) if t]
    if not n_tokens or not k_tokens:
        return False
    return all(any(nt.startswith(kt) for nt in n_tokens) for kt in k_tokens)


def staff_in_team(fullname: str, roster: list[str]) -> bool:
    """STRICT word-token matcher. Empty roster ⇒ include all.

    A roster keyword matches a full name iff every token in the keyword is a
    prefix of some token in the full name (case-insensitive). Single-char
    tokens act as initials. This prevents cross-team leakage where short
    keywords like "uma" used to substring-match every "*kumar" surname.
    """
    if not roster:
        return True
    if not (fullname or "").strip():
        return False
    return any(_kw_matches_name(r, fullname) for r in roster)


def assign_row_to_team(row: dict) -> str | None:
    """Pick the single best-fit team_id for this timesheet row.

    Multiple teams may have roster keywords that match the same name (e.g.
    "Pavithra" matches Team M's "pavithra" AND Team B's "pavithra s"). We
    disambiguate via:
      1. row["team"] (TEAM_ADMIN_MAP-derived label) — authoritative when set
      2. Longest matching roster keyword wins
      3. Alphabetical team_id as last resort, with a [DEBUG ambiguous] log

    Result is cached on the row dict so each row is computed at most once.
    """
    if "_assignedTeam" in row:
        return row["_assignedTeam"]
    name = (row.get("name") or "").strip()
    if not name:
        row["_assignedTeam"] = None
        return None
    matches: list[tuple[str, int]] = []
    for tid, roster in TEAM_ROSTERS.items():
        best = 0
        for kw in roster or []:
            if _kw_matches_name(kw, name) and len(kw) > best:
                best = len(kw)
        if best > 0:
            matches.append((tid, best))

    result: str | None = None
    if not matches:
        result = None
    elif len(matches) == 1:
        result = matches[0][0]
    else:
        row_team_label = (row.get("team") or "").strip().lower()
        if row_team_label:
            for tid, _ in matches:
                label = TEAM_LETTER_MAP.get(tid, {}).get("label", "").strip().lower()
                if label and label == row_team_label:
                    result = tid
                    break
        if result is None:
            ms = sorted(matches, key=lambda x: (-x[1], x[0]))
            if ms[0][1] > ms[1][1]:
                result = ms[0][0]
            else:
                result = ms[0][0]
                print(f"[DEBUG ambiguous] name='{name}' rowTeam='{row.get('team')}' matches={matches} → {result}")
    row["_assignedTeam"] = result
    return result


def row_belongs_to_team(row: dict, team_id: str) -> bool:
    """True iff the row's best-fit team (via assign_row_to_team) is team_id.
    Teams with no roster fall back to row["team"] label equality."""
    roster = TEAM_ROSTERS.get(team_id) or []
    if not roster:
        label = TEAM_LETTER_MAP.get(team_id, {}).get("label", "")
        return (row.get("team") or "").strip().lower() == label.strip().lower()
    return assign_row_to_team(row) == team_id

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


def _eod_date_iso(date_raw) -> str:
    """Return the YYYY-MM-DD form of a raw EOD cell value, or '' if unparseable.
    Wraps _parse_eod_date so callers that need a string (not datetime) get the
    canonical form directly."""
    dt = _parse_eod_date(date_raw)
    return dt.strftime("%Y-%m-%d") if dt else ""


def _fetch_eod_csv(sheet_id: str, tab: str | None = None, gid: str | None = None) -> tuple[str, str]:
    """Fetch the raw CSV for an EOD tab. Returns (csv_text, url_used).

    Prefers the /export endpoint (which exports the entire sheet including
    blank rows) when gid is known. Falls back to /gviz/tq with an explicit
    range when only a tab name is available. Raises EodSheetError on permission
    / not-found errors so the picker can move on to the next candidate.
    """
    if not sheet_id:
        return "", ""
    if gid:
        # /export?format=csv returns the full sheet content for that gid,
        # blank rows included — bypasses gviz's auto-truncate-at-first-blank.
        url = (f"https://docs.google.com/spreadsheets/d/{sheet_id}"
               f"/export?format=csv&gid={gid}")
    elif tab:
        url = (f"https://docs.google.com/spreadsheets/d/{sheet_id}"
               f"/gviz/tq?tqx=out:csv&range=A1:O10000"
               f"&sheet={requests.utils.quote(tab)}")
    else:
        # No tab/gid → default first tab via gviz
        url = (f"https://docs.google.com/spreadsheets/d/{sheet_id}"
               f"/gviz/tq?tqx=out:csv&range=A1:O10000")

    print(f"[eod-fetch] url={url}")
    resp = requests.get(url, timeout=15)
    if resp.status_code in (401, 403):
        raise EodSheetError(
            "EOD source not accessible. Share the sheet as 'Anyone with the link can view'.",
            resp.status_code,
        )
    if resp.status_code == 404:
        raise EodSheetError("EOD source not found (404). Verify the sheet URL.", 404)
    resp.raise_for_status()
    return resp.text, url


def _normalize_eod_status(raw: str) -> str:
    """Map free-text column-L into one of:
       awaiting_response | in_progress | completed | ""

    Strips every non-letter (so "Awaiting REstponse" → "awaitingrestponse"
    still matches the "awaiting" substring; "In-Process" / "In Process" /
    "WIP" / "On-going" all collapse into a single check).
    """
    if not raw:
        return ""
    s = re.sub(r"[^a-z]", "", raw.lower())
    if not s:
        return ""
    # Awaiting Response — also catches the "Awaiting REstponse" typo seen in
    # the Team J sheet and any "awaitingreply"-style variant.
    if "awaiting" in s:
        return "awaiting_response"
    # In-Progress family
    if "inprogress" in s or "inprocess" in s or "wip" in s or "ongoing" in s:
        return "in_progress"
    # Completed family — "Delay Resolved" and similar map here.
    if ("completed" in s or "complete" in s or "done" in s
            or "resolved" in s or "closed" in s):
        return "completed"
    return ""


# Notes-column heuristic patterns. Kept as lowercase substrings so the caller
# only has to lowercase once.
_NOTES_PENDING_SIGNALS = (
    "awaiting", "in process", "in progress", "pending", "query",
    "queries", "blocked", "blocker", "open issue",
)
_NOTES_COMPLETED_SIGNALS = (
    "completed", "resolved", "closed", "done", "no issues",
)


def _infer_status_from_notes(notes: str) -> str:
    """When column L is blank, scan column M (status details) for delay
    keywords. Returns awaiting_response if any pending signal fires,
    completed if ONLY completed signals fire, "" if neither side fires."""
    if not notes:
        return ""
    t = notes.lower()
    has_pending   = any(sig in t for sig in _NOTES_PENDING_SIGNALS)
    has_completed = any(sig in t for sig in _NOTES_COMPLETED_SIGNALS)
    if has_pending:
        return "awaiting_response"
    if has_completed:
        return "completed"
    return ""


def get_eod_data(sheet_id: str, tab: str | None = None, gid: str | None = None) -> list[dict]:
    csv_text, _url = _fetch_eod_csv(sheet_id, tab=tab, gid=gid)
    if not csv_text:
        return []
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    result = []
    start = 1 if rows and not _safe_float(rows[0][0] if rows[0] else "") else 0
    for row in rows[start:]:
        while len(row) < 15:
            row.append("")
        date_raw = str(row[0]).strip()
        if not date_raw or date_raw.lower() in ("", "nan", "date"):
            continue
        # Normalize the date at parse time. Rows whose date won't parse still
        # ship through downstream (date_iso = ""), and downstream filters drop
        # them — but stamping the normalized ISO form on every row makes the
        # debug endpoint show real values and avoids re-parsing per consumer.
        date_iso = _eod_date_iso(date_raw)
        committed_val = _safe_float(row[1])
        booked_val    = _safe_float(row[2])
        eod_status    = str(row[11]).strip() if len(row) > 11 else ""  # col L
        eod_notes     = str(row[12]).strip() if len(row) > 12 else ""  # col M (Status Details)
        posted_query  = str(row[13]).strip() if len(row) > 13 else ""  # col N (Posted Query Details)
        util_pct      = round(booked_val / committed_val * 100, 1) if committed_val > 0 else 0.0

        # Status: prefer the explicit column-L value. When blank, infer from
        # the notes column ("WORKPAPER Awaiting - 1" → awaiting_response).
        status_norm   = _normalize_eod_status(eod_status)
        status_source = "explicit_column_L" if status_norm else ""
        if not status_norm:
            inferred = _infer_status_from_notes(eod_notes)
            if inferred:
                status_norm   = inferred
                status_source = "notes_heuristic"
            else:
                status_source = "blank"

        note_delays = (
            len([x for x in eod_notes.split("\n") if x.strip()])
            if eod_notes not in ("", "nan") else 0
        )
        if note_delays == 0 and committed_val > 0 and booked_val < committed_val * 0.75:
            delays = 1
        else:
            delays = note_delays

        result.append({
            "date":             date_iso or date_raw[:10],
            "dateRaw":          date_raw,
            "committed":        committed_val,
            "booked":           booked_val,
            "utilPct":          util_pct,
            "eodStatus":        eod_status,
            "statusNorm":       status_norm,
            "statusNormSource": status_source,
            "notes":            eod_notes,
            "queryText":        posted_query,
            "delays":           delays,
        })
    return result


def _resolve_eod_rows_for_client(team_id: str, client_name: str) -> tuple[list[dict], str]:
    """Fetch EOD rows for a client with flexible tab matching.

    Tries in order:
      1. tab name == client name (e.g. "Go Figure Accounting")
      2. tab name == "{client name} Delays"
      3. Each tsMatch alias from TEAM_CLIENTS as a tab name + "{alias} Delays"
         (so "GFA" / "Go Figure" tabs match a client whose canonical name is
         "Go Figure Accounting")
      4. configured gid (the team's default tab)
      5. sheet's first tab (no tab/gid specified)
    Returns (rows, matched_label). Picks the candidate that returns the MOST
    rows, not just the first non-empty one — avoids picking a near-empty
    per-client tab when the populated team-wide tab also exists.
    """
    cfg = TEAM_LETTER_MAP.get(team_id) or {}
    sid = cfg.get("sheetId")
    gid = cfg.get("gid")
    label_safe = (sid or "")[:8] + ("…" if sid else "")
    if not sid:
        print(f"[eod] team={team_id} client={client_name} sheetId=None matchedTab=none rows=0")
        return [], "none"

    # Pull tsMatch aliases for this client from TEAM_CLIENTS, so the picker
    # can try tabs named after the alias (e.g. "GFA") as well as the
    # canonical client name.
    aliases: list[str] = []
    for client_cfg in (TEAM_CLIENTS.get(team_id) or []):
        if (client_cfg.get("name") or "").strip() == (client_name or "").strip():
            aliases = list(client_cfg.get("tsMatch") or [])
            break
        if client_name and fuzzy_contains(client_cfg.get("name") or "", client_name):
            aliases = list(client_cfg.get("tsMatch") or [])
            break

    candidates: list[tuple[str, dict]] = []
    seen: set[str] = set()
    def _add(label: str, kwargs: dict, key: str):
        if key in seen:
            return
        seen.add(key)
        candidates.append((label, kwargs))
    if client_name:
        _add(f"tab={client_name!r}",         {"tab": client_name},               f"t:{client_name.lower()}")
        _add(f"tab={client_name!r}+Delays", {"tab": f"{client_name} Delays"},   f"t:{client_name.lower()} delays")
    for alias in aliases:
        if not alias:
            continue
        _add(f"tab={alias!r}",          {"tab": alias},                 f"t:{alias.lower()}")
        _add(f"tab={alias!r}+Delays",  {"tab": f"{alias} Delays"},     f"t:{alias.lower()} delays")
    if gid:
        _add(f"gid={gid}", {"gid": gid}, f"gid:{gid}")
    _add("default-first-tab", {}, "default")

    last_error: str | None = None
    best_rows: list[dict] = []
    best_label: str | None = None
    best_score: tuple[int, int] = (-1, -1)   # (rows_with_recent_dates, total_rows)
    attempts: list[tuple[str, int, int]] = []  # (label, total, recent) for one summary log
    today_date = datetime.now()
    recent_cutoff = today_date - timedelta(days=90)
    for label, kwargs in candidates:
        try:
            rows = get_eod_data(sid, **kwargs)
        except EodSheetError as e:
            last_error = e.reason
            continue
        except Exception as e:
            last_error = str(e)
            continue
        if not rows:
            continue
        # Score each candidate by how many rows fall in the last 90 days —
        # so a tab that returns only March-2025 rows loses to one returning
        # current-month rows, even if the stale tab is listed first.
        recent_ct = 0
        for r in rows:
            d = _parse_eod_date(r.get("date") or r.get("dateRaw") or "")
            if d and d >= recent_cutoff:
                recent_ct += 1
        attempts.append((label, len(rows), recent_ct))
        score = (recent_ct, len(rows))
        if score > best_score:
            best_score = score
            best_rows = rows
            best_label = label

    if best_label:
        print(f"[eod] team={team_id} client={client_name} sheetId={label_safe} "
              f"matchedTab={best_label} rows={len(best_rows)} "
              f"recent90d={best_score[0]} attempts={attempts}")
        return best_rows, best_label

    err_suffix = f" error={last_error}" if last_error else ""
    print(f"[eod] team={team_id} client={client_name} sheetId={label_safe} "
          f"matchedTab=none rows=0 attempts={attempts}{err_suffix}")
    return [], "none"


_EOD_DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y-%m-%d %H:%M:%S",
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%y",                   # 5/14/26 — Google Sheets default
    "%m/%d/%y %H:%M:%S",          # 5/14/26 00:00:00
    "%m-%d-%Y",
    "%m-%d-%y",
    "%b, %d %Y %H:%M:%S",
    "%b, %d %Y",
    "%b %d, %Y",
    "%B %d, %Y",
    "%d/%m/%Y",
    "%d-%m-%Y",
)


def _parse_eod_date(date_str) -> datetime | None:
    """Parse an EOD-sheet date cell into a datetime.

    Google Sheets exports dates in whatever the cell formatting says, so the
    same column can hold "5/14/26", "5/14/2026", "5/14/26 00:00:00",
    "2026-05-14", or "May 14, 2026". This walks a list of strptime patterns
    and also strips any leading apostrophe (Sheets' text-literal marker)
    before parsing. Returns None if nothing matches.
    """
    s = ("" if date_str is None else str(date_str)).strip()
    if not s:
        return None
    # Sheets sometimes prefixes text-typed dates with an apostrophe so they
    # don't auto-format. Strip it.
    if s.startswith("'"):
        s = s[1:].strip()
    # Try the full string first (catches time-of-day variants), then the
    # whitespace-split first chunk (catches "5/14/26 0:00:00" type values
    # whose time-of-day format we didn't enumerate).
    base = s.split()[0] if " " in s else s
    for candidate in (s, base):
        for fmt in _EOD_DATE_FORMATS:
            try:
                return datetime.strptime(candidate, fmt)
            except ValueError:
                continue
    # Last-ditch manual numeric split for bare slash forms we may have missed
    if "/" in base:
        try:
            parts = base.split("/")
            if len(parts) >= 3:
                mo = int(parts[0])
                dy = int(parts[1])
                yr = int(parts[2])
                if yr < 100:
                    yr += 2000 if yr <= 68 else 1900
                return datetime(yr, mo, dy)
        except (ValueError, TypeError):
            pass
    return None


_STOPWORDS = frozenset((
    "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "at",
    "is", "are", "was", "were", "be", "been", "by", "from", "with", "as",
    "this", "that", "it", "we", "you", "they", "he", "she", "i", "but",
    "not", "no", "yes", "have", "has", "had", "do", "does", "did", "will",
    "would", "should", "can", "could", "may", "might", "all", "any", "some",
    "task", "tasks", "client", "clients", "weekly", "monthly", "today",
    "yesterday", "please", "need", "needs", "needed", "pending", "open",
))


def _query_keyset(text: str) -> set[str]:
    """Lowercase, strip non-letter, keep tokens >3 chars and not stopwords.
    Used to compare two queryText strings for "same query?" fuzzy matching."""
    if not text:
        return set()
    cleaned = re.sub(r"[^a-z\s]", " ", text.lower())
    return {
        t for t in cleaned.split()
        if len(t) > 3 and t not in _STOPWORDS
    }


def _estimate_resolved_in_days(completed_row: dict, all_eod_rows: list[dict],
                                completed_date: datetime) -> int | None:
    """Best-effort: for a completed EOD row, find the earliest prior open row
    in the same sheet whose queryText overlaps significantly, and return the
    days-between. Returns None if no plausible match.

    Uses Jaccard similarity on filtered word tokens with a 0.4 threshold and
    a minimum of 3 shared significant words to avoid false positives from
    incidental word overlap."""
    cur_text = (completed_row.get("queryText") or completed_row.get("notes") or "").strip()
    if not cur_text:
        return None
    cur_keys = _query_keyset(cur_text)
    if len(cur_keys) < 3:
        return None

    earliest: datetime | None = None
    for r in all_eod_rows or []:
        sn = (r.get("statusNorm") or "").lower()
        if sn == "completed":
            continue
        d = _parse_eod_date(r.get("date") or r.get("dateRaw") or "")
        if not d or d >= completed_date:
            continue
        other_text = (r.get("queryText") or r.get("notes") or "").strip()
        if not other_text:
            continue
        other_keys = _query_keyset(other_text)
        if len(other_keys) < 3:
            continue
        shared = cur_keys & other_keys
        if len(shared) < 3:
            continue
        union = cur_keys | other_keys
        if not union:
            continue
        if len(shared) / len(union) < 0.4:
            continue
        if earliest is None or d < earliest:
            earliest = d

    if earliest is None:
        return None
    days = (completed_date - earliest).days
    return max(0, days)


# ══════════════════════════════════════════════════════════════════════
# Weekly Review sheet — Team Lead reflections, one row per week per lead.
# Read-only consumption of a separate Google Sheet keyed by tab name.
# ══════════════════════════════════════════════════════════════════════

WEEKLY_REVIEW_SHEET_ID = os.getenv(
    "WEEKLY_REVIEW_SHEET_ID",
    # Default to the sheet ID the user provided; env var overrides.
    "1E-4WDKWWb2oFjXC5kgqJdML6VJ56iJ5e",
)
WEEKLY_REVIEW_CACHE_SECS = 300   # 5 min per spec
_WEEKLY_TAB_MATCH_TTL    = 3600  # 1 h per spec — cache positive matches
_ACTION_ITEMS_CACHE_TTL  = 3600  # 1 h per spec — cache Groq responses

# Module-level cache: { (team_id, week_offset): {"at": datetime, "data": dict} }
_weekly_review_cache: dict[tuple[str, int], dict] = {}
# Cache for resolved tab names: { team_id: {"at": datetime, "tab": str | None} }
# We cache negatives ("tab: None") with a shorter TTL window below so a lead
# adding their tab is picked up within minutes, not an hour.
_weekly_tab_match_cache: dict[str, dict] = {}
# AI action-items: { (team_id, weekRange): {"at": datetime, "items": list[str]} }
_action_items_cache: dict[tuple[str, str], dict] = {}
# Kept for backward compat with /clear-cache callers.
_weekly_review_tab_resolved: dict[str, str] = {}


def _csv_belongs_to_lead(csv_text: str, lead: str) -> bool:
    """Anti-fallback guard. gviz silently returns the FIRST tab's CSV when
    you pass an unknown sheet name (HTTP 200, no error). The weekly-review
    tabs all have a header row "WEEKLY TEAM REVIEW — {Lead}…", so we accept
    a candidate's CSV only if the first few rows mention the lead's name
    (or a known alias). Buelaangel's probe → Kokila's CSV → title says
    "Kokila", not "Buelaangel" → rejected.
    """
    if not csv_text or not lead:
        return False
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    if not rows:
        return False
    title_blob = " ".join(c for r in rows[:3] for c in (r or [])).lower()
    names = [lead, lead.split()[0]] + list(_LEAD_ALIASES.get(lead, []))
    for n in names:
        n_low = (n or "").lower().strip()
        if n_low and n_low in title_blob:
            return True
    return False

# Common alternate spellings / short forms for Team Lead names — used to
# generate candidate tab names. Lead names in TEAM_LETTER_MAP don't always
# match the tab spelling in the sheet (e.g. "Vinodhini" → "Vinothini").
_LEAD_ALIASES: dict[str, list[str]] = {
    "Buelaangel":   ["Buela"],
    "Chandralekha": ["Chandra"],
    "Logeshwari":   ["Logeswari", "Logesh"],
    "Vinodhini":    ["Vinothini", "Vino"],
    "Pavithira":    ["Pavithra"],
    "Inbamozhi":    ["Inba"],
    "Shaalini":     ["Shalini"],
}


def _candidate_weekly_tab_names(lead: str) -> list[str]:
    """Generate candidate Weekly-Review tab names for a team lead.

    Spec examples:
      "Kokila - Weekly Review"    (space-dash-space)
      "Vinothini- Weekly Review"  (no space before dash)

    Each form crosses with several separator variants. Order matters —
    earlier candidates are tried first.
    """
    forms: list[str] = [lead]
    # First word (e.g. "Buelaangel" → also "Buela")
    if " " in lead:
        forms.append(lead.split()[0])
    forms.extend(_LEAD_ALIASES.get(lead, []))

    candidates: list[str] = []
    seen: set[str] = set()
    for f in forms:
        for sep in (" - ", "- ", " -", "-"):
            name = f"{f}{sep}Weekly Review"
            if name.lower() not in seen:
                seen.add(name.lower())
                candidates.append(name)
    return candidates


# ── Column → semantic field mapping for the Weekly Review tab ──
# Columns A-Y per spec.
_WEEKLY_REVIEW_COLUMNS: list[tuple[int, str]] = [
    (0,  "weekRange"),           # A: "May 18 - May 23"
    (1,  "reviewedBy"),           # B
    (2,  "teamClient"),           # C
    (3,  "lateFiles"),            # D
    (4,  "blockedJobs"),          # E
    (5,  "scopeCreep"),           # F
    (6,  "deliveredVsContracted"),# G
    (7,  "clientBlockedHours"),   # H
    (8,  "trainingPto"),          # I
    (9,  "utilFlags"),            # J
    (10, "usNotes"),              # K
    (11, "repeatIssues"),         # L
    (12, "questionVolume"),       # M
    (13, "recognize"),            # N
    (14, "needsConversation"),    # O
    (15, "spanOfControl"),        # P
    (16, "sopGap"),               # Q
    (17, "complaintTheme"),       # R
    (18, "singlePointFailure"),   # S
    (19, "updatedThisWeek"),      # T (Whale)
    (20, "newProcedure"),         # U
    (21, "pendingUpdates"),       # V
    (22, "iOweClients"),          # W
    (23, "iOweStaff"),            # X
    (24, "iOweUS"),               # Y
]

# Sections grouping for the response payload
_WEEKLY_REVIEW_SECTIONS: dict[str, list[str]] = {
    "workIntake":    ["lateFiles", "blockedJobs", "scopeCreep"],
    "hoursCapacity": ["deliveredVsContracted", "clientBlockedHours", "trainingPto", "utilFlags"],
    "quality":       ["usNotes", "repeatIssues", "questionVolume"],
    "staffNotes":    ["recognize", "needsConversation", "spanOfControl"],
    "patterns":      ["sopGap", "complaintTheme", "singlePointFailure"],
    "whale":         ["updatedThisWeek", "newProcedure", "pendingUpdates"],
    "commitments":   ["iOweClients", "iOweStaff", "iOweUS"],
}


# Matches week-range strings in col A of a real data row. Examples that pass:
#   "May 18 - May 23", "Apr 27 - May 02", "Jun 01 - Jun 06", "5/18 - 5/23".
# Header/title rows ("Week of", "Reviewed by", "WEEKLY TEAM REVIEW — Kokila…")
# are rejected because they don't have the "<date> - <date>" shape.
_WEEK_RANGE_RE = re.compile(
    r"^\s*"
    r"(?:[A-Za-z]{3,}\.?,?\s+\d{1,2}|\d{1,2}/\d{1,2}(?:/\d{2,4})?)"
    r"\s*[-–—]\s*"
    r"(?:[A-Za-z]{3,}\.?,?\s+\d{1,2}|\d{1,2}/\d{1,2}(?:/\d{2,4})?)"
    r".*$"
)


def _looks_like_week_range(s: str) -> bool:
    return bool(_WEEK_RANGE_RE.match((s or "").strip()))


def _parse_weekly_review_csv(csv_text: str) -> list[dict]:
    """Parse the weekly-review tab CSV into a list of row dicts (one per week).

    Filters down to rows whose col A matches the "<date> - <date>" pattern, so
    the title row, section-header row, and column-header row ("Week of",
    "Reviewed by"…) are all rejected — even though their col A is non-empty.
    """
    if not csv_text:
        return []
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    if not rows:
        return []

    out: list[dict] = []
    for raw in rows:
        if not raw:
            continue
        col_a = (raw[0] if raw else "").strip()
        if not _looks_like_week_range(col_a):
            continue
        # Pad to 25 columns so column-N lookups never IndexError
        padded = list(raw) + [""] * max(0, 25 - len(raw))
        row_dict: dict[str, str] = {}
        for idx, field in _WEEKLY_REVIEW_COLUMNS:
            row_dict[field] = str(padded[idx] or "").strip()
        out.append(row_dict)
    return out


def _row_is_filled(row: dict) -> bool:
    """True iff any of cols D-Y carries text (i.e. the lead filled something
    beyond weekRange / reviewedBy / teamClient header metadata)."""
    for _, field in _WEEKLY_REVIEW_COLUMNS[3:]:  # cols D-Y
        if (row.get(field) or "").strip():
            return True
    return False


_SEVERITY_HIGH_KEYWORDS = (
    "waiting for", "blocked", "stuck", "urgent", "escalat",
    "delay", "overdue", "missing", "pending for", "not provided",
    "5+ days", "weeks", "month", "issue", "problem", "failure",
    "high priority", "critical",
)
_SEVERITY_COMPLETED_KEYWORDS = (
    "all work completed", "completed on time", "no issues",
    "no concerns", "all done", "everything fine", "running smoothly",
    "no work", "nil",
)
_SEVERITY_MEDIUM_KEYWORDS = (
    "working on", "in progress", "ongoing", "review",
    "pending", "training", "preparing", "need to",
)


def _classify_issue_severity(line: str) -> str:
    """Best-effort severity tag for a single line of weekly-review text.
    Keyword-driven; defaults to 'neutral' when no signal fires.
    """
    if not line or not line.strip():
        return "neutral"
    t = line.lower()
    if any(kw in t for kw in _SEVERITY_HIGH_KEYWORDS):
        return "high"
    if any(kw in t for kw in _SEVERITY_COMPLETED_KEYWORDS):
        return "completed"
    if any(kw in t for kw in _SEVERITY_MEDIUM_KEYWORDS):
        return "medium"
    return "neutral"


def _classify_field_lines(text: str) -> list[dict]:
    """Split free-text into non-empty trimmed lines and attach a severity tag."""
    if not text or not text.strip():
        return []
    out: list[dict] = []
    for ln in text.split("\n"):
        ln = ln.strip()
        if ln:
            out.append({"text": ln, "severity": _classify_issue_severity(ln)})
    return out


def _build_review_payload(row: dict | None) -> dict:
    """Turn a flat row dict into the section-grouped response shape.

    Each section field is emitted as {text, lines}, where `lines` is a list
    of {text, severity} entries (one per non-empty line). `text` keeps the
    raw multi-line string for callers that still want a single blob.
    """
    if not row:
        return {
            "weekRange":  None,
            "isFilled":   False,
            "reviewedBy": None,
            "sections":   None,
        }
    sections: dict[str, dict[str, dict]] = {}
    for sec_name, fields in _WEEKLY_REVIEW_SECTIONS.items():
        sections[sec_name] = {}
        for f in fields:
            raw = (row.get(f) or "").strip()
            sections[sec_name][f] = {
                "text":  raw,
                "lines": _classify_field_lines(raw),
            }
    return {
        "weekRange":   row.get("weekRange") or "",
        "isFilled":    _row_is_filled(row),
        "reviewedBy":  row.get("reviewedBy") or "",
        "teamClient":  row.get("teamClient") or "",
        "sections":    sections,
    }


def _section_field_text(section_field) -> str:
    """Accessor for the new {text, lines} field shape that also tolerates
    the legacy plain-string form."""
    if isinstance(section_field, dict):
        return (section_field.get("text") or "").strip()
    if isinstance(section_field, str):
        return section_field.strip()
    return ""


def _resolve_weekly_tab(team_id: str) -> tuple[str | None, str | None, list[str]]:
    """Returns (matched_tab_name, csv_text, candidates_tried).

    Strategy: probe each candidate tab name via gviz. For every 200 OK
    response, verify the CSV's title row actually mentions the expected
    lead — this catches gviz's silent fallback to the FIRST tab when the
    requested sheet name doesn't exist (the root cause of the original
    "all teams show Kokila's data" bug).

    Positive matches are cached for _WEEKLY_TAB_MATCH_TTL (1 h); negative
    results are cached too but with a shorter window so a lead adding their
    tab later is picked up within ~5 min (we piggyback on
    _weekly_review_cache's 5-min TTL — every full payload re-resolves).
    """
    cfg = TEAM_LETTER_MAP.get(team_id) or {}
    lead = (cfg.get("leadName") or "").strip()
    if not lead or not WEEKLY_REVIEW_SHEET_ID:
        return None, None, []

    candidates = _candidate_weekly_tab_names(lead)

    # Fast path: previously matched tab still works
    cached = _weekly_tab_match_cache.get(team_id)
    if cached and (datetime.now() - cached["at"]).total_seconds() < _WEEKLY_TAB_MATCH_TTL:
        tab = cached.get("tab")
        if tab:
            try:
                csv_text, _ = _fetch_eod_csv(WEEKLY_REVIEW_SHEET_ID, tab=tab)
                if _csv_belongs_to_lead(csv_text, lead):
                    return tab, csv_text, [tab]
            except Exception:
                pass  # fall through and re-probe

    for cand in candidates:
        try:
            csv_text, _url = _fetch_eod_csv(WEEKLY_REVIEW_SHEET_ID, tab=cand)
        except EodSheetError as e:
            # 401/403/404 from gviz → tab doesn't exist, try next
            print(f"[weeklyTab] team={team_id} cand={cand!r} skip ({e.reason})")
            continue
        except Exception as e:
            print(f"[weeklyTab] team={team_id} cand={cand!r} error: {e}")
            continue
        if not csv_text:
            continue
        if _csv_belongs_to_lead(csv_text, lead):
            _weekly_tab_match_cache[team_id] = {"at": datetime.now(), "tab": cand}
            print(f"[weeklyTab] team={team_id} matched cand={cand!r}")
            return cand, csv_text, candidates
        # gviz silently fell back to the first tab — keep probing.

    _weekly_tab_match_cache[team_id] = {"at": datetime.now(), "tab": None}
    print(f"[weeklyTab] team={team_id} lead={lead!r} no candidate matched "
          f"(tried {len(candidates)})")
    return None, None, candidates


def _fetch_weekly_review_rows(team_id: str) -> tuple[list[dict], str | None]:
    """Fetch all weekly-review rows for a team. Returns ([], None) if no tab
    candidate matched, so the caller emits isFilled=False rather than
    another team's data."""
    matched_tab, csv_text, _candidates = _resolve_weekly_tab(team_id)
    if not matched_tab or not csv_text:
        return [], None

    rows = _parse_weekly_review_csv(csv_text)
    print(f"[weeklyReview] team={team_id} matchedTab={matched_tab!r} rows={len(rows)}")
    return rows, matched_tab


def _count_commitments(text: str) -> int:
    """Counts distinct commitment items in a single 'I owe — …' field.

    Leads sometimes write commitments as one long sentence with no
    separators, so a naive newline-split underreports. We split on both
    newlines and semicolons, ignore the placeholder dash, and fall back to
    a count of 1 when there's substantive text but no separators to split on.
    """
    if not text or not text.strip():
        return 0
    items: list[str] = []
    for chunk in text.replace(";", "\n").split("\n"):
        chunk = chunk.strip()
        if chunk and len(chunk) > 5 and chunk != "—":
            items.append(chunk)
    if not items and len(text.strip()) > 10:
        return 1
    return len(items)


def _commitment_counts(commitments_section: dict | None) -> dict:
    """Returns {iOweClients, iOweStaff, iOweUS} count per category."""
    if not commitments_section:
        return {"iOweClients": 0, "iOweStaff": 0, "iOweUS": 0}
    return {
        "iOweClients": _count_commitments(_section_field_text(commitments_section.get("iOweClients"))),
        "iOweStaff":   _count_commitments(_section_field_text(commitments_section.get("iOweStaff"))),
        "iOweUS":      _count_commitments(_section_field_text(commitments_section.get("iOweUS"))),
    }


def _compute_client_mentions(team_id: str, work_intake: dict | None) -> list[dict]:
    """Counts how often each configured client (name + tsMatch aliases) appears
    in the team's Work Intake free-text fields for the picked week. Returns
    [{"client": <display name>, "count": <int>}] sorted by count desc.
    Substring match, case-insensitive."""
    if not work_intake:
        return []
    clients = TEAM_CLIENTS.get(team_id) or []
    if not clients:
        return []
    blob = " ".join([
        _section_field_text(work_intake.get("lateFiles")),
        _section_field_text(work_intake.get("blockedJobs")),
        _section_field_text(work_intake.get("scopeCreep")),
    ]).lower()
    if not blob.strip():
        return []
    out: list[dict] = []
    for c in clients:
        aliases = [c.get("name") or ""] + list(c.get("tsMatch") or [])
        seen_count = 0
        for a in aliases:
            a_low = (a or "").lower().strip()
            if a_low:
                seen_count += blob.count(a_low)
        if seen_count > 0:
            out.append({"client": c.get("name") or "", "count": seen_count})
    out.sort(key=lambda x: (-x["count"], x["client"]))
    return out


def _generate_action_items(payload: dict) -> list[str]:
    """Call Groq to produce 1-3 concrete next-week action items from this
    week's review. Returns [] if anything goes wrong (Groq error, bad JSON,
    non-list shape). Only runs when isFilled is true — avoids 15 LLM calls
    on the admin-hour fan-out for empty weeks.
    """
    if not payload or not payload.get("isFilled"):
        return []
    sections = payload.get("sections") or {}

    def _t(sec: str, field: str) -> str:
        return _section_field_text((sections.get(sec) or {}).get(field))

    review_lines = [
        f"WORK INTAKE — Late files: {_t('workIntake', 'lateFiles')}",
        f"WORK INTAKE — Blocked jobs: {_t('workIntake', 'blockedJobs')}",
        f"WORK INTAKE — Scope creep: {_t('workIntake', 'scopeCreep')}",
        f"HOURS — Delivered vs contracted: {_t('hoursCapacity', 'deliveredVsContracted')}",
        f"HOURS — Client-blocked: {_t('hoursCapacity', 'clientBlockedHours')}",
        f"HOURS — Training/PTO: {_t('hoursCapacity', 'trainingPto')}",
        f"QUALITY — US notes: {_t('quality', 'usNotes')}",
        f"QUALITY — Repeat issues: {_t('quality', 'repeatIssues')}",
        f"QUALITY — Question volume: {_t('quality', 'questionVolume')}",
        f"STAFF — Needs conversation: {_t('staffNotes', 'needsConversation')}",
        f"STAFF — Span of control: {_t('staffNotes', 'spanOfControl')}",
        f"PATTERNS — SOP gap: {_t('patterns', 'sopGap')}",
        f"PATTERNS — Complaint theme: {_t('patterns', 'complaintTheme')}",
        f"PATTERNS — Single-point failure: {_t('patterns', 'singlePointFailure')}",
        f"COMMITMENTS — I owe clients: {_t('commitments', 'iOweClients')}",
        f"COMMITMENTS — I owe staff: {_t('commitments', 'iOweStaff')}",
        f"COMMITMENTS — I owe US: {_t('commitments', 'iOweUS')}",
    ]
    review_text = "\n".join(l for l in review_lines if l.split(": ", 1)[-1].strip())
    if not review_text.strip():
        return []

    system = (
        "You read a Team Lead's weekly review and produce 1-3 concrete action "
        "items for next week. Output ONLY a JSON array of short strings — one "
        "sentence each, max 120 characters, no markdown, no code fences, no "
        "commentary. Focus on the highest-urgency unresolved items: blocked "
        "work, missing files, single-point-of-failure risks, SOP gaps, and "
        "open commitments. Skip anything already completed."
    )
    user = (
        f"Review for {payload.get('leadName') or ''} — week of "
        f"{payload.get('weekRange') or ''}:\n\n{review_text}\n\n"
        "Return JSON array now."
    )

    try:
        resp = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": user},
            ],
            max_tokens=300,
            temperature=0.3,
        )
        content = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        print(f"[actionItems] Groq error: {e}")
        return []

    # Tolerate a stray ```json fence around the JSON array
    if content.startswith("```"):
        inner = content.strip("`").strip()
        if inner.lower().startswith("json"):
            inner = inner[4:].lstrip()
        content = inner

    try:
        parsed = json.loads(content)
    except Exception as e:
        print(f"[actionItems] JSON parse error: {e} content={content[:200]!r}")
        return []

    if not isinstance(parsed, list):
        return []
    out: list[str] = []
    for item in parsed[:3]:
        if isinstance(item, str):
            s = item.strip()
            if s:
                out.append(s[:160])
    return out


def _get_action_items(payload: dict) -> list[str]:
    """Cache wrapper around _generate_action_items, keyed by (team_id,
    weekRange) so the same week's items aren't re-generated every fetch."""
    if not payload or not payload.get("isFilled"):
        return []
    team_id    = payload.get("teamId")
    week_range = (payload.get("weekRange") or "").strip()
    if not team_id or not week_range:
        return _generate_action_items(payload)
    key = (team_id, week_range)
    entry = _action_items_cache.get(key)
    if entry and (datetime.now() - entry["at"]).total_seconds() < _ACTION_ITEMS_CACHE_TTL:
        return entry["items"]
    items = _generate_action_items(payload)
    _action_items_cache[key] = {"at": datetime.now(), "items": items}
    return items


def get_weekly_review(team_id: str, week_offset: int = 0) -> dict:
    """Returns the weekly-review payload for a team at a given week offset.

    week_offset = 0 → most recent row; 1 → previous week; etc.

    Cached for WEEKLY_REVIEW_CACHE_SECS to limit upstream Google Sheets hits.
    """
    cache_key = (team_id, week_offset)
    entry = _weekly_review_cache.get(cache_key)
    if entry and (datetime.now() - entry["at"]).total_seconds() < WEEKLY_REVIEW_CACHE_SECS:
        return entry["data"]

    cfg = TEAM_LETTER_MAP.get(team_id) or {}
    rows, matched_tab = _fetch_weekly_review_rows(team_id)
    # Sheet stores weeks chronologically with newest at the bottom, so reverse
    # to get a newest-first list. We only surface filled rows in the dropdown
    # — empty future-week placeholders aren't useful navigation targets.
    filled_rows_newest_first = [r for r in reversed(rows) if _row_is_filled(r)]
    available_weeks = [
        {"weekRange": r["weekRange"], "isFilled": True}
        for r in filled_rows_newest_first
    ]
    selected_row = (
        filled_rows_newest_first[week_offset]
        if 0 <= week_offset < len(filled_rows_newest_first)
        else None
    )
    payload = _build_review_payload(selected_row)
    work_intake = (payload.get("sections") or {}).get("workIntake") if payload.get("isFilled") else None
    commitments_section = (payload.get("sections") or {}).get("commitments") if payload.get("isFilled") else None
    payload.update({
        "teamId":           team_id,
        "teamLabel":        cfg.get("label", team_id),
        "leadName":         cfg.get("leadName", ""),
        "matchedTab":       matched_tab,
        "weekOffset":       week_offset,
        "availableWeeks":   available_weeks,
        "clientMentions":   _compute_client_mentions(team_id, work_intake),
        "commitmentCounts": _commitment_counts(commitments_section),
    })
    # AI action items come last because the generator reads fields off the
    # populated payload (teamId, weekRange, leadName).
    payload["actionItems"] = _get_action_items(payload)
    _weekly_review_cache[cache_key] = {"at": datetime.now(), "data": payload}
    return payload


# ── Per-client "Delays" tab integration ────────────────────────────
# Each team's main EOD sheet has one tab per configured client (e.g.
# "Bookkeeping Doctor") with day-level batch totals. The actual delay
# questions live in a SEPARATE tab named "{client} Delays" (e.g.
# "Bookkeeping Doctor Delays") with one row per posted question and a
# resolution-notes column for completed items.
_DELAYS_TAB_MATCH_TTL = 3600  # 1 h
# (team_id, client_name) -> {at, tab_name | None, csv_text | None, candidates}
_delays_tab_match_cache: dict[tuple[str, str], dict] = {}
# team_id -> {at, questions: list[dict]} — flattened across all configured clients
_team_delay_questions_cache: dict[str, dict] = {}

_DELAYS_HEADER_KEYWORDS = (
    "question", "query", "delay", "resolution", "posted query", "raised",
)


def _csv_looks_like_delays_tab(csv_text: str) -> bool:
    """Detect gviz's silent fallback to the first (main EOD) tab. The Delays
    tab has 'question' / 'query' / 'delay' / 'resolution' in its header row;
    the main EOD tab does not."""
    if not csv_text:
        return False
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)[:5]
    blob = " ".join(c for r in rows for c in (r or [])).lower()
    return any(kw in blob for kw in _DELAYS_HEADER_KEYWORDS)


def _candidate_delays_tab_names(client_name: str, aliases: list[str] | None) -> list[str]:
    """Generate candidate tab names for a client's Delays tab. Crosses each
    name form with several suffix patterns leads have been seen to use."""
    forms: list[str] = [client_name]
    for a in aliases or []:
        if a and a not in forms:
            forms.append(a)
    suffixes = (" Delays", " - Delays", " Delay Questions", " Delay Qns", " Delay Q&A")
    out: list[str] = []
    seen: set[str] = set()
    for f in forms:
        f = (f or "").strip()
        if not f:
            continue
        for s in suffixes:
            name = f"{f}{s}"
            if name.lower() not in seen:
                seen.add(name.lower())
                out.append(name)
    return out


def _resolve_delays_tab(team_id: str, client_name: str, aliases: list[str] | None
                       ) -> tuple[str | None, str | None, list[str]]:
    """Probe gviz for the client's Delays tab on the team's main sheet.
    Returns (matched_tab_name, csv_text, candidates_tried). Each positive
    match is cached for 1 h; negative matches are cached too (with shorter
    effective TTL via the upstream team-response cache)."""
    key = (team_id, (client_name or "").strip())
    cached = _delays_tab_match_cache.get(key)
    if cached and (datetime.now() - cached["at"]).total_seconds() < _DELAYS_TAB_MATCH_TTL:
        return cached.get("tab_name"), cached.get("csv_text"), cached.get("candidates", [])

    cfg = TEAM_LETTER_MAP.get(team_id) or {}
    sheet_id = cfg.get("sheetId")
    if not sheet_id or not client_name:
        return None, None, []

    candidates = _candidate_delays_tab_names(client_name, aliases)
    matched_tab: str | None = None
    matched_csv: str | None = None
    for cand in candidates:
        try:
            csv_text, _url = _fetch_eod_csv(sheet_id, tab=cand)
        except EodSheetError as e:
            print(f"[delaysTab] team={team_id} client={client_name!r} cand={cand!r} skip ({e.reason})")
            continue
        except Exception as e:
            print(f"[delaysTab] team={team_id} client={client_name!r} cand={cand!r} error: {e}")
            continue
        if csv_text and _csv_looks_like_delays_tab(csv_text):
            matched_tab = cand
            matched_csv = csv_text
            break
        # else: gviz silently fell back to the main tab — keep probing

    _delays_tab_match_cache[key] = {
        "at":         datetime.now(),
        "tab_name":   matched_tab,
        "csv_text":   matched_csv,
        "candidates": candidates,
    }
    if matched_tab:
        print(f"[delaysTab] team={team_id} client={client_name!r} matched cand={matched_tab!r}")
    else:
        print(f"[delaysTab] team={team_id} client={client_name!r} no tab matched (tried {len(candidates)})")
    return matched_tab, matched_csv, candidates


def _parse_delays_tab_csv(csv_text: str) -> tuple[list[dict], dict]:
    """Parse a Delays tab CSV into structured rows. Column positions are
    header-driven (we don't assume fixed A-G layout). Returns (rows, mapping)
    where mapping records the column-index → semantic-field map we used."""
    if not csv_text:
        return [], {}
    reader = csv.reader(io.StringIO(csv_text))
    raw = list(reader)
    if not raw:
        return [], {}

    # Find header — first row in the top 5 that has "date" + ("question" or "query")
    header_idx = -1
    for i, row in enumerate(raw[:5]):
        if not row:
            continue
        rlow = " ".join((c or "").lower() for c in row)
        if "date" in rlow and ("question" in rlow or "query" in rlow or "delay" in rlow):
            header_idx = i
            break
    if header_idx == -1:
        # Looser fallback: any row containing 'question' / 'query'
        for i, row in enumerate(raw[:5]):
            rlow = " ".join((c or "").lower() for c in row)
            if "question" in rlow or "query" in rlow:
                header_idx = i
                break
    if header_idx == -1:
        return [], {}

    headers = [(c or "").strip() for c in raw[header_idx]]
    mapping: dict[str, int] = {}
    for idx, h in enumerate(headers):
        hl = h.lower()
        if "datePosted" not in mapping and (
            "date posted" in hl or "date raised" in hl or "posted on" in hl
            or hl == "date" or "raised date" in hl
        ):
            mapping["datePosted"] = idx
        if "questionText" not in mapping and ("question" in hl or "query" in hl or hl.startswith("delay")):
            mapping["questionText"] = idx
        if "fileReference" not in mapping and ("file" in hl or "account" in hl or "ref" in hl):
            mapping["fileReference"] = idx
        if "postedTo" not in mapping and ("posted to" in hl or "raised to" in hl or "addressee" in hl or "assigned" in hl):
            mapping["postedTo"] = idx
        if "status" not in mapping and "status" in hl:
            mapping["status"] = idx
        if "dateAnswered" not in mapping and ("date answered" in hl or "answered on" in hl or "resolved on" in hl or "date resolved" in hl):
            mapping["dateAnswered"] = idx
        if "resolutionNotes" not in mapping and ("resolution" in hl or "answer" in hl or "notes" in hl):
            mapping["resolutionNotes"] = idx

    def _col(row: list[str], key: str) -> str:
        idx = mapping.get(key)
        if idx is None or idx >= len(row):
            return ""
        return (row[idx] or "").strip()

    today = datetime.now()
    out: list[dict] = []
    for row in raw[header_idx + 1:]:
        if not row or not any((c or "").strip() for c in row):
            continue
        date_posted = _col(row, "datePosted")
        question    = _col(row, "questionText")
        if not date_posted and not question:
            continue  # skip blank rows
        normalized_posted = _normalize_eod_date(date_posted) if date_posted else ""
        date_answered = _col(row, "dateAnswered")
        normalized_answered = _normalize_eod_date(date_answered) if date_answered else ""

        # Days math (best effort)
        age_days = None
        resolved_in_days = None
        try:
            posted_dt = _parse_eod_date(normalized_posted) if normalized_posted else None
            if posted_dt:
                age_days = max(0, (today - posted_dt).days)
                if normalized_answered:
                    answered_dt = _parse_eod_date(normalized_answered)
                    if answered_dt:
                        resolved_in_days = max(0, (answered_dt - posted_dt).days)
        except Exception:
            pass

        status_raw = _col(row, "status")
        is_resolved = bool(normalized_answered) or "resolv" in status_raw.lower() or "closed" in status_raw.lower() or "complete" in status_raw.lower()

        out.append({
            "datePosted":      normalized_posted or date_posted,
            "questionText":    question,
            "fileReference":   _col(row, "fileReference"),
            "postedTo":        _col(row, "postedTo"),
            "status":          status_raw,
            "dateAnswered":    normalized_answered or None,
            "resolutionNotes": _col(row, "resolutionNotes"),
            "ageDays":         age_days,
            "resolvedInDays":  resolved_in_days,
            "isResolved":      is_resolved,
        })
    return out, mapping


def _get_team_delay_questions(team_id: str) -> list[dict]:
    """Returns a flat list of delay questions across every configured client
    for the team. Each entry carries a `clientName` field so the modal can
    show provenance. Cached per team for 1 h."""
    cached = _team_delay_questions_cache.get(team_id)
    if cached and (datetime.now() - cached["at"]).total_seconds() < _DELAYS_TAB_MATCH_TTL:
        return cached["questions"]

    clients = TEAM_CLIENTS.get(team_id) or []
    out: list[dict] = []
    for c in clients:
        name    = c.get("name") or ""
        aliases = list(c.get("tsMatch") or [])
        if not name:
            continue
        matched_tab, csv_text, _candidates = _resolve_delays_tab(team_id, name, aliases)
        if not matched_tab or not csv_text:
            continue
        rows, _mapping = _parse_delays_tab_csv(csv_text)
        for r in rows:
            r["clientName"] = name
            r["tabUsed"]    = matched_tab
            out.append(r)
    _team_delay_questions_cache[team_id] = {"at": datetime.now(), "questions": out}
    print(f"[delaysTab] team={team_id} aggregated {len(out)} delay questions across clients")
    return out


def compute_delays_aging(eod_rows: list[dict], period_start: str, period_end: str) -> dict:
    """Build aging-report aggregates from EOD rows for the given period.

    Per-day age tiers on each delaysByDay entry:
      - completed: rows whose status normalized to "completed" (any age)
      - fresh:    open rows aged 0-2 days
      - aging:    open rows aged 3-7 days
      - overdue:  open rows aged 8+ days
      - total:    completed + fresh + aging + overdue
    A row is "open" iff its statusNorm is not "completed" (or fell back to
    in_progress via the missing-status heuristic below).

    delaysAgeSummary keeps the per-card buckets the cards on the dashboard
    expect: today (age 0), 1to2days (age 1-2), 3to7days (age 3-7),
    8plusDays (age 8+), plus totalOpen and the oldest open query.
    """
    now = datetime.now()
    today_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start_d = _parse_eod_date(period_start) or today_date.replace(day=1)
    end_d   = _parse_eod_date(period_end)   or today_date

    # Bucket EOD rows by their date string (YYYY-MM-DD)
    by_day: dict[str, list[dict]] = {}
    for r in eod_rows or []:
        d = _parse_eod_date(str(r.get("date") or ""))
        if not d:
            continue
        if d < start_d or d > end_d:
            continue
        key = d.strftime("%Y-%m-%d")
        by_day.setdefault(key, []).append(r)

    today_count   = 0
    bucket_1_2    = 0
    bucket_3_7    = 0
    bucket_8_plus = 0
    oldest_days   = 0
    oldest_query  = ""

    delays_by_day: list[dict] = []
    cur = start_d
    cap = min(end_d, today_date)
    while cur <= cap:
        key = cur.strftime("%Y-%m-%d")
        day_rows = by_day.get(key, [])
        age_days = max(0, (today_date - cur).days)

        completed_ct = 0
        open_ct      = 0
        for r in day_rows:
            sn = (r.get("statusNorm") or "").lower()
            if sn == "completed":
                completed_ct += 1
            elif sn in ("in_progress", "awaiting_response"):
                open_ct += 1
            else:
                # Missing status — infer from hours: healthy = completed,
                # otherwise treat as open so it's flagged for review.
                committed = float(r.get("committed") or 0)
                booked    = float(r.get("booked") or 0)
                if committed > 0 and booked >= committed * 0.75:
                    completed_ct += 1
                else:
                    open_ct += 1

        # Stack-bar age tiers for OPEN rows only (completed is its own tier
        # regardless of age — once it's done it's done).
        if age_days <= 2:
            fresh_ct, aging_ct, overdue_ct = open_ct, 0, 0
        elif age_days <= 7:
            fresh_ct, aging_ct, overdue_ct = 0, open_ct, 0
        else:
            fresh_ct, aging_ct, overdue_ct = 0, 0, open_ct
        total_today = completed_ct + open_ct

        # Pick the longest query text on this day as the preview (legacy field
        # used by the existing tooltip code path until the new one ships).
        queries = [str(r.get("queryText") or "").strip() for r in day_rows]
        queries = [q for q in queries if q]
        query_preview = ""
        if queries:
            query_preview = max(queries, key=len)

        # Per-day topQueries — open rows on this day with non-empty queryText,
        # sorted by length desc (within one day all rows share the same age,
        # so length stands in for "most informative"). Truncated to 100 chars
        # for the tooltip. Up to 3 entries.
        open_rows_today: list[dict] = []
        for r in day_rows:
            sn = (r.get("statusNorm") or "").lower()
            if sn == "completed":
                continue
            qt = (r.get("queryText") or "").strip().replace("\n", " ")
            if not qt:
                qt = (r.get("notes") or "").strip().replace("\n", " ")
            if not qt:
                continue
            open_rows_today.append((qt, r))
        open_rows_today.sort(key=lambda pair: -len(pair[0]))
        top_queries = [
            {"text": qt[:100], "ageDays": age_days, "client": ""}
            for qt, _r in open_rows_today[:3]
        ]

        # Per-day statusBreakdown — counts by normalized status for the
        # tooltip's color-coded dots row.
        status_breakdown = {"awaiting_response": 0, "in_progress": 0, "completed": 0}
        for r in day_rows:
            sn = (r.get("statusNorm") or "").lower()
            if sn in status_breakdown:
                status_breakdown[sn] += 1

        # Full per-row detail for the click-to-open modal. Untruncated — the
        # modal renders the entire queryText + notes.
        raised_date_formatted = cur.strftime("%B %d, %Y")
        all_rows_payload: list[dict] = []
        for r in day_rows:
            sn = (r.get("statusNorm") or "").lower()
            is_completed = sn == "completed"
            row_payload = {
                "queryText":        (r.get("queryText") or ""),
                "notes":            (r.get("notes") or ""),
                "eodStatus":        (r.get("eodStatus") or ""),
                "statusNorm":       sn,
                "statusNormSource": (r.get("statusNormSource") or ""),
                "ageDays":          age_days,
                "raisedDate":       key,
                "raisedDateFormatted": raised_date_formatted,
                "isCompleted":      is_completed,
                "committed":        float(r.get("committed") or 0),
                "booked":           float(r.get("booked") or 0),
                "utilPct":          float(r.get("utilPct") or 0),
                "resolvedInDays":   None,
            }
            if is_completed:
                row_payload["resolvedInDays"] = _estimate_resolved_in_days(
                    r, eod_rows, cur,
                )
                # Derive a resolved-on date for the modal. raisedDate is
                # YYYY-MM-DD; offset by the estimated resolved-in-days.
                rid = row_payload.get("resolvedInDays")
                if rid is not None:
                    try:
                        raised_dt = datetime.strptime(key, "%Y-%m-%d")
                        resolved_dt = raised_dt + timedelta(days=int(rid))
                        row_payload["resolvedOnDate"]      = resolved_dt.strftime("%Y-%m-%d")
                        row_payload["resolvedOnFormatted"] = resolved_dt.strftime("%b %d, %Y")
                    except Exception:
                        pass
            all_rows_payload.append(row_payload)

        delays_by_day.append({
            "date":             key,
            "total":            total_today,
            "completed":        completed_ct,
            "fresh":            fresh_ct,
            "aging":            aging_ct,
            "overdue":          overdue_ct,
            "topQueries":       top_queries,
            "statusBreakdown":  status_breakdown,
            "allRows":          all_rows_payload,
            # Legacy fields, kept for back-compat with the existing
            # delaysAgeSummary caller and any downstream consumers.
            "totalDelays":      total_today,
            "inProgress":       open_ct if age_days <= 7 else 0,
            "awaitingResponse": open_ct if age_days > 7 else 0,
            "hasQuery":         bool(query_preview),
            "queryPreview":     query_preview[:200],
            "ageDays":          age_days,
        })

        # Open count for the per-card buckets
        if open_ct > 0:
            if age_days == 0:
                today_count += open_ct
            elif age_days <= 2:
                bucket_1_2 += open_ct
            elif age_days <= 7:
                bucket_3_7 += open_ct
            else:
                bucket_8_plus += open_ct

            if age_days > oldest_days:
                oldest_days  = age_days
                oldest_query = query_preview[:200] if query_preview else ""

        cur += timedelta(days=1)

    total_open = today_count + bucket_1_2 + bucket_3_7 + bucket_8_plus

    return {
        "delaysAgeSummary": {
            "today":       today_count,
            "1to2days":    bucket_1_2,
            "3to7days":    bucket_3_7,
            "8plusDays":   bucket_8_plus,
            "totalOpen":   total_open,
            "oldestDays":  oldest_days,
            "oldestQuery": oldest_query,
        },
        "delaysByDay": delays_by_day,
    }


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


_FUZZY_STRIP = re.compile(r"[\s\-\.\(\)/,'_&]+")


def _normalize_for_match(s: str) -> str:
    """Lowercase + strip whitespace, dashes, dots, parens, slashes, commas,
    apostrophes, underscores, ampersands for fuzzy customer-name comparison.
    "24Hr Bookkeeper" → "24hrbookkeeper" matches "24hr-bookkeeper" →
    "24hrbookkeeper"."""
    return _FUZZY_STRIP.sub("", (s or "").lower())


def fuzzy_contains(haystack: str, needle: str) -> bool:
    """True iff `needle` appears in `haystack` after normalizing both
    (case-insensitive, punctuation-insensitive, whitespace-insensitive)."""
    n = _normalize_for_match(needle)
    if not n:
        return False
    return n in _normalize_for_match(haystack)


def _normalize_date(date_raw) -> str:
    """Normalize any reasonable date input to 'YYYY-MM-DD'.

    The Timesheets.com upstream returns WORKDATE as 'May, 06 2026 00:00:00'
    (abbreviated month, comma, day, year, optional HH:MM:SS). We accept that
    plus ISO, slash, and dash variants. Returns '' if nothing parses, so
    callers can distinguish a missing date from a silently mangled one.
    """
    s = str(date_raw or "").strip()
    if not s:
        return ""
    # ISO first (with or without time component) — fast path
    head = s[:10]
    if len(head) == 10 and head[4] == "-" and head[7] == "-":
        try:
            datetime.strptime(head, "%Y-%m-%d")
            return head
        except ValueError:
            pass
    # Numeric slash forms — could be M/D/YYYY or M/D/YY
    if "/" in s:
        parts = s.split(" ")[0].split("/")
        if len(parts) >= 3:
            try:
                mo = int(parts[0])
                dy = int(parts[1])
                yr = int(parts[2])
                if yr < 100:
                    yr += 2000
                return f"{yr:04d}-{mo:02d}-{dy:02d}"
            except ValueError:
                pass
    # Try strptime against common variants. Most-specific (with time) first.
    # Stripping any trailing time-of-day variant we don't recognize gives the
    # date-only variants a second chance.
    base = s.split(" ", 1)[0] if " " in s and "," not in s.split(" ", 1)[0] else s
    # If there's a comma after the month abbrev (e.g. "May, 06 2026 00:00:00")
    # the date piece runs up to the second space after the comma.
    date_only = s
    if "," in s:
        # "May, 06 2026 00:00:00" → split off the time-of-day if present
        parts = s.split(" ")
        if len(parts) >= 3:
            date_only = " ".join(parts[:3])  # "May, 06 2026"
    for fmt in (
        "%b, %d %Y %H:%M:%S",  # Timesheets.com WORKDATE
        "%b, %d %Y",
        "%b %d, %Y %H:%M:%S",
        "%b %d, %Y",
        "%B %d, %Y %H:%M:%S",
        "%B %d, %Y",
        "%b %d %Y",
        "%B %d %Y",
        "%d-%b-%Y",
        "%d %b %Y",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%m/%d/%Y",
        "%m-%d-%Y",
        "%Y/%m/%d",
    ):
        for candidate in (s, date_only, base):
            try:
                return datetime.strptime(candidate, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
    return ""


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
            # LASTCHANGEDATE is the only upstream field that carries real
            # HH:MM:SS precision (verified via /api/debug/upstream-time-fields).
            # We store the parsed datetime as a naive ISO string in IST since
            # that's where Timesheets.com data originates.
            last_changed_at = _parse_change_timestamp(row.get("LASTCHANGEDATE", ""))
            rows.append({
                "userId":         userid,
                "name":           row.get("FULLNAME", "Unknown"),
                "hours":          hours,
                "billable":       str(row.get("BILLABLE", "0")) == "1",
                "customer":       row.get("CUSTOMERNAME", ""),
                "project":        row.get("PROJECTNAME", ""),
                "desc":           row.get("WORKDESCRIPTION", ""),
                "team":           team,
                "date":           _normalize_date(date_raw),
                "lastChangedAt":  last_changed_at,
            })
    return rows


_IST = ZoneInfo("Asia/Kolkata")
ACTIVE_WINDOW_MINUTES = 90


def _now_ist_naive() -> datetime:
    """Current time in Asia/Kolkata as a naive datetime, matching the naive
    ISO strings stored in row['lastChangedAt']."""
    return datetime.now(_IST).replace(tzinfo=None)


def _is_active_now(last_changed_iso: str) -> bool:
    """True iff the (naive-IST) ISO timestamp is within ACTIVE_WINDOW_MINUTES
    of current IST time."""
    if not last_changed_iso:
        return False
    try:
        then = datetime.fromisoformat(last_changed_iso)
    except (ValueError, TypeError):
        return False
    diff = (_now_ist_naive() - then).total_seconds() / 60
    return 0 <= diff <= ACTIVE_WINDOW_MINUTES


def _parse_change_timestamp(raw) -> str:
    """Parse a Timesheets.com LASTCHANGEDATE value into a naive ISO string.

    Upstream format observed: 'May, 08 2026 12:43:23'. Returns '' if blank
    or unparseable. The returned string omits the timezone suffix — callers
    treat it as Asia/Kolkata-local (where Timesheets.com data originates).
    """
    s = ("" if raw is None else str(raw)).strip()
    if not s:
        return ""
    for fmt in (
        "%b, %d %Y %H:%M:%S",
        "%b %d, %Y %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%y %H:%M:%S",
    ):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%dT%H:%M:%S")
        except ValueError:
            continue
    return ""


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

    # ── Authoritative aggregation against TEAM_CLIENTS[team_id] ───
    # Seed every configured client with zero so they always appear in the table
    # (even if no time logged yet). Unmatched rows fall into "Internal / Other".
    team_client_cfg = TEAM_CLIENTS.get(team_id) or []
    orgs: dict = {}
    for cfg_entry in team_client_cfg:
        orgs[cfg_entry["name"]] = {
            "billable":    0.0,
            "nonBillable": 0.0,
            "staff":       set(),
            "estHrs":      cfg_entry.get("estHrs", 0),
            "tz":          cfg_entry.get("tz", ""),
            "meeting":     cfg_entry.get("meeting", "No scheduled meeting"),
            "tsMatch":     list(cfg_entry.get("tsMatch") or []),
            "matchedCustomers": set(),
            "rowsMatched": 0,
            "isConfig":    True,
        }
    orgs["Internal / Other"] = {
        "billable":    0.0,
        "nonBillable": 0.0,
        "staff":       set(),
        "estHrs":      0,
        "tz":          "",
        "meeting":     "",
        "tsMatch":     [],
        "matchedCustomers": set(),
        "rowsMatched": 0,
        "isConfig":    False,
    }

    total_rows = 0
    matched_rows = 0
    staff_names_found: set = set()

    # Match priority: assign_row_to_team (handles multi-team name ambiguity)
    # → falls back to row["team"] label equality when no roster is configured.
    def _row_matches(row) -> bool:
        return row_belongs_to_team(row, team_id)

    for row in rows:
        h = float(row.get("hours", 0))
        if h <= 0:
            continue
        total_rows += 1

        fullname = (row.get("name") or "").strip()
        if not _row_matches(row):
            continue

        billable = bool(row.get("billable"))
        customer = (row.get("customer") or "").strip()
        desc     = (row.get("desc") or "").strip()

        # INTERNAL_CODES short-circuit: SNMP / breaks / admin / training rows
        # never get matched against TEAM_CLIENTS — they bucket directly into
        # "Internal / Other" so the hours are preserved (not silently dropped)
        # but don't pollute any configured client.
        if is_internal_code(customer):
            bucket = orgs["Internal / Other"]
            resolved = None
        else:
            # Resolve against TEAM_CLIENTS; non-matches go to "Internal / Other".
            resolved = _resolve_client_for_team(team_id, customer, desc)
            bucket   = orgs[resolved] if resolved else orgs["Internal / Other"]

        matched_rows += 1
        staff_names_found.add(fullname)
        if billable:
            bucket["billable"] += h
        else:
            bucket["nonBillable"] += h
        bucket["staff"].add(fullname)
        bucket["rowsMatched"] += 1
        if customer:
            bucket["matchedCustomers"].add(customer)

    clients_data = []
    for org_name, h in orgs.items():
        actual = h["billable"] + h["nonBillable"]
        committed = h["estHrs"] or 0
        util = round(actual / committed * 100, 1) if committed > 0 else 0
        gap  = round(actual - committed, 1) if committed > 0 else 0.0
        if committed > 0:
            if util > 95:
                status = "OVER TARGET"
            elif util >= 75:
                status = "ON TARGET"
            elif util < 50:
                status = "CRITICAL"
            else:
                status = "BELOW TARGET"
        else:
            status = "PLACEHOLDER" if h["isConfig"] else "OTHER"
        clients_data.append({
            "name":        org_name,
            "org":         org_name,
            "committed":   round(committed, 1),
            "actual":      round(actual, 1),
            "billable":    round(h["billable"], 1),
            "nonBillable": round(h["nonBillable"], 1),
            "total":       round(actual, 1),
            "efficiency":  util,
            "utilPct":     util,
            "gap":         gap,
            "staffCount":  len(h["staff"]),
            "rowsMatched":     h["rowsMatched"],
            "matchedCustomers": sorted(h["matchedCustomers"]),
            "delays":      0,
            "status":      status,
            "timezone":    h["tz"],
            "meeting":     h["meeting"],
            "isPlaceholder": h["isConfig"] and committed == 0 and actual == 0,
            "isInternalOther": not h["isConfig"],
        })
        if h["isConfig"]:
            print(f"[client-match] team={team_id} client={org_name!r} "
                  f"tsMatchTried={h['tsMatch']} "
                  f"customersMatched={sorted(h['matchedCustomers'])} "
                  f"rowsMatched={h['rowsMatched']} hours={round(actual, 1)}")

    # Sort: configured clients first (by actual desc), Internal / Other last (only if non-zero).
    def _sort_key(c):
        if c["isInternalOther"]:
            return (1, -c["actual"])
        return (0, -c["actual"])
    clients_data = [
        c for c in clients_data
        if not c["isInternalOther"] or c["actual"] > 0
    ]
    clients_data.sort(key=_sort_key)

    print(f"[DEBUG] team={team_id} roster={roster} staffFound={sorted(staff_names_found)[:10]}")

    total_b  = round(sum(c["billable"]    for c in clients_data), 1)
    total_nb = round(sum(c["nonBillable"] for c in clients_data), 1)
    total    = round(total_b + total_nb, 1)

    # EOD values came from the parallel asyncio.gather above; just count delays.
    total_delays = sum(int(e.get("delays") or 0) for e in eod_rows)
    delays_aging = compute_delays_aging(eod_rows, start, end)

    # Enrich each delaysByDay[i] with the matching delay-question rows from
    # the per-client "{Client} Delays" tab. We attach the questions to the
    # day they were datePosted on. Skipped for the admin-hour fan-out
    # (different code path) — only the team endpoint pays the probe cost.
    try:
        questions = await asyncio.to_thread(_get_team_delay_questions, team_id)
    except Exception as e:
        print(f"[delaysTab] team={team_id} aggregator failed: {e}")
        questions = []
    if questions:
        by_date: dict[str, list[dict]] = {}
        for q in questions:
            dp = (q.get("datePosted") or "")[:10]
            if dp:
                by_date.setdefault(dp, []).append(q)
        for day in delays_aging.get("delaysByDay") or []:
            d_key = (day.get("date") or "")[:10]
            day["delayQuestionsForDay"] = by_date.get(d_key, [])

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

    if roster and len(roster) == 1 and matched_rows == 0 and total_rows > 0:
        print(f"[WARN] {team_id} roster has only 1 entry {roster!r} but matched 0 rows. "
              f"This team may need additional preparers added to TEAM_ROSTERS.")

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
        "eod":              eod_rows,
        "eodError":         eod_error,
        "hasEodSheet":      bool(sheet_id),
        "delaysAgeSummary": delays_aging["delaysAgeSummary"],
        "delaysByDay":      delays_aging["delaysByDay"],
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
    team_rows = [r for r in rows if row_belongs_to_team(r, team_id)]
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


@app.get("/api/debug/upstream-time-fields")
def debug_upstream_time_fields():
    """Probe whether the Timesheets.com upstream returns any per-row
    timestamp field (clock-in, clock-out, last-changed, etc).

    Lists every field key from the first 3 rows of a one-week report, then
    isolates any field whose name contains TIME/DATE/CHANG/CLOCK/START/END/
    CREAT/UPDAT/STAMP — and shows a sample value so we can see whether the
    value carries HH:MM:SS precision or is date-only.

    This is the precondition check for the proposed "Currently Active" and
    "Daily Timeline" features. If no time-bearing field exists upstream,
    those features can't have per-row precision without fabricating data.
    """
    today = datetime.now()
    start = (today - timedelta(days=7)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")
    data = _debug_fetch_raw(start, end, "None")
    if not isinstance(data, dict) or "error" in data:
        return {"error": data.get("error") if isinstance(data, dict) else "no data"}

    report = data.get("report") or {}
    report_data = report.get("ReportData") or []
    rows: list[dict] = []
    for group in report_data:
        recs = group.get("Records") or {}
        for row in (recs.get("Data") or []):
            rows.append(row)
            if len(rows) >= 3:
                break
        if len(rows) >= 3:
            break

    all_keys: set = set()
    for r in rows:
        all_keys.update(r.keys())

    time_tokens = ("TIME", "DATE", "CHANG", "CLOCK", "START", "END",
                   "CREAT", "UPDAT", "STAMP", "PUNCH")
    time_like_keys = sorted(k for k in all_keys
                            if any(tok in k.upper() for tok in time_tokens))

    # For each time-like key, sample values from the first 3 rows
    time_like_samples: dict = {}
    for k in time_like_keys:
        vals = []
        for r in rows:
            v = r.get(k)
            if v not in (None, ""):
                vals.append(str(v))
        time_like_samples[k] = vals[:3]

    # Heuristic: does any time-like field carry HH:MM:SS precision (not just
    # "00:00:00" trailing on a date)? Look for non-zero seconds.
    def _has_realtime(samples: list) -> bool:
        for s in samples:
            # Check for any "HH:MM:SS" pattern where time isn't 00:00:00
            m = re.search(r"\b(\d{1,2}):(\d{2}):(\d{2})\b", s)
            if m:
                hh, mm, ss = m.group(1), m.group(2), m.group(3)
                if not (hh == "00" and mm == "00" and ss == "00"):
                    return True
        return False

    realtime_fields = [k for k, vals in time_like_samples.items() if _has_realtime(vals)]

    return {
        "range":                  {"start": start, "end": end},
        "total_keys_per_row":     len(all_keys),
        "row_keys_sorted":        sorted(all_keys),
        "time_like_keys":         time_like_keys,
        "time_like_samples":      time_like_samples,
        "fields_with_real_clock": realtime_fields,
        "first_3_rows_full":      rows,
        "verdict": (
            "Upstream has per-row clock precision in: " + ", ".join(realtime_fields)
            if realtime_fields else
            "Upstream returns date-only values (all HH:MM:SS are 00:00:00 or absent). "
            "Per-minute features (live presence, timeline blocks) can't be built without "
            "fabricating times."
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


# ── Employee drill-down ───────────────────────────────────────────

def _team_member_count(team_id: str) -> int:
    """Count of staff associated with a team — used as the divisor for
    per-employee committed hours. Prefers the admin-hierarchy count when
    available, falls back to roster keyword count."""
    admin_id = TEAM_ADMIN_MAP.get(team_id)
    if admin_id:
        # Count from cached users: admin + everyone reporting to them.
        users = USERS_CACHE.get("data") or []
        if users:
            members = sum(
                1 for u in users
                if str(u.get("USERID", "")) == admin_id
                or str(u.get("ADMINUSERID") or "") == admin_id
            )
            if members > 0:
                return members
    roster = TEAM_ROSTERS.get(team_id, [])
    if roster:
        return len(roster)
    return 1  # Avoid div-by-zero downstream


def get_employee_committed_hours(team_id: str, period: str) -> float:
    """Per-employee target hours for the period.
    Monthly = (sum of TEAM_CLIENTS[team_id].estHrs) / member_count.
    Weekly = monthly / 4.33, today = monthly / today.day.
    Returns 0.0 if the team has no estHrs configured."""
    clients_cfg = TEAM_CLIENTS.get(team_id) or []
    total_est = sum(float(c.get("estHrs") or 0) for c in clients_cfg)
    if total_est <= 0:
        return 0.0
    members = max(1, _team_member_count(team_id))
    monthly = total_est / members
    if period == "weekly":
        return round(monthly / 4.33, 1)
    if period == "today":
        day = max(1, datetime.now().day)
        return round(monthly / day, 1)
    return round(monthly, 1)


def _employee_match(row_name: str, query: str) -> bool:
    """Case-insensitive substring match either direction. Handles 'Buelaangel'
    matching 'Buelaangel T' (and vice-versa)."""
    r = (row_name or "").lower().strip()
    q = (query or "").lower().strip()
    if not r or not q:
        return False
    return q in r or r in q


def _match_employee_rows(rows: list, employee_name: str) -> tuple[list, str]:
    """Pick the rows belonging to `employee_name` using a cascade of strategies.

    Returns (matched_rows, strategy_label). Strategies tried in order:
      1. exact_full        — full-name token equality (case-insensitive)
      2. fullname_prefix   — every token in query is a prefix of some name token
                             (handles "Pavithra S" → "Pavithra Srinivasan")
      3. first_name_only   — only the first token of the query matches the first
                             name token (last-resort, only if 1 and 2 found nothing)
    """
    q = (employee_name or "").strip()
    if not q:
        return [], "empty_query"
    q_lower = q.lower()
    q_tokens = [t for t in re.split(r"[\s\-\.,]+", q_lower) if t]
    if not q_tokens:
        return [], "empty_query"

    # 1. Exact full-name equality (tokens equal)
    exact: list = []
    for r in rows:
        n = (r.get("name") or "").lower().strip()
        n_tokens = [t for t in re.split(r"[\s\-\.,]+", n) if t]
        if n_tokens == q_tokens:
            exact.append(r)
    if exact:
        return exact, "exact_full"

    # 2. Prefix-tokens: every token in query is a prefix of some token in name.
    prefix: list = []
    for r in rows:
        n = (r.get("name") or "").lower().strip()
        n_tokens = [t for t in re.split(r"[\s\-\.,]+", n) if t]
        if not n_tokens:
            continue
        if all(any(nt.startswith(qt) for nt in n_tokens) for qt in q_tokens):
            prefix.append(r)
    if prefix:
        return prefix, "fullname_prefix"

    # 3. First-name only fallback
    first = q_tokens[0]
    if len(first) < 3:
        return [], "no_match"
    first_only: list = []
    for r in rows:
        n = (r.get("name") or "").lower().strip()
        n_tokens = [t for t in re.split(r"[\s\-\.,]+", n) if t]
        if n_tokens and n_tokens[0].startswith(first):
            first_only.append(r)
    if first_only:
        return first_only, "first_name_only"
    return [], "no_match"


def _build_employee_response(team_id: str, employee_name: str, period: str) -> dict:
    cfg = TEAM_LETTER_MAP.get(team_id)
    if not cfg:
        return {"error": "Team not found", "teamId": team_id}

    start, end, label = date_range_for_period(period)
    rows = get_cached_rows(start, end)

    # Cascade name match (exact → prefix → first-name)
    emp_rows, strategy = _match_employee_rows(rows, employee_name)
    canonical_name = (emp_rows[0].get("name") if emp_rows else employee_name)

    total_h     = sum(float(r.get("hours") or 0) for r in emp_rows)
    billable_h  = sum(float(r.get("hours") or 0) for r in emp_rows if r.get("billable"))
    nonbill_h   = total_h - billable_h
    bill_pct    = round(billable_h / total_h * 100, 1) if total_h > 0 else 0.0

    committed = get_employee_committed_hours(team_id, period)
    util_pct  = round(billable_h / committed * 100, 1) if committed > 0 else 0.0

    # Top clients (by hours) — resolve via TEAM_CLIENTS where possible, else raw customer name.
    by_client: dict = {}
    for r in emp_rows:
        h = float(r.get("hours") or 0)
        if h <= 0:
            continue
        customer = (r.get("customer") or "").strip() or "Internal / Admin"
        canonical = _resolve_client_for_team(team_id, customer, r.get("desc") or "") or customer
        entry = by_client.setdefault(canonical, {"hours": 0.0, "billable": 0.0, "nonBillable": 0.0})
        entry["hours"] += h
        if r.get("billable"):
            entry["billable"] += h
        else:
            entry["nonBillable"] += h
    top_clients = [
        {
            "client":      name,
            "hours":       round(v["hours"], 1),
            "billable":    round(v["billable"], 1),
            "nonBillable": round(v["nonBillable"], 1),
        }
        for name, v in sorted(by_client.items(), key=lambda kv: -kv[1]["hours"])
    ][:5]

    # Recent work — top 30 rows sorted by date desc
    def _row_date_key(r):
        d = (r.get("date") or "")[:10]
        return d if d else "0000-00-00"
    recent = sorted(emp_rows, key=_row_date_key, reverse=True)[:30]
    recent_out = [
        {
            "date":     (r.get("date") or "")[:10],
            "client":   r.get("customer") or "",
            "project":  r.get("project") or "",
            "hours":    round(float(r.get("hours") or 0), 1),
            "desc":     (r.get("desc") or "").strip(),
            "billable": bool(r.get("billable")),
        }
        for r in recent
    ]

    # Daily hours — fill every day in the period. Rows whose date can't be
    # normalized still count toward total hours, but can't be placed on a
    # specific day — they're tracked in undated_hours for the [employee] log.
    daily_buckets: dict = {}
    undated_hours = 0.0
    for r in emp_rows:
        d = _normalize_date(r.get("date"))
        h = float(r.get("hours") or 0)
        if not d:
            undated_hours += h
            continue
        bucket = daily_buckets.setdefault(d, {"hours": 0.0, "billable": 0.0, "nonBillable": 0.0})
        bucket["hours"] += h
        if r.get("billable"):
            bucket["billable"] += h
        else:
            bucket["nonBillable"] += h

    # Build a continuous date series start..min(end, today). Future days in the
    # period don't belong in the chart.
    daily_out = []
    try:
        start_d = datetime.strptime(start, "%Y-%m-%d")
        end_d   = datetime.strptime(end,   "%Y-%m-%d")
        today_d = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        cap     = min(end_d, today_d)
        cur = start_d
        while cur <= cap:
            key = cur.strftime("%Y-%m-%d")
            b = daily_buckets.get(key, {"hours": 0.0, "billable": 0.0, "nonBillable": 0.0})
            daily_out.append({
                "date":        key,
                "hours":       round(b["hours"], 1),
                "billable":    round(b["billable"], 1),
                "nonBillable": round(b["nonBillable"], 1),
            })
            cur += timedelta(days=1)
    except Exception:
        daily_out = [
            {
                "date":        k,
                "hours":       round(v["hours"], 1),
                "billable":    round(v["billable"], 1),
                "nonBillable": round(v["nonBillable"], 1),
            }
            for k, v in sorted(daily_buckets.items())
        ]

    first_date = daily_out[0]["date"]  if daily_out else "—"
    last_date  = daily_out[-1]["date"] if daily_out else "—"
    print(f"[employee] name={employee_name!r} team={team_id} strategy={strategy} "
          f"matchedRows={len(emp_rows)} totalHours={round(total_h, 1)} "
          f"dailyHoursCount={len(daily_out)} firstDate={first_date} lastDate={last_date} "
          f"undatedHours={round(undated_hours, 1)}")

    # Last-activity fields — pulled from the row with the latest LASTCHANGEDATE
    last_row = None
    last_lc  = ""
    for r in emp_rows:
        lc = r.get("lastChangedAt") or ""
        if lc and lc > last_lc:
            last_lc  = lc
            last_row = r
    last_desc = (last_row.get("desc") if last_row else "") or ""
    last_desc = last_desc.strip().replace("\n", " ")

    return {
        "name":              canonical_name,
        "team_id":           team_id,
        "team_name":         cfg.get("label", team_id),
        "period":            label,
        "totalHours":        round(total_h, 1),
        "billableHours":     round(billable_h, 1),
        "nonBillableHours":  round(nonbill_h, 1),
        "billablePct":       bill_pct,
        "committedHours":    round(committed, 1),
        "utilizationPct":    util_pct,
        "topClients":        top_clients,
        "recentWork":        recent_out,
        "dailyHours":        daily_out,
        "rowCount":          len(emp_rows),
        "lastLoggedAt":      last_lc,
        "lastLoggedClient":  (last_row.get("customer") if last_row else "") or "",
        "lastLoggedProject": (last_row.get("project")  if last_row else "") or "",
        "lastLoggedDesc":    last_desc[:80],
        "lastLoggedHours":   round(float(last_row.get("hours") or 0), 1) if last_row else 0,
        "activeNow":         _is_active_now(last_lc),
    }


@app.get("/api/team/{team_id}/employee/{employee_name}/{period}")
async def employee_endpoint(team_id: str, employee_name: str, period: str):
    if period not in ("today", "weekly", "monthly"):
        return {"error": "Invalid period. Use today | weekly | monthly."}
    t0 = time.perf_counter()
    result = await asyncio.to_thread(_build_employee_response, team_id, employee_name, period)
    print(f"[PERF] employee={employee_name} team={team_id} {period} "
          f"total={time.perf_counter()-t0:.2f}s rows={result.get('rowCount', 0)}")
    return result


# ── Leaderboard ──────────────────────────────────────────────────

_leaderboard_cache: dict = {}
LEADERBOARD_CACHE_SECS = 60  # 1 min — short enough for auto-refresh to feel live


def _previous_period_range(period: str) -> tuple[str, str] | None:
    """Same shape as date_range_for_period but for the previous period.
    Used to compute the trend direction. Returns None for unsupported periods."""
    today = datetime.now()
    if period == "today":
        d = today - timedelta(days=1)
        s = d.strftime("%Y-%m-%d")
        return s, s
    if period == "weekly":
        cur_start = today - timedelta(days=today.weekday())
        prev_end  = cur_start - timedelta(days=1)
        prev_start = prev_end - timedelta(days=6)
        return prev_start.strftime("%Y-%m-%d"), prev_end.strftime("%Y-%m-%d")
    if period == "monthly":
        first_this = today.replace(day=1)
        last_prev  = first_this - timedelta(days=1)
        first_prev = last_prev.replace(day=1)
        return first_prev.strftime("%Y-%m-%d"), last_prev.strftime("%Y-%m-%d")
    return None


def _build_leaderboard(team_id: str, period: str) -> dict:
    cfg = TEAM_LETTER_MAP.get(team_id)
    if not cfg:
        return {"error": "Team not found", "teamId": team_id}

    start, end, label = date_range_for_period(period)
    rows = get_cached_rows(start, end)
    team_label = cfg.get("label", team_id)
    roster     = TEAM_ROSTERS.get(team_id, [])
    committed  = get_employee_committed_hours(team_id, period)

    # Same logic _team_response uses: assign_row_to_team handles multi-team ambiguity.
    def _row_matches(row) -> bool:
        return row_belongs_to_team(row, team_id)

    by_emp: dict = {}
    for r in rows:
        if not _row_matches(r):
            continue
        name = (r.get("name") or "").strip()
        if not name:
            continue
        h = float(r.get("hours") or 0)
        entry = by_emp.setdefault(name, {
            "billable":      0.0,
            "total":         0.0,
            "lastChangedAt": "",
            "lastRow":       None,
        })
        entry["total"] += h
        if r.get("billable"):
            entry["billable"] += h
        # Track the row with the latest LASTCHANGEDATE for this employee
        lc = r.get("lastChangedAt") or ""
        if lc and lc > entry["lastChangedAt"]:
            entry["lastChangedAt"] = lc
            entry["lastRow"]       = r

    # Previous-period rows for trend (only if already cached — never re-fetch)
    prev_by_emp: dict = {}
    prev_range = _previous_period_range(period)
    if prev_range:
        prev_key = f"{prev_range[0]}_{prev_range[1]}"
        prev_entry = _rows_cache.get(prev_key)
        if prev_entry and isinstance(prev_entry.get("rows"), list):
            for r in prev_entry["rows"]:
                if not _row_matches(r):
                    continue
                name = (r.get("name") or "").strip()
                if not name:
                    continue
                h = float(r.get("hours") or 0)
                pe = prev_by_emp.setdefault(name, {"billable": 0.0, "total": 0.0})
                pe["total"] += h
                if r.get("billable"):
                    pe["billable"] += h

    members = []
    for name, v in by_emp.items():
        util = round(v["billable"] / committed * 100, 1) if committed > 0 else 0.0
        prev = prev_by_emp.get(name)
        if prev and committed > 0:
            prev_util = prev["billable"] / committed * 100
            delta = util - prev_util
            trend = "up" if delta > 5 else ("down" if delta < -5 else "flat")
        else:
            trend = "flat"
        # Last-activity fields, pulled from the row with the latest
        # LASTCHANGEDATE for this employee.
        last_changed   = v["lastChangedAt"]
        last_row       = v["lastRow"] or {}
        last_desc      = (last_row.get("desc") or "").strip().replace("\n", " ")
        active_now     = _is_active_now(last_changed)
        members.append({
            "name":             name,
            "billable":         round(v["billable"], 1),
            "committed":        round(committed, 1),
            "utilPct":          util,
            "totalHours":       round(v["total"], 1),
            "trend":            trend,
            "lastLoggedAt":     last_changed,
            "lastLoggedClient": (last_row.get("customer") or "").strip(),
            "lastLoggedProject": (last_row.get("project") or "").strip(),
            "lastLoggedDesc":   last_desc[:80],
            "lastLoggedHours":  round(float(last_row.get("hours") or 0), 1) if last_row else 0,
            "activeNow":        active_now,
        })

    members.sort(key=lambda m: -m["utilPct"])
    for i, m in enumerate(members):
        m["rank"] = i + 1

    print(f"[teamMembers] team={team_id} rosterCount={len(roster)} foundEmployees={len(members)} "
          f"names={[m['name'] for m in members]}")

    return {
        "team_id":  team_id,
        "team_name": team_label,
        "period":   label,
        "members":  members,
    }


@app.get("/api/team/{team_id}/leaderboard/{period}")
async def leaderboard_endpoint(team_id: str, period: str):
    if period not in ("today", "weekly", "monthly"):
        return {"error": "Invalid period. Use today | weekly | monthly."}

    cache_key = f"{team_id}_{period}"
    now = datetime.now()
    entry = _leaderboard_cache.get(cache_key)
    if entry and (now - entry["at"]).total_seconds() < LEADERBOARD_CACHE_SECS:
        cached = dict(entry["data"])
        cached["fromCache"] = True
        return cached

    t0 = time.perf_counter()
    result = await asyncio.to_thread(_build_leaderboard, team_id, period)
    print(f"[PERF] leaderboard team={team_id} {period} total={time.perf_counter()-t0:.2f}s "
          f"members={len(result.get('members', []))}")
    result["fromCache"] = False
    if not result.get("error"):
        _leaderboard_cache[cache_key] = {"data": result, "at": now}
    return result


# Registered BEFORE the /api/team/{team_id}/{period} catch-all below — otherwise
# the period placeholder would swallow "admin-review" and reject it as an
# invalid period.
@app.get("/api/team/{team_id}/admin-review")
async def admin_review_endpoint(team_id: str, week_offset: int = 0):
    """Per-team weekly admin-review payload for a given week_offset (0 = newest row).
    Tab name is matched against the team lead's name with several spelling
    variants — see _candidate_weekly_tab_names."""
    if team_id not in TEAM_LETTER_MAP:
        return {"error": f"unknown team_id {team_id}"}
    if week_offset < 0:
        week_offset = 0
    result = await asyncio.to_thread(get_weekly_review, team_id, week_offset)
    return result


def _debug_weekly_review(team_id: str) -> dict:
    """Returns the raw CSV grid alongside the parsed rows so we can see exactly
    which row the parser is picking and which rows it's skipping (title /
    section-headers / column-headers). Uses the same direct-probe resolver
    as the production endpoint, so it's subject to the same anti-fallback
    title-row guard."""
    cfg = TEAM_LETTER_MAP.get(team_id) or {}
    lead = (cfg.get("leadName") or "").strip()
    if not lead or not WEEKLY_REVIEW_SHEET_ID:
        return {"error": "team_id has no leadName or WEEKLY_REVIEW_SHEET_ID is unset",
                "team_id": team_id}

    matched_tab, csv_text, candidates = _resolve_weekly_tab(team_id)

    raw_rows: list[list[str]] = []
    if csv_text:
        try:
            reader = csv.reader(io.StringIO(csv_text))
            raw_rows = list(reader)
        except Exception:
            pass

    if not matched_tab:
        return {
            "team_id":          team_id,
            "lead_name":        lead,
            "sheet_id":         WEEKLY_REVIEW_SHEET_ID,
            "tab_used":         None,
            "tried_candidates": candidates,
        }

    parsed = []
    for i, raw in enumerate(raw_rows):
        col_a = (raw[0] if raw else "").strip()
        kept = _looks_like_week_range(col_a)
        parsed.append({
            "sheet_row":          i + 1,  # 1-indexed to match the sheet UI
            "col_a":               col_a,
            "kept_as_data_row":    kept,
            "is_filled":           False,
            "row_dict":            None,
            "raw":                 list(raw),
        })

    # Now fill in is_filled / row_dict for the rows we kept
    data_rows: list[dict] = []
    for entry in parsed:
        if not entry["kept_as_data_row"]:
            continue
        padded = list(entry["raw"]) + [""] * max(0, 25 - len(entry["raw"]))
        row_dict = {field: str(padded[idx] or "").strip()
                    for idx, field in _WEEKLY_REVIEW_COLUMNS}
        entry["row_dict"]  = row_dict
        entry["is_filled"] = _row_is_filled(row_dict)
        data_rows.append({"sheet_row": entry["sheet_row"], "row": row_dict})

    # Pick newest filled (sheet has newest at bottom → reverse)
    filled_newest_first = [d for d in reversed(data_rows) if _row_is_filled(d["row"])]
    picked = filled_newest_first[0] if filled_newest_first else None

    return {
        "team_id":             team_id,
        "lead_name":           lead,
        "sheet_id":            WEEKLY_REVIEW_SHEET_ID,
        "tab_used":            matched_tab,
        "total_rows_scanned":  len(raw_rows),
        "filled_rows_found":   len(filled_newest_first),
        "all_filled_weeks":    [d["row"]["weekRange"] for d in filled_newest_first],
        "picked_sheet_row":    picked["sheet_row"] if picked else None,
        "picked_row_raw":      next((p["raw"] for p in parsed
                                     if picked and p["sheet_row"] == picked["sheet_row"]),
                                    None),
        "parsed_data":         picked["row"] if picked else None,
        "row_3_for_comparison": parsed[2]["raw"] if len(parsed) >= 3 else None,
        "all_rows_summary":    [
            {"sheet_row": p["sheet_row"], "col_a": p["col_a"],
             "kept_as_data_row": p["kept_as_data_row"], "is_filled": p["is_filled"]}
            for p in parsed
        ],
    }


def _debug_weekly_review_tabs() -> dict:
    """Per-team weekly-review tab probe report. For each team, lists the
    candidate names tried, which one matched (if any), and a short sample
    of the matched tab's first row so we can confirm we got the right tab
    rather than gviz's silent fallback to the first sheet."""
    mapping = []
    matched_count = 0
    for tid in TEAM_ORDER:
        cfg  = TEAM_LETTER_MAP.get(tid) or {}
        lead = (cfg.get("leadName") or "").strip()
        matched_tab, csv_text, candidates = _resolve_weekly_tab(tid)
        sample = ""
        if csv_text:
            try:
                reader = csv.reader(io.StringIO(csv_text))
                rows = list(reader)
                if rows:
                    sample = " | ".join(c.strip() for c in rows[0][:5] if c.strip())[:160]
            except Exception:
                pass
        if matched_tab:
            matched_count += 1
        mapping.append({
            "team_id":          tid,
            "leadName":         lead,
            "candidates_tried": candidates,
            "matchedTab":       matched_tab,
            "status":           "matched" if matched_tab else "no_tab_for_this_team",
            "first_row_sample": sample,
        })
    return {
        "sheet_id":            WEEKLY_REVIEW_SHEET_ID,
        "matched_count":       matched_count,
        "total_teams":         len(TEAM_ORDER),
        "team_to_tab_mapping": mapping,
    }


@app.get("/api/debug/weekly-review-tabs")
async def debug_weekly_review_tabs_endpoint():
    """Lists every tab discovered in the weekly-review sheet and shows which
    team_id (if any) maps to each. Confirms unfilled teams don't silently
    inherit another lead's data."""
    return await asyncio.to_thread(_debug_weekly_review_tabs)


def _debug_delays_tab(team_id: str, client: str) -> dict:
    """Diagnostic dump of a single client's Delays tab probe. Shows the
    candidates we tried, which one matched, the discovered column mapping,
    and a sample of parsed rows so we can verify the schema before relying
    on the integration in the modal."""
    if team_id not in TEAM_LETTER_MAP:
        return {"error": f"unknown team_id {team_id}"}
    if not client:
        return {"error": "missing client query param"}
    clients_cfg = TEAM_CLIENTS.get(team_id) or []
    aliases: list[str] = []
    for c in clients_cfg:
        if (c.get("name") or "").lower() == client.lower():
            aliases = list(c.get("tsMatch") or [])
            break
    matched_tab, csv_text, candidates = _resolve_delays_tab(team_id, client, aliases)
    if not matched_tab:
        return {
            "team_id":        team_id,
            "client_name":    client,
            "tab_name_tried": candidates,
            "tab_found":      None,
            "row_count":      0,
            "note":           "No matching Delays tab found in the team's sheet.",
        }
    parsed, mapping = _parse_delays_tab_csv(csv_text)
    return {
        "team_id":                  team_id,
        "client_name":              client,
        "tab_name_tried":           candidates,
        "tab_found":                matched_tab,
        "row_count":                len(parsed),
        "column_mapping_detected":  mapping,
        "sample_rows":              parsed[:10],
    }


@app.get("/api/debug/delays-tab")
async def debug_delays_tab_endpoint(team_id: str, client: str):
    """Probes the team's main sheet for the '{client} Delays' tab and returns
    the discovered schema + first 10 parsed rows. Use this to verify the tab
    exists with the expected columns before the modal integration is trusted."""
    return await asyncio.to_thread(_debug_delays_tab, team_id, client)


@app.get("/api/debug/weekly-review")
async def debug_weekly_review_endpoint(team_id: str):
    """Diagnostic dump of the weekly-review sheet for a given team. Shows every
    sheet row plus which ones the parser kept and which one it picked."""
    if team_id not in TEAM_LETTER_MAP:
        return {"error": f"unknown team_id {team_id}"}
    return await asyncio.to_thread(_debug_weekly_review, team_id)


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

    # Attach the parent team's EOD sheet data so ClientDashboard can render
    # the Daily Delays chart filtered to this client.
    parent_team = find_team_for_client(client_name)
    print(f"[findTeam] client={client_name!r} resolved={parent_team}")
    eod_rows: list = []
    eod_error: str | None = None
    has_eod_sheet = False
    sid_present = False
    matched_tab: str = "none"
    if parent_team:
        cfg = TEAM_LETTER_MAP.get(parent_team) or {}
        sid = cfg.get("sheetId")
        sid_present = bool(sid)
        if sid:
            has_eod_sheet = True
            try:
                eod_rows, matched_tab = await asyncio.to_thread(
                    _resolve_eod_rows_for_client, parent_team, client_name
                )
            except EodSheetError as e:
                eod_error = e.reason
            except Exception as e:
                eod_error = f"EOD fetch failed: {e}"
            if has_eod_sheet and not eod_rows and not eod_error:
                eod_error = f"EOD sheet exists but no tab matches client '{client_name}'."
    aging = compute_delays_aging(eod_rows, start, end) if eod_rows else {
        "delaysAgeSummary": {
            "today": 0, "1to2days": 0, "3to7days": 0, "8plusDays": 0,
            "totalOpen": 0, "oldestDays": 0, "oldestQuery": "",
        },
        "delaysByDay": [],
    }
    result["parentTeamId"]     = parent_team
    result["hasEodSheet"]      = has_eod_sheet
    result["eod"]              = eod_rows
    result["eodError"]         = eod_error
    result["delaysAgeSummary"] = aging["delaysAgeSummary"]
    result["delaysByDay"]      = aging["delaysByDay"]

    print(f"[PERF] client={client_name} {period} total={time.perf_counter()-t0:.2f}s "
          f"parent={parent_team} sidConfigured={sid_present} eodRows={len(eod_rows)} eodError={eod_error}")
    cache_set(cache_key, result)
    return result


@app.get("/api/debug/unmapped-clients")
def debug_unmapped_clients():
    """Aggregate hours from this month's timesheet rows by customer name and
    flag the ones that don't resolve to any team in TEAM_CLIENTS. Use this to
    discover clients that need to be added to the per-team config."""
    start, end, _ = date_range_for_period("monthly")
    try:
        rows = get_cached_rows(start, end)
    except Exception as e:
        return {"error": str(e), "rows": []}

    agg: dict[str, dict] = {}
    for r in rows:
        cust = (r.get("customer") or "").strip()
        if not cust:
            continue
        # Internal/admin/breaks/training rows aren't unmapped — they're
        # explicitly categorized as internal work. Skip them here.
        if is_internal_code(cust):
            continue
        team_id = find_team_for_client(cust)
        entry = agg.setdefault(cust, {
            "clientName": cust,
            "totalHours": 0.0,
            "rowCount":   0,
            "teamId":     team_id,
        })
        entry["totalHours"] += float(r.get("hours") or 0)
        entry["rowCount"]   += 1

    unmapped = [
        {**v, "totalHours": round(v["totalHours"], 1)}
        for v in agg.values() if v["teamId"] is None
    ]
    unmapped.sort(key=lambda x: -x["totalHours"])
    return {
        "range":   {"start": start, "end": end},
        "count":   len(unmapped),
        "rows":    unmapped,
    }


@app.get("/api/debug/client-eod")
def debug_client_eod(name: str, period: str = "monthly"):
    """Diagnostic dump for the Client view's "No open delays" bug.

    Walks the same flow the client endpoint uses:
      1. Resolve parent team via find_team_for_client
      2. Look up sheetId + gid from TEAM_LETTER_MAP
      3. Try every candidate tab — including the client's tsMatch aliases —
         and report what each one returned BEFORE _resolve_eod_rows_for_client
         picks one. This exposes whether the picker is grabbing an empty
         per-client tab instead of the populated team-wide tab.
      4. Sample the first 5 rows from the picked tab
      5. Compute the aging summary from those rows

    No side effects, no state changes.
    """
    if period not in ("today", "weekly", "monthly"):
        return {"error": "Invalid period. Use today | weekly | monthly."}

    parent_team_id = find_team_for_client(name)
    out: dict = {
        "client_name":               name,
        "period":                    period,
        "parent_team_id":            parent_team_id,
        "team_sheet_id":             None,
        "team_sheet_gid":            None,
        "ts_match_aliases":          [],
        "candidates_attempted":      [],
        "tab_matching_strategy_used": None,
        "matched_tab_label":         None,
        "raw_eod_rows_in_picked_tab": 0,
        "first_5_raw_rows":          [],
        "rows_after_client_filter":  None,
        "filter_criteria_tried":     "none (current code does not row-filter by client — all team-EOD rows are passed through to compute_delays_aging)",
        "delaysAgeSummary_computed": None,
        "delaysByDay_nonempty_days": 0,
    }
    if not parent_team_id:
        out["note"] = ("find_team_for_client returned None — client not "
                       "resolved to any team. /api/debug/unmapped-clients shows "
                       "the customer name as it appears in timesheets.")
        return out

    cfg = TEAM_LETTER_MAP.get(parent_team_id) or {}
    sid = cfg.get("sheetId")
    gid = cfg.get("gid")
    out["team_sheet_id"]  = (sid[:8] + "…") if sid else None
    out["team_sheet_gid"] = gid
    if not sid:
        out["note"] = f"TEAM_LETTER_MAP[{parent_team_id}] has no sheetId — "\
                       f"set SHEET_{parent_team_id.upper()} env var or hardcode."
        return out

    # Gather every tab candidate that _resolve_eod_rows_for_client uses, PLUS
    # the tsMatch aliases for this client (which the picker doesn't currently
    # try — that's the suspect).
    aliases: list[str] = []
    for client_cfg in (TEAM_CLIENTS.get(parent_team_id) or []):
        if (client_cfg.get("name") or "").strip() == name.strip():
            aliases = list(client_cfg.get("tsMatch") or [])
            break
        # Fuzzy match the canonical client name too
        if name and fuzzy_contains(client_cfg.get("name") or "", name):
            aliases = list(client_cfg.get("tsMatch") or [])
            break
    out["ts_match_aliases"] = aliases

    candidates: list[tuple[str, dict]] = []
    candidates.append((f"tab='{name}'",          {"tab": name}))
    candidates.append((f"tab='{name} Delays'",  {"tab": f"{name} Delays"}))
    for alias in aliases:
        candidates.append((f"tab='{alias}'",         {"tab": alias}))
        candidates.append((f"tab='{alias} Delays'", {"tab": f"{alias} Delays"}))
    if gid:
        candidates.append((f"gid={gid}",            {"gid": gid}))
    candidates.append(("default-first-tab",         {}))

    # Walk every candidate. Capture raw CSV + parsed-row counts + URL used,
    # so the response shows whether truncation is happening at the gviz/export
    # layer (raw CSV is short) or further down in our parser (raw CSV is long
    # but parsed rows aren't).
    today_d = datetime.now()
    recent_cutoff = today_d - timedelta(days=90)
    attempts: list[dict] = []
    picked: dict | None = None
    picked_rows: list[dict] = []
    picked_label: str | None = None
    picked_csv: str = ""
    best_score: tuple[int, int] = (-1, -1)

    for label, kwargs in candidates:
        attempt: dict = {
            "candidate":  label,
            "url":        None,
            "csv_bytes":  0,
            "csv_lines":  0,
            "totalRows":  0,
            "recentRows": 0,
            "error":      None,
        }
        try:
            csv_text, url_used = _fetch_eod_csv(sid, **kwargs)
            attempt["url"]       = url_used
            attempt["csv_bytes"] = len(csv_text)
            attempt["csv_lines"] = csv_text.count("\n") + (1 if csv_text else 0)
            # Parse via the same logic get_eod_data uses, so attempts mirror live behavior
            rows = get_eod_data(sid, **kwargs) if csv_text else []
            attempt["totalRows"] = len(rows)
            for r in rows:
                d = _parse_eod_date(r.get("date") or r.get("dateRaw") or "")
                if d and d >= recent_cutoff:
                    attempt["recentRows"] += 1
            score = (attempt["recentRows"], attempt["totalRows"])
            if score > best_score:
                best_score = score
                picked = attempt
                picked_rows = rows
                picked_label = label
                picked_csv = csv_text
        except EodSheetError as e:
            attempt["error"] = e.reason
        except Exception as e:
            attempt["error"] = f"{type(e).__name__}: {e}"
        attempts.append(attempt)

    out["candidates_attempted"]      = attempts
    out["attempts"]                  = attempts  # alias the user asked for
    out["tab_matching_strategy_used"] = picked_label or "none"
    out["matched_tab_label"]          = picked_label
    out["picked_url"]                 = picked.get("url") if picked else None
    out["raw_eod_rows_in_picked_tab"] = len(picked_rows)
    out["first_5_raw_rows"]           = picked_rows[:5]
    out["last_5_raw_rows"]            = picked_rows[-5:] if len(picked_rows) > 5 else []
    out["raw_csv_total_bytes"]        = len(picked_csv)
    out["raw_csv_first_500_chars"]    = picked_csv[:500]
    out["raw_csv_last_500_chars"]     = picked_csv[-500:] if len(picked_csv) > 500 else picked_csv

    # Now run compute_delays_aging exactly as the live endpoint does
    start, end, _ = date_range_for_period(period)
    aging = compute_delays_aging(picked_rows, start, end)
    summary = aging["delaysAgeSummary"]
    by_day = aging["delaysByDay"]
    out["delaysAgeSummary_computed"] = summary
    out["delaysByDay_nonempty_days"] = sum(
        1 for d in by_day if d.get("total", 0) > 0
    )
    out["period_window"] = {"start": start, "end": end}

    # ── Diagnostic counters ────────────────────────────────────────
    # Reports how every row was classified so we can see which path fired
    # (explicit column-L, notes heuristic, or blank).
    status_dist: dict[str, int] = {}
    status_norm_dist: dict[str, int] = {}
    status_source_dist: dict[str, int] = {}
    raw_status_sample: list[str] = []
    period_start_d = _parse_eod_date(start)
    period_end_d   = _parse_eod_date(end)
    period_filtered: list[dict] = []
    open_in_period: list[dict] = []
    completed_in_period = 0
    in_progress_in_period = 0
    awaiting_in_period = 0
    blank_status_in_period = 0
    for r in picked_rows:
        raw = (r.get("eodStatus") or "").strip()
        norm = (r.get("statusNorm") or "")
        src  = (r.get("statusNormSource") or "blank")
        status_dist[raw or "<blank>"] = status_dist.get(raw or "<blank>", 0) + 1
        status_norm_dist[norm or "<blank>"] = status_norm_dist.get(norm or "<blank>", 0) + 1
        status_source_dist[src] = status_source_dist.get(src, 0) + 1
        if raw and len(raw_status_sample) < 10 and raw not in raw_status_sample:
            raw_status_sample.append(raw)
        # Period filter
        d = _parse_eod_date(r.get("date") or r.get("dateRaw") or "")
        if not d or not period_start_d or not period_end_d:
            continue
        if d < period_start_d or d > period_end_d:
            continue
        period_filtered.append(r)
        if norm == "completed":
            completed_in_period += 1
        elif norm == "in_progress":
            in_progress_in_period += 1
            open_in_period.append(r)
        elif norm == "awaiting_response":
            awaiting_in_period += 1
            open_in_period.append(r)
        else:
            blank_status_in_period += 1

    total_rows  = len(picked_rows)
    blank_count = status_dist.get("<blank>", 0)
    data_quality_warning: str | None = None
    if total_rows and blank_count / total_rows >= 0.20:
        pct = round(blank_count * 100 / total_rows)
        data_quality_warning = (
            f"{blank_count} of {total_rows} rows ({pct}%) have blank EOD "
            f"Status (column L). Classifying via notes heuristic. Recommend "
            f"{parent_team_id or 'the team'} fill column L for accurate aging."
        )

    out["status_distribution"]        = status_dist
    out["statusNorm_distribution"]    = status_norm_dist
    out["statusNormSource_distribution"] = status_source_dist
    out["raw_status_distinct_sample"] = raw_status_sample
    out["data_quality_warning"]       = data_quality_warning
    out["period_filtered_row_count"]  = len(period_filtered)
    out["period_filter_breakdown"]    = {
        "completed":             completed_in_period,
        "in_progress":           in_progress_in_period,
        "awaiting_response":     awaiting_in_period,
        "blank_status":          blank_status_in_period,
    }
    out["open_rows_in_period"]        = len(open_in_period)
    out["first_3_open_rows_in_period"] = open_in_period[:3]
    out["first_3_in_period_rows_full"] = period_filtered[:3]

    return out


@app.get("/api/debug/employee-raw")
def debug_employee_raw(team_id: str, name: str, period: str = "monthly"):
    """Diagnostic dump for the Daily Hours chart bug. Returns the raw rows the
    employee endpoint sees, what format their `date` field is in, which match
    strategy fired, and what dailyHours[] would compute to. Read-only — does
    not change any state. Hit this when totals show real hours but Daily Hours
    renders empty."""
    if period not in ("today", "weekly", "monthly"):
        return {"error": "Invalid period. Use today | weekly | monthly."}
    if team_id not in TEAM_LETTER_MAP:
        return {"error": f"unknown team_id {team_id}"}

    start, end, label = date_range_for_period(period)
    try:
        rows = get_cached_rows(start, end)
    except Exception as e:
        return {"error": f"get_cached_rows failed: {e}", "team_id": team_id}

    emp_rows, strategy = _match_employee_rows(rows, name)

    # Sample the first 5 matched rows verbatim (everything parse_rows produced).
    # Strip the cached `_assignedTeam` helper field if present, but keep
    # everything else so the user can see what the upstream returned.
    def _sanitize(r: dict) -> dict:
        return {k: v for k, v in r.items() if not k.startswith("_")}

    sample = [_sanitize(r) for r in emp_rows[:5]]

    # Distinct date values seen, capped at 10
    seen_dates: list = []
    seen_set: set = set()
    empty_count = 0
    for r in emp_rows:
        d = r.get("date")
        if not d:
            empty_count += 1
            continue
        if d in seen_set:
            continue
        seen_set.add(d)
        if len(seen_dates) < 10:
            seen_dates.append(d)

    date_field_present = any(("date" in r) for r in emp_rows)

    # Re-run the daily-buckets logic from _build_employee_response so we can
    # report dailyHours_returned without round-tripping through the endpoint.
    daily_buckets: dict = {}
    undated_hours = 0.0
    for r in emp_rows:
        d = _normalize_date(r.get("date"))
        h = float(r.get("hours") or 0)
        if not d:
            undated_hours += h
            continue
        bucket = daily_buckets.setdefault(d, {"hours": 0.0, "billable": 0.0, "nonBillable": 0.0})
        bucket["hours"] += h
        if r.get("billable"):
            bucket["billable"] += h
        else:
            bucket["nonBillable"] += h

    daily_out: list = []
    try:
        start_d = datetime.strptime(start, "%Y-%m-%d")
        end_d   = datetime.strptime(end,   "%Y-%m-%d")
        today_d = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        cap     = min(end_d, today_d)
        cur = start_d
        while cur <= cap:
            key = cur.strftime("%Y-%m-%d")
            b = daily_buckets.get(key, {"hours": 0.0, "billable": 0.0, "nonBillable": 0.0})
            daily_out.append({
                "date":        key,
                "hours":       round(b["hours"], 1),
                "billable":    round(b["billable"], 1),
                "nonBillable": round(b["nonBillable"], 1),
            })
            cur += timedelta(days=1)
    except Exception as e:
        daily_out = [{"error": f"date loop failed: {e}"}]

    nonzero_count = sum(1 for d in daily_out if d.get("hours", 0) > 0)
    total_h = round(sum(float(r.get("hours") or 0) for r in emp_rows), 1)

    # Also probe _normalize_date on each unique date string so the user can see
    # which raw formats survive normalization and which collapse to "".
    norm_probe = []
    for d in seen_dates:
        norm_probe.append({"raw": d, "normalized": _normalize_date(d)})

    return {
        "name_searched":                name,
        "name_matching_strategy_used":  strategy,
        "matched_rows_count":           len(emp_rows),
        "first_5_matched_rows":         sample,
        "date_field_values_sample":     seen_dates,
        "date_field_present_in_rows":   date_field_present,
        "date_field_empty_count":       empty_count,
        "normalize_date_probe":         norm_probe,
        "period_start":                 start,
        "period_end":                   end,
        "period_label":                 label,
        "today":                        datetime.now().strftime("%Y-%m-%d"),
        "dailyHours_returned":          daily_out,
        "dailyHours_nonzero_count":     nonzero_count,
        "totalHours_computed":          total_h,
        "undated_hours":                round(undated_hours, 1),
        "total_rows_in_period":         len(rows),
    }


@app.get("/api/debug/client-coverage")
def debug_client_coverage(team_id: str):
    """Per-configured-client coverage report for one team.

    For every entry in TEAM_CLIENTS[team_id]: list the timesheet customer
    names that fuzzy-matched its tsMatch, how many rows hit, and total hours.
    Also lists unmapped customers (rows whose customer didn't fuzzy-match any
    of this team's configured clients but DO belong to one of the team's
    members per row_belongs_to_team).
    """
    if team_id not in TEAM_LETTER_MAP:
        return {"error": f"unknown team_id {team_id}"}
    start, end, _ = date_range_for_period("monthly")
    try:
        rows = get_cached_rows(start, end)
    except Exception as e:
        return {"error": str(e), "team_id": team_id}

    cfg_list = TEAM_CLIENTS.get(team_id) or []
    per_client: dict[str, dict] = {
        c["name"]: {
            "name":             c["name"],
            "tsMatch":          list(c.get("tsMatch") or []),
            "matchedCustomers": set(),
            "rowsMatched":      0,
            "hours":            0.0,
        }
        for c in cfg_list
    }
    unmapped: dict[str, dict] = {}

    for r in rows:
        if not row_belongs_to_team(r, team_id):
            continue
        cust = (r.get("customer") or "").strip()
        if not cust:
            continue
        h = float(r.get("hours") or 0)
        if h <= 0:
            continue
        resolved = _resolve_client_for_team(team_id, cust, r.get("desc") or "")
        if resolved and resolved in per_client:
            entry = per_client[resolved]
            entry["matchedCustomers"].add(cust)
            entry["rowsMatched"] += 1
            entry["hours"]       += h
        else:
            u = unmapped.setdefault(cust, {
                "customerName": cust, "hours": 0.0, "rowCount": 0,
            })
            u["hours"]    += h
            u["rowCount"] += 1

    configured_out = []
    for name, e in per_client.items():
        configured_out.append({
            "name":             name,
            "tsMatch":          e["tsMatch"],
            "matchedCustomers": sorted(e["matchedCustomers"]),
            "rowsMatched":      e["rowsMatched"],
            "hours":            round(e["hours"], 1),
        })
    configured_out.sort(key=lambda x: -x["hours"])

    unmapped_out = [
        {**v, "hours": round(v["hours"], 1)}
        for v in unmapped.values()
    ]
    unmapped_out.sort(key=lambda x: -x["hours"])

    return {
        "team_id":             team_id,
        "team_label":          TEAM_LETTER_MAP[team_id].get("label", team_id),
        "range":               {"start": start, "end": end},
        "configured_clients":  configured_out,
        "unmapped_customers":  unmapped_out,
    }


@app.get("/api/admin-hour")
async def admin_hour_endpoint(week_offset: int = 0):
    """Aggregated weekly-review view across every team in TEAM_ORDER.

    Returns one entry per team with isFilled + review payload, plus a summary
    that the AdminHourPage uses for the cards and compliance chart. Fetches
    each team's review in parallel via asyncio.gather so total latency is
    bounded by the slowest single fetch, not the sum.
    """
    if week_offset < 0:
        week_offset = 0
    team_ids = list(TEAM_ORDER)

    async def _one(tid: str) -> dict:
        try:
            review = await asyncio.to_thread(get_weekly_review, tid, week_offset)
        except Exception as e:
            return {"teamId": tid, "isFilled": False, "review": None, "error": str(e)}
        return {
            "teamId":     tid,
            "teamLabel":  TEAM_LETTER_MAP.get(tid, {}).get("label", tid),
            "leadName":   TEAM_LETTER_MAP.get(tid, {}).get("leadName", ""),
            "isFilled":   bool(review.get("isFilled")),
            "review":     review,
        }

    teams = await asyncio.gather(*(_one(tid) for tid in team_ids))

    teams_filled = sum(1 for t in teams if t["isFilled"])
    total_teams  = len(teams)
    compliance   = round(teams_filled * 100 / total_teams) if total_teams else 0

    # Rough cross-team aggregates: count how many sections-with-any-text
    # appear in the patterns / commitments / quality buckets. Best-effort
    # signal; not a strict definition.
    # NOTE: each section field is now {text, lines}, not a plain string, so
    # we go through _section_field_text() instead of calling .strip() on it.
    issues_found    = 0
    sop_gaps        = 0
    commitments_ct  = 0
    for t in teams:
        review = t.get("review") or {}
        sections = review.get("sections") or {}
        patterns = sections.get("patterns") or {}
        if _section_field_text(patterns.get("sopGap")):
            sop_gaps += 1
        if _section_field_text(patterns.get("complaintTheme")):
            issues_found += 1
        if _section_field_text(patterns.get("singlePointFailure")):
            issues_found += 1
        for _field, txt in (sections.get("commitments") or {}).items():
            if _section_field_text(txt):
                commitments_ct += 1

    # Use the first filled team's weekRange as the cross-team range label,
    # since all leads ought to be writing about the same calendar week.
    week_range_label = ""
    for t in teams:
        if t["isFilled"] and (t.get("review") or {}).get("weekRange"):
            week_range_label = t["review"]["weekRange"]
            break

    return {
        "weekRange":   week_range_label,
        "weekOffset":  week_offset,
        "summary": {
            "teamsFilled":       teams_filled,
            "totalTeams":        total_teams,
            "compliancePct":     compliance,
            "totalIssuesFound":  issues_found,
            "totalCommitments":  commitments_ct,
            "totalSopGaps":      sop_gaps,
        },
        "teams":       teams,
    }


@app.get("/api/clear-cache")
@app.post("/api/clear-cache")
async def clear_cache():
    _cache.clear()
    _team_cache.clear()
    _rows_cache.clear()
    _trend_cache.clear()
    _leaderboard_cache.clear()
    _weekly_review_cache.clear()
    _weekly_tab_match_cache.clear()
    _weekly_review_tab_resolved.clear()
    _action_items_cache.clear()
    _delays_tab_match_cache.clear()
    _team_delay_questions_cache.clear()
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

def _build_chat_rows_block(view_hint: dict | None) -> str:
    """If the user is viewing a specific team / client / employee, pull cached
    rows for the current month and emit a date-stamped, per-row listing the LLM
    can cite. Returns "" if no hint is provided or no rows match."""
    if not view_hint or not isinstance(view_hint, dict):
        return ""

    team_id        = (view_hint.get("teamId") or "").strip()
    client_name    = (view_hint.get("clientName") or "").strip()
    employee_name  = (view_hint.get("employeeName") or "").strip()
    period         = view_hint.get("period") or "monthly"
    if period not in ("today", "weekly", "monthly"):
        period = "monthly"

    if not (team_id or client_name or employee_name):
        return ""

    try:
        start, end, label = date_range_for_period(period)
        rows = _rows_cache.get(f"{start}_{end}", {}).get("rows")
        if rows is None:
            # Don't block the chat on an upstream fetch — only use cached rows.
            return ""
    except Exception:
        return ""

    # Decide which rows to keep based on the hint precedence.
    matched = []
    if employee_name:
        # Employee scope wins — single person's rows across all clients.
        emp_match_rows, _strategy = _match_employee_rows(rows, employee_name)
        matched.extend(emp_match_rows)
        scope_label = f"employee {employee_name}"
    elif client_name:
        cn = client_name.lower()
        for r in rows:
            cust = (r.get("customer") or "").lower()
            desc = (r.get("desc") or "").lower()
            if cn in cust or cn in desc:
                matched.append(r)
        scope_label = f"client {client_name}"
    elif team_id:
        cfg        = TEAM_LETTER_MAP.get(team_id) or {}
        team_label = cfg.get("label", team_id)
        roster     = TEAM_ROSTERS.get(team_id, [])
        for r in rows:
            if roster:
                if row_belongs_to_team(r, team_id):
                    matched.append(r)
            else:
                if (r.get("team") or "").strip().lower() == team_label.strip().lower():
                    matched.append(r)
        scope_label = f"team {team_label}"
    else:
        return ""

    if not matched:
        return ""

    # Sort by date desc, separate billable / non-billable so LLM can answer
    # "why did X get N non-billable hours" without missing the obscure ones.
    def _key(r):
        return (r.get("date") or "")[:10]
    matched.sort(key=_key, reverse=True)

    nonbill = [r for r in matched if not r.get("billable")]
    bill    = [r for r in matched if r.get("billable")]

    def _fmt(r):
        date = (r.get("date") or "unknown")[:10]
        emp  = (r.get("name") or "—").strip()
        cust = (r.get("customer") or "—").strip()
        hrs  = float(r.get("hours") or 0)
        desc = (r.get("desc") or "").strip().replace("\n", " ")
        bflag = "billable" if r.get("billable") else "non-billable"
        return f"- {date}: {emp} | {cust} | {hrs:.2f}h | {bflag} | {desc[:120]}"

    blocks = [f"\nRECENT TIMESHEET ENTRIES for {scope_label} ({label}):"]
    if nonbill:
        blocks.append(f"\nNON-BILLABLE entries ({len(nonbill)} total, showing top {min(len(nonbill), 30)}):")
        blocks.extend(_fmt(r) for r in nonbill[:30])
    if bill:
        blocks.append(f"\nBILLABLE entries ({len(bill)} total, showing top {min(len(bill), 30)} most recent):")
        blocks.extend(_fmt(r) for r in bill[:30])
    return "\n".join(blocks)


DELAY_KEYWORDS = (
    "delay", "delays", "question", "queries", "query", "open", "pending",
    "eod", "awaiting", "blocker", "blocked", "non-billable", "nonbillable",
    "non billable", "billable hours", "billable hour", " why ", " why?", "why ",
    "overdue", "stuck", "oldest", "longest", "older than", "days old",
)


def _user_query_mentions_delays(messages: list) -> bool:
    """Look at the most recent user message and decide if we should pull EOD."""
    last = ""
    for m in reversed(messages or []):
        if m.get("role") == "user":
            last = (m.get("content") or "").lower()
            break
    if not last:
        return False
    return any(k.strip() in last for k in DELAY_KEYWORDS)


def _build_chat_eod_block(view_hint: dict | None) -> str:
    """Surface recent EOD rows for the relevant team so the LLM can answer
    delay/age/status questions. Rows are sorted by ageDays desc (oldest first)
    and capped at 50 to stay within the token budget."""
    if not view_hint or not isinstance(view_hint, dict):
        return ""

    team_id     = (view_hint.get("teamId") or "").strip()
    client_name = (view_hint.get("clientName") or "").strip()

    # Resolve team
    if not team_id and client_name:
        team_id = find_team_for_client(client_name) or ""
    if not team_id:
        return ""

    cfg = TEAM_LETTER_MAP.get(team_id)
    if not cfg or not cfg.get("sheetId"):
        return ""

    # For client scope, route through the flexible-tab picker so we get the
    # correct populated tab (matches the live client endpoint exactly).
    try:
        if client_name:
            eod_rows, _label = _resolve_eod_rows_for_client(team_id, client_name)
        else:
            eod_rows = get_eod_data(cfg["sheetId"], gid=cfg.get("gid"))
    except Exception as e:
        return f"\nEOD SHEET ROWS: (fetch failed: {e})"
    if not eod_rows:
        return ""

    today_d = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff  = today_d - timedelta(days=60)  # 60-day lookback so "older than 30 days" queries can answer

    # Decorate each row with ageDays. Drop rows we can't date or that fall
    # outside the lookback window.
    decorated: list[tuple[int, dict]] = []
    for r in eod_rows:
        d = _parse_eod_date(r.get("date") or r.get("dateRaw") or "")
        if not d:
            continue
        if d < cutoff:
            continue
        age = max(0, (today_d - d).days)
        decorated.append((age, r))

    # Sort oldest first so the LLM sees the most-aged items at the top of the
    # context — "what's the oldest open question" can be answered from row 1.
    decorated.sort(key=lambda pair: -pair[0])
    capped = decorated[:50]
    if not capped:
        return ""

    def _status_label(sn: str) -> str:
        sn = (sn or "").lower()
        if sn == "awaiting_response":
            return "awaiting_response"
        if sn == "in_progress":
            return "in_progress"
        if sn == "completed":
            return "completed"
        return "unknown"

    attribution = client_name or cfg.get("label") or team_id

    def _fmt(age: int, r: dict) -> str:
        date  = (r.get("date") or "unknown")[:10]
        stat  = _status_label(r.get("statusNorm") or "")
        qtext = (r.get("queryText") or "").strip().replace("\n", " ")
        if not qtext:
            qtext = (r.get("notes") or "").strip().replace("\n", " ")
        return f'- [{date}] {attribution} | status: {stat} | age: {age} days | query: "{qtext[:200]}"'

    header = (
        f"\nEOD SHEET ROWS for {attribution} "
        f"(last 60 days, {len(capped)} entries, OLDEST FIRST):"
    )
    return "\n".join([header, *(_fmt(age, r) for age, r in capped)])


@app.post("/api/chat")
async def chat(request: dict):
    messages   = request.get("messages", [])
    context    = request.get("context", "")
    view_hint  = request.get("viewHint")
    include_eod = _user_query_mentions_delays(messages)

    rows_block, eod_block = await asyncio.gather(
        asyncio.to_thread(_build_chat_rows_block, view_hint),
        asyncio.to_thread(_build_chat_eod_block, view_hint) if include_eod else asyncio.sleep(0, result=""),
    )

    system_prompt = f"""You are MoneyPenny AI analyzing real timesheet and EOD data.

REAL DATA RIGHT NOW:
{context}
{rows_block}
{eod_block}

Answer questions directly using ONLY this data.

GENERAL RULES:
- ALWAYS cite the date (YYYY-MM-DD) and the source (timesheet entry vs EOD sheet).
  Never say "I don't have the date" — the date IS in the data above.
- If asked "why" a person or client has a value, list each contributing entry
  with date, hours, and a brief description. If many, show the top 5 by hours
  or recency.
- Format dates as YYYY-MM-DD. Sum hours when there are multiple entries.
- Give specific numbers, not generic advice. Keep response under 180 words.
- Use bullet points when listing multiple entries.

EOD / DELAY RULES (when the user asks about delays, questions, pending items,
overdue items, oldest items, or anything similar):
- Each EOD row has format: [date] team_or_client | status: STATE | age: N days | query: "..."
- The rows are pre-sorted OLDEST FIRST. Use that order.
- ALWAYS state the age in days when describing an open item (e.g. "12 days old").
- ALWAYS include the EOD Status (Awaiting Response / In Progress / Completed).
- If user asks "older than N days" or "over N days" or "more than N days":
  filter to ageDays >= N and list every matching row.
- If user asks for "oldest" / "longest pending" / "stale": return the row(s)
  with the highest age.
- If user asks "show all delays": list every OPEN row (status != completed)
  with date, age, status, and query text.

Status thresholds: BELOW TARGET <75% | ON TARGET 75-95% | OVER TARGET 95-120% | CRITICAL >120%"""

    response = groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[{"role": "system", "content": system_prompt}, *messages],
        max_tokens=320,
        temperature=0.2,
    )
    return {"reply": response.choices[0].message.content}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
