# Whale MCP integration plan

**Status: DEFERRED. Do not connect.** Nothing in the dashboard talks to Whale
today (as of 2026-09-28). The Whale REST client in `backend/whale_api.py` and
the `/api/whale/*` routes are built, but `WHALE_API_TOKEN` and
`WHALE_WORKSPACE_ID` are empty on the server, so every call returns "not
configured" and the SOP page shows its "awaiting credentials" state.

## Gates. All three are required before any connection

1. **WISP approval** from Raj, covering Whale as a store of company and client
   data that the dashboard (and its chatbot) will read.
2. **Whale MCP leaves beta.** We don't build against a beta interface for
   production client data.
3. **Security review** done and signed off (see the checklist below).

Until then, don't set the Whale env vars on the server, don't connect the
Whale MCP connector to any account that has company data, and don't commit
any Whale token. This repo is public.

## What Whale holds

| Data | Examples | Sensitivity |
|---|---|---|
| SOPs | Per-client bookkeeping / close procedures, playbooks, cards | Internal; names clients |
| Training records | Who completed which training / playbook, when | Staff personal data |
| Client documentation | Client-specific process notes and reference docs | Client confidential |

## How the dashboard would use it

- **SOP links per client.** On the client dashboard, link straight to that
  client's SOP cards. Map clients to SOPs by name, with a manual override
  table, the same way `TEAM_CLIENTS` handles `tsMatch` aliases.
- **Training completion tracking.** On the team dashboard, show each
  preparer's completion of the playbooks required for the clients they work
  on. The roster comes from the Timesheets.com dynamic roster, so a preparer
  who moves teams picks up the new team's requirements automatically.
- **Client documentation lookup.** The chatbot can answer "how do we do X
  for client Y" with a citation back to the Whale card. It must be scoped the
  same way the dashboard is: a team member only sees their own team's and
  shared clients.
- **SOP staleness audit.** `/api/whale/audit/outdated` already sketches this:
  flag SOPs not updated in N months for active clients.

## Integration shape (when unblocked)

- **Read-only.** The dashboard never writes to Whale.
- **Server-side only.** The token lives in `backend/.env` and never reaches
  the browser. Every Whale route goes through the existing auth middleware and
  per-team scoping in `access_control.classify_path`.
- **Cached.** Keep the existing 1-hour TTL, and fall back gracefully when
  Whale is down (same pattern as the roster's live → stale → fallback tiers).
- **MCP vs REST.** Use the REST client (`whale_api.py`) for dashboard pages.
  Consider the MCP connector only for the chatbot's document lookup, and only
  after it is out of beta.

## Security review checklist

- [ ] WISP entry for Whale: data classes, retention, sub-processors.
- [ ] Token scope: read-only, least privilege, rotation owner and schedule.
- [ ] Per-team scoping verified: team member A can't read team B's client SOPs
      through the page or the chatbot.
- [ ] No Whale content in logs, error messages, or the public repo.
- [ ] Chatbot: Whale content is treated as data, not instructions (prompt
      injection from document text).
- [ ] Offboarding: removing a user from `access_control.py` removes their
      access to Whale-derived data immediately.
