import { useState } from "react";
import Home from "./pages/Home";
import TeamDashboard from "./pages/TeamDashboard";
import ClientDashboard from "./pages/ClientDashboard";
import Chatbot from "./components/Chatbot";

export default function App() {
  const [view, setView] = useState({ page: "home" });
  const [richContext, setRichContext] = useState("");

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
