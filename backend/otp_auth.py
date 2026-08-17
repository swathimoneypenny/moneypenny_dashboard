"""Email + OTP authentication over AWS SES.

Flow:
  1. POST /api/auth/request-otp  → 6-digit code, hashed and stored, emailed
  2. POST /api/auth/verify-otp   → validates, issues a 30-day session token
  3. every API call             → Bearer token verified, user context attached

Deviations from the original sketch, all deliberate:

  * The response to request-otp is ALWAYS the same generic message. The sketch
    returned "rate_limited" only for whitelisted addresses, which turns the
    endpoint into an email-enumeration oracle: ask twice and a "please wait"
    reply confirms the address is authorized while an unknown one keeps saying
    "sent". Rate limiting now applies to every address and never changes the
    reply. `retryAfter` is included in both cases so the UI can still show a
    countdown without disclosing anything.

  * SESSION_SECRET is read at call time and validated. An empty secret would
    make HMAC keyed on b"" and every session token trivially forgeable, so
    auth refuses to operate rather than failing open.

  * The OTP store is swept on access so abandoned codes cannot accumulate.

The store is in-process: a backend restart invalidates pending (unverified)
OTPs, and users simply request a new code. Issued session tokens are unaffected
because they are stateless HMACs.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from datetime import datetime, timedelta

from access_control import get_user_access, is_authorized, normalize_email

SESSION_TTL_DAYS = 30
OTP_TTL_MINUTES = 10
OTP_LENGTH = 6
MAX_OTP_ATTEMPTS = 5
OTP_RATE_LIMIT_SECONDS = 60

SES_REGION = os.getenv("AWS_REGION", "ap-southeast-2")
SES_FROM_EMAIL = os.getenv("SES_FROM_EMAIL", "no-reply@beyond-numbers.com")

_GENERIC_SENT = "If your email is authorized, a login code has been sent."

_lock = threading.Lock()
# {email: {"code_hash", "expires", "attempts"}}
_otp_store: dict[str, dict] = {}
# {email: last_request_epoch} — populated for EVERY address, authorized or not.
_otp_rate_limit: dict[str, float] = {}

_ses_client = None


def enabled() -> bool:
    """Whether OTP auth replaces the password login. Read at call time so
    `pm2 restart --update-env` applies it."""
    return os.getenv("OTP_AUTH_ENABLED", "").strip().lower() in ("1", "true", "yes")


def _session_secret() -> bytes:
    secret = (os.getenv("DASHBOARD_SESSION_SECRET") or "").strip()
    if len(secret) < 16:
        # Refuse rather than sign with an empty/weak key — an attacker who can
        # guess it can mint tokens for any email, including admins.
        raise RuntimeError(
            "DASHBOARD_SESSION_SECRET is missing or too short (<16 chars). "
            "Generate one with: python3 -c \"import secrets; print(secrets.token_hex(32))\""
        )
    return secret.encode()


def _ses():
    global _ses_client
    if _ses_client is None:
        import boto3  # imported lazily so the module loads without boto3
        _ses_client = boto3.client("ses", region_name=SES_REGION)
    return _ses_client


# ── OTP issue ─────────────────────────────────────────────────────
def generate_otp() -> str:
    return f"{secrets.randbelow(10 ** OTP_LENGTH):0{OTP_LENGTH}d}"


def _hash_otp(code: str, email: str) -> str:
    return hmac.new(_session_secret(), f"{code}:{email}".encode(), hashlib.sha256).hexdigest()


def _sweep(now_epoch: float) -> None:
    """Drop expired OTPs and stale rate-limit marks. Called under _lock."""
    dead = [e for e, v in _otp_store.items() if v["expires"].timestamp() < now_epoch]
    for e in dead:
        _otp_store.pop(e, None)
    stale = [e for e, t in _otp_rate_limit.items()
             if now_epoch - t > max(OTP_RATE_LIMIT_SECONDS, OTP_TTL_MINUTES * 60) * 2]
    for e in stale:
        _otp_rate_limit.pop(e, None)


def request_otp(email: str) -> dict:
    """Generate + email an OTP. The reply is identical for every address."""
    email = normalize_email(email)
    now = time.time()

    if not email or "@" not in email:
        return {"status": "sent", "message": _GENERIC_SENT, "retryAfter": OTP_RATE_LIMIT_SECONDS}

    with _lock:
        _sweep(now)
        last = _otp_rate_limit.get(email, 0.0)
        throttled = (now - last) < OTP_RATE_LIMIT_SECONDS
        retry_after = int(OTP_RATE_LIMIT_SECONDS - (now - last)) if throttled else OTP_RATE_LIMIT_SECONDS
        if not throttled:
            _otp_rate_limit[email] = now

    # Same shape whether or not the address is authorized, and whether or not it
    # was throttled — only the countdown differs.
    reply = {"status": "sent", "message": _GENERIC_SENT, "retryAfter": retry_after}

    if throttled or not is_authorized(email):
        return reply

    access = get_user_access(email)
    code = generate_otp()
    try:
        code_hash = _hash_otp(code, email)
    except RuntimeError as e:
        print(f"[OTP] refusing to issue: {e}")
        return {"status": "error", "message": "Login is misconfigured on the server."}

    with _lock:
        _otp_store[email] = {
            "code_hash": code_hash,
            "expires": datetime.now() + timedelta(minutes=OTP_TTL_MINUTES),
            "attempts": 0,
        }

    if not _send_otp_email(email, access["name"], code):
        with _lock:
            _otp_store.pop(email, None)
            _otp_rate_limit.pop(email, None)
        return {"status": "error", "message": "Could not send the code. Please contact an admin."}
    return reply


def _send_otp_email(email: str, name: str, code: str) -> bool:
    subject = "MoneyPenny Dashboard — Your Login Code"
    body_text = (
        f"Hi {name},\n\n"
        f"Your MoneyPenny Dashboard login code is:\n\n    {code}\n\n"
        f"This code expires in {OTP_TTL_MINUTES} minutes. Do not share it with anyone.\n\n"
        f"If you didn't request this code, you can ignore this email.\n\n"
        f"--\nMoneyPenny LLC Dashboard\n"
    )
    body_html = f"""
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:500px;margin:0 auto">
      <h2 style="color:#FF8403;margin-bottom:4px">MoneyPenny Dashboard</h2>
      <p>Hi {name},</p>
      <p>Your login code is:</p>
      <div style="background:#f5f5f5;padding:20px;text-align:center;font-size:32px;
                  font-weight:700;letter-spacing:8px;color:#3C3C3C;border-radius:8px;margin:20px 0">
        {code}
      </div>
      <p style="color:#666">This code expires in {OTP_TTL_MINUTES} minutes.<br>
      Do not share it with anyone.</p>
      <p style="color:#999;font-size:12px">If you didn't request this code, ignore this email.</p>
    </div>
    """
    try:
        _ses().send_email(
            Source=SES_FROM_EMAIL,
            Destination={"ToAddresses": [email]},
            Message={
                "Subject": {"Data": subject},
                "Body": {"Text": {"Data": body_text}, "Html": {"Data": body_html}},
            },
        )
        return True
    except Exception as e:
        # Never log the code itself.
        print(f"[OTP] SES send failed for {email}: {type(e).__name__}: {e}")
        return False


# ── OTP verify + session tokens ───────────────────────────────────
def verify_otp_and_issue_token(email: str, code: str) -> tuple[dict, str | None]:
    email = normalize_email(email)
    code = (code or "").strip()
    generic = {"status": "error", "message": "Invalid or expired code."}

    if not is_authorized(email):
        return generic, None

    with _lock:
        entry = _otp_store.get(email)
        if not entry:
            return generic, None
        if datetime.now() > entry["expires"]:
            _otp_store.pop(email, None)
            return {"status": "error", "message": "Code expired. Request a new one."}, None
        if entry["attempts"] >= MAX_OTP_ATTEMPTS:
            _otp_store.pop(email, None)
            return {"status": "error", "message": "Too many attempts. Request a new code."}, None
        entry["attempts"] += 1
        stored_hash = entry["code_hash"]
        attempts_left = MAX_OTP_ATTEMPTS - entry["attempts"]

    try:
        candidate = _hash_otp(code, email)
    except RuntimeError:
        return {"status": "error", "message": "Login is misconfigured on the server."}, None

    if not hmac.compare_digest(stored_hash, candidate):
        return {"status": "error", "message": "Invalid code.",
                "attemptsRemaining": max(attempts_left, 0)}, None

    with _lock:
        _otp_store.pop(email, None)
        _otp_rate_limit.pop(email, None)

    token = issue_session_token(email)
    access = get_user_access(email)
    return {
        "status": "success",
        "token": token,
        "user": {"email": email, "name": access["name"],
                 "role": access["role"], "team": access["team"]},
        "expiresInSecs": SESSION_TTL_DAYS * 24 * 3600,
    }, token


def issue_session_token(email: str) -> str:
    payload = {
        "email": email,
        "iat": int(time.time()),
        "exp": int(time.time()) + SESSION_TTL_DAYS * 24 * 3600,
        "jti": secrets.token_hex(8),
    }
    payload_b64 = base64.urlsafe_b64encode(
        json.dumps(payload, sort_keys=True).encode()).decode().rstrip("=")
    sig = hmac.new(_session_secret(), payload_b64.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def verify_session_token(token: str) -> dict | None:
    """Return the user context, or None. Never raises."""
    if not token or "." not in token:
        return None
    try:
        payload_b64, sig = token.rsplit(".", 1)
        expected = hmac.new(_session_secret(), payload_b64.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        if int(payload["exp"]) < time.time():
            return None
        email = payload["email"]
        access = get_user_access(email)
        if not access:
            # Revoked by removal from the whitelist since the token was issued.
            return None
        return {"email": email, "role": access["role"],
                "team": access["team"], "name": access["name"]}
    except (ValueError, KeyError, TypeError, json.JSONDecodeError,
            binascii.Error, RuntimeError):
        return None


def ses_selftest(to_email: str) -> dict:
    """Send a plain test email. Admin-only diagnostic."""
    try:
        resp = _ses().send_email(
            Source=SES_FROM_EMAIL,
            Destination={"ToAddresses": [normalize_email(to_email)]},
            Message={"Subject": {"Data": "MoneyPenny Dashboard — SES test"},
                     "Body": {"Text": {"Data": "SES is configured correctly."}}},
        )
        return {"ok": True, "messageId": resp.get("MessageId"),
                "from": SES_FROM_EMAIL, "region": SES_REGION}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}",
                "from": SES_FROM_EMAIL, "region": SES_REGION}


def health() -> dict:
    secret_ok = True
    secret_err = None
    try:
        _session_secret()
    except RuntimeError as e:
        secret_ok, secret_err = False, str(e)
    try:
        import boto3  # noqa: F401
        boto3_ok = True
    except ImportError:
        boto3_ok = False
    with _lock:
        pending = len(_otp_store)
    return {
        "otp_auth_enabled": enabled(),
        "session_secret_ok": secret_ok,
        "session_secret_error": secret_err,
        "boto3_installed": boto3_ok,
        "ses_region": SES_REGION,
        "ses_from": SES_FROM_EMAIL,
        "pending_otps": pending,
        "session_ttl_days": SESSION_TTL_DAYS,
        "otp_ttl_minutes": OTP_TTL_MINUTES,
        "rate_limit_seconds": OTP_RATE_LIMIT_SECONDS,
        "max_attempts": MAX_OTP_ATTEMPTS,
    }
