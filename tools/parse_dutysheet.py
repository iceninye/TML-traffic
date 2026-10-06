#!/usr/bin/env python3
"""Parses an MTR Tuen Ma Line Duty Sheet (PDF) into a schedule the app can load.

    pip install pdfplumber
    python3 tools/parse_dutysheet.py DUTYSHEET.pdf [DUTYSHEET.pdf ...]
    python3 tools/parse_dutysheet.py DUTYSHEET.pdf --base TML1100B --dry-run

A Duty Sheet is a crew roster, not a timetable. Each duty is a list of legs:
Run, pick-up place and time (to the second), relief time (to the minute) and
place. It has no per-station times and no trip numbers. What it does give,
exactly, is every trip's terminal departure, and the time the train passes
the relief points (KSR, TAW) and reaches the far terminal.

So the parser:
  1. reads every leg (pdfplumber word positions, columns taken from each
     page's own "Run / Place / Time / Remark / Time / Place" header row)
  2. keeps the revenue legs that start at Tuen Mun / Wu Kai Sha as trips
  3. rebuilds the stops in between from the nearest trip of a base working
     timetable (same day type, latest one not newer than the sheet), stretched
     between the Duty Sheet's anchors
  4. runs tools/validate_dutysheet.py and only then writes
     data/timetables/DS<code>.json and registers it in data/timetables/index.json

The output holds run, direction, times and the duty numbers (更份, 7 digits:
sheet code + sequence) driving each trip, as [duty, from station] pairs.
Nothing else about the crew (book on/off, meal breaks, remarks) is written.

Flags in the relief column: N = empty train (no passengers) to the
destination, L = last trip, the train goes back to depot at the terminus.
"""

import argparse
import bisect
import hashlib
import json
import os
import re
import sys
from datetime import datetime

import pdfplumber

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
TERMINI = {"TUM": "WKS", "WKS": "TUM"}
DAY_BY_TYPE = {"1": "weekday", "5": "weekday", "6": "saturday", "7": "sunday"}
PARSER_VERSION = "0.2.0"
ANCHOR_WINDOW = 5400   # a trip is shorter than this (seconds)
RELIEF_ROUND = 30      # relief time is the arrival minute, rounded down

PICKUP = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})$")
RELIEF = re.compile(r"^(\d{1,2}):(\d{2})$")
PLACE = re.compile(r"^(?:DM)?([A-Z][A-Z0-9]{1,5})$")
DUTY = re.compile(r"^\d{7}$")


def secs(h, m, s=0):
    return int(h) * 3600 + int(m) * 60 + int(s)


def iso_date(text):
    try:
        return datetime.strptime(text, "%d %b %Y").date().isoformat()
    except ValueError:
        try:
            return datetime.strptime(text, "%d %B %Y").date().isoformat()
        except ValueError:
            return None


def rows_by_y(words, tol=3):
    rows = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if rows and abs(rows[-1][0] - w["top"]) <= tol:
            rows[-1][1].append(w)
        else:
            rows.append([w["top"], [w]])
    return [sorted(ws, key=lambda w: w["x0"]) for _, ws in rows]


HEADER = ["Run", "Place", "Time", "Remark", "Time", "Place"]


def header_columns(row):
    """x centres of Run, Place, Time, Remark, Time, Place from a header row, or None."""
    texts = [w["text"] for w in row]
    for i in range(len(texts) - 5):
        if texts[i:i + 6] == HEADER:
            return [(w["x0"] + w["x1"]) / 2 for w in row[i:i + 6]]
    return None


def parse_pdf(path):
    """Returns (meta, legs, stats). Times are seconds after the service day's
    midnight (after midnight continues past 86400)."""
    with open(path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    pdf = pdfplumber.open(path)
    first = pdf.pages[0].extract_text() or ""
    code_m = re.search(r"Duty Sheet (\d{4})\s*\((\w+)", first)
    if not code_m:
        raise ValueError("no 'TML Duty Sheet <code>' title on page 1")
    code = code_m.group(1)
    issued = re.search(r"Issue Date:\s*(\d{1,2} \w+ \d{4})", first)
    eff = re.search(r"Implementation Date:\s*(\d{1,2} \w+ \d{4})", first)
    meta = {
        "code": code,
        "title_day": code_m.group(2),
        "issued": iso_date(issued.group(1)) if issued else None,
        "effective": iso_date(eff.group(1)) if eff else None,
        "sha256": digest,
        "pages": len(pdf.pages),
    }

    legs = []
    stats = {"duties": 0, "legs": 0, "unparsed": [], "chainBreaks": 0}
    columns = None
    duty = None
    clock = None  # (offset, previous time) inside the current duty
    for page_no, page in enumerate(pdf.pages, 1):
        for row in rows_by_y(page.extract_words()):
            cols = header_columns(row)
            if cols:
                columns = cols
                continue
            if columns is None:
                continue
            run_x, place_x, time_x, remark_x, rel_x, rplace_x = columns
            left = [w for w in row if w["x1"] < run_x - 12]
            body = [w for w in row if w["x1"] >= run_x - 12]
            for w in left:
                if DUTY.match(w["text"]) and w["x0"] < run_x - 40:
                    duty = w["text"]
                    stats["duties"] += 1
                    clock = (0, 0)
            if not body:
                continue
            texts = [w["text"] for w in body]
            if not texts[0].isdigit():
                continue
            pi = next((i for i, x in enumerate(texts) if PICKUP.match(x)), None)
            if pi is None or pi < 2:
                continue
            # Run, then "DM" (optionally glued to the place), then the place, then the pick-up time.
            place_words = texts[1:pi]
            if not place_words or not PLACE.match(place_words[-1]):
                stats["unparsed"].append(f"p{page_no}: {' '.join(w['text'] for w in row)}")
                continue
            ri = next((i for i in range(len(texts) - 1, pi, -1) if RELIEF.match(texts[i])), None)
            run = [texts[0]]
            place = [PLACE.match(place_words[-1])]
            pick_t = PICKUP.match(texts[pi])
            rel_t = RELIEF.match(texts[ri]) if ri else None
            rel_place = texts[ri + 1] if ri and ri + 1 < len(texts) else None
            flag = "".join(texts[ri + 2:]) if ri else ""
            t = secs(*pick_t.groups())
            cells = {"place": place_words}
            if duty is None:
                stats["unparsed"].append(f"p{page_no}: leg before any duty: {' '.join(w['text'] for w in row)}")
                continue
            off, prev = clock
            if t + off < prev - 6 * 3600:
                off += 86400
            t += off
            leg = {"duty": duty, "run": int(run[0]), "place": place[-1].group(1), "t": t,
                   "dm": place_words[0].startswith("DM"),
                   "flag": flag, "relPlace": rel_place,
                   # Only to tell driving from riding; never written out.
                   "remark": " ".join(texts[pi + 1:ri] if ri else texts[pi + 1:])}
            if rel_t:
                r = secs(*rel_t.groups()) + off
                if r < t - 6 * 3600:
                    r += 86400
                leg["rel"] = r
                clock = (off, r)
            else:
                clock = (off, t)
            legs.append(leg)
            stats["legs"] += 1
    return meta, legs, stats


STATIONS = [
    "TUM", "SIH", "TIS", "LOP", "YUL", "KSR", "TWW", "MEF", "NAC", "AUS", "ETS", "HUH", "HOM",
    "TKW", "SUW", "KAT", "DIH", "HIK", "TAW", "CKT", "STW", "CIO", "SHM", "TSH", "HEO", "MOS", "WKS",
]


def trips_from_legs(legs):
    """Revenue trips: legs that start at a terminus and end at a station on the
    line without the empty-train flag. A relief at KSR or TAW hands the train to
    the next driver, so the leg chain is followed to where the trip really ends
    (the far terminus, or a short turn such as Hung Hom). Anchors: the relief
    points the run passes and the arrival at the end."""
    by_run = {}
    for leg in legs:
        by_run.setdefault(leg["run"], []).append(leg)
    trips = []
    seen = set()
    for run, ls in by_run.items():
        for leg in ls:
            if (leg["place"] not in TERMINI or leg["dm"] or "N" in leg["flag"] or not leg.get("relPlace")
                    or leg.get("rel") is None or leg["relPlace"][:3] not in STATIONS
                    or leg["relPlace"][:3] == leg["place"]):
                continue
            key = (run, leg["place"], leg["t"])
            if key in seen:
                continue
            seen.add(key)
            anchors, cur = [], leg
            while cur["relPlace"][:3] in ("KSR", "TAW"):
                nxt = next((n for n in ls if n["place"] == cur["relPlace"] and cur["rel"] - 60 <= n["t"] <= cur["rel"] + 150
                            and n is not cur and n.get("rel") is not None), None)
                if not nxt:
                    break
                anchors.append((nxt["place"][:3], nxt["t"]))
                cur = nxt
            end = cur["relPlace"][:3]
            trips.append({"run": run, "dir": "DOWN" if leg["place"] == "TUM" else "UP", "origin": leg["place"],
                          "dest": end if end in STATIONS and end not in ("KSR", "TAW") else TERMINI[leg["place"]],
                          "dep": leg["t"], "anchors": anchors,
                          "arrival": cur["rel"] if end not in ("KSR", "TAW") else None,
                          "lastLeg": "L" in cur["flag"]})
    trips.sort(key=lambda t: t["dep"])
    return trips


def load_json(path):
    with open(path, encoding="utf8") as fh:
        return json.load(fh)


def choose_base(index, meta, day, forced):
    entries = index.get("timetables", [])
    if forced:
        return next((e for e in entries if e["code"] == forced), None)
    cands = [e for e in entries if e.get("day") == day and e.get("kind") == "normal"
             and e.get("source") != "dutysheet" and (e.get("effective") or "") <= (meta["effective"] or "9999")]
    return max(cands, key=lambda e: e.get("effective") or "", default=None)


def template_trips(base):
    """Passenger trips from a base timetable with their stop times, by direction."""
    out = {"DOWN": [], "UP": []}
    for t in base["trips"]:
        s = t["stops"]
        if len(s) >= 20 and s[0][0] in TERMINI and len(s[0]) < 4:
            dep = s[0][2] if s[0][2] is not None else s[0][1]
            out[t["dir"]].append((dep, [(x[0], x[1] if x[1] is not None else x[2], x[2] if x[2] is not None else x[1]) for x in s]))
    for v in out.values():
        v.sort(key=lambda p: p[0])
    return out


def interp(x, xs, ys):
    i = max(1, min(bisect.bisect_right(xs, x), len(xs) - 1))
    x0, x1, y0, y1 = xs[i - 1], xs[i], ys[i - 1], ys[i]
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0) if x1 != x0 else y0


def rebuild(trip, templates):
    """Stops for one trip: the nearest template trip, shifted to the Duty
    Sheet's departure and stretched between its anchors."""
    cands = templates[trip["dir"]]
    keys = [c[0] for c in cands]
    i = bisect.bisect_left(keys, trip["dep"])
    near = [cands[j] for j in (i - 1, i) if 0 <= j < len(cands)]
    if not near:
        return None
    tdep, tstops = min(near, key=lambda c: abs(c[0] - trip["dep"]))
    names = [x[0] for x in tstops]
    if trip["dest"] in names and trip["dest"] != names[-1]:
        tstops = tstops[:names.index(trip["dest"]) + 1]
    ax = {(c, w): a - tdep for c, a, d in tstops for w, a in (("a", a), ("d", d))}
    points = [(0, 0)]
    for code, t in trip["anchors"]:
        if (code, "d") in ax and ax[(code, "d")] > points[-1][0] and t - trip["dep"] > points[-1][1]:
            points.append((ax[(code, "d")], t - trip["dep"]))
    if trip["arrival"] is not None and (trip["dest"], "a") in ax:
        x, y = ax[(trip["dest"], "a")], trip["arrival"] - trip["dep"] + RELIEF_ROUND
        if x > points[-1][0] and y > points[-1][1]:
            points.append((x, y))
    xs, ys = [p[0] for p in points], [p[1] for p in points]

    def at(x):
        if len(points) < 2:
            return trip["dep"] + x
        return trip["dep"] + (interp(x, xs, ys) if x <= xs[-1] else ys[-1] + (x - xs[-1]))

    stops, last = [], None
    for k, (code, _, _) in enumerate(tstops):
        a, d = round(at(ax[(code, "a")])), round(at(ax[(code, "d")]))
        if last is not None:
            a, d = max(a, last), max(d, a, last)
        last = d
        stops.append([code, None if k == 0 else a, None if k == len(tstops) - 1 else d])
    stops[0][2] = trip["dep"]
    return stops, "anchored" if len(points) > 1 else "terminal"


def stop_time(stop):
    return stop[2] if stop[2] is not None else stop[1]


def duties_for(stops, run, legs_by_run):
    """[[duty, station], ...]: who drives the trip from which stop, from the
    legs of the same run. A leg covers its pick-up second to the end of its
    relief minute (a leg with no relief time, such as a depot move, to the
    duty's next pick-up); where two overlap (a relief), the later pick-up wins."""
    legs = legs_by_run.get(run, [])
    out = []
    for stop in stops:
        t = stop_time(stop)
        if t is None:
            continue
        cover = [l for l in legs if l["end"] is not None and l["t"] - 5 <= t < l["end"]]
        if not cover:
            return None
        duty = max(cover, key=lambda l: l["t"])["duty"]
        if not out or out[-1][0] != duty:
            out.append([duty, stop[0]])
    return out or None


def build(meta, legs, stats, base_entry, base):
    day = DAY_BY_TYPE.get(meta["code"][0], "special")
    trips_in = trips_from_legs(legs)
    templates = template_trips(base)
    legs_by_run = {}
    for i, leg in enumerate(legs):
        # DM shuttles carry no passengers; "Riding" is a driver travelling as a
        # passenger, not driving the train.
        if leg["dm"] or leg["remark"].lower().startswith("rid"):
            continue
        after = legs[i + 1] if i + 1 < len(legs) else None
        if leg.get("rel") is not None:
            end = leg["rel"] + 60
        elif after is not None and after["duty"] == leg["duty"] and after["t"] > leg["t"]:
            end = after["t"]
        else:
            end = None
        legs_by_run.setdefault(leg["run"], []).append({**leg, "end": end})
    trips, precision = [], {"exact": 0, "anchored": 0, "terminal": 0}
    sheet = {(t["run"], t["dir"], t["dep"]): t for t in trips_in}
    # Base trips the sheet confirms keep the base's own stop times, trip numbers
    # and notes: they are the official ones, a rebuild is not. A terminal
    # departure counts as confirmed when the sheet has it (same run, direction,
    # second); any other trip (depot pull-outs such as KSR, short workings)
    # when the same run has a driver on every stop.
    used = set()
    for bt in base["trips"]:
        f = bt["stops"][0]
        key = (bt["run"], bt["dir"], f[2])
        terminal = f[0] in TERMINI and len(f) < 4 and f[2] is not None and len(bt["stops"]) > 1
        if terminal and key not in sheet:
            continue
        duties = duties_for(bt["stops"], bt["run"], legs_by_run)
        if not duties:
            if terminal:
                stats.setdefault("noDuty", []).append(key)
            else:
                continue
        if terminal:
            used.add(key)
        row = dict(bt)
        row.update({"duties": duties, "src": "duty", "precision": "exact"})
        if terminal and sheet[key]["lastLeg"] and "LAST TRIP, TRAIN TO DEPOT AT TERMINUS" not in row.get("notes", []):
            row["notes"] = row.get("notes", []) + ["LAST TRIP, TRAIN TO DEPOT AT TERMINUS"]
        precision["exact"] += 1
        trips.append(row)
    # Terminal departures the base does not have: rebuilt from the sheet.
    for key, t in sheet.items():
        if key in used:
            continue
        rebuilt = rebuild(t, templates)
        if not rebuilt:
            continue
        stops, prec = rebuilt
        precision[prec] += 1
        notes = ["LAST TRIP, TRAIN TO DEPOT AT TERMINUS"] if t["lastLeg"] else []
        trips.append({"dir": t["dir"], "run": t["run"], "trip": "", "notes": notes,
                      "duties": duties_for(stops, t["run"], legs_by_run), "stops": stops,
                      "src": "duty", "precision": prec})
    trips.sort(key=lambda t: stop_time(t["stops"][0]))
    out = {
        "schema": "dutysheet/1",
        "timetable": f"DS{meta['code']}",
        "dutysheet": meta["code"],
        "day": day,
        "kind": "normal",
        "issued": meta["issued"],
        "effective": meta["effective"],
        "base": base_entry["code"],
        "source": {"sha256": meta["sha256"], "pages": meta["pages"], "parser": PARSER_VERSION,
                   "legs": stats["legs"], "unparsed": len(stats["unparsed"])},
        "coverage": {"trips": len(trips), "runs": len({t["run"] for t in trips}), **precision},
        # Run / dwell tables, headways and first/last trains are not in a Duty
        # Sheet; they come from the base timetable.
        "sectionA": base.get("sectionA"),
        "headways": base.get("headways"),
        "firstLast": base.get("firstLast"),
        "trips": trips,
    }
    return out


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", nargs="+")
    ap.add_argument("--base", help="base timetable code (default: latest same-day normal one not newer than the sheet)")
    ap.add_argument("--dry-run", action="store_true", help="parse and validate, write nothing")
    ap.add_argument("--keep-redundant", action="store_true",
                    help="also write a sheet identical to its base timetable (normally skipped: the base is exact)")
    args = ap.parse_args(argv)

    sys.path.insert(0, HERE)
    from validate_dutysheet import validate

    folder = os.path.join(DATA, "timetables")
    index_path = os.path.join(folder, "index.json")
    index = load_json(index_path) if os.path.exists(index_path) else {"timetables": []}
    failed = False
    for path in args.pdf:
        try:
            meta, legs, stats = parse_pdf(path)
        except ValueError as e:
            print(f"{path}: {e}")
            failed = True
            continue
        day = DAY_BY_TYPE.get(meta["code"][0], "special")
        base_entry = choose_base(index, meta, day, args.base)
        if not base_entry:
            print(f"DS{meta['code']}: no base timetable found for {day} ({meta['effective']}); pass --base")
            failed = True
            continue
        base = load_json(os.path.join(folder, base_entry["file"]))
        out = build(meta, legs, stats, base_entry, base)
        errors, notes, primary = validate(out, base, base_entry)
        print(f"DS{meta['code']} ({day}, effective {meta['effective']}, base {base_entry['code']}): "
              f"{'PASS' if not errors else 'FAIL'}")
        for n in notes:
            print(f"  · {n}")
        for e in errors[:20]:
            print(f"  ✗ {e}")
        if stats["unparsed"]:
            print(f"  · unparsed rows ({len(stats['unparsed'])}), first: {stats['unparsed'][0]}")
        if errors:
            failed = True
            continue
        if args.dry_run:
            continue
        if not primary and not args.keep_redundant:
            print("  · not written: the base timetable already has these trips (use --keep-redundant to write it anyway)")
            continue
        existing = next((e for e in index["timetables"] if e["code"] == out["timetable"]), None)
        if existing and existing.get("sha256") == meta["sha256"]:
            print("  · same PDF already registered, nothing to do")
            continue
        out["revision"] = (existing or {}).get("revision", 0) + 1
        with open(os.path.join(folder, f"{out['timetable']}.json"), "w", encoding="utf8") as fh:
            json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
            fh.write("\n")
        entry = {"code": out["timetable"], "file": f"{out['timetable']}.json", "day": day, "kind": "normal",
                 "effective": meta["effective"], "source": "dutysheet", "base": base_entry["code"],
                 "revision": out["revision"], "sha256": meta["sha256"], "primary": primary}
        index["timetables"] = [e for e in index["timetables"] if e["code"] != out["timetable"]] + [entry]
        print(f"  registered, primary={primary}")
    if not args.dry_run:
        with open(index_path, "w", encoding="utf8") as fh:
            json.dump(index, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
