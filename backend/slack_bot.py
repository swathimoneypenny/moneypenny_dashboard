import certifi
import os
os.environ['SSL_CERT_FILE'] = certifi.where()
os.environ['WEBSOCKET_CLIENT_CA_BUNDLE'] = certifi.where()

import ssl
ssl._create_default_https_context = ssl._create_unverified_context

import re
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


def is_allowed(user_id):
    return True


def fetch_active_clients():
    try:
        resp = requests.get(f"{DASHBOARD_API}/api/active-clients", timeout=30)
        return resp.json().get("clients", [])[:24]
    except:
        return []


def fetch_client_dashboard(client_name, period="weekly"):
    try:
        resp = requests.get(
            f"{DASHBOARD_API}/api/client/{requests.utils.quote(client_name)}/{period}",
            timeout=30
        )
        return resp.json()
    except:
        return None


def build_home(show_clients=False, clients=None, selected_client=None, client_data=None):
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": "💰 MoneyPenny Assistant", "emoji": True}},
        {"type": "section", "text": {"type": "mrkdwn", "text": "Your AI assistant for SOPs, timesheets, and client dashboards."}},
        {"type": "divider"},
    ]

    # Home Page
    if not show_clients and not selected_client:
        blocks += [
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "*💬 Chat*\nSend a message in the *Messages* tab to ask about SOPs, timesheets, payroll and more!"}
            },
            {"type": "divider"},
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "*📊 MP Dashboard*\nView live performance data for all active clients."},
                "accessory": {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Open Dashboard", "emoji": True},
                    "style": "primary",
                    "action_id": "open_dashboard",
                    "value": "open"
                }
            },
            {"type": "divider"},
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "*⌨️ Quick Commands:*\n• `!weekly abs` — ABS weekly report\n• `!monthly abs` — ABS monthly report\n• `!lastweek <client>` — Any client last week\n• `!help` — Show all commands"}
            },
        ]

    # Clients List
    if show_clients and clients:
        blocks += [
            {"type": "section", "text": {"type": "mrkdwn", "text": "*📊 Active Clients — Last 30 Days*\nClick any client to view live dashboard:"}},
            {"type": "divider"},
            {
                "type": "actions",
                "elements": [{
                    "type": "button",
                    "text": {"type": "plain_text", "text": "← Back to Home", "emoji": True},
                    "action_id": "back_home",
                    "value": "back"
                }]
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "⭐ *Team M — All Clients* (ABS, Radicle, DAA CPA, Equity Champions)"},
                "accessory": {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "View Team M", "emoji": True},
                    "style": "primary",
                    "action_id": "view_team_m",
                    "value": "team_m"
                }
            },
            {"type": "divider"},
        ]

        for i in range(0, len(clients), 2):
            row = clients[i:i+2]
            elements = []
            for j, c in enumerate(row):
                elements.append({
                    "type": "button",
                    "text": {"type": "plain_text", "text": c["name"][:20], "emoji": True},
                    "action_id": f"vc_{i+j}",
                    "value": c["name"]
                })
            blocks.append({"type": "actions", "elements": elements})

    # Client Dashboard
    if selected_client and client_data:
        staff = client_data.get("staff", {})
        total_billable = round(sum(v["billable"] for v in staff.values()), 2)
        total_non = round(sum(v["nonBillable"] for v in staff.values()), 2)
        total = total_billable + total_non
        efficiency = round(total_billable / total * 100, 1) if total > 0 else 0
        status_emoji = "🟢" if efficiency >= 80 else "🟡" if efficiency >= 50 else "🔴"

        blocks += [
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*📊 {selected_client}*\n{client_data.get('period', '')}"}},
            {"type": "divider"},
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"✅ *Total Billable*\n{total_billable}h"},
                    {"type": "mrkdwn", "text": f"🔴 *Non-Billable*\n{total_non}h"},
                    {"type": "mrkdwn", "text": f"{status_emoji} *Efficiency*\n{efficiency}%"},
                    {"type": "mrkdwn", "text": f"👥 *Staff Count*\n{len(staff)}"},
                ]
            },
            {"type": "divider"},
        ]

        top_staff = sorted(staff.items(), key=lambda x: x[1]["billable"], reverse=True)[:5]
        staff_text = "*👤 Staff Breakdown:*\n"
        for name, hrs in top_staff:
            t = hrs["billable"] + hrs["nonBillable"]
            e = round(hrs["billable"] / t * 100) if t > 0 else 0
            bar = "🟩" * (e // 20) + "⬜" * (5 - e // 20)
            staff_text += f"{bar} {name.split()[0]} — {hrs['billable']}h ({e}%)\n"

        blocks += [
            {"type": "section", "text": {"type": "mrkdwn", "text": staff_text}},
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "📊 *View full charts dashboard in browser:*\n`http://localhost:3000`"}
            },
            {"type": "divider"},
           {
             "type": "actions",
             "elements": [
                {"type": "button", "text": {"type": "plain_text", "text": "← Back to Clients"}, "action_id": "open_dashboard", "value": "open"},
                {"type": "button", "text": {"type": "plain_text", "text": "📅 This Week"}, "action_id": "client_weekly", "value": selected_client},
                {"type": "button", "text": {"type": "plain_text", "text": "📆 This Month"}, "action_id": "client_monthly", "value": selected_client},
        ]
    },
]

    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": "MoneyPenny LLC • Live Data"}]})
    return blocks


@app.event("app_home_opened")
def update_home(client, event):
    user_id = event["user"]
    print(f"Home opened: {user_id}")
    try:
        result = client.views_publish(user_id=user_id, view={"type": "home", "blocks": build_home()})
        print(f"Published: {result['ok']}")
    except Exception as e:
        print(f"Error: {e}")


@app.action("open_dashboard")
def handle_open_dashboard(ack, body, client):
    ack()
    user_id = body["user"]["id"]
    clients = fetch_active_clients()
    client.views_publish(user_id=user_id, view={"type": "home", "blocks": build_home(show_clients=True, clients=clients)})


@app.action("back_home")
def handle_back_home(ack, body, client):
    ack()
    user_id = body["user"]["id"]
    client.views_publish(user_id=user_id, view={"type": "home", "blocks": build_home()})


@app.action("view_team_m")
def handle_view_team_m(ack, body, client):
    ack()
    user_id = body["user"]["id"]
    clients = fetch_active_clients()
    client.views_publish(user_id=user_id, view={"type": "home", "blocks": build_home(show_clients=True, clients=clients)})


@app.action(re.compile("^vc_"))
def handle_view_client(ack, body, client):
    ack()
    user_id = body["user"]["id"]
    client_name = body["actions"][0]["value"]
    data = fetch_client_dashboard(client_name, "weekly")
    client.views_publish(user_id=user_id, view={"type": "home", "blocks": build_home(selected_client=client_name, client_data=data)})


@app.action("client_weekly")
def handle_client_weekly(ack, body, client):
    ack()
    user_id = body["user"]["id"]
    client_name = body["actions"][0]["value"]
    data = fetch_client_dashboard(client_name, "weekly")
    client.views_publish(user_id=user_id, view={"type": "home", "blocks": build_home(selected_client=client_name, client_data=data)})


@app.action("client_monthly")
def handle_client_monthly(ack, body, client):
    ack()
    user_id = body["user"]["id"]
    client_name = body["actions"][0]["value"]
    data = fetch_client_dashboard(client_name, "monthly")
    client.views_publish(user_id=user_id, view={"type": "home", "blocks": build_home(selected_client=client_name, client_data=data)})


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
    print("Starting ABS Slack Bot with Dashboard!")
    ssl._create_default_https_context = ssl._create_unverified_context
    from slack_sdk import WebClient
    wc = WebClient(token=SLACK_BOT_TOKEN)
    try:
        wc.views_publish(user_id=ALLOWED_USER_ID, view={"type": "home", "blocks": build_home()})
        print("Home published!")
    except Exception as e:
        print(f"Home publish error: {e}")
    handler = SocketModeHandler(app, SLACK_APP_TOKEN)
    handler.start()