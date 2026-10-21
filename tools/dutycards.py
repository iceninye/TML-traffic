#!/usr/bin/env python3
"""Reads the duty cards of a Duty Sheet workbook (.xlsx) into data/duties/DS<code>.json.

    python3 tools/dutycards.py TML_duty_sheet_8022.xlsx DUTYSHEET.pdf [...] [--dry-run]
    python3 tools/dutycards.py --stubs     # number-only lists for sheets without cards

tools/parse_dutysheet.py calls read_cards() / write_duties() for every .xlsx it
ingests, so a normal ingest writes the timetable and the duty cards together.

Each duty card (sheets KSR, TAW, HHS, ETS DM) gives: book on/off place and time,
work hours, and a list of legs (Run, pick-up place and time, relief time and
place, remark, flag), with the meal break as a leg whose remark is "MB".

What is written (decided by the project owner, 2026-10-14, "option A"):
  duty number, depot group (KSR / TAD / HHS), workbook tab, book on/off, work minutes, meal
  (from, to, place) and the legs as [kind, run, from, at, to, until].
Free-text remarks (instructions to the crew) are NOT written; each leg only
keeps a kind: drive, empty, prep, ride, wait (standby / break), other.
Times are seconds since the start of the service day; after midnight they run
past 86400. Meal/leg places are station or depot codes as printed on the sheet.
"""

import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
CARD_SHEETS = {"KSR": "KSR", "TAW": "TAD", "HHS": "HHS", "ETS DM": "HHS", "overnight": "TAD"}
# Fifth digit of a duty number -> crew group. 4/6 are the marathon 7091M's Tai Wai and
# Hung Hom numbers, 7 its overnight (Tai Wai) duties.
GROUP_BY_DIGIT = {"1": "KSR", "3": "TAD", "4": "TAD", "5": "HHS", "6": "HHS", "7": "TAD"}
DUTY = re.compile(r"^\d{7}$")
DAY_WORDS = {"weekday": "weekday", "saturday": "saturday", "sunday": "sunday"}
SCHEMA = "dutycards/1"
PARSER_VERSION = "0.1.0"


def secs(value):
    if value is None or not hasattr(value, "hour"):
        return None
    return value.hour * 3600 + value.minute * 60 + getattr(value, "second", 0)


def text(value):
    return "" if value is None else str(value).strip()


# Duties that are not published: 6091588 and 7091587 (HUH ETS DM shuttle cards whose
# legs fall outside sign-on/off) and 1101586 (Ice, 2026-10-14).
SKIP_DUTIES = {"6091588", "7091587", "1101586"}
# Printed Work Hr that the source sheet gets wrong (Ice, 2026-10-14: 6.5 h and 8 h,
# later sheet versions will correct them), in minutes.
WORK_OVERRIDES = {"1101107": 390, "1101131": 480}


def meal_gap(meal, legs, on_place, pos=None):
    """The meal break is the time from getting off a train to picking up the next
    one, not the printed MB row (Ice, 2026-10-14: 1101165 alights 19:44 at KSR1,
    picks up 20:57 at KSR2: 1 h 13 min). The MB row only says which gap it is:
    the last leg before it is the one alighted from, the next leg after it is
    the pick-up. In a workbook the MB row's own time can be wrong (8023586 prints
    18:41 between legs at 19:16 and 20:30), so its position among the card's rows
    (pos = number of legs above it) decides; the PDF reader has no position and
    goes by the MB time. Returns [from, to, placeFrom, placeTo]."""
    if not meal:
        return None
    if pos is not None:
        before, after = legs[:pos], legs[pos:]
    else:
        before = [l for l in legs if l[3] <= meal[0]]
        after = [l for l in legs if l[3] > meal[0]]
    if before:
        prev = before[-1]
        start = prev[5] if prev[5] is not None else prev[3]
        place_from = prev[4] or prev[2]
    else:
        start, place_from = meal[0], meal[2] or on_place
    if after:
        end, place_to = after[0][3], after[0][2]
    else:
        end, place_to = meal[1], meal[2] or place_from
    if end <= start:
        return [meal[0], meal[1], meal[2], meal[2]]
    return [start, end, place_from, place_to]


# A DM shuttle trip HUH3 to ETS1 or ETS2 to HUH2 carries no passengers: the train
# is being parked (泊車; Ice, 2026-10-14, 1101334 Run 20 and Run 62).
PARK_TRIPS = {("HUH3", "ETS1"), ("ETS2", "HUH2")}


def park_kind(kind, frm, to):
    return "park" if kind == "drive" and (frm, to) in PARK_TRIPS else kind


def leg_kind(remark, flag, has_run):
    r = remark.lower()
    if r.startswith("train preparation") or r.startswith("empty train"):
        return "prep" if r.startswith("train") else "empty"
    if r.startswith("ride") or r.startswith("自己攬車"):
        return "ride"
    if r.startswith(("spare", "break")) or "standby" in r:
        return "wait"
    if "N" in flag:
        return "empty"
    return "drive" if has_run else "other"


def read_cards(path):
    """Returns (info, duties, stats). info has the sheet title fields."""
    import openpyxl

    with open(path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheets = [n for n in CARD_SHEETS if n in wb.sheetnames]
    if not sheets:
        raise ValueError(f"none of the sheets {list(CARD_SHEETS)} in the workbook")
    title = ""
    duties = []
    stats = {"cards": 0, "legs": 0, "meals": 0, "warnings": [], "kinds": {}}
    dates = set()
    for name in sheets:
        rows = [tuple(r) + (None,) * (10 - len(r)) for r in wb[name].iter_rows(max_col=10, values_only=True)]
        if not title:
            title = next((str(r[0]) for r in rows[:8] if r[0] and "Duty Sheet" in str(r[0])), "")
        starts = [i for i, r in enumerate(rows) if r[0] is not None and DUTY.match(str(r[0]))]
        for n, i in enumerate(starts):
            end = starts[n + 1] if n + 1 < len(starts) else len(rows)
            block = rows[i:end]
            duty_id = str(block[0][0])
            where = f"{name}!{duty_id}"
            label = next((k for k, r in enumerate(block[:8]) if str(r[0]).strip().lower() == "book on"), None)
            if label is None or label + 3 >= len(block):
                stats["warnings"].append(f"{where}: no Book On block")
                continue
            on_place, off_place = text(block[label + 1][0]), text(block[label + 1][1])
            on_t, off_t = secs(block[label + 2][0]), secs(block[label + 2][1])
            work = secs(block[label + 3][1])
            if on_t is None or off_t is None:
                stats["warnings"].append(f"{where}: no book on/off time")
                continue
            if off_t <= on_t:
                off_t += 86400
            for r in block:
                if hasattr(r[0], "date"):
                    dates.add(r[0].date().isoformat())
            group = CARD_SHEETS[name]
            if GROUP_BY_DIGIT.get(duty_id[4]) not in (None, group):
                stats["warnings"].append(f"{where}: number says {GROUP_BY_DIGIT[duty_id[4]]}, sheet says {group}")
            legs, meal, meal_pos = [], None, None
            prev, place = on_t, on_place
            for r in block:
                run, remark, flag = r[2], text(r[6]), text(r[9])
                start, relief = secs(r[5]), secs(r[7])
                if start is None:
                    continue
                if start < prev - 6 * 3600:
                    start += 86400
                if remark == "MB" or (remark.startswith("MB") and not isinstance(run, (int, float))):
                    until = relief + 86400 * (start // 86400) if relief is not None else None
                    if until is not None and until < start:
                        until += 86400
                    meal = [start, until, place]
                    meal_pos = len(legs)
                    stats["meals"] += 1
                    prev = until if until is not None else start
                    continue
                if not text(r[4]):
                    continue
                if relief is not None:
                    relief += 86400 * (start // 86400)
                    if relief < start - 6 * 3600:
                        relief += 86400
                kind = leg_kind(remark, flag, isinstance(run, (int, float)))
                kind = park_kind(kind, text(r[4]), text(r[8]) or None)
                leg = [kind, int(run) if isinstance(run, (int, float)) else None, text(r[4]), start,
                       text(r[8]) or None, relief]
                legs.append(leg)
                stats["legs"] += 1
                stats["kinds"][kind] = stats["kinds"].get(kind, 0) + 1
                prev = relief if relief is not None else start
                place = text(r[8]) or place
            if duty_id in SKIP_DUTIES:
                continue
            meal = meal_gap(meal, legs, on_place, meal_pos)
            work = WORK_OVERRIDES.get(duty_id, work // 60 if work is not None else None)
            work = None if work is None else work * 60
            if work is not None:
                made = (off_t - on_t - (meal[1] - meal[0] if meal and meal[1] else 0)) // 60
                if abs(made - work // 60) > 1:
                    stats["warnings"].append(f"{where}: work {work // 60} min, book on/off minus meal {made}")
            duties.append({
                "id": duty_id, "group": group, "tab": name,
                "on": [on_t, on_place], "off": [off_t, off_place],
                "work": None if work is None else work // 60,
                "meal": meal, "legs": legs,
            })
            stats["cards"] += 1
    code = re.search(r"Duty Sheet (\d{4})\s*\(([^)]*)", title)
    if not code:
        raise ValueError("no 'TML Duty Sheet <code>' title")
    issued = re.search(r"Issue Date:\s*(\d{1,2} \w+ \d{4})", title)
    if len(dates) != 1:
        raise ValueError(f"expected one service date, found {sorted(dates) or 'none'}")
    info = {"code": code.group(1), "titleDay": code.group(2).strip(), "issuedText": issued.group(1) if issued else None,
            "date": next(iter(dates)), "sha256": digest}
    listed = duty_list_ids(wb)
    if listed is not None:
        extra = sorted(d["id"] for d in duties if d["id"] not in listed)
        if extra:
            stats["warnings"].append(f"cards not in the duty list, skipped: {extra}")
            duties = [d for d in duties if d["id"] in listed]
        missing = sorted(listed - {d["id"] for d in duties})
        if missing:
            stats["warnings"].append(f"MISSING: in the duty list but no card: {missing}")
    ids = [d["id"] for d in duties]
    if len(ids) != len(set(ids)):
        stats["warnings"].append("duplicate duty numbers")
    return info, duties, stats


def cards_from_pdf(meta, legs, stats):
    """Cards of a PDF sheet: parse_dutysheet.parse_pdf() already collected book
    on/off, work hours and the meal per duty; the legs come from its leg list.
    Returns (info, duties, stats) like read_cards(). A PDF has no duty list page,
    so every card with a complete Book On block is kept."""
    out = {"cards": 0, "legs": 0, "meals": 0, "warnings": [], "kinds": {}}
    by_duty = {}
    for leg in legs:
        by_duty.setdefault(leg["duty"], []).append(leg)
    duties = []
    for duty_id, card in stats["cards"].items():
        if card.get("on") is None or card.get("off") is None:
            out["warnings"].append(f"{duty_id}: no complete Book On block, skipped")
            continue
        on_t, off_t = card["on"], card["off"]
        if off_t <= on_t:
            off_t += 86400
        card_legs = []
        # Times are re-anchored on the card's own book-on time (the PDF reader
        # starts every duty at midnight, so a duty that begins in the evening
        # would otherwise keep its after-midnight legs on the wrong day).
        prev = on_t
        for leg in by_duty.get(duty_id, []):
            t = leg["t"] % 86400
            while t < prev - 6 * 3600:
                t += 86400
            rel = None
            if leg.get("rel") is not None:
                rel = leg["rel"] % 86400 + (t // 86400) * 86400
                if rel < t - 6 * 3600:
                    rel += 86400
            kind = park_kind(leg_kind(leg["remark"], leg["flag"], True), leg["place"], leg["relPlace"])
            card_legs.append([kind, leg["run"], leg["place"], t, leg["relPlace"], rel])
            prev = rel if rel is not None else t
        card_legs.sort(key=lambda l: l[3])
        if card_legs and card_legs[-1][3] > off_t + 3600:
            out["warnings"].append(f"{duty_id}: legs run past book off ({card_legs[-1][3] // 3600}h), card skipped")
            continue
        for leg in card_legs:
            out["kinds"][leg[0]] = out["kinds"].get(leg[0], 0) + 1
        if duty_id in SKIP_DUTIES:
            continue
        meal = meal_gap(card["meal"], card_legs, card["on_place"])
        work = card.get("work")
        if duty_id in WORK_OVERRIDES:
            work = WORK_OVERRIDES[duty_id] * 60
        if work is not None:
            made = (off_t - on_t - (meal[1] - meal[0] if meal else 0)) // 60
            if abs(made - work // 60) > 1:
                out["warnings"].append(f"{duty_id}: work {work // 60} min, book on/off minus meal {made}")
        duties.append({"id": duty_id, "group": GROUP_BY_DIGIT.get(duty_id[4], "KSR"), "tab": None,
                       "on": [on_t, card["on_place"]], "off": [off_t, card["off_place"]],
                       "work": None if work is None else work // 60, "meal": meal, "legs": card_legs})
        out["cards"] += 1
        out["legs"] += len(card_legs)
        out["meals"] += 1 if meal else 0
    ids = [d["id"] for d in duties]
    if len(ids) != len(set(ids)):
        out["warnings"].append("duplicate duty numbers")
    info = {"code": meta["code"], "titleDay": meta["title_day"], "issuedText": None, "issued": meta["issued"],
            "date": meta.get("effective"), "sha256": meta["sha256"], "src": "pdf"}
    return info, duties, out


def duty_list_ids(wb):
    """Duty numbers on the workbook's own 'duty list' sheet (the day's roster), or None."""
    if "duty list" not in wb.sheetnames:
        return None
    return {str(c) for r in wb["duty list"].iter_rows(values_only=True) for c in r
            if isinstance(c, int) and DUTY.match(str(c))}


def day_class(info, dated):
    if dated:
        return "special"
    word = info["titleDay"].lower()
    return next((v for k, v in DAY_WORDS.items() if k in word), "special")


def also_on(code):
    """The extra dates a sheet runs on ("alsoOn" on its DS<code> entry in
    data/timetables/index.json), copied to the duty index so pages that read
    only data/duties/ (tml-roster) pick the right sheet on those days too."""
    with open(os.path.join(DATA, "timetables", "index.json"), encoding="utf8") as fh:
        books = json.load(fh)["timetables"]
    return next((b.get("alsoOn") for b in books if b["code"] == f"DS{code}"), None)


def write_duties(path, info, duties, issued_iso, dated=True, dry_run=False):
    folder = os.path.join(DATA, "duties")
    index_path = os.path.join(folder, "index.json")
    cls = day_class(info, dated)
    out = {"schema": SCHEMA, "dutysheet": info["code"], "class": cls, "dates": [info["date"]] if dated else None,
           "issued": issued_iso, "parser": PARSER_VERSION, "src": info.get("src", "xlsx"), "sha256": info["sha256"], "duties": duties}
    if dry_run:
        return out
    os.makedirs(folder, exist_ok=True)
    index = {"note": "Duty cards (book on/off, meal, legs) per Duty Sheet. Written by tools/dutycards.py.", "sheets": []}
    if os.path.exists(index_path):
        with open(index_path, encoding="utf8") as fh:
            index = json.load(fh)
    file = f"DS{info['code']}.json"
    with open(os.path.join(folder, file), "w", encoding="utf8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    entry = {"code": info["code"], "file": file, "class": cls, "dates": out["dates"], "issued": issued_iso,
             "duties": len(duties), "sha256": info["sha256"]}
    if also_on(info["code"]):
        entry["alsoOn"] = also_on(info["code"])
    index["sheets"] = sorted([e for e in index["sheets"] if e["code"] != info["code"]] + [entry], key=lambda e: e["code"])
    with open(index_path, "w", encoding="utf8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    return out


def write_stubs():
    """Sheets without duty cards (the older PDFs 1101, 6091, 7091): list their duty
    numbers, read from the timetable the sheet produced, so the app can show the
    number list; no times. A real card file written later replaces the stub."""
    folder = os.path.join(DATA, "duties")
    index_path = os.path.join(folder, "index.json")
    with open(index_path, encoding="utf8") as fh:
        index = json.load(fh)
    with open(os.path.join(DATA, "timetables", "index.json"), encoding="utf8") as fh:
        books = json.load(fh)["timetables"]
    have = {e["code"] for e in index["sheets"]}
    for b in books:
        if b.get("source") != "dutysheet" or b.get("dates"):
            continue
        code = re.sub(r"^DS", "", b["code"])
        if code in have:
            continue
        with open(os.path.join(DATA, "timetables", b["file"]), encoding="utf8") as fh:
            book = json.load(fh)
        ids = sorted({d[0] for t in book["trips"] for d in (t.get("duties") or [])})
        duties = [{"id": i, "group": GROUP_BY_DIGIT.get(i[4], "KSR")} for i in ids]
        out = {"schema": SCHEMA, "dutysheet": code, "class": b["day"], "dates": None, "issued": book.get("issued"),
               "parser": PARSER_VERSION, "cards": False, "duties": duties}
        file = f"DS{code}.json"
        with open(os.path.join(folder, file), "w", encoding="utf8") as fh:
            json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
            fh.write("\n")
        index["sheets"].append({"code": code, "file": file, "class": b["day"], "dates": None, "issued": book.get("issued"),
                                "duties": len(duties), "cards": False, **({"alsoOn": b["alsoOn"]} if b.get("alsoOn") else {})})
        print(f"DS{code}: {len(duties)} duty numbers only (no cards)")
    index["sheets"].sort(key=lambda e: e["code"])
    with open(index_path, "w", encoding="utf8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
        fh.write("\n")


def main(argv):
    from datetime import datetime

    if "--stubs" in argv:
        write_stubs()
        return 0

    dry = "--dry-run" in argv
    failed = False
    for path in [a for a in argv if not a.startswith("--")]:
        try:
            if path.lower().endswith(".pdf"):
                sys.path.insert(0, HERE)
                import parse_dutysheet

                meta, legs, pdf_stats = parse_dutysheet.parse_pdf(path)
                info, duties, stats = cards_from_pdf(meta, legs, pdf_stats)
                dated, issued = False, info["issued"]
            else:
                info, duties, stats = read_cards(path)
                dated = True
                issued = datetime.strptime(info["issuedText"], "%d %b %Y").date().isoformat() if info["issuedText"] else None
        except ValueError as e:
            print(f"{path}: {e}")
            failed = True
            continue
        problems = [w for w in stats["warnings"] if w.startswith("MISSING")]
        by = {}
        for d in duties:
            by[d["group"]] = by.get(d["group"], 0) + 1
        print(f"DS{info['code']} ({info['date']}): {len(duties)} cards {by}, {stats['legs']} legs, "
              f"{stats['meals']} meals, kinds {stats['kinds']}")
        spans = [w for w in stats["warnings"] if " min, book on/off" in w]
        if spans:
            print(f"  · {len(spans)} duties where work hours differ from book on/off minus meal (unlisted breaks), e.g. {spans[0]}")
        for w in stats["warnings"]:
            if w not in spans:
                print(f"  ! {w}")
        if problems or any("duplicate" in w for w in stats["warnings"]):
            failed = True
            continue
        write_duties(path, info, duties, issued, dated=dated, dry_run=dry)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
