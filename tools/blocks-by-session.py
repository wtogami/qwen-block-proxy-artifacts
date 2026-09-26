#!/usr/bin/env python3
"""blocks-by-session.py - effectiveness tracker for block-proxy-artifacts.

Read-only scan of an opencode session database. For every session containing
hallucinated-relay-URL fingerprints, prints per-session counts:

  dials     tool calls whose inputs contain a relay-shaped URL AND whose tool
            could actually reach the network (fetch-type tools; bash invoking
            curl/wget/etc.)
  blocked   dials that died on the plugin (policy error text)
  leaked    dials that reached the network (e.g. 403 from the dead host)
  mention   fingerprint quotes in non-dial tools (analysis, edits) - harmless
  blk-m     mention calls the plugin false-positively blocked

The fingerprint regexes here are intentionally BROADER than the plugin's
rules, so the report also surfaces near-misses the rules let through.

Known heuristic caveats:
- bash commands that merely MENTION a network-client word (e.g. analysis
  scripts quoting "curl") classify as dials; spot-check the "leaked" rows
  against titles of analysis/forensics sessions before trusting them.
- The tracker is read-only (opens the DB with mode=ro) and safe to run while
  opencode is running.

Usage:
  python3 tools/blocks-by-session.py [path/to/opencode.db]
  # or OPENCODE_DB=/path/to/opencode.db python3 tools/blocks-by-session.py
"""
import collections
import datetime
import json
import os
import re
import sqlite3
import sys

# Fragment-built regexes keep this file invisible to the plugin it measures.
# NETWORK_CLIENT is also fragment-built: ad-hoc analysis commands that merely
# quote a curl-or-regex pattern must not self-classify as dial attempts.
FINGERPRINT = re.compile(r"routify.{0,3}file.{0,3}proxy|proxy._temp_file", re.I)
NETWORK_CLIENT = re.compile(r"\bcu" + r"rl\b|\bw" + r"get\b|\bhtt" + r"pie\b|\bn" + r"c\b", re.I)
POLICY = "Blocked by block-proxy-artifacts policy"


def is_dial(tool, state):
    name = (tool or "").lower()
    if "fetch" in name or name in {"webfetch", "websearch"}:
        return True
    if name == "bash":
        cmd = json.dumps((state.get("input") or {}).get("command", ""))
        return bool(NETWORK_CLIENT.search(cmd))
    return False


def main():
    db_path = (
        sys.argv[1]
        if len(sys.argv) > 1
        else os.environ.get(
            "OPENCODE_DB", os.path.expanduser("~/.local/share/opencode/opencode.db")
        )
    )
    if not os.path.exists(db_path):
        print("db not found: " + db_path, file=sys.stderr)
        return 1

    db = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    stats = collections.defaultdict(
        lambda: dict(dials=0, blocked=0, leaked=0, mentions=0, blocked_mentions=0, last=0, title="?")
    )

    rows = db.execute(
        "SELECT m.session_id sid, s.title title, p.data data, p.time_created tc "
        "FROM part p JOIN message m ON p.message_id = m.id JOIN session s ON s.id = m.session_id "
        "WHERE p.data LIKE '%routify%' OR p.data LIKE '%proxy%temp_file%' OR p.data LIKE '%block-proxy%'"
    )
    for r in rows:
        try:
            part = json.loads(r["data"])
        except (json.JSONDecodeError, TypeError):
            continue
        if part.get("type") != "tool":
            continue
        state = part.get("state") or {}
        if not FINGERPRINT.search(json.dumps(state.get("input")) or ""):
            continue
        st = stats[r["sid"]]
        st["title"] = r["title"]
        st["last"] = max(st["last"], r["tc"] or 0)
        blocked_here = POLICY in json.dumps(state.get("error") or "")
        if is_dial(part.get("tool"), state):
            st["dials"] += 1
            st["blocked" if blocked_here else "leaked"] += 1
        else:
            st["mentions"] += 1
            if blocked_here:
                st["blocked_mentions"] += 1

    if not stats:
        print("no relay-shaped tool calls found")
        return 0

    fmt = lambda ms: datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")
    print(f"{'last':12} {'dials':>6} {'blocked':>8} {'leaked':>7} {'mention':>8} {'blk-m':>6}  session")
    tot = [0, 0, 0, 0]
    for _sid, s in sorted(stats.items(), key=lambda kv: kv[1]["last"]):
        tot[0] += s["dials"]
        tot[1] += s["blocked"]
        tot[2] += s["leaked"]
        tot[3] += s["blocked_mentions"]
        print(
            f"{fmt(s['last']):12} {s['dials']:>6} {s['blocked']:>8} {s['leaked']:>7} "
            f"{s['mentions']:>8} {s['blocked_mentions']:>6}  {s['title'][:52]}"
        )
    print(f"{'':12} {tot[0]:>6} {tot[1]:>8} {tot[2]:>7} {'':>8} {tot[3]:>6}  TOTAL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
