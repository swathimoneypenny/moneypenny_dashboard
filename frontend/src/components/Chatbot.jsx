import { useState, useRef, useEffect } from "react";
import { C, API_BASE, authFetch } from "../config";

const API = API_BASE;

function TypingDots() {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0" }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: C.blue,
            animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-6px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function Message({ msg }) {
  const isUser = msg.role === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        marginBottom: 10,
      }}
    >
      <div
        style={{
          maxWidth: "86%",
          padding: "10px 14px",
          borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
          background: isUser
            ? "linear-gradient(135deg,#3d8ef0,#9f7aea)"
            : C.card,
          border: isUser ? "none" : `1px solid ${C.border}`,
          color: isUser ? "#ffffff" : C.pri,
          fontSize: 13,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          boxShadow: isUser ? "0 4px 14px rgba(61,142,240,0.25)" : "none",
        }}
      >
        {msg.content}
      </div>
    </div>
  );
}

export default function Chatbot({ context }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 80);
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(text) {
    const userMsg = text.trim();
    if (!userMsg || loading) return;

    const nextMsgs = [...messages, { role: "user", content: userMsg }];
    setMessages(nextMsgs);
    setInput("");
    setLoading(true);

    try {
      const res = await authFetch(`/api/chat`, {
        method: "POST",
        body: JSON.stringify({
          messages: nextMsgs.map((m) => ({ role: m.role, content: m.content })),
          context,
        }),
      });
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I couldn't reach the server. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  const showWelcome = messages.length === 0;

  return (
    <>
      {/* Floating button — stays bottom-right always */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="MoneyPenny AI"
        style={{
          position: "fixed",
          bottom: 24,
          right: open ? 396 : 24,
          width: 52,
          height: 52,
          borderRadius: "50%",
          border: "none",
          cursor: "pointer",
          background: "linear-gradient(135deg,#3d8ef0,#9f7aea)",
          boxShadow: open
            ? "0 0 0 3px rgba(61,142,240,0.25), 0 8px 32px rgba(61,142,240,0.45)"
            : "0 4px 20px rgba(61,142,240,0.4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          zIndex: 1001,
          transition: "right 0.3s cubic-bezier(0.16,1,0.3,1), box-shadow 0.2s, transform 0.2s",
          transform: open ? "scale(1.08)" : "scale(1)",
          color: "#fff",
        }}
      >
        {open ? "✕" : "💬"}
      </button>

      {/* Sidebar panel */}
      {open && (
        <div
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            width: 380,
            height: "100vh",
            background: "#0a1628",
            borderLeft: `1px solid ${C.border}`,
            display: "flex",
            flexDirection: "column",
            zIndex: 1000,
            boxShadow: "-20px 0 60px rgba(0,0,0,0.6)",
            animation: "slideInRight 0.3s cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 18px",
              background: "linear-gradient(180deg,#0e2040 0%,#0b1929 100%)",
              borderBottom: `1px solid ${C.border}`,
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "linear-gradient(135deg,#00c896,#3d8ef0)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                }}
              >
                🤖
              </div>
              <div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    background: "linear-gradient(135deg,#00c896,#3d8ef0)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    lineHeight: 1.2,
                  }}
                >
                  MoneyPenny AI
                </div>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
                  Powered by Groq · Llama 3.1
                </div>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              title="Close"
              style={{
                background: "transparent",
                border: `1px solid ${C.border}`,
                color: C.sec,
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
                width: 28,
                height: 28,
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✕
            </button>
          </div>

          {/* Messages area */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "14px 14px 6px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {showWelcome && (
              <div style={{ padding: "20px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>🤖</div>
                <div style={{ fontSize: 13, color: C.pri, fontWeight: 600, marginBottom: 6 }}>
                  MoneyPenny AI
                </div>
                <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
                  Ask me about team performance,<br />
                  utilization rates, or staff hours.
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <Message key={i} msg={m} />
            ))}

            {loading && (
              <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 10 }}>
                <div
                  style={{
                    padding: "9px 13px",
                    borderRadius: "12px 12px 12px 2px",
                    background: C.card,
                    border: `1px solid ${C.border}`,
                  }}
                >
                  <TypingDots />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: "12px 14px",
              borderTop: `1px solid ${C.border}`,
              background: C.surface,
              flexShrink: 0,
            }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask MoneyPenny AI…"
              disabled={loading}
              style={{
                flex: 1,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: "9px 12px",
                color: C.pri,
                fontSize: 13,
                outline: "none",
                fontFamily: "'DM Sans', sans-serif",
                opacity: loading ? 0.6 : 1,
              }}
            />
            <button
              onClick={() => send(input)}
              disabled={loading || !input.trim()}
              style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                border: "none",
                background:
                  loading || !input.trim()
                    ? C.border
                    : "linear-gradient(135deg,#3d8ef0,#9f7aea)",
                color: "#fff",
                cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                fontSize: 16,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                transition: "transform 0.12s",
              }}
            >
              ➤
            </button>
          </div>
        </div>
      )}
    </>
  );
}
