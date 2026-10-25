#!/usr/bin/env python3
"""Mark the passenger stops of "START SERVICE AT X AND END AT Y" trips.

Event-day short workings (TWW to CIO, KAT to MEF ...) carry 3xxxx/4xxxx trip
numbers, which the first version of tools/parse_timetables.py read as an empty
train, so every stop was flagged empty and no board could ever match them (the
live train showed as a dashed "-" circle). Stops from X to Y carry passengers;
stops before X (and after Y) stay empty. Patches data/timetables/*.json in
place, only trips whose stops are all flagged empty. Safe to run twice.

A second pass does the same for all-empty trips that stop at every station
like a passenger train (dwell of 20 s or more at most stops) and carry no
NON-PASSENGER note: the TML709UF event extras KAT to TIS ("END SERVICE AT TIS")
and TAW to CIO. Same logic as revive_dwelling_trips() in parse_timetables.py.

  python3 tools/fix_start_service.py
"""
import glob
import json
import os
import re

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "timetables")
total = 0
for path in sorted(glob.glob(os.path.join(root, "*.json"))):
    with open(path, encoding="utf8") as fh:
        raw = fh.read()
    book = json.loads(raw)
    changed = 0
    for trip in book.get("trips", []):
        stops = trip["stops"]
        if not stops or not all(len(s) > 3 and s[3] for s in stops):
            continue
        m = next((re.match(r"START SERVICE AT (\w+) AND END AT (\w+)", n) for n in trip.get("notes", [])
                  if re.match(r"START SERVICE AT (\w+) AND END AT (\w+)", n)), None)
        if not m:
            continue
        codes = [s[0] for s in stops]
        if m.group(1) not in codes or m.group(2) not in codes:
            continue
        a, b = codes.index(m.group(1)), codes.index(m.group(2))
        for i, s in enumerate(stops):
            if a <= i <= b:
                del s[3:]
        changed += 1
    for trip in book.get("trips", []):
        stops = trip["stops"]
        if len(stops) < 3 or not all(len(s) > 3 and s[3] for s in stops):
            continue
        if any(re.match(r"NON[ -]PASSENGER", n) for n in trip.get("notes", [])):
            continue
        dwell = [s[2] - s[1] for s in stops if s[1] is not None and s[2] is not None]
        if len(dwell) >= 3 and sum(d >= 20 for d in dwell) * 2 >= len(dwell):
            for s in stops:
                del s[3:]
            changed += 1
    if changed:
        indent = 1 if raw.startswith("{\n ") else None
        out = json.dumps(book, ensure_ascii=False, indent=indent, separators=(",", ":") if indent is None else None)
        with open(path, "w", encoding="utf8") as fh:
            fh.write(out + ("\n" if raw.endswith("\n") else ""))
        print(os.path.basename(path), changed)
        total += changed
print("trips fixed:", total)
