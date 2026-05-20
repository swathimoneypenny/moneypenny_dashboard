import { useEffect, useMemo, useState } from "react";
import { C, authFetch } from "../config";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";

// AI-driven departure analysis page. Reusable for any client — the slug
// in the URL state picks the target. Backend at
// /api/analysis/client-departure/{slug}.

const SEVERITY_BG = {
  high:   "rgba(226,92,92,0.12)",
  medium: "rgba(242,137,90,0.12)",
  low:    "rgba(240,185,71,0.10)",
};
const SEVERITY_BORDER = {
  high:   "#E25C5C",
  medium: "#F2895A",
  low:    "#F0B947",
};
const SEVERITY_DOT = SEVERITY_BORDER;

function SectionCard({ title, accent, icon, children, subtitle }) {
  return (
    <div style={{
      background: C.card,
      border: `1px solid ${C.border}`,
      borderLeft: `4px solid ${accent || C.blue}`,
      borderRadius: 10,
      padding: "18px 20px",
      marginBottom: 16,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: subtitle ? 4 : 14 }}>
        <span style={{
          fontSize: 12,
          fontWeight: 700,
          color: accent || C.sec,
          textTransform: "uppercase",
          letterSpacing: 1,
        }}>
          {icon && <span style={{ marginRight: 6 }}>{icon}</span>}{title}
        </span>
      </div>
      {subtitle && (
        <div style={{ fontSize: 11, color: C.muted, fontStyle: "italic", marginBottom: 14 }}>
          {subtitle}
        </div>
      )}
      {children}
    </div>
  );
}

function RootCauseCard({ entry }) {
  const sev = (entry.severity || "medium").toLowerCase();
  const accent = SEVERITY_BORDER[sev] || SEVERITY_BORDER.medium;
  return (
    <div style={{
      background: SEVERITY_BG[sev] || SEVERITY_BG.medium,
      border: `1px solid ${C.border}`,
      borderLeft: `4px solid ${accent}`,
      borderRadius: 8,
      padding: "14px 16px",
      marginBottom: 12,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
        <span style={{
          display: "inline-flex",
          justifyContent: "center",
          alignItems: "center",
          width: 28,
          height: 28,
          borderRadius: "50%",
          background: accent,
          color: "white",
          fontSize: 13,
          fontWeight: 700,
          flexShrink: 0,
        }}>
          {entry.rank}
        </span>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.pri, flex: 1 }}>
          {entry.cause}
        </div>
        <span style={{
          fontSize: 10,
          padding: "3px 10px",
          borderRadius: 12,
          background: accent,
          color: "white",
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}>
          {sev}
        </span>
      </div>
      {entry.evidence && (
        <div style={{
          fontSize: 12,
          color: C.sec,
          marginLeft: 40,
          fontStyle: "italic",
          lineHeight: 1.5,
          paddingLeft: 8,
          borderLeft: `2px solid ${C.border}`,
        }}>
          Evidence: {entry.evidence}
        </div>
      )}
    </div>
  );
}

function HoursTrendChart({ monthlyHours }) {
  if (!Array.isArray(monthlyHours) || monthlyHours.length === 0) {
    return (
      <div style={{ color: C.muted, fontSize: 12, fontStyle: "italic", textAlign: "center", padding: 20 }}>
        No timesheet hours found for this client in the last 6 months.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={monthlyHours} margin={{ top: 4, right: 8, left: -16, bottom: 4 }}>
        <CartesianGrid stroke={C.border} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" tick={{ fill: C.sec, fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
        <Tooltip
          contentStyle={{ background: "rgba(11,25,41,0.95)", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, color: C.pri }}
          formatter={(v, k) => [`${v}h`, k]}
        />
        <Bar dataKey="billable"    stackId="a" fill="#3DC58B" />
        <Bar dataKey="nonBillable" stackId="a" fill="#F0B947" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function ClientDepartureAnalysisPage({ clientSlug, onBack }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    if (!clientSlug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/analysis/client-departure/${encodeURIComponent(clientSlug)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.error) {
          setError(`${d.error}: ${d.error_detail || d.error_message || ""}`);
          setData(null);
        } else {
          setData(d);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [clientSlug]);

  const analysis = data?.analysis || {};
  const aiError  = analysis?.error;
  const rootCauses     = Array.isArray(analysis.rootCauses)     ? analysis.rootCauses : [];
  const earlyWarnings  = Array.isArray(analysis.earlyWarnings)  ? analysis.earlyWarnings : [];
  const recovery       = analysis.recovery || {};
  const preventionRules = Array.isArray(analysis.preventionRules) ? analysis.preventionRules : [];
  const summary        = analysis.summaryForPenny || "";

  const today = useMemo(() => new Date().toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  }), []);

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      {/* Header */}
      <div style={{
        background: "linear-gradient(180deg,#0e2040 0%,#0b1929 100%)",
        borderBottom: `1px solid ${C.border}`,
        padding: "20px 32px",
        display: "flex",
        alignItems: "center",
        gap: 18,
        flexWrap: "wrap",
      }}>
        <button
          onClick={onBack}
          style={{
            background: "transparent",
            border: `1px solid ${C.border}`,
            color: C.sec,
            borderRadius: 8,
            padding: "8px 14px",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          ← Back
        </button>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.pri, letterSpacing: -0.4 }}>
            Departure Analysis · {data?.clientName || clientSlug}
          </div>
          <div style={{ fontSize: 12, color: C.sec, marginTop: 2 }}>
            {data?.teamLabel || ""} · Analyzed {today} · Range {data?.rangeStart} → {data?.rangeEnd}
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
        {loading && (
          <div style={{ padding: 60, textAlign: "center", color: C.muted, fontSize: 13 }}>
            Running AI analysis on the last 6 months of data… (this can take ~5-10s on the first call)
          </div>
        )}

        {!loading && error && (
          <div style={{
            background: `${C.red}14`,
            border: `1px solid ${C.red}55`,
            borderLeft: `3px solid ${C.red}`,
            borderRadius: 8,
            padding: "12px 16px",
            fontSize: 13,
            color: C.pri,
            marginBottom: 16,
          }}>
            <strong style={{ color: C.red }}>Couldn't load analysis:</strong> {error}
          </div>
        )}

        {!loading && data && (
          <>
            {/* Executive summary (purple) */}
            {(summary || aiError) && (
              <div style={{
                background: "linear-gradient(135deg, rgba(124,58,237,0.15), rgba(59,130,246,0.10))",
                border: "1px solid #7C3AED40",
                borderLeft: "4px solid #7C3AED",
                borderRadius: 10,
                padding: 20,
                marginBottom: 20,
              }}>
                <div style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#A78BFA",
                  marginBottom: 10,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                }}>
                  Executive Summary
                </div>
                {aiError ? (
                  <div style={{ fontSize: 13, color: C.muted, fontStyle: "italic" }}>
                    AI analysis unavailable: {aiError}{analysis.error_detail ? ` — ${analysis.error_detail}` : ""}.
                    Raw data is still shown below for manual review.
                  </div>
                ) : (
                  <div style={{ fontSize: 15, lineHeight: 1.55, color: C.pri }}>
                    {summary || "—"}
                  </div>
                )}
                {recovery && typeof recovery.confidence === "number" && (
                  <div style={{
                    fontSize: 12,
                    color: C.muted,
                    marginTop: 12,
                    fontFamily: "'DM Mono', monospace",
                  }}>
                    Recovery confidence: <strong style={{ color: recovery.confidence >= 60 ? "#3DC58B" : recovery.confidence >= 30 ? "#F0B947" : "#E25C5C" }}>
                      {recovery.confidence}%
                    </strong> · Possible: <strong style={{ color: C.sec }}>{String(recovery.possible || "—")}</strong>
                  </div>
                )}
              </div>
            )}

            {/* Top root causes */}
            {rootCauses.length > 0 && (
              <SectionCard title="Top Root Causes" accent="#E25C5C" icon="🔴"
                subtitle="Ranked by severity, cited from the last 6 months of operational data.">
                {rootCauses.map((rc, i) => (
                  <RootCauseCard key={i} entry={{ ...rc, rank: rc.rank ?? i + 1 }} />
                ))}
              </SectionCard>
            )}

            {/* Early warnings */}
            {earlyWarnings.length > 0 && (
              <SectionCard title="Early Warning Signals" accent="#F0B947" icon="⚠"
                subtitle="When did decline first appear? Which signals were visible but not acted upon?">
                {earlyWarnings.map((w, i) => {
                  const missed = !!w.missed;
                  return (
                    <div key={i} style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      padding: "10px 12px",
                      background: C.surface,
                      border: `1px solid ${C.border}`,
                      borderLeft: `3px solid ${missed ? "#E25C5C" : "#3DC58B"}`,
                      borderRadius: 6,
                      marginBottom: 8,
                    }}>
                      <span style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: C.muted,
                        fontFamily: "'DM Mono', monospace",
                        minWidth: 70,
                      }}>
                        {w.month || "—"}
                      </span>
                      <span style={{ fontSize: 13, color: C.pri, flex: 1 }}>
                        {w.signal || "—"}
                      </span>
                      <span style={{
                        fontSize: 10,
                        padding: "2px 8px",
                        borderRadius: 10,
                        background: missed ? "#E25C5C22" : "#3DC58B22",
                        color: missed ? "#E25C5C" : "#3DC58B",
                        fontWeight: 700,
                      }}>
                        {missed ? "Missed" : "Noticed"}
                      </span>
                    </div>
                  );
                })}
              </SectionCard>
            )}

            {/* Recovery actions */}
            {recovery && Array.isArray(recovery.actions) && recovery.actions.length > 0 && (
              <SectionCard title="Recovery Actions" accent="#F2895A" icon="🎯"
                subtitle="What Penny could do now to attempt salvaging the relationship.">
                <div style={{ display: "grid", gap: 8 }}>
                  {recovery.actions.map((a, i) => (
                    <div key={i} style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: C.pri,
                    }}>
                      <span style={{
                        display: "inline-flex",
                        justifyContent: "center",
                        alignItems: "center",
                        minWidth: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: "#F2895A",
                        color: "white",
                        fontSize: 11,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}>
                        {i + 1}
                      </span>
                      <span>{a}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {/* Prevention rules */}
            {preventionRules.length > 0 && (
              <SectionCard title="Prevention Rules for Other Clients" accent="#4A8FE7" icon="🛡"
                subtitle="Thresholds we should monitor going forward — these become future dashboard alerts.">
                <div style={{ display: "grid", gap: 8 }}>
                  {preventionRules.map((p, i) => (
                    <div key={i} style={{
                      background: C.surface,
                      border: `1px solid ${C.border}`,
                      borderLeft: `3px solid #4A8FE7`,
                      borderRadius: 6,
                      padding: "10px 12px",
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}>
                      <div style={{ color: C.pri }}>
                        <strong style={{ color: "#4A8FE7" }}>If</strong> {p.trigger || "—"}
                        {p.threshold && <> <span style={{ color: C.muted }}>(threshold: {p.threshold})</span></>}
                      </div>
                      <div style={{ color: C.sec, marginTop: 4 }}>
                        <strong style={{ color: "#3DC58B" }}>Then</strong> {p.intervention || "—"}
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {/* Hours trend (raw) */}
            <SectionCard title="Hours Trend (Last 6 Months)" accent="#3DC58B" icon="📊"
              subtitle="Billable vs non-billable hours per month — the underlying data driving the analysis.">
              <HoursTrendChart monthlyHours={data?.monthlyHours} />
            </SectionCard>

            {/* Weekly mentions */}
            {Array.isArray(data?.weeklyMentions) && data.weeklyMentions.length > 0 && (
              <SectionCard title="Team Lead's Weekly Review Mentions" accent="#9B7EE8" icon="📝"
                subtitle="Every weekly-review entry where this client was mentioned.">
                {data.weeklyMentions.map((m, i) => (
                  <div key={i} style={{
                    background: C.surface,
                    border: `1px solid ${C.border}`,
                    borderRadius: 6,
                    padding: "10px 12px",
                    marginBottom: 8,
                  }}>
                    <div style={{ fontSize: 11, color: C.muted, fontFamily: "'DM Mono', monospace", marginBottom: 6 }}>
                      {m.weekRange || "—"}
                    </div>
                    {(m.snippets || []).map((s, j) => (
                      <div key={j} style={{ fontSize: 12, color: C.sec, marginBottom: 4, whiteSpace: "pre-wrap" }}>
                        • {s}
                      </div>
                    ))}
                  </div>
                ))}
              </SectionCard>
            )}

            {/* Footer */}
            <div style={{ fontSize: 10, color: C.muted, textAlign: "center", marginTop: 24, fontStyle: "italic" }}>
              Generated at {data?.generatedAt || "—"} · Cached 1 hour per slug.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
