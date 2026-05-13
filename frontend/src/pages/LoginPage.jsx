import { useState } from "react";
import { C, API_BASE, setToken } from "../config";

export default function LoginPage({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e) {
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
      if (res.status === 503) {
        setError("Server has no password configured. Set DASHBOARD_PASSWORD on the server.");
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
    } catch (err) {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: "100%",
          maxWidth: 380,
          background: `linear-gradient(180deg, ${C.card} 0%, ${C.surface} 100%)`,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          padding: "36px 28px",
          boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <span style={{ fontSize: 30 }}>💰</span>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.pri, letterSpacing: -0.3 }}>
              MoneyPenny Dashboard
            </div>
            <div style={{ fontSize: 12, color: C.muted }}>Sign in to continue</div>
          </div>
        </div>

        <label
          style={{
            display: "block",
            fontSize: 11,
            color: C.muted,
            textTransform: "uppercase",
            letterSpacing: 1,
            marginBottom: 6,
          }}
        >
          Password
        </label>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter dashboard password"
          style={{
            width: "100%",
            background: C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "10px 12px",
            color: C.pri,
            fontSize: 14,
            outline: "none",
            fontFamily: "'DM Sans', sans-serif",
          }}
        />

        {error && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 12px",
              borderRadius: 6,
              background: `${C.red}14`,
              border: `1px solid ${C.red}40`,
              color: C.red,
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !password}
          style={{
            marginTop: 18,
            width: "100%",
            background: submitting || !password
              ? C.border
              : "linear-gradient(135deg,#3d8ef0,#9f7aea)",
            border: "none",
            color: "#fff",
            borderRadius: 8,
            padding: "11px 14px",
            fontSize: 14,
            fontWeight: 600,
            cursor: submitting || !password ? "not-allowed" : "pointer",
            fontFamily: "'DM Sans', sans-serif",
            transition: "transform 0.12s",
          }}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>

        <div style={{ marginTop: 14, fontSize: 11, color: C.muted, textAlign: "center" }}>
          Single shared password for all managers.
        </div>
      </form>
    </div>
  );
}
