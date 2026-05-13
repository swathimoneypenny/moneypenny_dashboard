import { useEffect, useState } from "react";
import Home from "./pages/Home";
import TeamDashboard from "./pages/TeamDashboard";
import ClientDashboard from "./pages/ClientDashboard";
import LoginPage from "./pages/LoginPage";
import Chatbot from "./components/Chatbot";
import { API_BASE, getToken, clearToken } from "./config";

export default function App() {
  const [view, setView] = useState({ page: "home" });
  const [richContext, setRichContext] = useState("");

  // null = checking, true = authed, false = needs login
  const [authed, setAuthed] = useState(getToken() ? null : false);

  useEffect(() => {
    if (authed !== null) return;
    const token = getToken();
    if (!token) {
      setAuthed(false);
      return;
    }
    // Strictly: only treat the user as authed if the server returns valid: true.
    // We deliberately do NOT honor d.authDisabled — that would let a misconfigured
    // server bypass the password gate entirely.
    fetch(`${API_BASE}/api/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d && d.valid === true) {
          setAuthed(true);
        } else {
          clearToken();
          setAuthed(false);
        }
      })
      .catch(() => {
        clearToken();
        setAuthed(false);
      });
  }, [authed]);

  if (authed === null) {
    // Brief loading state while verifying the token
    return null;
  }
  if (authed === false) {
    return <LoginPage onLogin={() => setAuthed(true)} />;
  }

  const basicContext = (() => {
    if (view.page === "client") return `Viewing client: ${view.clientName}`;
    if (view.page === "team")   return `Viewing team: ${view.teamName}`;
    return "Viewing MoneyPenny Dashboard home screen";
  })();

  const context = richContext || basicContext;

  if (view.page === "team") {
    return (
      <>
        <TeamDashboard
          teamId={view.teamId}
          teamName={view.teamName}
          onBack={() => { setRichContext(""); setView({ page: "home" }); }}
          onContextUpdate={setRichContext}
        />
        <Chatbot context={context} />
      </>
    );
  }

  if (view.page === "client") {
    return (
      <>
        <ClientDashboard
          clientName={view.clientName}
          onBack={() => { setRichContext(""); setView({ page: "home" }); }}
          onContextUpdate={setRichContext}
        />
        <Chatbot context={context} />
      </>
    );
  }

  return (
    <>
      <Home
        onSelectTeam={(team) => {
          setRichContext("");
          setView({ page: "team", teamId: team.id, teamName: team.name });
        }}
        onSelectClient={(client) => {
          setRichContext("");
          setView({ page: "client", clientName: client.name });
        }}
      />
      <Chatbot context={context} />
    </>
  );
}
