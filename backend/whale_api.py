"""Whale (usewhale.io) API client.

Required environment variables on the server:
  WHALE_API_TOKEN     — bearer token from the Whale workspace settings
  WHALE_WORKSPACE_ID  — workspace ID, sent as `x-request-id` header

If either var is unset or set to the literal string "PENDING", every
call raises WhaleAPIError("Whale API not configured…") and `_is_configured()`
returns False, so the dashboard can gracefully degrade and surface a
"awaiting credentials from vendor" banner instead of crashing.

The aggregate `get_all_sops()` traverses every board → library →
playbook → card. Wrapped by `get_all_sops_cached()` with a 1-hour TTL
to keep upstream traffic bounded.
"""
import os
import time
import requests
from typing import Optional, Dict, List, Any

WHALE_BASE_URL = "https://api.usewhale.io/api"


class WhaleAPIError(Exception):
    pass


class WhaleAPI:
    def __init__(self, token: Optional[str] = None, workspace_id: Optional[str] = None):
        self.token        = token        or os.getenv("WHALE_API_TOKEN",    "PENDING")
        self.workspace_id = workspace_id or os.getenv("WHALE_WORKSPACE_ID", "PENDING")

    def _is_configured(self) -> bool:
        return (
            self.token        not in ("", "PENDING", None)
            and self.workspace_id not in ("", "PENDING", None)
        )

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "x-request-id":  self.workspace_id,
            "Content-Type":  "application/json",
        }

    def _get(self, path: str, params: Optional[Dict] = None) -> Any:
        if not self._is_configured():
            raise WhaleAPIError(
                "Whale API not configured. Set WHALE_API_TOKEN and "
                "WHALE_WORKSPACE_ID env vars."
            )
        url = f"{WHALE_BASE_URL}{path}"
        try:
            resp = requests.get(url, headers=self._headers(), params=params, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.HTTPError as e:
            raise WhaleAPIError(
                f"Whale API HTTP {e.response.status_code}: {e.response.text[:200]}"
            )
        except requests.exceptions.RequestException as e:
            raise WhaleAPIError(f"Whale API network error: {e}")

    # ── Boards ───────────────────────────────────────────────
    def get_boards(self, include_counters: bool = True) -> List[Dict]:
        data = self._get("/boards", params={"include_counters": str(include_counters).lower()})
        # Whale may return either a bare list or a {boards: [...]} envelope
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return data.get("boards") or data.get("data") or []
        return []

    def get_board(self, board_id: str) -> Dict:
        return self._get(f"/boards/{board_id}")

    # ── Libraries ────────────────────────────────────────────
    def get_libraries(self) -> List[Dict]:
        data = self._get("/libraries")
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return data.get("libraries") or data.get("data") or []
        return []

    def get_library(self, library_id: str) -> Dict:
        return self._get(f"/libraries/{library_id}")

    # ── Playbooks / Cards ───────────────────────────────────
    def get_playbook(self, playbook_id: str) -> Dict:
        return self._get(f"/playbooks/{playbook_id}")

    # ── Search ──────────────────────────────────────────────
    def search_analytics_queries(self, start_date: str, end_date: str) -> List[Dict]:
        return self._get("/search/analytics/queries", params={
            "start_date": start_date,
            "end_date":   end_date,
        })

    # ── Health ──────────────────────────────────────────────
    def get_healthscore(self) -> Dict:
        return self._get("/client/healthscore")

    def get_health(self) -> Dict:
        return self._get("/health")

    # ── Aggregate: every SOP across every board ─────────────
    def get_all_sops(self) -> List[Dict]:
        """Traverse boards → libraries → playbooks → cards. Returns a flat
        list, each item annotated with its parent board / library / playbook
        for grouping in the UI. Failures inside individual sub-fetches are
        skipped so a single bad board doesn't blank the whole result."""
        all_cards: List[Dict] = []
        try:
            boards = self.get_boards()
        except WhaleAPIError:
            return []

        for board in boards:
            board_id = board.get("id") or board.get("uuid")
            if not board_id:
                continue
            try:
                board_full = self.get_board(str(board_id))
            except WhaleAPIError:
                continue

            for library in (board_full.get("libraries") or []):
                for playbook in (library.get("playbooks") or []):
                    for card in (playbook.get("cards") or []):
                        all_cards.append({
                            "id":              card.get("id") or card.get("uuid"),
                            "title":           card.get("title", ""),
                            "content":         card.get("content", ""),
                            "description":     card.get("description", ""),
                            "subject_tags":    card.get("subject_tags") or card.get("tags") or [],
                            "playbook_id":     playbook.get("id") or playbook.get("uuid"),
                            "playbook_title":  playbook.get("title", ""),
                            "library_id":      library.get("id") or library.get("uuid"),
                            "library_title":   library.get("title", ""),
                            "board_id":        board.get("id") or board.get("uuid"),
                            "board_name":      board.get("name") or board.get("title", ""),
                            "last_updated":    card.get("last_updated_on") or card.get("updated_at"),
                            "created_on":      card.get("created_on") or card.get("created_at"),
                        })
        return all_cards


# ── Module-level cache (1 hour TTL) ────────────────────────────
_sops_cache: Dict[str, Any] = {"data": [], "fetched_at": 0.0}
SOPS_CACHE_TTL = 3600  # 1 hour


def get_all_sops_cached(force_refresh: bool = False) -> List[Dict]:
    """Returns cached SOPs (1 h TTL). Pass force_refresh=True to bust."""
    now = time.time()
    if (not force_refresh
            and _sops_cache["data"]
            and (now - _sops_cache["fetched_at"]) < SOPS_CACHE_TTL):
        return _sops_cache["data"]
    api  = WhaleAPI()
    sops = api.get_all_sops()
    _sops_cache["data"]       = sops
    _sops_cache["fetched_at"] = now
    return sops


def clear_sops_cache() -> None:
    _sops_cache["data"]       = []
    _sops_cache["fetched_at"] = 0.0
