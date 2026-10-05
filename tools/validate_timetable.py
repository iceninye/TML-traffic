#!/usr/bin/env python3
"""Checks a parsed timetable before the app may use it.

    python3 tools/validate_timetable.py data/timetables/TML1100B.json

Exit code 0 = pass, 1 = fail. tools/parse_timetables.py runs this and only
registers a timetable in data/timetables/index.json when it passes.

Checks (each one is something the app relies on):
  - every trip runs in station order for its direction, times never go back
  - stations are the 27 Tuen Ma Line codes
  - section A has 26 hops in each direction
  - the day's first/last trains leave Tuen Mun and Wu Kai Sha at plausible
    times (05:00-07:00 first, after 23:00 last)
  - trains reaching a terminus mostly leave again as the same Run (the app
    links them for the layover); a timetable where few do is suspect
  - headway bands exist for both directions
"""

import json
import sys

ORDER = ["TUM", "SIH", "TIS", "LOP", "YUL", "KSR", "TWW", "MEF", "NAC", "AUS", "ETS", "HUH", "HOM",
         "TKW", "SUW", "KAT", "DIH", "HIK", "TAW", "CKT", "STW", "CIO", "SHM", "TSH", "HEO", "MOS", "WKS"]
INDEX = {c: i for i, c in enumerate(ORDER)}


def hm(sec):
    sec = int(sec) % 86400
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}"


def validate(data):
    errors = []
    notes = []
    trips = data.get("trips") or []
    if len(trips) < 50:
        errors.append(f"only {len(trips)} trips")

    for n, t in enumerate(trips):
        codes = [s[0] for s in t["stops"]]
        bad = [c for c in codes if c not in INDEX]
        if bad:
            errors.append(f"trip {n} ({t.get('trip')}): unknown stations {bad}")
            continue
        idx = [INDEX[c] for c in codes]
        want = sorted(idx) if t["dir"] == "DOWN" else sorted(idx, reverse=True)
        if idx != want:
            errors.append(f"trip {n} ({t.get('trip')}): stations out of order for {t['dir']}")
        times = [x for s in t["stops"] for x in (s[1], s[2]) if x is not None]
        if times != sorted(times):
            errors.append(f"trip {n} ({t.get('trip')}): times go backwards")
        if len(codes) < 2:
            errors.append(f"trip {n} ({t.get('trip')}): fewer than two stops")

    for d in ("DOWN", "UP"):
        hops = (data.get("sectionA") or {}).get(d, {}).get("hops", [])
        if len(hops) != 26:
            errors.append(f"section A {d}: {len(hops)} hops, expected 26")
        if not (data.get("headways") or {}).get(d):
            errors.append(f"headways {d}: missing")

    def deps(code, d):
        return [s[2] for t in trips if t["dir"] == d for s in t["stops"] if s[0] == code and s[2] is not None]

    for code, d in (("TUM", "DOWN"), ("WKS", "UP")):
        times = deps(code, d)
        if not times:
            errors.append(f"no departures from {code}")
            continue
        first, last = min(times), max(times)
        notes.append(f"{code} {d}: first {hm(first)}, last {hm(last)}")
        if not (5 * 3600 <= first <= 7 * 3600):
            errors.append(f"{code} first departure {hm(first)} outside 05:00-07:00")
        if last < 23 * 3600:
            errors.append(f"{code} last departure {hm(last)} before 23:00")

    by_run = {}
    for t in trips:
        by_run.setdefault(t["run"], []).append(t)
    arrivals = linked = 0
    for ts in by_run.values():
        ts.sort(key=lambda t: t["stops"][0][2] or t["stops"][0][1])
        for a, b in zip(ts, ts[1:]):
            end = a["stops"][-1][0]
            if end in ("TUM", "WKS"):
                arrivals += 1
                linked += b["stops"][0][0] == end
    share = linked / arrivals if arrivals else 0
    notes.append(f"terminus arrivals continuing as the same Run: {linked}/{arrivals}")
    if arrivals and share < 0.9:
        errors.append(f"only {share:.0%} of terminus arrivals continue as the same Run")

    notes.append(f"{len(trips)} trips (up {sum(t['dir'] == 'UP' for t in trips)}, down {sum(t['dir'] == 'DOWN' for t in trips)})")
    return errors, notes


def main(paths):
    ok = True
    for path in paths:
        with open(path, encoding="utf8") as fh:
            data = json.load(fh)
        errors, notes = validate(data)
        print(f"{path} ({data.get('timetable')}): {'PASS' if not errors else 'FAIL'}")
        for n in notes:
            print(f"  · {n}")
        for e in errors[:20]:
            print(f"  ✗ {e}")
        if len(errors) > 20:
            print(f"  ✗ ... {len(errors) - 20} more")
        ok = ok and not errors
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1:]))
