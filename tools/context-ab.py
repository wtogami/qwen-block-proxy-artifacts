#!/usr/bin/env python3
"""Session-level dial comparison between serving-config windows (read-only DB scan).

Groups fabricated relay dials (webfetch/fetch tool inputs matching the
canonical host or the dual-stack sibling) by opencode session, so rates and
shape shares are compared per *session*, not per dial (dials cluster within
a session, so counting them as independent samples inflates significance).

Usage:
  python3 tools/context-ab.py \
    --window "256K-ORIG=2026-09-29T04:17,2026-09-29T04:56" \
    --window "256K-now=2026-09-30T22:40,2026-09-30T23:59" \
    --window "512K-YaRN=2026-10-01T20:50,2026-10-01T22:10"

Times are UTC. Windows must not overlap analysis sessions (this script's own
session does not dial, but keep forensic echo sessions out of the windows).
"""
import argparse
import datetime
import json
import math
import sqlite3
import sys
from collections import defaultdict

DB = "file:/home/opencode/.local/share/opencode/opencode.db?mode=ro"
DUAL = ".ap-southeast-1.oss."


def parse(t: str) -> int:
    return int(datetime.datetime.strptime(t, "%Y-%m-%dT%H:%M").replace(
        tzinfo=datetime.timezone.utc).timestamp() * 1000)


def fisher_two_sided(a, b, c, d):
    """P(X <= min observed tail | margins) style exact test, doubled, capped at 1."""
    n = a + b + c + d
    r1, r2 = a + b, c + d
    k1 = a + c

    def p(k):
        return (math.comb(r1, k) * math.comb(r2, k1 - k)) / math.comb(n, k1)

    k0 = a
    p0 = p(k0)
    lo = max(0, k1 - r2)
    hi = min(r1, k1)
    return min(1.0, 2 * sum(p(k) for k in range(lo, hi + 1) if p(k) <= p0 + 1e-12))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", action="append", required=True)
    args = ap.parse_args()

    db = sqlite3.connect(DB, uri=True)
    windows = []
    for w in args.window:
        label, span = w.split("=", 1)
        t0, t1 = span.split(",")
        windows.append((label, parse(t0), parse(t1)))

    results = []
    for label, t0, t1 in windows:
        sess = defaultdict(lambda: [0, 0])  # session -> [canonical, dual]
        for (mid, data) in db.execute(
                "SELECT message_id, data FROM part "
                "WHERE time_created BETWEEN ? AND ?", (t0, t1)):
            try:
                j = json.loads(data)
            except Exception:
                continue
            if j.get("type") != "tool" or j.get("tool") not in ("webfetch", "fetch"):
                continue
            inp = (j.get("state") or {}).get("input") or {}
            for u in [inp.get("url")] + list(inp.get("urls") or []):
                if (isinstance(u, str) and "routify" in u and "proxy" in u
                        and "aliyuncs" in u):
                    (sid,) = db.execute(
                        "SELECT session_id FROM message WHERE id=?", (mid,)).fetchone()
                    c = sess[sid]
                    c[1 if DUAL in u else 0] += 1
        results.append((label, sess))

    for label, sess in results:
        per = [c + d for c, d in sess.values()]
        tot_c = sum(c for c, _ in sess.values())
        tot_d = sum(d for _, d in sess.values())
        med = sorted(per)[len(per) // 2] if per else 0
        runs_with_dual = sum(1 for _, d in sess.values() if d > 0)
        print(f"{label}: sessions={len(sess)} dials={tot_c + tot_d} "
              f"(canonical {tot_c}, dual-stack {tot_d}, "
              f"{100 * tot_d / max(1, tot_c + tot_d):.0f}%) | "
              f"dials/session mean={sum(per) / max(1, len(per)):.1f} "
              f"median={med} range=[{min(per) if per else 0},{max(per) if per else 0}] | "
              f"sessions with dual: {runs_with_dual}/{len(sess)}")

    if len(results) == 2:
        (la, sa), (lb, sb) = results
        A = (sum(c for c, _ in sa.values()), sum(d for _, d in sa.values()))
        B = (sum(c for c, _ in sb.values()), sum(d for _, d in sb.values()))
        print(f"\ndial-level Fisher (canonical vs dual, {la} vs {lb}): "
              f"p={fisher_two_sided(*A, *B):.3f} — NOTE: inflated, dials are "
              f"session-clustered; trust the per-session counts above.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
