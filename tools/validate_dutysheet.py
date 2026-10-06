#!/usr/bin/env python3
"""Checks a parsed Duty Sheet schedule before the app may use it.

    python3 tools/validate_dutysheet.py data/timetables/DS1101.json

Exit code 0 = pass, 1 = fail. tools/parse_dutysheet.py runs this and only
registers a sheet in data/timetables/index.json when it passes.

Checks:
  - every trip runs in station order for its direction, times never go back,
    stations are the 27 Tuen Ma Line codes (same rules as validate_timetable)
  - no duplicate (run, direction, departure); a run never has two trips
    running at once; a run's trips alternate direction and join at the terminus
  - the day starts and ends at plausible times, and the departure gaps at each
    terminus are plausible
  - the parser read the PDF cleanly (no unparsed rows)
  - against the base timetable: how many of its trips the sheet has, how many
    are new, how many moved. A sheet that matches the base is redundant; one
    that matches under 70 % is rejected (wrong base, or a very different day)
  - freshness: not effective in the far future, not older than its base
"""

import json
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate_timetable import INDEX, hm  # noqa: E402

DAY_FIRST = (5 * 3600, 7 * 3600)
MIN_GAP = 90  # seconds between departures from one terminus, one direction


def dep(trip):
    return trip["stops"][0][2]


def validate(data, base=None, base_entry=None, today=None):
    """Returns (errors, notes, primary). `primary` tells the app whether this
    sheet should be preferred over its base timetable."""
    errors, notes = [], []
    trips = data.get("trips") or []
    if len(trips) < 50:
        errors.append(f"only {len(trips)} trips")
    src = data.get("source") or {}
    if src.get("unparsed"):
        errors.append(f"{src['unparsed']} PDF rows were not understood")

    for n, t in enumerate(trips):
        label = f"trip {n} (run {t.get('run')} {hm(dep(t))})"
        codes = [s[0] for s in t["stops"]]
        bad = [c for c in codes if c not in INDEX]
        if bad:
            errors.append(f"{label}: unknown stations {bad}")
            continue
        idx = [INDEX[c] for c in codes]
        want = sorted(idx) if t["dir"] == "DOWN" else sorted(idx, reverse=True)
        if idx != want:
            errors.append(f"{label}: stations out of order for {t['dir']}")
        times = [x for s in t["stops"] for x in s[1:3] if x is not None]
        if times != sorted(times):
            errors.append(f"{label}: times go backwards")
        if len(codes) < 2:
            errors.append(f"{label}: fewer than two stops")

    seen = {}
    for t in trips:
        key = (t["run"], t["dir"], dep(t))
        if key in seen:
            errors.append(f"duplicate trip run {key[0]} {key[1]} {hm(key[2])}")
        seen[key] = t

    by_run = {}
    for t in trips:
        by_run.setdefault(t["run"], []).append(t)
    joined = arrivals = 0
    for run, ts in by_run.items():
        ts.sort(key=dep)
        for a, b in zip(ts, ts[1:]):
            end = a["stops"][-1]
            if dep(b) < (end[1] or 0):
                errors.append(f"run {run}: trip at {hm(dep(b))} starts before the one from {hm(dep(a))} ends")
            arrivals += 1
            joined += b["stops"][0][0] == end[0] and a["dir"] != b["dir"]
    notes.append(f"{len(by_run)} runs; trips continuing as the same run from the terminus: {joined}/{arrivals}")
    if arrivals and joined / arrivals < 0.9:
        errors.append(f"only {joined / arrivals:.0%} of trips join the next one of the same run at the terminus")

    for code, d in (("TUM", "DOWN"), ("WKS", "UP")):
        times = sorted(dep(t) for t in trips if t["dir"] == d and t["stops"][0][0] == code)
        if not times:
            errors.append(f"no departures from {code}")
            continue
        notes.append(f"{code}: first {hm(times[0])}, last {hm(times[-1])}")
        if not DAY_FIRST[0] <= times[0] <= DAY_FIRST[1]:
            errors.append(f"{code} first departure {hm(times[0])} outside 05:00-07:00")
        if times[-1] < 23 * 3600:
            errors.append(f"{code} last departure {hm(times[-1])} before 23:00")
        close = sum(1 for a, b in zip(times, times[1:]) if b - a < MIN_GAP)
        if close:
            errors.append(f"{close} departures from {code} less than {MIN_GAP} s after the previous one")

    cov = data.get("coverage") or {}
    notes.append(f"{len(trips)} trips; stops anchored on a Duty Sheet relief time: {cov.get('anchored', 0)}, terminal only: {cov.get('terminal', 0)}")

    primary = True
    if base is not None:
        base_deps = {}
        for t in base["trips"]:
            first = t["stops"][0]
            if first[0] in ("TUM", "WKS") and len(first) < 4 and first[2] is not None and len(t["stops"]) > 1:
                base_deps[(t["run"], t["dir"], dep(t))] = t
        mine = set(seen)
        same = len(mine & set(base_deps))
        share = same / len(base_deps) if base_deps else 0
        new, gone = len(mine - set(base_deps)), len(set(base_deps) - mine)
        notes.append(f"against {base_entry['code']}: {same}/{len(base_deps)} of its trips present ({share:.0%}), {new} new, {gone} missing")
        if share < 0.7:
            errors.append(f"only {share:.0%} of {base_entry['code']}'s trips are in the sheet: wrong base or a very different day")
        elif share < 0.95:
            notes.append("less than 95% of the base's trips match: check the diff before relying on it")
        if abs(len(trips) - len(base["trips"])) > 0.15 * len(base["trips"]):
            notes.append(f"trip count {len(trips)} differs from the base's {len(base['trips'])} by over 15%")
        identical = share >= 0.99 and new == 0
        eff, base_eff = data.get("effective") or "", base_entry.get("effective") or ""
        primary = not identical and eff >= base_eff
        if identical:
            notes.append("identical to the base timetable (whose times are exact): the app keeps the base as primary")
        elif eff < base_eff:
            notes.append(f"older than its base ({eff} < {base_eff}): not primary")

    today = today or date.today().isoformat()
    if (data.get("effective") or "") > today:
        notes.append(f"effective {data['effective']}, in the future")
    return errors, notes, primary


def main(paths):
    ok = True
    for path in paths:
        with open(path, encoding="utf8") as fh:
            data = json.load(fh)
        base = base_entry = None
        folder = os.path.dirname(os.path.abspath(path))
        index_path = os.path.join(folder, "index.json")
        if data.get("base") and os.path.exists(index_path):
            with open(index_path, encoding="utf8") as fh:
                index = json.load(fh)
            base_entry = next((e for e in index["timetables"] if e["code"] == data["base"]), None)
            if base_entry:
                with open(os.path.join(folder, base_entry["file"]), encoding="utf8") as fh:
                    base = json.load(fh)
        errors, notes, primary = validate(data, base, base_entry)
        print(f"{path} ({data.get('timetable')}): {'PASS' if not errors else 'FAIL'}, primary={primary}")
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
