import { useEffect, useState } from "react";
import Home from "./pages/Home";
import TeamDashboard from "./pages/TeamDashboard";
import ClientDashboard from "./pages/ClientDashboard";
import EmployeeProfile from "./pages/EmployeeProfile";
import AdminHourPage from "./pages/AdminHourPage";
import ClientDepartureAnalysisPage from "./pages/ClientDepartureAnalysisPage";
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
    if (view.page === "client")              return `Viewing client: ${view.clientName}`;
    if (view.page === "employee")            return `Viewing employee: ${view.employeeName} (${view.teamName})`;
    if (view.page === "team")                return `Viewing team: ${view.teamName}`;
    if (view.page === "admin_hour")          return "Viewing Admin Hour cross-team overview";
    if (view.page === "departure_analysis")  return `Viewing departure analysis: ${view.clientSlug}`;
    return "Viewing MoneyPenny Dashboard home screen";
  })();

  const context = richContext || basicContext;

  // Tells the chat endpoint which entity is on screen so it can pull and
  // format real per-row timesheet entries (with date + billable flag) into
  // the prompt. Without this hint the chatbot only sees aggregated context.
  const viewHint = (() => {
    if (view.page === "employee") {
      return { teamId: view.teamId, employeeName: view.employeeName, period: "monthly" };
    }
    if (view.page === "team") {
      return { teamId: view.teamId, period: "monthly" };
    }
    if (view.page === "client") {
      return { clientName: view.clientName, period: "monthly" };
    }
    return null;
  })();

  // Helper passed to TeamDashboard to drill into an individual employee
  const handleSelectEmployee = ({ teamId, employeeName, teamName }) => {
    setRichContext("");
    setView({ page: "employee", teamId, employeeName, teamName, fromTeamId: teamId });
  };

  if (view.page === "employee") {
    return (
      <>
        <EmployeeProfile
          teamId={view.teamId}
          teamName={view.teamName}
          employeeName={view.employeeName}
          onBack={() => {
            setRichContext("");
            // Return to the team dashboard we came from (if known), else home.
            if (view.fromTeamId) {
              setView({ page: "team", teamId: view.fromTeamId, teamName: view.teamName });
            } else {
              setView({ page: "home" });
            }
          }}
          onContextUpdate={setRichContext}
        />
        <Chatbot context={context} viewHint={viewHint} />
      </>
    );
  }

  if (view.page === "team") {
    return (
      <>
        <TeamDashboard
          teamId={view.teamId}
          teamName={view.teamName}
          onBack={() => { setRichContext(""); setView({ page: "home" }); }}
          onContextUpdate={setRichContext}
          onSelectEmployee={handleSelectEmployee}
        />
        <Chatbot context={context} viewHint={viewHint} />
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
          onOpenDepartureAnalysis={(slug) => setView({ page: "departure_analysis", clientSlug: slug, fromClientName: view.clientName })}
        />
        <Chatbot context={context} viewHint={viewHint} />
      </>
    );
  }

  if (view.page === "departure_analysis") {
    return (
      <>
        <ClientDepartureAnalysisPage
          clientSlug={view.clientSlug}
          onBack={() => {
            setRichContext("");
            if (view.fromClientName) {
              setView({ page: "client", clientName: view.fromClientName });
            } else {
              setView({ page: "home" });
            }
          }}
        />
        <Chatbot context={context} viewHint={viewHint} />
      </>
    );
  }

  if (view.page === "admin_hour") {
    return (
      <>
        <AdminHourPage
          onBack={() => setView({ page: "home" })}
          onSelectTeam={(team) => setView({ page: "team", teamId: team.id, teamName: team.name })}
        />
        <Chatbot context={context} viewHint={viewHint} />
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
        onOpenAdminHour={() => setView({ page: "admin_hour" })}
      />
      <Chatbot context={context} viewHint={viewHint} />
    </>
  );
}
