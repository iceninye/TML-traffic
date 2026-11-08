#!/usr/bin/env python3
"""Writes data/overlays.json: the Week 46 (9-13 Nov 2026) extra train Run 851.

Source: the MTR notice "司機職務表臨時改動" (duty sheets 1101xxx / 8027xxx, for
week 46 only). Only the revenue legs are modelled: YUL2 08:10:57 start service
towards WKS, and WKS 09:13:12 to MEF 10:00 (L, terminates at Mei Foo). The
intermediate stops follow an ordinary trip of DS1101 (YUL-WKS as is, WKS-MEF
scaled to arrive at 10:00:00), so they are modelled, not published times.
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
book = json.loads((root / "data/timetables/DS1101.json").read_text())
trips = book["trips"]

def pick(direction, first, last):
    for t in trips:
        codes = [s[0] for s in t["stops"]]
        if t["dir"] == direction and first in codes and last in codes and not t["notes"]:
            i, j = codes.index(first), codes.index(last)
            if i < j and t["stops"][0][0] in (first, "TUM", "WKS") and t["stops"][i][2] is not None:
                return t["stops"][i:j + 1]
    raise SystemExit(f"no template for {first}->{last}")

def build(stops, dep0, scale=1.0, arr_end=None):
    t0 = stops[0][2]
    out = []
    for k, (code, arr, dep, *_) in enumerate(stops):
        a = None if k == 0 else round(dep0 + (arr - t0) * scale)
        d = None if k == len(stops) - 1 else round(dep0 + (dep - t0) * scale)
        out.append([code, a, d])
    if arr_end is not None:
        out[-1][1] = arr_end
    return out

def hms(h, m, s):
    return h * 3600 + m * 60 + s

down = build(pick("DOWN", "YUL", "WKS"), hms(8, 10, 57))
tpl_up = pick("UP", "WKS", "MEF")
tpl_len = tpl_up[-1][1] - tpl_up[0][2]
dep_up = hms(9, 13, 12)
up = build(tpl_up, dep_up, (hms(10, 0, 0) - dep_up) / tpl_len, hms(10, 0, 0))

dates = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]
out = {
    "note": "Dated additions on top of the working timetables (see applyOverlays in lib/tml-timetable.js) and notices the user must acknowledge. Written by tools/make_overlay_w46.py.",
    "overlays": [{
        "id": "2026-w46-run851",
        "dates": dates,
        "days": ["weekday"],
        "label": "Week 46 臨時加班車 Run 851",
        "trips": [
            {"dir": "DOWN", "run": 851, "trip": "", "notes": ["START SERVICE AT YUL"], "stops": down, "src": "overlay", "precision": "modelled"},
            {"dir": "UP", "run": 851, "trip": "", "notes": ["LAST TRIP, TRAIN TO DEPOT AT TERMINUS", "TERMINATES AT MEF"], "stops": up, "src": "overlay", "precision": "modelled"},
        ],
    }],
    "notices": [{
        "id": "2026-w46-duty-sheets",
        "dates": dates,
        "title": "Week 46 臨時司機職務表",
        "text": "11月9日至13日（星期一至五）港鐵用臨時司機職務表（1101xxx／8027xxx），加開臨時加班車 Run 851（元朗 08:10 開出往烏溪沙，09:13 烏溪沙開出，美孚 10:00 終點，L），亦會影響部份班次。\n本 App 未有新版職務表，只加入咗 Run 851，其他班次嘅時間、Run 編號同更份號碼可能有輕微偏差，請以車長職務表為準。",
    }],
}
(root / "data/overlays.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
print(down[0], down[-1], up[0], up[-1])
