#!/usr/bin/env python3
"""Build data/duty-basic.json from the "Index" sheet of a duty workbook (.xlsx).

    python3 tools/index-to-basic.py path/to/workbook.xlsx

Index columns: duty, book-on time, book-on place, book-off time, book-off place,
working hours, remarks, DE/DL. Keeps book-on/off and hours only; remarks are not
copied. Status rows (RD, AL ... with place "-") are skipped. Needs openpyxl.
"""
import json
import sys
from datetime import time
from pathlib import Path

import openpyxl


def seconds(t):
    return t.hour * 3600 + t.minute * 60 + t.second


# 官表 Index 有幾個更份時數印錯（同 duty sheet 對唔上）。修正值放喺
# data/duty-hours-fixes.json，每次重新產生都會套用，唔會被覆蓋。
def load_fixes():
    fix = Path(__file__).resolve().parent.parent / "data" / "duty-hours-fixes.json"
    if not fix.exists():
        return {}
    return json.loads(fix.read_text(encoding="utf-8")).get("hours", {})


def main(path):
    sheet = openpyxl.load_workbook(path, data_only=True)["Index"]
    duties = {}
    for row in sheet.iter_rows(min_row=2, max_col=8, values_only=True):
        code, on, on_at, off, off_at, hours, _remarks, flag = row
        if not code or not isinstance(on, time) or not isinstance(off, time) or on_at == "-":
            continue
        start, end = seconds(on), seconds(off)
        if end <= start:
            end += 86400  # books off after midnight
        duties[str(code).strip().upper()] = [start, on_at or "", end, off_at or "", hours, flag or ""]
    fixes = load_fixes()
    for code, hours in fixes.items():
        if code in duties:
            duties[code][4] = hours
    out = {
        "note": "Book-on/off per duty from a duty workbook's Index sheet: [on, place, off, place, hours, DE/DL]. Written by tools/index-to-basic.py; hours fixed from data/duty-hours-fixes.json where the Index sheet is wrong.",
        "duties": duties,
    }
    target = Path(__file__).resolve().parent.parent / "data" / "duty-basic.json"
    target.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(duties)} duties -> {target} ({target.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
