import requests
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()


def fetch_report(start_date, end_date):
    try:
        token = os.getenv("TIMESHEET_API_TOKEN")
        api_key = os.getenv("TIMESHEET_API_KEY")

        headers = {
            "apikey": api_key,
            "x-ts-authorization": token
        }

        # Get all users
        users_resp = requests.get(
            "https://secure.timesheets.com/api/public/v1/users?maxrows=300",
            headers=headers,
            timeout=10
        )
        users = users_resp.json()["data"]["users"]["Data"]

        # Build POST body
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
            headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
            data=body,
            timeout=15
        )
        return report_resp.json()

    except Exception as e:
        return None


def format_timesheet(data, label):
    try:
        lines = [f"=== TIMESHEET — {label} ==="]
        total_billable = 0
        total_non_billable = 0
        staff_summary = {}

        if data and data.get("report") and data["report"].get("ReportData"):
            for group in data["report"]["ReportData"]:
                if not group.get("Records") or not group["Records"].get("Data"):
                    continue
                for row in group["Records"]["Data"]:
                    name = row.get("FULLNAME", "Unknown")
                    hours = float(row.get("HOURS", 0))
                    client = row.get("CUSTOMERNAME", row.get("ACCOUNTCODENAME", "N/A"))
                    billable = str(row.get("BILLABLE", "0")) == "1"

                    if hours <= 0:
                        continue

                    if name not in staff_summary:
                        staff_summary[name] = {"billable": 0, "non_billable": 0}

                    if billable:
                        total_billable += hours
                        staff_summary[name]["billable"] += hours
                    else:
                        total_non_billable += hours
                        staff_summary[name]["non_billable"] += hours

        lines.append(f"\n--- {label} Staff Summary ---")
        for name, hrs in sorted(staff_summary.items(), key=lambda x: x[1]["non_billable"], reverse=True):
            lines.append(
                f"STAFF: {name} | Billable: {round(hrs['billable'], 2)} hrs | Non-Billable: {round(hrs['non_billable'], 2)} hrs"
            )

        lines.append(f"\nTOTAL BILLABLE ({label}): {round(total_billable, 2)} hrs")
        lines.append(f"TOTAL NON-BILLABLE ({label}): {round(total_non_billable, 2)} hrs")
        lines.append(f"GRAND TOTAL ({label}): {round(total_billable + total_non_billable, 2)} hrs")

        return "\n".join(lines)

    except Exception as e:
        return f"Could not format timesheet: {str(e)}"


def get_timesheet_data():
    """Main function — fetches today + yesterday timesheet data"""
    today = datetime.now().strftime("%Y-%m-%d")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    today_data = fetch_report(today, today)
    yesterday_data = fetch_report(yesterday, yesterday)

    today_text = format_timesheet(today_data, "Today")
    yesterday_text = format_timesheet(yesterday_data, "Yesterday")

    return today_text + "\n\n" + yesterday_text