"""Google Sheets access with optional service-account auth.

WHY THIS EXISTS
---------------
Every sheet read used to go through unauthenticated export URLs
(`/export?format=csv&gid=`, `/gviz/tq?tqx=out:csv`), which only work while a
sheet is shared "Anyone with the link can view". Verified 2026-08-10: all 17
sheets returned HTTP 200 + text/csv to a request carrying no credentials at
all — Team T handed out 3.2 MB. This module is the prerequisite for setting
those sheets to Restricted.

FEATURE FLAG
------------
`SHEETS_USE_API=1` routes reads through the Sheets API v4 with a service
account. Anything else keeps the legacy public-URL transport, so deploying
this module changes nothing until the flag is set.

TRANSPORT-SHAPED RETURN VALUE
-----------------------------
`fetch_csv()` returns a `SheetResult(status_code, text, url)` rather than
raising, because the existing call sites in main.py each branch on HTTP status
in their own way — one raises EodSheetError on 401/403, others cache "" and
carry on. Mirroring the `requests` shape keeps that error handling untouched,
so flag-off behaviour is identical and flag-on failures degrade the same way.

RAGGED ROWS — THE SUBTLE PART
-----------------------------
`spreadsheets.values.get` is NOT equivalent to a CSV export. It drops trailing
empty cells, so rows come back ragged, and it omits trailing empty rows. The
CSV export always emits a full rectangle. Callers here read fixed column
positions (eod_sheet.format_eod reads `row.iloc[14]`; several parsers index
`row[8]`), so ragged rows would give pandas a short header, a narrower frame,
and an IndexError — or silently shift columns. Every row is therefore padded
to the widest row before serialising.
"""

from __future__ import annotations

import csv
import io
import os
import threading

import requests

# ── Config ────────────────────────────────────────────────────────
_DEFAULT_SA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "moneypenny-sa.json")
SA_KEY_PATH = os.getenv("GOOGLE_SA_KEY_PATH", _DEFAULT_SA_PATH)
SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets"

# Google's CSV export uses CRLF; match it so nothing downstream sees a
# different line ending between the two transports.
_CSV_LINETERMINATOR = "\r\n"

_creds_lock = threading.Lock()
_creds_cache = None
_import_error: str | None = None

# Documents the Sheets API structurally cannot read: .xlsx/.xls files stored in
# Drive rather than native Google Sheets. The API answers 400 FAILED_PRECONDITION
# ("The document must not be an Office file") no matter how it is shared, so
# there is no auth fix — the file has to be converted to a native Sheet.
#
# Verified 2026-08-10: 15 of the 16 documents are native; WEEKLY_REVIEW_SHEET_ID
# is an Office file (33-char Drive id, not the usual 44-char Sheets id).
#
# Such a document falls back to the legacy CSV export so API mode does not break
# a live feature. That means it stays dependent on public link sharing and
# CANNOT be restricted in Phase 4 until it is converted. Surfaced by
# health_check() and logged once per document so it can't be forgotten.
_office_file_ids: set[str] = set()
_office_warned: set[str] = set()


def _note_office_file(sheet_id: str) -> None:
    _office_file_ids.add(sheet_id)
    if sheet_id not in _office_warned:
        _office_warned.add(sheet_id)
        print(f"[sheets-client] WARNING {sheet_id} is an Office (.xlsx) file — "
              f"the Sheets API cannot read it. Falling back to the PUBLIC CSV "
              f"export, so this document must stay link-shared. Convert it to a "
              f"native Google Sheet (File > Save as Google Sheets) before "
              f"restricting it.")


def is_office_file(sheet_id: str) -> bool:
    return sheet_id in _office_file_ids


def use_api() -> bool:
    """Read the flag at call time, not import time, so pm2 restart --update-env
    picks it up and tests can toggle it."""
    return os.getenv("SHEETS_USE_API", "").strip().lower() in ("1", "true", "yes")


class SheetResult:
    """Minimal stand-in for a requests.Response, carrying only what the call
    sites actually read."""

    __slots__ = ("status_code", "text", "url")

    def __init__(self, status_code: int, text: str, url: str):
        self.status_code = status_code
        self.text = text
        self.url = url

    def __repr__(self):
        return f"SheetResult(status={self.status_code}, bytes={len(self.text)}, url={self.url!r})"


# ── Credentials ───────────────────────────────────────────────────
def _get_credentials():
    """Load and cache service-account credentials. Raises on failure — callers
    convert that into a status code."""
    global _creds_cache, _import_error
    if _creds_cache is not None:
        return _creds_cache
    with _creds_lock:
        if _creds_cache is not None:
            return _creds_cache
        try:
            from google.oauth2 import service_account  # noqa: PLC0415
        except ImportError as e:
            _import_error = (
                f"google-auth is not installed ({e}). "
                "pip install -r requirements.txt"
            )
            raise RuntimeError(_import_error) from e
        if not os.path.exists(SA_KEY_PATH):
            raise FileNotFoundError(
                f"Service account key not found: {SA_KEY_PATH}. "
                "Complete Phase 0 — create the service account, download the "
                "JSON key, and place it there with chmod 600."
            )
        _creds_cache = service_account.Credentials.from_service_account_file(
            SA_KEY_PATH, scopes=SHEETS_SCOPES
        )
        return _creds_cache


def _authorized_session() -> requests.Session:
    """A requests Session that injects (and refreshes) the SA bearer token.

    Deliberately uses google.auth's requests transport rather than the
    googleapiclient discovery build: these are plain REST GETs, and it avoids
    pulling in the discovery-document fetch and its cache warnings.
    """
    from google.auth.transport.requests import AuthorizedSession  # noqa: PLC0415
    return AuthorizedSession(_get_credentials())


def _status_from_exception(e: Exception) -> int:
    """Best-effort HTTP status from a google-auth / requests error, so callers
    keep their 401/403/404 branches. 0 means 'no HTTP status' (network, missing
    key, bad JSON) — treated as a generic failure by every call site."""
    resp = getattr(e, "response", None)
    code = getattr(resp, "status_code", None)
    if isinstance(code, int):
        return code
    if isinstance(e, FileNotFoundError):
        return 0
    return 0


# ── CSV serialisation ─────────────────────────────────────────────
def rows_to_csv(rows: list[list]) -> str:
    """Serialise API rows to CSV text that matches an export.

    Pads every row to the widest row. See the module docstring — without this,
    fixed-position column reads break.
    """
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    out = io.StringIO()
    writer = csv.writer(out, lineterminator=_CSV_LINETERMINATOR)
    for r in rows:
        padded = list(r) + [""] * (width - len(r))
        writer.writerow(["" if c is None else c for c in padded])
    return out.getvalue()


def _quote_range(tab: str, cell_range: str | None) -> str:
    """Build an A1 range for a tab name.

    Tab titles contain apostrophes in this workspace (e.g. sheets owned by
    "Grace God's") and spaces ("ABS - Delay qsn"). A1 notation wraps the title
    in single quotes and escapes an embedded quote by doubling it.
    """
    safe = (tab or "").replace("'", "''")
    return f"'{safe}'!{cell_range}" if cell_range else f"'{safe}'"


# ── API transport ─────────────────────────────────────────────────
def api_get(sheet_id: str, query: str) -> tuple[int, dict | None]:
    """Authenticated GET against the Sheets v4 REST API.

    `query` is everything after the spreadsheet id, e.g.
    "?fields=sheets(properties(sheetId,title))".

    Falls back to `&key=GOOGLE_API_KEY` when the flag is off, so the two
    pre-existing v4 call sites in main.py keep working unchanged today AND
    survive Phase 4 — an API key cannot read a Restricted sheet, so without
    this they would 403 the moment sharing is locked down.
    """
    if not sheet_id:
        return 0, None
    if use_api():
        try:
            session = _authorized_session()
            resp = session.get(f"{SHEETS_API_BASE}/{sheet_id}{query}", timeout=20)
            if resp.status_code != 200:
                if resp.status_code == 400 and "Office file" in (resp.text or ""):
                    _note_office_file(sheet_id)
                return resp.status_code, None
            return 200, resp.json()
        except Exception as e:
            print(f"[sheets-client] api_get sid={sheet_id} failed: {e}")
            return _status_from_exception(e), None

    api_key = (os.environ.get("GOOGLE_API_KEY") or "").strip()
    if not api_key:
        return 0, None
    sep = "&" if "?" in query else "?"
    url = f"{SHEETS_API_BASE}/{sheet_id}{query}{sep}key={api_key}"
    try:
        resp = requests.get(url, timeout=20)
        if resp.status_code != 200:
            return resp.status_code, None
        return 200, resp.json()
    except Exception as e:
        print(f"[sheets-client] api_get (key mode) sid={sheet_id} failed: {e}")
        return 0, None


def _list_tabs_with_status(sheet_id: str) -> tuple[int, list[dict]]:
    """(status, [{gid, title}]). Status is kept separate from an empty list so
    callers can tell 'auth/network failed' from 'sheet genuinely has no tabs' —
    reporting the former as 404 would send an operator hunting for a missing tab
    during Phase 3 when the real problem is the service account."""
    status, data = api_get(sheet_id, "?fields=sheets(properties(sheetId,title))")
    if status != 200 or not data:
        return status, []
    out = []
    for s in data.get("sheets") or []:
        props = s.get("properties") or {}
        title = props.get("title")
        if title:
            out.append({"gid": str(props.get("sheetId")), "title": title})
    return 200, out


def list_tabs(sheet_id: str) -> list[dict]:
    """[{gid, title}] for every tab. [] on failure.

    Replaces the /htmlview page scrape, which was both fragile (the page format
    has changed in production before) and dependent on public access.
    """
    return _list_tabs_with_status(sheet_id)[1]


def tab_name_for_gid(sheet_id: str, gid: str) -> str | None:
    for t in list_tabs(sheet_id):
        if t["gid"] == str(gid):
            return t["title"]
    return None


def _fetch_values_csv(sheet_id: str, range_a1: str, descriptor: str) -> SheetResult:
    try:
        session = _authorized_session()
        url = f"{SHEETS_API_BASE}/{sheet_id}/values/{requests.utils.quote(range_a1, safe='')}"
        resp = session.get(
            url,
            params={
                # FORMATTED_VALUE matches what the CSV export writes — the
                # displayed string, not the underlying serial number.
                "valueRenderOption": "FORMATTED_VALUE",
                "dateTimeRenderOption": "FORMATTED_STRING",
            },
            timeout=30,
        )
        if resp.status_code != 200:
            if resp.status_code == 400 and "Office file" in (resp.text or ""):
                _note_office_file(sheet_id)
            print(f"[sheets-client] values sid={sheet_id} range={range_a1} "
                  f"-> {resp.status_code}: {resp.text[:160]}")
            return SheetResult(resp.status_code, "", descriptor)
        rows = (resp.json() or {}).get("values") or []
        return SheetResult(200, rows_to_csv(rows), descriptor)
    except Exception as e:
        print(f"[sheets-client] values sid={sheet_id} range={range_a1} failed: {e}")
        return SheetResult(_status_from_exception(e), "", descriptor)


# ── Legacy transport ──────────────────────────────────────────────
def _legacy_url(sheet_id: str, gid: str | None, tab: str | None,
                cell_range: str | None) -> str:
    """Reproduce the exact URLs the call sites used before this refactor."""
    base = f"https://docs.google.com/spreadsheets/d/{sheet_id}"
    if gid:
        return f"{base}/export?format=csv&gid={gid}"
    if tab:
        rng = f"&range={cell_range}" if cell_range else ""
        return f"{base}/gviz/tq?tqx=out:csv{rng}&sheet={requests.utils.quote(tab)}"
    rng = f"&range={cell_range}" if cell_range else ""
    return f"{base}/gviz/tq?tqx=out:csv{rng}"


def _fetch_legacy(url: str) -> SheetResult:
    try:
        resp = requests.get(url, timeout=15, allow_redirects=True)
        if resp.status_code != 200:
            return SheetResult(resp.status_code, "", url)
        # Google exports UTF-8 but often omits the charset header, so requests
        # would guess ISO-8859-1 and mangle smart quotes / em-dashes.
        return SheetResult(200, resp.content.decode("utf-8", errors="replace"), url)
    except Exception as e:
        print(f"[sheets-client] legacy fetch failed {url}: {e}")
        return SheetResult(0, "", url)


# ── Unified entry point ───────────────────────────────────────────
def fetch_csv(sheet_id: str, gid: str | None = None, tab: str | None = None,
              cell_range: str | None = None) -> SheetResult:
    """Fetch a tab as CSV text. Never raises for fetch failures.

    Identify the tab by `gid` (preferred) or `tab` name. `cell_range` is an A1
    fragment like "A1:O10000"; it is preserved from the legacy gviz calls so
    column counts don't shift.
    """
    if not sheet_id:
        return SheetResult(0, "", "")

    if not use_api() or is_office_file(sheet_id):
        return _fetch_legacy(_legacy_url(sheet_id, gid, tab, cell_range))

    descriptor = f"sheets-api://{sheet_id}/{gid or tab or 'first-tab'}"
    title = tab
    if gid or title is None:
        # One metadata call serves both the gid lookup and the first-tab case.
        status, tabs = _list_tabs_with_status(sheet_id)
        if status != 200:
            if is_office_file(sheet_id):
                # Discovered mid-call: retry over the legacy transport rather
                # than failing a live feature.
                return _fetch_legacy(_legacy_url(sheet_id, gid, tab, cell_range))
            # Propagate the REAL failure (403 not shared, 0 no credentials)
            # rather than flattening it to a misleading 404.
            return SheetResult(status, "", descriptor)
        if gid:
            title = next((t["title"] for t in tabs if t["gid"] == str(gid)), None)
            if title is None:
                print(f"[sheets-client] gid {gid} genuinely absent from {sheet_id}")
                return SheetResult(404, "", descriptor)
        else:
            if not tabs:
                return SheetResult(404, "", descriptor)
            title = tabs[0]["title"]

    res = _fetch_values_csv(sheet_id, _quote_range(title, cell_range), descriptor)
    if res.status_code == 400 and is_office_file(sheet_id):
        # Only reachable on the by-tab path, which skips the metadata call and
        # so learns the document is an Office file here instead.
        return _fetch_legacy(_legacy_url(sheet_id, gid, tab, cell_range))
    return res


# ── Diagnostics ───────────────────────────────────────────────────
def health_check(probe_sheet_id: str | None = None) -> dict:
    """Report whether the service account is usable. Optionally prove it by
    reading a real sheet's metadata."""
    out: dict = {
        "api_mode": use_api(),
        "sa_key_path": SA_KEY_PATH,
        "sa_key_found": os.path.exists(SA_KEY_PATH),
        "google_auth_installed": False,
        "sa_email": None,
        "error": None,
        # Documents seen falling back to the public CSV export because the
        # Sheets API can't read them. Anything listed here CANNOT be restricted
        # in Phase 4 until it is converted to a native Google Sheet.
        "office_file_fallbacks": sorted(_office_file_ids),
    }
    try:
        import google.auth  # noqa: F401, PLC0415
        out["google_auth_installed"] = True
    except ImportError as e:
        out["error"] = f"google-auth not installed: {e}"
        return out

    if not out["sa_key_found"]:
        out["error"] = (f"key file missing at {SA_KEY_PATH} — Phase 0 not complete")
        return out

    try:
        creds = _get_credentials()
        out["sa_email"] = getattr(creds, "service_account_email", None)
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
        return out

    if probe_sheet_id:
        tabs = list_tabs(probe_sheet_id)
        out["probe_sheet_id"] = probe_sheet_id[:8] + "…"
        out["probe_tab_count"] = len(tabs)
        out["probe_ok"] = bool(tabs)
        if not tabs:
            out["error"] = ("metadata read returned nothing — is the sheet shared "
                            "with the service account as Viewer?")
    return out
