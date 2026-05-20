import { useEffect } from "react";
import { C } from "../config";

// Shared base for the chart-click detail modals (issues / clients /
// commitments / etc.). Centered overlay, ESC + overlay-click + ✕ all
// close, body scroll lock while open, max-height 80vh with scroll inside.
//
// Usage:
//   <ChartDetailModal open={!!selected} onClose={() => setSelected(null)}
//     title="Issues of type: Blocked — awaiting response"
//     subtitle={`${count} items · Week of ${weekRange}`}>
//     <YourBodyContent />
//   </ChartDetailModal>
export default function ChartDetailModal({ open, onClose, title, subtitle, icon, accent, children }) {
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") onClose && onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const accentColor = accent || C.blue;

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        background: "rgba(0,0,0,0.72)",
        backdropFilter: "blur(4px)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        animation: "chartDetailFadeIn .15s ease-out",
      }}
    >
      <style>{`
        @keyframes chartDetailFadeIn { from { opacity: 0 } to { opacity: 1 } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderTop: `3px solid ${accentColor}`,
          borderRadius: 12,
          padding: 24,
          maxWidth: 720,
          maxHeight: "85vh",
          overflow: "auto",
          width: "90%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
            marginBottom: 18,
            paddingBottom: 14,
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
            {icon && (
              <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>{icon}</span>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 600, color: C.pri, letterSpacing: -0.2, marginBottom: 2 }}>
                {title}
              </div>
              {subtitle && (
                <div style={{ fontSize: 12, color: C.muted }}>{subtitle}</div>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              color: C.sec,
              width: 32,
              height: 32,
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
