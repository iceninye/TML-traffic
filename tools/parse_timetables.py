#!/usr/bin/env python3
"""Parses the MTR Tuen Ma Line working timetables (PDF) into the schedule
files the app loads.

    pip install pdfplumber
    python3 tools/parse_timetables.py WEEKDAY.pdf SATURDAY.pdf SUNDAY.pdf

Writes data/tml-schedule-weekday.json, -saturday.json, -sunday.json.

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
    """Run and dwell seconds per hop, per direction, per period column."""
    out = {}
    for page in pdf.pages[:8]:
        text = page.extract_text() or ""
        if "Inter-station Run Times" not in text:
            continue
        direction = "DOWN" if "Down Track" in text else "UP" if "Up Track" in text else None
        if not direction:
            continue
        hops = []
        for line in text.splitlines():
            m = re.match(r"^([A-Z]{3}) - ([A-Z]{3}) ([\d.]+) (.+)$", line)
            if not m:
                continue
            nums = m.group(4).split()
            vals = [None if v == "-" else int(v) for v in nums]
            hops.append({"from": m.group(1), "to": m.group(2), "km": float(m.group(3)), "cols": vals})
        # Period headers, e.g. "Morning-peak (sec.) Non-peak (sec.) ..."
        header = next((l for l in text.splitlines() if "(sec.)" in l), "")
        periods = re.findall(r"([A-Za-z-]+(?: [A-Za-z-]+)*) \(sec\.\)", header)
        out[direction] = {"periods": periods, "hops": hops}
    return out


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


def parse_section_h(pdf):
    trips = []
    notes = {}
    for page in pdf.pages:
        text = page.extract_text() or ""
        for m in re.finditer(r"^\((\d+)\) (.+)$", text, re.M):
            notes[m.group(1)] = m.group(2).strip()
        if "LINE TML" not in text:
            continue
        direction, page_trips = parse_service_page(page)
        for t in page_trips:
            t["dir"] = direction
            trips.append(t)
    out = []
    for t in trips:
        stops = unwrap(t["stops"])
        public = {}
        for point, kind, sec in stops:
            if point not in PUBLIC:
                continue
            entry = public.setdefault(point, {})
            entry[kind] = sec
        if len(public) < 2:
            continue
        seq = sorted(public.items(), key=lambda kv: min(kv[1].values()))
        out.append({
            "dir": t["dir"],
            "run": t["run"],
            "trip": "/".join(t["trip"]),
            "notes": [notes.get(n.strip("()"), n) for n in t["notes"]],
            "stops": [[code, v.get("arr"), v.get("dep")] for code, v in seq],
        })
    return out


def summarise(name, trips):
    by_dir = {"UP": 0, "DOWN": 0}
    for t in trips:
        by_dir[t["dir"]] += 1
    first = min(t["stops"][0][2] or t["stops"][0][1] for t in trips)
    last = max(t["stops"][-1][1] or t["stops"][-1][2] for t in trips)
    print(f"{name}: {len(trips)} trips (up {by_dir['UP']}, down {by_dir['DOWN']}) "
          f"{first // 3600:02d}:{first % 3600 // 60:02d} -> {last // 3600 % 24:02d}:{last % 3600 // 60:02d}")


def main(paths):
    for path, day in zip(paths, ["weekday", "saturday", "sunday"]):
        pdf = pdfplumber.open(path)
        code = re.search(r"\((TML\w+)\)", pdf.pages[0].extract_text() or "")
        trips = parse_section_h(pdf)
        out = {
            "timetable": code.group(1) if code else None,
            "day": day,
            "sectionA": parse_section_a(pdf),
            "headways": parse_section_c(pdf),
            "trips": trips,
        }
        with open(os.path.join(DATA, f"tml-schedule-{day}.json"), "w", encoding="utf8") as fh:
            json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
            fh.write("\n")
        summarise(f"{day} {out['timetable']}", trips)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
