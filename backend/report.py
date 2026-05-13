import os
import requests
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

TIMESHEET_API_TOKEN = os.getenv("TIMESHEET_API_TOKEN")
TIMESHEET_API_KEY = os.getenv("TIMESHEET_API_KEY")

ABS_TEAM = {
    "Pavithira Vinayaga Moorthy": "TL",
    "Bhuvaneswari Balaji": "Preparer",
    "Reshma Lakshmanaboopathi": "Preparer",
}

CLIENT_ALIASES = {
    "abs": ["Accounting Benefit Solutions (ABS)", "SNMP"],
    "accounting benefit": ["Accounting Benefit Solutions (ABS)"],
    "jb": ["JB Advisory Group"],
    "jb advisory": ["JB Advisory Group"],
    "gfa": ["Go Figure Accounting"],
    "go figure": ["Go Figure Accounting"],
    "movement": ["Movement Medical, LLC"],
    "movement medical": ["Movement Medical, LLC"],
    "portnoy": ["Portnoy CPA"],
    "thrive": ["Thrive Business Services", "Thrive - Production"],
    "wiebe": ["Wiebe Hinton Hambalek LLP"],
    "financly": ["Financly"],
    "ais": ["AIS Solutions"],
    "nisivoccia": ["NisiVoccia LLP", "NisiVoccia LLP CAS"],
    "katy": ["Katy Advisors LLC"],
    "katy advisors": ["Katy Advisors LLC"],
    "cbms": ["CBMS_MyProsperityTree"],
    "back office": ["Back Office People"],
    "beacon": ["Beacon Advisors"],
    "core 4": ["Core 4 Financial"],
    "pokorny": ["Pokorny CPAs"],
    "soco": ["SoCo Business Solutions, Inc"],
    "redmond": ["Redmond Accounting Inc"],
    "ez ledger": ["EZ Ledger Inc"],
    "manzelli": ["Manzelli Consulting"],
    "putma accountancy": ["Putman Accountancy Corporation"],
    "modern cpas": ["Modern CPAs"],
    "empower accounting": ["Empower Accounting"],
    "lah cpa": ["LAH CPAs"],
    "radicle science": ["Radicle Science Inc."],
    "financial synergy": ["Financial Synergy"],
    "rdg tax group": ["RDG Tax Group LLC"],
    "sambrano": ["Sambrano Services"],
    "stay by rafa": ["Stay By Rafa"],
    "artesani": ["Artesani Accounting"],
    "mintage": ["Mintage Labs"],
    "24hr": ["24 Hr Bookkeeper"],
    "bookkeeping doctor": ["Bookkeeping Doctor"],
    "ollin balance": ["Ollin Balance"],
    "smithbookkeeping": ["Smithbookkeeping"],
    "acs": ["ASC Custom Books"],
    "asc": ["ASC Custom Books"],
    "tim thompson": ["Tim Thompson CPA"],
    "bkp repair": ["Bookkeeping Repair LLC"],
    "baker bookkeeps": ["Baker Bookkeeps"],
    "proper trust": ["The Proper Trust LLC"],
    "daa cpa": ["DAA CPA"],
    "equity champions": ["Equity Champions"],
}


def get_role(name):
    for member, role in ABS_TEAM.items():
        if member.lower() in name.lower() or name.lower() in member.lower():
            return role
    return None


def fetch_timesheet(start_date, end_date):
    try:
        headers = {
            "apikey": TIMESHEET_API_KEY,
            "x-ts-authorization": TIMESHEET_API_TOKEN
        }
        users_resp = requests.get(
            "https://secure.timesheets.com/api/public/v1/users?maxrows=300",
            headers=headers, timeout=10
        )
        users = users_resp.json()["data"]["users"]["Data"]

        body = (
            f"StartDate={start_date}&EndDate={end_date}"
            "&AllAccountCodes=1&GroupType=None&ReportType=Detailed"
            "&AllCustomers=1&AllProjects=1&Signed=0,1&Approved=0,1"
            "&Billable=0,1&RecordStatus=0,1"
        )
        for u in users:
            body += f"&UserList={u['USERID']}"

        resp = requests.post(
            "https://secure.timesheets.com/api/public/v1/report/project/customizable",
            headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
            data=body, timeout=15
        )
        return resp.json()
    except Exception as e:
        return None


def build_report(staff, title):
    total_billable = sum(v["billable"] for v in staff.values())
    total_non_billable = sum(v["non_billable"] for v in staff.values())
    total = total_billable + total_non_billable
    efficiency = round((total_billable / total * 100), 1) if total > 0 else 0

    lines = [
        f"📊 *{title}*",
        "━━━━━━━━━━━━━━━━━━━━━━",
        "*📈 Overall Performance*",
        f"✅ Total Billable: *{round(total_billable, 2)} hrs*",
        f"🔴 Non-Billable: *{round(total_non_billable, 2)} hrs*",
        f"📊 Efficiency: *{efficiency}%*",
        "",
        "*👤 Staff Breakdown*",
        "━━━━━━━━━━━━━━━━━━━━━━",
    ]

    for name, hrs in sorted(staff.items(), key=lambda x: (x[1]["role"] != "TL", -x[1]["billable"])):
        role = hrs["role"]
        lines.append(
            f"• {name} ({role}) — Billable: *{round(hrs['billable'], 2)} hrs* | Non-Bill: *{round(hrs['non_billable'], 2)} hrs*"
        )

    return "\n".join(lines)


def get_lastday_report(client_input="abs"):
    client_key = client_input.lower().strip()
    aliases = CLIENT_ALIASES.get(client_key, [client_input])
    is_abs = client_key == "abs"

    today = datetime.now()
    yesterday = today - timedelta(days=1)
    start = yesterday.strftime("%Y-%m-%d")
    end = yesterday.strftime("%Y-%m-%d")
    label = yesterday.strftime("%b %d, %Y")

    data = fetch_timesheet(start, end)
    staff = {}

    if data and data.get("report") and data["report"].get("ReportData"):
        for group in data["report"]["ReportData"]:
            if not group.get("Records") or not group["Records"].get("Data"):
                continue
            for row in group["Records"]["Data"]:
                name = row.get("FULLNAME", "Unknown")
                hours = float(row.get("HOURS", 0))
                billable = str(row.get("BILLABLE", "0")) == "1"
                customer = row.get("CUSTOMERNAME", "")
                desc = row.get("WORKDESCRIPTION", "")
                project = row.get("PROJECTNAME", "")

                if hours <= 0:
                    continue

                if is_abs:
                    role = get_role(name)
                    if role is None:
                        continue
                    if any(x in project for x in ["Admin", "Training", "SNMPLLC INTERNAL"]) and not billable:
                        continue
                    if name not in staff:
                        staff[name] = {"billable": 0, "non_billable": 0, "role": role}
                else:
                    matched = any(alias.lower() in customer.lower() or alias.lower() in desc.lower() for alias in aliases)
                    if not matched:
                        continue
                    if name not in staff:
                        staff[name] = {"billable": 0, "non_billable": 0, "role": "Employee"}

                if billable:
                    staff[name]["billable"] += hours
                else:
                    staff[name]["non_billable"] += hours

    if not staff:
        return f"⚠️ No data found for *{client_input}* yesterday!"

    return build_report(staff, f"{client_input.upper()} Yesterday Report — {label}")


def get_client_report(client_input, period="lastweek"):
    client_key = client_input.lower().strip()
    aliases = CLIENT_ALIASES.get(client_key, [client_input])
    is_abs = client_key == "abs"

    today = datetime.now()
    if period == "weekly":
        start = (today - timedelta(days=today.weekday())).strftime("%Y-%m-%d")
        end = today.strftime("%Y-%m-%d")
        label = f"{(today - timedelta(days=today.weekday())).strftime('%b %d')} – {today.strftime('%b %d, %Y')}"
    elif period == "lastweek":
        last_monday = today - timedelta(days=today.weekday() + 7)
        last_sunday = last_monday + timedelta(days=6)
        start = last_monday.strftime("%Y-%m-%d")
        end = last_sunday.strftime("%Y-%m-%d")
        label = f"{last_monday.strftime('%b %d')} – {last_sunday.strftime('%b %d, %Y')}"
    else:
        start = today.replace(day=1).strftime("%Y-%m-%d")
        end = today.strftime("%Y-%m-%d")
        label = today.strftime("%B %Y")

    data = fetch_timesheet(start, end)
    staff = {}

    if data and data.get("report") and data["report"].get("ReportData"):
        for group in data["report"]["ReportData"]:
            if not group.get("Records") or not group["Records"].get("Data"):
                continue
            for row in group["Records"]["Data"]:
                name = row.get("FULLNAME", "Unknown")
                hours = float(row.get("HOURS", 0))
                billable = str(row.get("BILLABLE", "0")) == "1"
                customer = row.get("CUSTOMERNAME", "")
                desc = row.get("WORKDESCRIPTION", "")
                project = row.get("PROJECTNAME", "")

                if hours <= 0:
                    continue

                # For ABS — filter team members + skip admin entries
                if is_abs:
                    role = get_role(name)
                    if role is None:
                        continue
                    if any(x in project for x in ["Admin", "Training", "SNMPLLC INTERNAL"]) and not billable:
                        continue
                    if name not in staff:
                        staff[name] = {"billable": 0, "non_billable": 0, "role": role}
                else:
                    # For other clients — match by customer name
                    matched = any(
                        alias.lower() in customer.lower() or alias.lower() in desc.lower()
                        for alias in aliases
                    )
                    if not matched:
                        continue
                    if name not in staff:
                        staff[name] = {"billable": 0, "non_billable": 0, "role": "Employee"}

                if billable:
                    staff[name]["billable"] += hours
                else:
                    staff[name]["non_billable"] += hours

    if not staff:
        return f"⚠️ No data found for *{client_input}* — this client may not be active currently!"

    return build_report(staff, f"{client_input.upper()} Report — {label}")