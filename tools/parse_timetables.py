#!/usr/bin/env python3
"""Parses the MTR Tuen Ma Line working timetables (PDF) into the schedule
files the app loads.

    pip install pdfplumber
    python3 tools/parse_timetables.py TIMETABLE.pdf [TIMETABLE.pdf ...]

For each PDF: parses it to data/timetables/<CODE>.json, runs
tools/validate_timetable.py on the result, and only if it passes adds or
updates its entry in data/timetables/index.json (the list the app loads).
The day type comes from the timetable code (MTR format, digit IV):
1/5 weekday, 6 saturday, 7 sunday/PH, anything else "special".

Each PDF has:
  A. per-direction run and dwell times for four periods (AM peak, non-peak,
     PM peak, non-peak)
  C. headways by period
  H. the train service: every trip as a column, every station as a row,
     8 trips per page. Rows include sidings and depot points (TT1, KATS,
     W1F, PCKTD ...); only the 27 passenger stations are kept.

Times are stored as seconds after midnight of the service day; anything
after midnight continues past 86400 so a trip's times always increase.
"""

import json
import os
import re
import sys

import pdfplumber

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

STATIONS = [
    "TUM", "SIH", "TIS", "LOP", "YUL", "KSR", "TWW", "MEF", "NAC", "AUS", "ETS", "HUH", "HOM",
    "TKW", "SUW", "KAT", "DIH", "HIK", "TAW", "CKT", "STW", "CIO", "SHM", "TSH", "HEO", "MOS", "WKS",
]
PUBLIC = set(STATIONS)
TIME = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})$")


def seconds(text):
    m = TIME.match(text)
    if not m:
        return None
    h, mi, s = map(int, m.groups())
    return h * 3600 + mi * 60 + s


def rows_by_y(words, tol=2.5):
    rows = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if rows and abs(rows[-1][0] - w["top"]) <= tol:
            rows[-1][1].append(w)
        else:
            rows.append([w["top"], [w]])
    return rows


# ------------------------------------------------------------- section A

def parse_section_a(pdf):
    """Run and dwell seconds per hop, per direction, per period column, plus
    the period names (and clock ranges where the timetable gives them) and
    the summary rows: turnaround at each terminus, round trip, trains used."""
    out = {}
    summary = {}
    for page in pdf.pages[:8]:
        text = page.extract_text() or ""
        if "Inter-station Run Times" not in text:
            continue
        direction = "DOWN" if "Down Track" in text else "UP" if "Up Track" in text else None
        if not direction:
            continue
        hops = []
        # Underlined rows come out with "_" glyphs mixed into the text.
        lines = [l.replace("_", "") for l in text.splitlines()]
        for line in lines:
            m = re.match(r"^([A-Z]{3}) - ([A-Z]{3}) ([\d.]+) (.+)$", line)
            if m:
                vals = [None if v == "-" else int(v) for v in m.group(4).split()]
                hops.append({"from": m.group(1), "to": m.group(2), "km": float(m.group(3)), "cols": vals})
                continue
            for label, key in (("TUM Turnaround Time", "turnaroundTUM"), ("WKS Turnaround Time", "turnaroundWKS"),
                               ("Round Trip Time", "roundTrip"), ("Number of Trains Used", "trainsUsed")):
                if line.startswith(label):
                    rest = re.sub(r"^\s*\([a-z]\)", "", line[len(label):])
                    summary[key] = [int(v) for v in re.findall(r"\d+", rest)]
        # Period headers: "Morning-peak (sec.) Non-peak (sec.)" or, with no
        # space, "Morning-Afternoon(sec.)"; drop the column words in front.
        header = next((l for l in lines if "(sec.)" in l), "")
        names = [re.sub(r"^(Distance|Station)\s+", "", n).strip() for n in re.findall(r"([A-Za-z][A-Za-z -]*?)\s*\(sec\.\)", header)]
        ranges = re.findall(r"\((\d{2}:\d{2}) - (\d{2}:\d{2})\)", text)
        ncols = max((len(h["cols"]) for h in hops), default=0) // 2
        # An underlined summary row can lose its spaces ("33263326"): split
        # it evenly by the number of period columns.
        for key, vals in summary.items():
            if len(vals) == 1 and ncols > 1 and len(str(vals[0])) % ncols == 0:
                text_v = str(vals[0])
                w = len(text_v) // ncols
                summary[key] = [int(text_v[i:i + w]) for i in range(0, len(text_v), w)]
        periods = []
        for i in range(ncols):
            entry = {"name": names[i] if i < len(names) else f"period {i + 1}"}
            if i < len(ranges):
                entry["from"], entry["to"] = ranges[i]
            periods.append(entry)
        out[direction] = {"periods": periods, "hops": hops}
    if summary:
        out["summary"] = summary
    return out


# ------------------------------------------------------------- section F

def parse_section_f(pdf):
    """First and last departure (hhmm) from each station toward each other
    station: {"first": {from: {to: "0545"}}, "last": {...}}."""
    out = {"first": {}, "last": {}}
    for page in pdf.pages[:20]:
        text = page.extract_text() or ""
        if "First Trains and Last Trains" not in text:
            continue
        part = "first"
        for line in text.splitlines():
            line = line.replace("_", "").strip()
            if line.startswith("Last Trains"):
                part = "last"
            # 26 times of 4 digits; spacing is unreliable in the text layer.
            m = re.match(r"^([A-Z]{3})\s*([\d\s]+)$", line)
            if not m:
                continue
            digits = re.sub(r"\D", "", m.group(2))
            if len(digits) != 104:
                continue
            origin = m.group(1)
            times = [digits[i:i + 4] for i in range(0, 104, 4)]
            targets = [c for c in STATIONS if c != origin]
            out[part][origin] = dict(zip(targets, times))
    return out if out["first"] else None


# ------------------------------------------------------------- section C

def parse_section_c(pdf):
    bands = {"DOWN": [], "UP": []}
    for page in pdf.pages[:10]:
        text = page.extract_text() or ""
        if "Summary of Train Service Frequencies" not in text:
            continue
        direction = None
        for line in text.splitlines():
            m = re.match(r"^(?:Track Time Period.*)?(Down|Up)? ?(\d{2}:\d{2}) - (\d{2}:\d{2}) ([\d.]+) \((\d+)s\)", line)
            if line.startswith("Down"):
                direction = "DOWN"
            elif line.startswith("Up"):
                direction = "UP"
            if m and direction:
                bands[direction].append({"from": m.group(2), "to": m.group(3), "headway": int(m.group(5))})
    return bands


# ------------------------------------------------------------- section H

def parse_service_page(page):
    words = page.extract_words()
    head = next((w for w in words if w["text"] == "LINE"), None)
    if not head:
        return None, []
    top = [w for w in words if abs(w["top"] - head["top"]) < 3]
    direction = "UP" if any(w["text"] == "UP" for w in top) else "DOWN"
    cols = sorted((w for w in words if w["text"] == "HH:MM:SS"), key=lambda w: w["x0"])
    if not cols:
        return direction, []
    centers = [(c["x0"] + c["x1"]) / 2 for c in cols]
    # Station labels and arr/dep sit left of the first trip column; the
    # three timetables place that column at different x.
    label_x = cols[0]["x0"] - 1
    half = (centers[1] - centers[0]) / 2 if len(centers) > 1 else 24

    def column(w):
        x = (w["x0"] + w["x1"]) / 2
        best = min(range(len(centers)), key=lambda i: abs(centers[i] - x))
        return best if abs(centers[best] - x) <= half else None

    trips = [{"run": None, "trip": [], "notes": [], "stops": [], "start": False, "next": None} for _ in centers]
    for _, row in rows_by_y(words):
        row.sort(key=lambda w: w["x0"])
        labels = [w["text"] for w in row if w["x1"] < label_x]
        cells = [w for w in row if w["x1"] >= label_x]
        key = " ".join(labels)
        if key.startswith("Run No"):
            for w in cells:
                i = column(w)
                if i is not None and w["text"].isdigit():
                    trips[i]["run"] = int(w["text"])
        elif key.startswith("Trip No") or (not labels and cells and all(re.match(r"^\d{5}$|^/$", w["text"]) for w in cells)):
            for w in cells:
                i = column(w)
                if i is not None and re.match(r"^\d{5}$", w["text"]):
                    trips[i]["trip"].append(w["text"])
        elif key.startswith("Notes"):
            for w in cells:
                i = column(w)
                if i is not None:
                    trips[i]["notes"].append(w["text"])
        elif not labels and cells and all(w["text"] == "START" for w in cells):
            for w in cells:
                i = column(w)
                if i is not None:
                    trips[i]["start"] = True
        elif len(labels) >= 2 and labels[-1] in ("arr", "dep"):
            point = labels[0]
            kind = labels[-1]
            for w in cells:
                i = column(w)
                t = seconds(w["text"])
                if i is not None and t is not None:
                    trips[i]["stops"].append((point, kind, t))
        elif key == "Next":
            for w in cells:
                i = column(w)
                if i is not None and re.match(r"^\d{5}$", w["text"]):
                    trips[i]["next"] = w["text"]
    return direction, [t for t in trips if t["stops"]]


def unwrap(stops):
    """Make a trip's clock monotonic across midnight; early-morning service
    day starts at 04:00."""
    out = []
    last = None
    for point, kind, t in stops:
        if last is None and t < 4 * 3600:
            t += 86400
        while last is not None and t < last - 6 * 3600:
            t += 86400
        out.append((point, kind, t))
        last = t
    return out


# Depot and siding points: a public stop met before one of these, in a trip
# that carries a non-passenger trip number, is run empty.
DEPOT = {"PCKTD", "PCKTB", "W1A", "W1C", "W1F", "E3A", "E3C", "ENT", "EXT"}


def passenger_number(n):
    return n[:1] in ("1", "2")


def parse_section_h(pdf, section_a=None):
    trips = []
    positioning = []
    for page in pdf.pages:
        text = page.extract_text() or ""
        if "LINE TML" not in text:
            continue
        # Footnote numbers are reused on every page: resolve them per page.
        page_notes = {m.group(1): m.group(2).strip() for m in re.finditer(r"^\(([^)]+)\) (.+)$", text, re.M)}
        direction, page_trips = parse_service_page(page)
        for t in page_trips:
            t["dir"] = direction
            tokens = re.findall(r"\(([^)]+)\)", "".join(t["notes"]))
            t["notes"] = [page_notes.get(k, f"({k})") for k in tokens]
            trips.append(t)

    out = []
    for t in trips:
        raw = unwrap(t["stops"])
        public_codes = {p for p, _, _ in raw if p in PUBLIC}
        if len(public_codes) < 2:
            # Empty move to a platform (depot -> TUM, siding -> TWW ...): keep
            # when the train arrives at a public platform, so the app knows
            # from when it stands there before its first trip.
            arr = [(p, sec) for p, kind, sec in raw if p in PUBLIC and kind == "arr"]
            if arr and t["run"] is not None:
                positioning.append({"run": t["run"], "station": arr[-1][0], "at": arr[-1][1]})
            continue

        # Which public stops are run empty.
        numbers = t["trip"]
        whole_np = not any(passenger_number(n) for n in numbers) or any(
            re.fullmatch(r"NON-PASSENGER TRAIN.*", n) for n in t["notes"])
        np_until = None  # first public stop where passenger service begins
        for n in t["notes"]:
            m = re.match(r"NON[ -]PASSENGER SERVICE FROM (\w+) TO (\w+)", n)
            if m:
                np_until = m.group(2)
        # Empty leg first (e.g. 40023/20044: depot -> ... -> passenger): public
        # stops before the depot point are empty. When the passenger leg comes
        # first (20204/40239), the empty tail is found by "END SERVICE AT".
        if np_until is None and numbers and not passenger_number(numbers[0]):
            seen_public = False
            for p, _, _ in raw:
                if p in PUBLIC:
                    seen_public = True
                elif p in DEPOT and seen_public:
                    np_until = "__after_depot__"
                    break

        # "END SERVICE AT X": the train runs empty after X (to a depot or
        # siding), so public stops after X carry no passengers.
        end_at = None
        for n in t["notes"]:
            m = re.match(r"END SERVICE AT (\w+)", n)
            if m:
                end_at = m.group(1)
        public = {}
        order = []
        empty = set()
        ended = False
        passing_depot = False
        reached = False
        for p, kind, sec in raw:
            if p in DEPOT:
                passing_depot = True
                continue
            if p not in PUBLIC:
                continue
            if p not in public:
                order.append(p)
                if ended:
                    empty.add(p)
                elif whole_np:
                    empty.add(p)
                elif np_until == "__after_depot__":
                    if not passing_depot:
                        empty.add(p)
                elif np_until and not reached:
                    if p == np_until:
                        reached = True
                    else:
                        empty.add(p)
            public.setdefault(p, {})[kind] = sec
            if end_at and p == end_at:
                ended = True
        seq = sorted(order, key=lambda c: min(public[c].values()))
        stops = []
        for code in seq:
            v = public[code]
            row = [code, v.get("arr"), v.get("dep")]
            if code in empty:
                row.append(1)
            stops.append(row)
        out.append({
            "dir": t["dir"],
            "run": t["run"],
            "trip": "/".join(numbers),
            "notes": t["notes"],
            "stops": stops,
        })

    fill_arrivals(out, section_a or {})
    attach_platform_arrivals(out, positioning)
    return out


def fill_arrivals(trips, section_a):
    """Most stations list only a departure. Arrival = previous departure +
    the run time of the section A period whose run + dwell best explains
    the timetabled gap; a stop the train is held at keeps its on-time
    arrival and simply dwells longer."""
    table = {}
    for d in ("DOWN", "UP"):
        for h in section_a.get(d, {}).get("hops", []):
            cols = h["cols"]
            pairs = [(cols[i], cols[i + 1] or 0) for i in range(0, len(cols) - 1, 2) if cols[i]]
            table[(d, h["from"], h["to"])] = pairs
    for t in trips:
        st = t["stops"]
        for k in range(1, len(st)):
            if st[k][1] is not None:
                continue
            prev_dep = st[k - 1][2] if st[k - 1][2] is not None else st[k - 1][1]
            dep = st[k][2]
            if prev_dep is None or dep is None:
                continue
            pairs = table.get((t["dir"], st[k - 1][0], st[k][0]))
            if not pairs:
                continue
            gap = dep - prev_dep
            run, _ = min(pairs, key=lambda rd: abs(rd[0] + rd[1] - gap))
            st[k][1] = max(prev_dep, min(dep, prev_dep + run))


def attach_platform_arrivals(trips, positioning):
    """An empty move that ends at a platform tells when the train is there
    before its first passenger trip from that station."""
    by_run = {}
    for t in trips:
        by_run.setdefault(t["run"], []).append(t)
    for move in positioning:
        candidates = [t for t in by_run.get(move["run"], [])
                      if t["stops"][0][0] == move["station"] and t["stops"][0][2] is not None
                      and 0 <= t["stops"][0][2] - move["at"] <= 3600]
        if candidates:
            first = min(candidates, key=lambda t: t["stops"][0][2])
            first["platformFrom"] = move["at"]


def iso_date(text):
    from datetime import datetime
    try:
        return datetime.strptime(text, "%d %B %Y").date().isoformat()
    except ValueError:
        return text


DAY_BY_TYPE = {"1": "weekday", "5": "weekday", "6": "saturday", "7": "sunday"}


def main(paths):
    sys.path.insert(0, HERE)
    from validate_timetable import validate

    folder = os.path.join(DATA, "timetables")
    os.makedirs(folder, exist_ok=True)
    index_path = os.path.join(folder, "index.json")
    index = {"timetables": []}
    if os.path.exists(index_path):
        with open(index_path, encoding="utf8") as fh:
            index = json.load(fh)
    failed = False
    for path in paths:
        pdf = pdfplumber.open(path)
        first = pdf.pages[0].extract_text() or ""
        code_m = re.search(r"\((TML\w+)\)", first)
        if not code_m:
            print(f"{path}: no timetable code on page 1, skipped")
            failed = True
            continue
        code = code_m.group(1)
        type_digit = code[3] if len(code) > 3 else ""
        day = DAY_BY_TYPE.get(type_digit, "special")
        # Page 1 says "Normal ..." or "Special ..."; only normal ones are the
        # calendar's default, special ones are tried when those do not fit.
        kind = "special" if re.search(r"\bSpecial\b", first) else "normal"
        eff = re.search(r"Effective:\s*(\d{1,2} \w+ \d{4})", first)
        section_a = parse_section_a(pdf)
        trips = parse_section_h(pdf, section_a)
        out = {
            "timetable": code,
            "day": day,
            "kind": kind,
            "sectionA": section_a,
            "headways": parse_section_c(pdf),
            "firstLast": parse_section_f(pdf),
            "trips": trips,
        }
        errors, notes = validate(out)
        if errors:
            print(f"{code}: FAIL, not registered")
            for e in errors[:10]:
                print(f"  ✗ {e}")
            failed = True
            continue
        with open(os.path.join(folder, f"{code}.json"), "w", encoding="utf8") as fh:
            json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
            fh.write("\n")
        entry = {"code": code, "file": f"{code}.json", "day": day,
                 "kind": kind,
                 "effective": iso_date(eff.group(1)) if eff else None}
        index["timetables"] = [e for e in index["timetables"] if e["code"] != code] + [entry]
        print(f"{code}: PASS, registered as {day}")
        for n in notes:
            print(f"  · {n}")
    with open(index_path, "w", encoding="utf8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
    return 1 if failed else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1:]))
