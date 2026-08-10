#!/usr/bin/env python3
"""CLI helper to review the roster diff before cutover.

Bypasses HTTP auth by calling the dynamic_roster module directly, so it works
over SSH without a dashboard password.

Usage:
    cd /opt/moneypenny/backend
    source venv/bin/activate
    python3 scripts/review_roster.py                     # summary + moves + warnings
    python3 scripts/review_roster.py --team team_a       # one team in detail
    python3 scripts/review_roster.py --section removed
    python3 scripts/review_roster.py --full              # export JSON

Note: importing main.py takes ~40s on a cold cache because the client
attribution pulls a 90-day timesheet report (~51k rows). Subsequent runs in the
same process are cached, but each CLI invocation is a fresh process — the rows
cache is in-memory, so expect the wait every time unless the backend has
already warmed the shared cache.
"""
import argparse
import json
import os
import sys

# Resolve the backend dir from this file rather than hardcoding /opt/moneypenny,
# so the script also runs from a local checkout.
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND_DIR)

import dynamic_roster  # noqa: E402

# The ACTIVE dicts (main.TEAM_ROSTERS) become the DYNAMIC roster once
# DYNAMIC_ROSTER_ENABLED is on, which would make the "hardcoded" column mirror
# the dynamic one and the diff read as empty. Always compare against the
# FALLBACK_* literals — they are the hand-maintained config by definition.
import main  # noqa: E402
from main import (  # noqa: E402
    FALLBACK_TEAM_ROSTERS as HARDCODED_ROSTERS,
    FALLBACK_TEAM_CLIENTS as HARDCODED_CLIENTS,
)


def print_section(title):
    print()
    print("=" * 70)
    print(f"  {title}")
    print("=" * 70)


def get_diff():
    """build_diff() needs main.py's injected config; the FastAPI lifespan does
    that at boot, but this is a plain script, so wire it up explicitly."""
    main._configure_dynamic_roster()
    diff = dynamic_roster.build_diff()
    if diff.get("error"):
        print(f"ERROR: {diff['error']}", file=sys.stderr)
        if diff.get("status"):
            print(json.dumps(diff["status"], indent=2), file=sys.stderr)
        sys.exit(1)
    return diff


def summarize_diff(diff):
    t = diff.get("totals", {})
    print_section("ROSTER DIFF SUMMARY")
    print(f"Source:             {diff.get('source')}")
    print(f"Dynamic enabled:    {diff.get('enabled')}")
    print(f"Generated:          {diff.get('generated_at')}")
    print()
    print(f"Timesheets users:   {t.get('total_users')} total, {t.get('active_users')} active")
    print(f"Teams:              {t.get('teams')}")
    print(f"Members hardcoded:  {t.get('members_old')}")
    print(f"Members dynamic:    {t.get('members_new')}")
    print(f"Members added:      {t.get('members_added')}")
    print(f"Members removed:    {t.get('members_removed')}")
    print(f"Members moved:      {t.get('members_moved')}")
    print(f"Clients added:      {t.get('clients_added')}")
    print(f"Shared clients:     {t.get('shared_clients')}")
    print(f"Orphan clients:     {t.get('orphan_clients')}")
    print(f"Warnings:           {t.get('warnings')}")
    print()
    print(f"NOTE: {diff.get('note')}")

    print_section("TEAM-BY-TEAM HEADCOUNT")
    print(f"{'Team':<10} {'Lead':<28} {'Hardcoded':>9} {'Dynamic':>8}  Delta")
    print("-" * 70)
    teams = diff.get("teams", {})
    for tid in sorted(teams):
        d = teams[tid]
        hc, dyn = d["old_count"], d["new_count"]
        delta = dyn - hc
        symbol = "^" if delta > 0 else ("v" if delta < 0 else "=")
        shown = f"{symbol} {abs(delta)}" if delta else "="
        print(f"{tid:<10} {d.get('lead', '')[:28]:<28} {hc:>9} {dyn:>8}  {shown}")


def show_members_moved(diff):
    print_section("MEMBERS MOVED BETWEEN TEAMS")
    moves = diff.get("members_moved") or []
    if not moves:
        print("(none)")
        return
    print("These reassign whose hours land on which team — check each one.\n")
    for m in moves:
        print(f"  {m['name']:<32} {m['from_team']} -> {m['to_team']}")


def show_members_removed(diff):
    print_section("MEMBERS REMOVED (hardcoded had them, Timesheets does not)")
    removed = diff.get("members_removed") or {}
    if not removed:
        print("(none)")
        return
    moved = {m["name"]: m["to_team"] for m in (diff.get("members_moved") or [])}
    for team in sorted(removed):
        print(f"\n  {team}:")
        for n in sorted(removed[team]):
            if n in moved:
                print(f"    - {n}  (moved to {moved[n]})")
            else:
                print(f"    - {n}  (inactive/departed, or was a wrong keyword match)")


def show_members_added(diff):
    print_section("MEMBERS ADDED (Timesheets has them, hardcoded did not)")
    added = diff.get("members_added") or {}
    if not added:
        print("(none)")
        return
    moved = {m["name"]: m["from_team"] for m in (diff.get("members_moved") or [])}
    for team in sorted(added):
        print(f"\n  {team}:")
        for n in sorted(added[team]):
            suffix = f"  (moved from {moved[n]})" if n in moved else ""
            print(f"    + {n}{suffix}")


def show_warnings(diff):
    print_section("WARNINGS")
    warnings = diff.get("warnings") or []
    if not warnings:
        print("(none)")
        return
    for w in warnings:
        print(f"  ! {w}")


def show_shared_clients(diff):
    print_section("SHARED CLIENTS (>=10% of hours on more than one team)")
    shared = diff.get("shared_clients") or []
    if not shared:
        print("(none)")
        return
    for s in shared:
        print(f"  {s['client']:<44} -> {', '.join(s['teams'])}")


def show_orphan_clients(diff):
    print_section("ORPHAN CLIENTS (real hours, no team claims them)")
    orphans = diff.get("orphan_clients") or []
    if not orphans:
        print("(none)")
        return
    print("Every team's share fell under the 10% threshold, or the only")
    print("qualifying team suppresses the client via TEAM_HIDDEN_CLIENTS.\n")
    print(f"  {'Client':<44} {'Hours':>9}  Top team")
    print("  " + "-" * 66)
    for o in orphans:
        print(f"  {o['name']:<44} {o['hours']:>9}  "
              f"{o['top_team']} ({int(o['top_share'] * 100)}%)")


def show_specific_team(team_id, diff):
    teams = diff.get("teams", {})
    if team_id not in teams and team_id not in HARDCODED_ROSTERS:
        print(f"Unknown team {team_id!r}. Known: {', '.join(sorted(teams))}")
        sys.exit(1)

    d = teams.get(team_id, {})
    print_section(f"{team_id.upper()} — {d.get('label', '')} (lead: {d.get('lead', '?')})")

    # Hardcoded entries are partial keywords ("jayashree b"); dynamic entries
    # are full names. build_diff already resolved the keywords against the live
    # user list, so use its verdicts instead of comparing the two directly.
    print(f"\nHardcoded keywords ({d.get('old_count', 0)}):")
    unresolved = set(d.get("unresolved_keywords") or [])
    for kw in HARDCODED_ROSTERS.get(team_id, []):
        if kw in unresolved:
            print(f"  ! {kw!r}  MATCHES NOBODY — dead keyword")
        else:
            print(f"    {kw!r}")

    dyn_members = diff.get("dynamic_teams", {}).get(team_id, [])
    added = set(d.get("added") or [])
    print(f"\nDynamic members ({len(dyn_members)}):")
    for m in dyn_members:
        print(f"  {'+ ' if m in added else '  '}{m}"
              f"{'  (NEW)' if m in added else ''}")

    if d.get("removed"):
        print(f"\nNo longer members ({len(d['removed'])}):")
        for m in sorted(d["removed"]):
            print(f"  - {m}")

    if d.get("excluded"):
        print(f"\nExcluded from this team ({len(d['excluded'])}):")
        for e in d["excluded"]:
            print(f"    {e['name']:<38} {e['reason']}")

    hc_clients = [c.get("name", "") for c in HARDCODED_CLIENTS.get(team_id, [])]
    dyn_clients = diff.get("dynamic_clients", {}).get(team_id, [])
    added_clients = set(diff.get("clients_added", {}).get(team_id, []))

    print(f"\nCurated clients ({len(hc_clients)}) — all preserved verbatim:")
    for c in hc_clients:
        print(f"    {c}")
    if added_clients:
        print(f"\nDiscovered clients added ({len(added_clients)}):")
        for c in dyn_clients:
            if c in added_clients:
                print(f"  + {c}")
    print(f"\nTotal client list after merge: {len(dyn_clients)}")


def export_full_diff(diff):
    output_path = "/tmp/roster_diff_full.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(diff, f, indent=2, default=str)
    print(f"\nFull diff exported to: {output_path}")
    print(f"View: cat {output_path} | less")


def main_cli():
    parser = argparse.ArgumentParser(
        description="Review the dynamic roster diff before cutover"
    )
    parser.add_argument("--full", action="store_true",
                        help="Export the full diff to /tmp/roster_diff_full.json")
    parser.add_argument("--team", type=str,
                        help="Detailed view for one team (e.g. team_a)")
    parser.add_argument("--section", type=str,
                        choices=["moved", "removed", "added", "shared",
                                 "orphans", "warnings"],
                        help="Show only one section")
    args = parser.parse_args()

    diff = get_diff()

    if args.full:
        export_full_diff(diff)
        return
    if args.team:
        show_specific_team(args.team, diff)
        return

    sections = {
        "moved": show_members_moved,
        "removed": show_members_removed,
        "added": show_members_added,
        "shared": show_shared_clients,
        "orphans": show_orphan_clients,
        "warnings": show_warnings,
    }
    if args.section:
        sections[args.section](diff)
        return

    summarize_diff(diff)
    show_members_moved(diff)
    show_warnings(diff)
    print()
    print("=" * 70)
    print("More detail:")
    print("  python3 scripts/review_roster.py --team team_a")
    print("  python3 scripts/review_roster.py --section removed")
    print("  python3 scripts/review_roster.py --section added")
    print("  python3 scripts/review_roster.py --section shared")
    print("  python3 scripts/review_roster.py --section orphans")
    print("  python3 scripts/review_roster.py --full")
    print("=" * 70)


if __name__ == "__main__":
    main_cli()
