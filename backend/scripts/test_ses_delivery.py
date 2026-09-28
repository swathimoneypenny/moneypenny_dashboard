"""Send one test email straight through SES, bypassing the OTP flow.

    venv/bin/python3 scripts/test_ses_delivery.py someone@moneypennyllc.com

"Sent" only means SES accepted it. If it then doesn't arrive, the problem is
downstream (recipient mail server quarantine / junk), not the dashboard.
"""
import os
import sys

import boto3
from botocore.exceptions import ClientError

if len(sys.argv) < 2:
    print("Usage: python3 test_ses_delivery.py <email@moneypennyllc.com>")
    sys.exit(1)

recipient = sys.argv[1].strip()
region = os.getenv("AWS_REGION", "ap-southeast-2")
sender = os.getenv("SES_FROM_EMAIL", "no-reply@beyond-numbers.com")
ses = boto3.client("ses", region_name=region)

try:
    resp = ses.send_email(
        Source=sender,
        Destination={"ToAddresses": [recipient]},
        Message={
            "Subject": {"Data": "MPLLC Dashboard - Test Delivery"},
            "Body": {
                "Text": {"Data": f"This is a test email to {recipient} from MPLLC Dashboard.\n\n"
                                 "If you receive this, SES delivery is working.\n\n"
                                 "If you receive this in Junk/Spam, please mark it as \"Not Spam\"."},
                "Html": {"Data": f"<p>Test email to <b>{recipient}</b>.</p>"
                                 "<p>If received, SES delivery is working.</p>"
                                 "<p>If in Junk/Spam, mark it \"Not Spam\".</p>"},
            },
        },
    )
    print(f"OK  sent from {sender} via {region}. MessageId: {resp['MessageId']}")
except ClientError as e:
    print(f"FAIL SES error: {e.response['Error']['Code']}: {e.response['Error']['Message']}")
    sys.exit(2)
