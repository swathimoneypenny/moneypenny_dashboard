import certifi
import os
os.environ['SSL_CERT_FILE'] = certifi.where()
os.environ['WEBSOCKET_CLIENT_CA_BUNDLE'] = certifi.where()

import ssl
ssl._create_default_https_context = ssl._create_unverified_context

import re
import threading
import time
from datetime import datetime

import requests
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from dotenv import load_dotenv

load_dotenv()

from retriever import get_context
from llm import get_answer
from timesheet import get_timesheet_data
from eod_sheet import get_eod_data
from report import get_client_report, get_lastday_report

SLACK_BOT_TOKEN = os.getenv("SLACK_BOT_TOKEN")
SLACK_APP_TOKEN = os.getenv("SLACK_APP_TOKEN")
ALLOWED_USER_ID = os.getenv("SWATHI_SLACK_USER_ID")
DASHBOARD_API = "http://localhost:8000"

app = App(token=SLACK_BOT_TOKEN)
chat_history = {}

# App Home selects do not persist across publishes, so remember each user's
# filter choices and re-send them as initial_option on every re-publish.
# In-memory only: a bot restart resets everyone to the defaults.
user_selections = {}

# Quick actions need a client and there is no per-user default; "abs" is the
# same fallback the existing `!lastday` command already uses.
DEFAULT_QUICK_CLIENT = "abs"

# Bumped whenever the Home layout changes, and printed in the footer, so a
# screenshot always says which build produced it. Slack keeps showing the last
# published view until something re-publishes, which makes a stale process look
# like a broken layout.
HOME_BUILD = "v4"

# The team roster is static config in main.py — fetch it once per process.
_teams_cache = None
_teams_lock = threading.Lock()


def get_teams(force=False):
    """Cached team→client roster. Filter changes must never re-fetch this."""
    global _teams_cache
    with _teams_lock:
        if _teams_cache is None or force:
            _teams_cache = fetch_team_clients()
        return _teams_cache


def publish_view(client, user_id, blocks, label="home"):
    """views_publish with timing, so slow publishes are visible in the log."""
    started = time.perf_counter()
    ok = False
    try:
        result = client.views_publish(
            user_id=user_id, view={"type": "home", "blocks": blocks})
        ok = bool(result.get("ok", True))
        return result
    finally:
        print(f"[publish] {label} user={user_id} ok={ok} "
              f"{(time.perf_counter() - started) * 1000:.0f}ms "
              f"({len(blocks)} blocks)")


def is_allowed(user_id):
    return True


def _get_json(url, label):
    """GET + parse JSON. Logs loudly on failure instead of failing silently.

    A bare `except: return []` here is what turned a 401 into an empty
    dropdown with no explanation, so every failure mode now prints.
    """
    try:
        resp = requests.get(url, timeout=30)
    except requests.RequestException as e:
        print(f"[{label}] REQUEST FAILED {type(e).__name__}: {e}")
        return None

    print(f"[{label}] GET {url} -> HTTP {resp.status_code}")
    if resp.status_code != 200:
        print(f"[{label}] non-200 body: {resp.text[:500]}")
        return None
    try:
        return resp.json()
    except ValueError:
        print(f"[{label}] body was not JSON: {resp.text[:500]}")
        return None


def fetch_active_clients():
    # No [:24] cap — the client list is a dropdown now, not a wall of buttons,
    # so there is no layout reason to truncate it.
    data = _get_json(f"{DASHBOARD_API}/api/active-clients", "active-clients")
    if not data:
        return []
    clients = data.get("clients", [])
    print(f"[active-clients] parsed {len(clients)} client(s)")
    return clients


def fetch_team_clients():
    """[{id, label, leadName, clients:[...]}] — the team→client roster.

    Served by /api/team-clients, which reads main.py's TEAM_LETTER_MAP and
    BOD_EOD_TAB_GIDS. The mapping is deliberately NOT copied into this file.
    """
    data = _get_json(f"{DASHBOARD_API}/api/team-clients", "team-clients")
    if not data:
        return []
    teams = data.get("teams", [])
    print(f"[team-clients] parsed {len(teams)} team(s), "
          f"{data.get('clientCount')} client(s)")
    return teams


def fetch_client_dashboard(client_name, period="weekly"):
    return _get_json(
        f"{DASHBOARD_API}/api/client/{requests.utils.quote(client_name)}/{period}",
        "client-dashboard",
    )


TEAM_DASHBOARD_URL = "http://3.107.206.82"


def dashboard_url(selection=None):
    """URL for the View dashboard button.

    The dashboard is a single-page React app with NO router and no query-string
    handling — App.jsx drives navigation purely from useState, and nothing reads
    window.location. So there is no deep-link format to target: any ?view=/
    ?team=/?client= params would be ignored and the user would land on the home
    screen anyway. Until the frontend parses the URL, this is just the base URL.
    """
    return TEAM_DASHBOARD_URL

# Slack limits.
MAX_SELECT_OPTIONS = 100      # above this Slack needs option_groups
SELECT_TEXT_LIMIT = 75        # hard Slack cap on option text and value


def _select_option(name):
    """One dropdown option.

    Slack rejects option text over 75 chars, so display text is truncated to
    72 + "…" while `value` keeps the full name for the handler. Button labels
    are never truncated — long names simply live in the dropdown instead.
    """
    text = name if len(name) <= SELECT_TEXT_LIMIT else name[:72] + "…"
    value = name
    if len(value) > SELECT_TEXT_LIMIT:
        # Slack also caps `value`. Truncating loses the dashboard lookup for
        # this one client, which still beats the whole Home tab failing.
        print(f"WARNING: client name over {SELECT_TEXT_LIMIT} chars, value truncated: {name}")
        value = value[:SELECT_TEXT_LIMIT]
    return {"text": {"type": "plain_text", "text": text}, "value": value}


def _client_select(names):
    """static_select, or option_groups by first letter once past Slack's cap."""
    if len(names) <= MAX_SELECT_OPTIONS:
        return {
            "type": "static_select",
            "placeholder": {"type": "plain_text", "text": "Select a client..."},
            "action_id": "select_client",
            "options": [_select_option(n) for n in names],
        }

    groups = {}
    for name in names:
        letter = name[0].upper() if name else "#"
        if not letter.isalpha():
            letter = "#"
        groups.setdefault(letter, []).append(name)

    return {
        "type": "static_select",
        "placeholder": {"type": "plain_text", "text": "Select a client..."},
        "action_id": "select_client",
        "option_groups": [
            {
                "label": {"type": "plain_text", "text": letter},
                "options": [_select_option(n) for n in groups[letter]],
            }
            for letter in sorted(groups)
        ],
    }


def _updated_stamp():
    stamp = datetime.now().strftime("%b %d, %I:%M %p")
    return stamp.replace(" 0", " ")  # strip the leading zero on the hour


def _staff_rows(client_data):
    """Normalise the staff payload to [{name, billable, nonBillable}].

    /api/client/<name>/<period> returns staff as a LIST of
    {"staff": ..., "billable": ..., "nonBillable": ...}. Earlier code here
    assumed a dict keyed by name and crashed on `.values()`, so accept both
    shapes and skip anything malformed rather than blowing up the view.
    """
    staff = (client_data or {}).get("staff") or []
    if isinstance(staff, dict):
        pairs = staff.items()
    else:
        pairs = (
            (row.get("staff") or row.get("name") or "Unknown", row)
            for row in staff if isinstance(row, dict)
        )

    rows = []
    for name, row in pairs:
        if not isinstance(row, dict):
            continue
        try:
            rows.append({
                "name": str(name or "Unknown"),
                "billable": float(row.get("billable") or 0),
                "nonBillable": float(row.get("nonBillable") or 0),
            })
        except (TypeError, ValueError):
            continue
    return rows


def _dashboard_totals(client_data):
    """(billable, non_billable, efficiency%, staff_count) from a client payload.

    Shared by the dashboard blocks and the quick_today DM. Prefers the API's
    own `summary` totals, which are already computed and prorated, and only
    falls back to summing the staff rows when it is absent.
    """
    summary = (client_data or {}).get("summary") or {}
    rows = _staff_rows(client_data)

    if "totalBillable" in summary:
        billable = round(float(summary.get("totalBillable") or 0), 2)
        non_billable = round(float(summary.get("totalNonBillable") or 0), 2)
        efficiency = round(float(summary.get("overallEfficiency") or 0), 1)
    else:
        billable = round(sum(r["billable"] for r in rows), 2)
        non_billable = round(sum(r["nonBillable"] for r in rows), 2)
        total = billable + non_billable
        efficiency = round(billable / total * 100, 1) if total > 0 else 0

    return billable, non_billable, efficiency, len(rows)


VIEW_OPTIONS = [
    {"text": {"type": "plain_text", "text": "Team view"}, "value": "team"},
    {"text": {"type": "plain_text", "text": "Client view"}, "value": "client"},
]


def _team_label(team):
    """'Team M — Pavithira's Team', falling back when no lead is configured."""
    label = team.get("label") or team.get("id", "")
    lead = (team.get("leadName") or "").strip()
    return f"{label} — {lead}'s Team" if lead else label


def _select(action_id, placeholder, options, initial_value=None):
    element = {
        "type": "static_select",
        "placeholder": {"type": "plain_text", "text": placeholder},
        "action_id": action_id,
        "options": options,
    }
    match = next((o for o in options if o["value"] == initial_value), None)
    if match:
        element["initial_option"] = match
    return element


def _filter_input(action_id, label, placeholder, options,
                  initial_value=None, dispatch=False):
    """An input block: label sits ABOVE a full-width select, not beside it.

    `dispatch` makes the select fire a block_actions event on change, which is
    what drives the View -> Team -> Client cascade. The Client select leaves it
    off; the View dashboard button reads it out of the view state instead.
    """
    block = {
        "type": "input",
        "block_id": f"{action_id}_block",
        "label": {"type": "plain_text", "text": label},
        "element": _select(action_id, placeholder, options, initial_value),
    }
    if dispatch:
        block["dispatch_action"] = True
    return block


def _browse_blocks(teams, selection):
    """The 3 stacked cascading filters.

    Row 3 only ever lists the selected team's clients — never the full roster —
    and falls back to a plain section (no accessory) when there is nothing to
    show, because a static_select with zero options makes Slack reject the
    entire view.
    """
    view = selection.get("view") or "team"
    team_id = selection.get("team")
    client_name = selection.get("client")

    blocks = [
        {"type": "section", "text": {"type": "mrkdwn", "text": "*Browse dashboards*"}},
        # Row 1 — view mode
        _filter_input("filter_view", "View", "Team view", VIEW_OPTIONS,
                      view, dispatch=True),
    ]

    if view == "team":
        # Row 2 — team picker
        team_options = [
            {"text": {"type": "plain_text", "text": _team_label(t)[:75]},
             "value": t["id"]}
            for t in teams
        ]
        if team_options:
            blocks.append(_filter_input("filter_team", "Team", "Select a team...",
                                        team_options, team_id, dispatch=True))
        else:
            blocks.append({"type": "section", "text": {
                "type": "mrkdwn", "text": "*Team*\n_No teams available right now._"}})

        names = []
        if team_id:
            names = next((t["clients"] for t in teams if t["id"] == team_id), [])
    else:
        # Client view — Row 2 hidden, Row 3 lists every client.
        names = sorted({n for t in teams for n in t["clients"]})

    # Row 3 — client picker. Dispatches so the View dashboard button below can
    # be swapped in as soon as a client exists to open.
    if names:
        blocks.append(_filter_input("filter_client", "Client", "Select a client...",
                                    [_select_option(n) for n in names], client_name,
                                    dispatch=True))
    elif view == "team" and not team_id:
        blocks.append({"type": "section", "text": {
            "type": "mrkdwn", "text": "*Client*\n_Select a team first_"}})
    else:
        blocks.append({"type": "section", "text": {
            "type": "mrkdwn", "text": "*Client*\n_No clients available right now._"}})

    # A url button needs its url at publish time, so it can only appear once a
    # client is picked. Until then show inert text rather than a dead button.
    if client_name and names and client_name in names:
        blocks.append({"type": "actions", "elements": [{
            "type": "button",
            "text": {"type": "plain_text", "text": "View dashboard"},
            "style": "primary",
            "url": dashboard_url(selection),
            "action_id": "open_selected_dashboard",
        }]})
    else:
        blocks.append({"type": "section", "text": {
            "type": "mrkdwn", "text": "_Pick a client to open its dashboard_"}})

    return blocks


def _build_home_screen(teams, selection):
    """The single Home screen. This IS home — no back button anywhere."""
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": "MoneyPenny Assistant"}},
        {"type": "context", "elements": [
            {"type": "mrkdwn", "text": "SOPs · Timesheets · Client dashboards"}]},
        {"type": "divider"},
        # No button here: Slack cannot switch the user to the Messages tab, and
        # a button that only DMs them is worse than the instruction itself.
        {
            "type": "section",
            "text": {"type": "mrkdwn",
                     "text": "*Ask me anything* — type a question in the Messages tab."},
        },
        {"type": "section", "text": {"type": "mrkdwn", "text": "*Quick actions*"}},
        {"type": "actions", "elements": [
            {"type": "button", "text": {"type": "plain_text", "text": "Today's hours"},
             "action_id": "quick_today", "value": "today"},
            {"type": "button", "text": {"type": "plain_text", "text": "Yesterday report"},
             "action_id": "quick_yesterday", "value": "yesterday"},
            {"type": "button", "text": {"type": "plain_text", "text": "Find an SOP"},
             "action_id": "quick_sop", "value": "sop"},
        ]},
        {"type": "divider"},
        {
            "type": "section",
            "text": {"type": "mrkdwn",
                     "text": "*Team Dashboard*\nLive hours, BOD/EOD status and committed vs actual for every team."},
            "accessory": {
                "type": "button",
                "text": {"type": "plain_text", "text": "Open dashboard"},
                "url": TEAM_DASHBOARD_URL,
                "action_id": "open_team_dashboard",
            },
        },
    ]

    blocks += _browse_blocks(teams, selection)

    blocks += [
        {"type": "divider"},
        {"type": "context", "elements": [
            {"type": "mrkdwn",
             "text": f"MoneyPenny LLC · Live data · Updated {_updated_stamp()} · {HOME_BUILD}"}]},
    ]
    return blocks


def build_home(teams=None, selection=None):
    """Home tab blocks. There is only one screen now.

    The in-Slack client summary screen is gone: it duplicated the real
    dashboard badly and linked to a dead localhost:3000. Clients open in the
    browser via the View dashboard button instead.
    """
    if teams is None:
        teams = get_teams()
    return _build_home_screen(teams, selection or {})


@app.event("app_home_opened")
def update_home(client, event):
    user_id = event["user"]
    print(f"Home opened: {user_id}")
    try:
        publish_home(client, user_id, label="home_opened")
    except Exception as e:
        print(f"Error: {e}")


def publish_home(client, user_id, label="home"):
    """Re-publish Home with this user's current filter selections.

    Uses the cached roster, so a filter change costs no HTTP at all.
    """
    blocks = build_home(selection=user_selections.get(user_id))
    publish_view(client, user_id, blocks, label=label)


# Legacy action_ids from views published by older builds. They no longer have a
# screen to open, so they just bring the user back to Home — and, importantly,
# they stay registered so a stale view never shows a red error marker.
@app.action("open_dashboard")
@app.action("back_home")
@app.action("view_team_m")
@app.action("select_client")
@app.action("client_weekly")
@app.action("client_monthly")
@app.action(re.compile("^vc_"))
@app.action(re.compile("^team_client_"))
def handle_legacy_action(ack, body, client):
    ack()
    publish_home(client, body["user"]["id"], label="legacy")


def _selected_value(body):
    return ((body["actions"][0].get("selected_option") or {}).get("value"))


@app.action("filter_view")
def handle_filter_view(ack, body, client):
    ack()
    user_id = body["user"]["id"]
    value = _selected_value(body) or "team"
    # Switching mode invalidates the team/client beneath it.
    user_selections[user_id] = {"view": value, "team": None, "client": None}
    publish_home(client, user_id, label="filter_view")


@app.action("filter_team")
def handle_filter_team(ack, body, client):
    ack()
    user_id = body["user"]["id"]
    selection = user_selections.setdefault(user_id, {"view": "team"})
    selection["team"] = _selected_value(body)
    selection["client"] = None   # changing team clears the chosen client
    publish_home(client, user_id, label="filter_team")


@app.action("filter_client")
def handle_filter_client(ack, body, client):
    """Records the pick and re-publishes so View dashboard becomes a real button.

    No dashboard API call here — only the button itself leaves Slack.
    """
    ack()
    user_id = body["user"]["id"]
    selection = user_selections.setdefault(user_id, {"view": "team"})
    selection["client"] = _selected_value(body)
    publish_home(client, user_id, label="filter_client")


@app.action("open_selected_dashboard")
def handle_open_selected_dashboard(ack):
    # It is a url button — the browser opens the dashboard. Slack still sends
    # the action, so ack it or the button shows a red error marker.
    ack()


@app.action("open_chat")
def handle_open_chat(ack):
    # Button removed from Home. Kept registered so a click on a stale published
    # view does not raise a red error marker.
    ack()


@app.action("open_team_dashboard")
def handle_open_team_dashboard(ack):
    # A url button opens the browser itself, but Slack still sends the action.
    # Without this ack the user gets a red error marker on the button.
    ack()


def dm(client, user_id, text):
    """Post to the user's DM so the answer is waiting when the deep link lands."""
    try:
        client.chat_postMessage(channel=user_id, text=text)
    except Exception as e:
        print(f"dm failed for {user_id}: {e}")


@app.action("quick_today")
def handle_quick_today(ack, body, client):
    # ack() first — the deep link opens immediately, the report follows.
    ack()
    user_id = body["user"]["id"]
    try:
        data = fetch_client_dashboard(DEFAULT_QUICK_CLIENT, "today")
        if not data:
            dm(client, user_id,
               f"Couldn't reach the dashboard for today's {DEFAULT_QUICK_CLIENT.upper()} hours.")
            return
        billable, non_billable, efficiency, staff_count = _dashboard_totals(data)
        dm(client, user_id,
           f"*Today's hours — {DEFAULT_QUICK_CLIENT.upper()}*\n"
           f"{data.get('period', '')}\n"
           f"• Billable: {billable}h\n"
           f"• Non-billable: {non_billable}h\n"
           f"• Efficiency: {efficiency}%\n"
           f"• Staff: {staff_count}")
    except Exception as e:
        print(f"quick_today failed: {e}")
        dm(client, user_id, "Couldn't build today's hours just now — try again shortly.")


@app.action("quick_yesterday")
def handle_quick_yesterday(ack, body, client):
    ack()
    user_id = body["user"]["id"]
    try:
        dm(client, user_id, get_lastday_report(DEFAULT_QUICK_CLIENT))
    except Exception as e:
        print(f"quick_yesterday failed: {e}")
        dm(client, user_id,
           "Couldn't build yesterday's report just now — try `!lastday abs` here.")


@app.action("quick_sop")
def handle_quick_sop(ack, body, client):
    ack()
    dm(client, body["user"]["id"],
       "*Find an SOP*\nWhich SOP do you need? Just type your question here — "
       "for example _\"what's the month-end close process?\"_ — and I'll search Whale for it.")


def process_message(user_id, text, say, client, channel_id):
    try:
        sop_context = get_context(text, top_k=3)
        timesheet_text = get_timesheet_data()
        eod_text = get_eod_data()
        full_context = (
            "=== ABS SOP DATA ===\n" + sop_context +
            "\n\n=== LIVE TIMESHEET DATA ===\n" + timesheet_text +
            "\n\n" + eod_text
        )
        history = chat_history.get(user_id, [])
        answer = get_answer(text, full_context, history)
        history.append({"role": "user", "content": text})
        history.append({"role": "assistant", "content": answer})
        chat_history[user_id] = history[-8:]
        say(answer)
    except Exception as e:
        say(f"⚠️ Error: {str(e)}")


def handle_command(text, say):
    t = text.lower().strip()
    if t == "!weekly abs":
        say(get_client_report("abs", "weekly"))
        return True
    if t == "!lastweek abs":
        say(get_client_report("abs", "lastweek"))
        return True
    if t == "!monthly abs":
        say(get_client_report("abs", "monthly"))
        return True
    if t.startswith("!lastday "):
        say(get_lastday_report(text[9:].strip()))
        return True
    if t == "!lastday":
        say(get_lastday_report("abs"))
        return True
    if t.startswith("!weekly "):
        say(get_client_report(text[8:].strip(), "weekly"))
        return True
    if t.startswith("!lastweek "):
        say(get_client_report(text[10:].strip(), "lastweek"))
        return True
    if t.startswith("!monthly "):
        say(get_client_report(text[9:].strip(), "monthly"))
        return True
    if t == "!help":
        say("""👋 *MoneyPenny Assistant — Help*
━━━━━━━━━━━━━━━━━━━━━━
📋 *Commands:*
• `!weekly abs` — ABS this week
• `!lastweek abs` — ABS last week
• `!monthly abs` — ABS this month
• `!weekly <client>` — Any client this week
• `!lastday <client>` — Yesterday's report
• `!help` — Show this menu

📊 *Dashboard:*
Open the *Home* tab to view live client dashboards!

💬 *Ask any question about SOPs, timesheets, or EOD!*""")
        return True
    return False


@app.event("app_mention")
def handle_mention(event, say, client):
    user_id = event.get("user")
    text = re.sub(r"<@[A-Z0-9]+>", "", event.get("text", "")).strip()
    if not text:
        say("Hi! Ask me anything or open the *Home* tab to view dashboards!")
        return
    if handle_command(text, say):
        return
    process_message(user_id, text, say, client, event.get("channel"))


@app.event("message")
def handle_dm(event, say, client):
    user_id = event.get("user")
    if event.get("channel_type") != "im":
        return
    text = event.get("text", "").strip()
    if not text:
        return
    if handle_command(text, say):
        return
    process_message(user_id, text, say, client, event.get("channel"))


if __name__ == "__main__":
    print(f"Starting ABS Slack Bot with Dashboard! (home {HOME_BUILD})")
    ssl._create_default_https_context = ssl._create_unverified_context
    from slack_sdk import WebClient
    wc = WebClient(token=SLACK_BOT_TOKEN)

    # Warm the roster once so no filter interaction ever pays for a fetch.
    warm_started = time.perf_counter()
    warmed = get_teams(force=True)
    print(f"[startup] cached {len(warmed)} team(s), "
          f"{sum(len(t.get('clients') or []) for t in warmed)} client(s) in "
          f"{(time.perf_counter() - warm_started) * 1000:.0f}ms")

    try:
        publish_view(wc, ALLOWED_USER_ID, build_home(), label="startup")
        print("Home published!")
    except Exception as e:
        print(f"Home publish error: {e}")
    handler = SocketModeHandler(app, SLACK_APP_TOKEN)
    handler.start()