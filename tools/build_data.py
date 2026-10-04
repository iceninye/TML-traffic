#!/usr/bin/env python3
"""Builds the two static model files the app loads.

    python3 tools/build_data.py              # both files
    python3 tools/build_data.py --no-track   # timetable only (no network)

data/tml-timetable.json — running-time model shared by the estimator and the
    diagram. See docs/MODEL.md for where each number comes from.
data/tml-track.json     — the real Tuen Ma Line alignment from OpenStreetMap
    (relation 6102298, down direction), stitched into one polyline and
    simplified, with each station's position along it. ODbL, see NOTICE.md.
"""

import json
import math
import os
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

# [code, km from TUM] — track distance, 56.30 km end to end.
STATIONS = [
    ("TUM", 0), ("SIH", 2.1), ("TIS", 7.05), ("LOP", 9.39), ("YUL", 10.43),
    ("KSR", 13.97), ("TWW", 22.9), ("MEF", 27.29), ("NAC", 29.7), ("AUS", 32.47),
    ("ETS", 34.18), ("HUH", 35.31), ("HOM", 36.09), ("TKW", 37.13), ("SUW", 38.27),
    ("KAT", 39.28), ("DIH", 40.54), ("HIK", 45.0), ("TAW", 46.29), ("CKT", 47.09),
    ("STW", 48.05), ("CIO", 49.19), ("SHM", 49.94), ("TSH", 52.81), ("HEO", 53.92),
    ("MOS", 55.0), ("WKS", 56.3),
]

# Hops listed in the weekday timetable TML1100B (down track):
# from -> (peak run s, off-peak run s, peak dwell s at `from`)
PUBLISHED = {
    "TUM": (133, 142, 26),
    "SIH": (237, 237, 31),
    "TIS": (140, 153, 24),
    "LOP": (90, 93, 28),
    "YUL": (181, 181, 24),
    "KSR": (337, 353, 30),
    "TWW": (237, 238, 30),
    "DIH": (237, 242, 22),
    "MOS": (138, 185, None),
}
TOTAL_PEAK = 3662
TOTAL_OFF = 3756
# Interchange nodes hold the train longer than an ordinary stop.
LONG_DWELL = {"MEF": 38, "HUH": 40, "HOM": 36}
DWELL_DEFAULT = 25

# Service bands per day type, HKT. `to` past 24:00 runs into the next morning.
PERIODS = {
    "weekday": {
        "timetable": "TML1100B",
        "maxTrains": 52,
        "bands": [
            {"from": "05:30", "to": "06:40", "headway": 405, "peak": False, "tag": "early"},
            {"from": "06:40", "to": "07:45", "headway": 180, "peak": True, "tag": "shoulder"},
            {"from": "07:45", "to": "08:45", "headway": 163, "peak": True, "tag": "amPeak"},
            {"from": "08:45", "to": "09:15", "headway": 210, "peak": True, "tag": "shoulder"},
            {"from": "09:15", "to": "16:55", "headway": 390, "peak": False, "tag": "day"},
            {"from": "16:55", "to": "19:25", "headway": 210, "peak": True, "tag": "pmPeak"},
            {"from": "19:25", "to": "25:30", "headway": 384, "peak": False, "tag": "evening"},
        ],
    },
    "saturday": {
        "timetable": "TML6090A",
        "maxTrains": 33,
        "bands": [
            {"from": "05:30", "to": "07:25", "headway": 405, "peak": False, "tag": "early"},
            {"from": "07:25", "to": "09:31", "headway": 280, "peak": True, "tag": "amPeak"},
            {"from": "09:31", "to": "16:33", "headway": 360, "peak": False, "tag": "day"},
            {"from": "16:33", "to": "19:29", "headway": 280, "peak": True, "tag": "pmPeak"},
            {"from": "19:29", "to": "25:30", "headway": 384, "peak": False, "tag": "evening"},
        ],
    },
    "sunday": {
        "timetable": "TML7090",
        "maxTrains": 26,
        "bands": [
            {"from": "05:30", "to": "09:25", "headway": 405, "peak": False, "tag": "early"},
            {"from": "09:25", "to": "22:00", "headway": 360, "peak": False, "tag": "day"},
            {"from": "22:00", "to": "25:30", "headway": 405, "peak": False, "tag": "evening"},
        ],
    },
}


def build_timetable():
    hops = []
    for (a, ka), (b, kb) in zip(STATIONS, STATIONS[1:]):
        hops.append({"from": a, "to": b, "km": round(kb - ka, 2)})

    # Least squares t = c0 + c1*m over the listed hops, leaving out the slow
    # terminal approach into Wu Kai Sha.
    rows = [h for h in hops if h["from"] in PUBLISHED and h["from"] != "MOS"]

    def fit(pick):
        xs = [h["km"] * 1000 for h in rows]
        ys = [PUBLISHED[h["from"]][pick] for h in rows]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        c1 = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
        return {"c0": round(my - c1 * mx, 3), "c1": round(c1, 6)}

    def fill(pick, model, total):
        known = sum(PUBLISHED[h["from"]][pick] for h in hops if h["from"] in PUBLISHED)
        unknown = [h for h in hops if h["from"] not in PUBLISHED]
        raw = [model["c0"] + model["c1"] * h["km"] * 1000 for h in unknown]
        scale = (total - known) / sum(raw)
        return {h["from"]: round(r * scale) for h, r in zip(unknown, raw)}

    fit_peak, fit_off = fit(0), fit(1)
    peak_fill = fill(0, fit_peak, TOTAL_PEAK)
    off_fill = fill(1, fit_off, TOTAL_OFF)
    for hop in hops:
        known = PUBLISHED.get(hop["from"])
        hop["peak"] = known[0] if known else peak_fill[hop["from"]]
        hop["off"] = known[1] if known else off_fill[hop["from"]]
        hop["source"] = "TML1100B" if known else "fitted"

    dwell = {}
    for code, _ in STATIONS[1:-1]:
        known = PUBLISHED.get(code, (None, None, None))[2]
        dwell[code] = LONG_DWELL.get(code) or known or DWELL_DEFAULT

    out = {
        "line": "TML",
        "note": "Run times are down-track (TUM->WKS) and applied to both directions. Built by tools/build_data.py.",
        "totalKm": 56.3,
        "totals": {
            "peakRunSec": sum(h["peak"] for h in hops),
            "offRunSec": sum(h["off"] for h in hops),
            "dwellSec": sum(dwell.values()),
        },
        "fit": {"peak": fit_peak, "off": fit_off},
        "stations": {code: {"km": km} for code, km in STATIONS},
        "hops": hops,
        "dwell": dwell,
        "firstLast": {
            "DOWN": {"from": "TUM", "first": "05:45", "last": "00:15"},
            "UP": {"from": "WKS", "first": "05:38", "last": "23:54"},
        },
        "periods": PERIODS,
    }
    write("tml-timetable.json", out)
    t = out["totals"]
    print(f"timetable: peak {t['peakRunSec']} s · off {t['offRunSec']} s · dwell {t['dwellSec']} s · "
          f"end to end off-peak {(t['offRunSec'] + t['dwellSec']) / 60:.1f} min")
    for h in hops:
        print(f"  {h['from']}-{h['to']} {h['km']:5.2f} km  peak {h['peak']:3d}s  off {h['off']:3d}s  {h['source']}")


# ---------------------------------------------------------------- track

OVERPASS = "https://overpass-api.de/api/interpreter"
RELATION = 6102298  # 港鐵屯馬綫, 下行 Down, TUM -> WKS


def fetch_relation(cache):
    if cache and os.path.exists(cache):
        with open(cache, encoding="utf8") as fh:
            return json.load(fh)
    query = f"[out:json][timeout:90];relation({RELATION});out geom;"
    req = urllib.request.Request(
        OVERPASS,
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "TML-traffic/0.2 (github.com/iceninye/TML-traffic)"},
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        payload = json.load(res)
    if cache:
        with open(cache, "w", encoding="utf8") as fh:
            json.dump(payload, fh)
    return payload


def metres(a, b):
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    dlat, dlng = lat2 - lat1, math.radians(b[0] - a[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * 6_371_000 * math.asin(min(1, math.sqrt(h)))


def stitch(ways):
    line = []
    for way in ways:
        pts = [(p["lon"], p["lat"]) for p in way]
        if not line:
            line = pts
            continue
        end = line[-1]
        if metres(end, pts[-1]) < metres(end, pts[0]):
            pts.reverse()
        # The first way may itself be backwards relative to the second.
        if len(line) == len(ways[0]) and metres(line[0], pts[0]) < metres(end, pts[0]):
            line.reverse()
            end = line[-1]
        gap = metres(end, pts[0])
        if gap > 50:
            print(f"  warning: {gap:.0f} m gap while stitching", file=sys.stderr)
        line.extend(pts[1:] if gap < 1 else pts)
    return line


def simplify(points, tolerance):
    # Douglas–Peucker in a local metric frame.
    lat0 = math.radians(sum(p[1] for p in points) / len(points))
    xy = [(p[0] * 111_320 * math.cos(lat0), p[1] * 110_540) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = xy[i]
        bx, by = xy[j]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy) or 1e-9
        best, at = 0.0, -1
        for k in range(i + 1, j):
            px, py = xy[k]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, at = d, k
        if best > tolerance:
            keep[at] = True
            stack += [(i, at), (at, j)]
    return [p for p, k in zip(points, keep) if k]


def project(line, cum, point):
    lat0 = math.radians(point[1])
    sx, sy = 111_320 * math.cos(lat0), 110_540
    best = (float("inf"), 0.0, point)
    for k in range(len(line) - 1):
        a, b = line[k], line[k + 1]
        ax, ay = (a[0] - point[0]) * sx, (a[1] - point[1]) * sy
        bx, by = (b[0] - point[0]) * sx, (b[1] - point[1]) * sy
        dx, dy = bx - ax, by - ay
        seg = dx * dx + dy * dy
        f = 0.0 if seg == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg))
        cx, cy = ax + f * dx, ay + f * dy
        d = math.hypot(cx, cy)
        if d < best[0]:
            snapped = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
            best = (d, cum[k] + f * (cum[k + 1] - cum[k]), snapped)
    return best


def build_track(cache):
    payload = fetch_relation(cache)
    rel = payload["elements"][0]
    ways = [m["geometry"] for m in rel["members"] if m["type"] == "way" and m["role"] == "" and m.get("geometry")]
    raw = stitch(ways)
    line = simplify(raw, 6.0)
    cum = [0.0]
    for a, b in zip(line, line[1:]):
        cum.append(cum[-1] + metres(a, b))

    with open(os.path.join(DATA, "tml-network.json"), encoding="utf8") as fh:
        network = json.load(fh)
    stations = {}
    last = -1.0
    for code, _ in STATIONS:
        s = network["stations"][code]
        off, along, snapped = project(line, cum, (s["lng"], s["lat"]))
        if along <= last:
            raise SystemExit(f"{code} projects behind the previous station ({along:.0f} m <= {last:.0f} m)")
        last = along
        stations[code] = {"along": round(along, 1), "offset": round(off, 1),
                          "lng": round(snapped[0], 6), "lat": round(snapped[1], 6)}
        if off > 150:
            print(f"  warning: {code} is {off:.0f} m off the alignment", file=sys.stderr)

    # Trim the tails beyond the terminus platforms (overrun / sidings).
    first, final = stations["TUM"]["along"], stations["WKS"]["along"]
    out_line, out_cum = [], []
    for p, c in zip(line, cum):
        if first - 1 <= c <= final + 1:
            out_line.append([round(p[0], 6), round(p[1], 6)])
            out_cum.append(round(c - first, 1))
    for code in stations:
        stations[code]["along"] = round(stations[code]["along"] - first, 1)
    # Make the ends exactly the terminus points.
    out_line.insert(0, [stations["TUM"]["lng"], stations["TUM"]["lat"]])
    out_cum.insert(0, 0.0)
    out_line.append([stations["WKS"]["lng"], stations["WKS"]["lat"]])
    out_cum.append(stations["WKS"]["along"])

    out = {
        "line": "TML",
        "source": f"OpenStreetMap relation {RELATION} (down direction), ODbL. Built by tools/build_data.py.",
        "lengthM": out_cum[-1],
        "coords": out_line,
        "cum": out_cum,
        "stations": stations,
    }
    write("tml-track.json", out)
    print(f"track: {len(raw)} raw points -> {len(out_line)} kept · {out_cum[-1] / 1000:.2f} km along OSM alignment")
    worst = max(stations.items(), key=lambda kv: kv[1]["offset"])
    print(f"  worst station snap: {worst[0]} {worst[1]['offset']} m")


def write(name, obj):
    with open(os.path.join(DATA, name), "w", encoding="utf8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")


if __name__ == "__main__":
    build_timetable()
    if "--no-track" not in sys.argv:
        cache = None
        for arg in sys.argv[1:]:
            if arg.startswith("--osm="):
                cache = arg[len("--osm="):]
        build_track(cache)
