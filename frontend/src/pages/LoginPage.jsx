import { useEffect, useRef, useState } from "react";
import { C, API_BASE, setToken } from "../config";

// Beyond Numbers brand accents used on the login card only.
const BRAND_ORANGE = "#FF8403";
const BRAND_CHARCOAL = "#3C3C3C";
const RESEND_SECONDS = 60;

/**
 * Two-step sign-in: work email → 6-digit code emailed via SES.
 *
 * Falls back to the legacy shared-password form when the server still has
 * OTP_AUTH_ENABLED off AND a password configured, so the rollout can proceed
 * without a flag-day. /api/auth/health tells us which mode is live; it is
 * auth-exempt precisely so this page can ask before anyone is signed in.
 */
export default function LoginPage({ onLogin }) {
  const [mode, setMode] = useState(null); // null = probing, "otp" | "password"
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMode(d?.otp_auth_enabled ? "otp" : "otp_optional"))
      .catch(() => setMode("otp_optional"));
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (step === "code" && codeRef.current) codeRef.current.focus();
  }, [step]);

  async function requestCode(e) {
    if (e) e.preventDefault();
    if (!email.trim() || !email.includes("@")) {
      setError("Enter your work email address.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.status === "error") {
        setError(data.message || "Could not send the code.");
        return;
      }
      // The server deliberately answers the same way for unknown addresses, so
      // the wording here must not imply the email was recognised.
      setNotice(data?.message || "If your email is authorized, a login code has been sent.");
      setCooldown(Number(data?.retryAfter) || RESEND_SECONDS);
      setStep("code");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode(e) {
    e.preventDefault();
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code: clean }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.status !== "success" || !data?.token) {
        let msg = data?.message || "Invalid code.";
        if (typeof data?.attemptsRemaining === "number") {
          msg += ` ${data.attemptsRemaining} attempt${data.attemptsRemaining === 1 ? "" : "s"} left.`;
        }
        setError(msg);
        return;
      }
      setToken(data.token);
      if (onLogin) onLogin(data.user);
      else window.location.reload();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPassword(e) {
    e.preventDefault();
    if (!password) {
      setError("Enter the password.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.status === 410) {
        setError("Password sign-in has been retired. Use your work email instead.");
        setMode("otp");
        return;
      }
      if (res.status === 503) {
        setError("Server has no password configured.");
        return;
      }
      if (!res.ok) {
        setError("Wrong password.");
        return;
      }
      const data = await res.json();
      if (!data?.token) {
        setError("Login failed: no token returned.");
        return;
      }
      setToken(data.token);
      if (onLogin) onLogin();
      else window.location.reload();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  const input = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.surface,
    color: C.pri,
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  };
  const button = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 8,
    border: "none",
    background: BRAND_ORANGE,
    color: "#fff",
    fontSize: 14,
    fontWeight: 700,
    cursor: submitting ? "default" : "pointer",
    opacity: submitting ? 0.7 : 1,
    marginTop: 14,
  };
  const linkBtn = {
    background: "transparent",
    border: "none",
    color: C.muted,
    fontSize: 12,
    cursor: "pointer",
    textDecoration: "underline",
    padding: 0,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `radial-gradient(1100px 520px at 50% -10%, rgba(255,132,3,0.14), transparent), ${C.bg}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          padding: 28,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 26 }}>💰</span>
          <div style={{ fontSize: 19, fontWeight: 700, color: C.pri }}>
            MoneyPenny Dashboard
          </div>
        </div>
        <div style={{ fontSize: 13, color: C.sec, marginBottom: 22 }}>
          {step === "email" ? "Sign in with your work email" : "Enter the code we emailed you"}
        </div>

        {mode === null && (
          <div style={{ fontSize: 13, color: C.muted }}>Loading…</div>
        )}

        {mode !== null && step === "email" && (
          <form onSubmit={requestCode}>
            <label style={{ fontSize: 12, color: C.muted }}>Work email</label>
            <input
              style={{ ...input, marginTop: 6 }}
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@moneypennyllc.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" style={button} disabled={submitting}>
              {submitting ? "Sending…" : "Send code"}
            </button>
          </form>
        )}

        {mode !== null && step === "code" && (
          <form onSubmit={verifyCode}>
            {notice && (
              <div
                style={{
                  fontSize: 12,
                  color: C.sec,
                  background: "rgba(255,255,255,0.05)",
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  marginBottom: 14,
                }}
              >
                {notice}
              </div>
            )}
            <label style={{ fontSize: 12, color: C.muted }}>6-digit code</label>
            <input
              ref={codeRef}
              style={{
                ...input,
                marginTop: 6,
                textAlign: "center",
                fontSize: 26,
                letterSpacing: 10,
                fontFamily: "'DM Mono', monospace",
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="······"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            <button type="submit" style={button} disabled={submitting}>
              {submitting ? "Verifying…" : "Verify & sign in"}
            </button>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 14,
                alignItems: "center",
              }}
            >
              <button
                type="button"
                style={linkBtn}
                onClick={() => { setStep("email"); setCode(""); setError(""); setNotice(""); }}
              >
                ← Change email
              </button>
              {cooldown > 0 ? (
                <span style={{ fontSize: 12, color: C.muted }}>Resend in {cooldown}s</span>
              ) : (
                <button type="button" style={linkBtn} onClick={() => requestCode()}>
                  Resend code
                </button>
              )}
            </div>
          </form>
        )}

        {error && (
          <div
            style={{
              marginTop: 14,
              fontSize: 12,
              color: C.red,
              background: C.statusRed,
              border: `1px solid ${C.red}`,
              borderRadius: 8,
              padding: "10px 12px",
            }}
          >
            {error}
          </div>
        )}

        {/* Legacy password form, only while the server still accepts it. */}
        {mode === "otp_optional" && (
          <details style={{ marginTop: 20 }}>
            <summary style={{ fontSize: 12, color: C.muted, cursor: "pointer" }}>
              Use the shared password instead
            </summary>
            <form onSubmit={submitPassword} style={{ marginTop: 12 }}>
              <input
                style={input}
                type="password"
                autoComplete="current-password"
                placeholder="Dashboard password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="submit" style={{ ...button, background: BRAND_CHARCOAL }} disabled={submitting}>
                {submitting ? "Signing in…" : "Sign in with password"}
              </button>
            </form>
          </details>
        )}
      </div>
    </div>
  );
}
