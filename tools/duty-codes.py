#!/usr/bin/env python3
"""Build data/duty-codes.json from the "duty no. / Wk hr / Book on / Book off" table.

    python3 tools/duty-codes.py path/to/duty-no.tsv

The table is pasted from Excel (tab separated). Columns: code, working hours,
book-on, book-off; NIL means no fixed time (leave, training and spare codes).
A code listed twice keeps the LAST row (the lower part of the table is the newer
one). Times are seconds from 00:00; a book-off at or before the book-on is the next
day (+86400), the same as data/duty-basic.json. Output: { codes: { CODE: [hours, on, off] } }
with on/off null for NIL. Only duty codes, no staff data.
"""
import json
import re
import sys
from pathlib import Path


def seconds(text):
    if text.strip().upper() in ("", "NIL"):
        return None
    h, m, *rest = (int(x) for x in text.split(":"))
    return h * 3600 + m * 60 + (rest[0] if rest else 0)


def parse(text):
    codes = {}
    started = False
    for line in text.splitlines():
        cells = [c.strip() for c in line.split("\t")]
        if not started:
            started = len(cells) >= 4 and cells[0].lower().startswith("duty no")
            continue
        if len(cells) < 4 or not re.fullmatch(r"[A-Za-z0-9/]+", cells[0]):
            continue
        hours = float(cells[1])
        on, off = seconds(cells[2]), seconds(cells[3])
        if on is not None and off is not None and off <= on:
            off += 86400
        codes[cells[0].upper()] = [hours, on, off]
    return codes


if __name__ == "__main__":
    codes = parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = {
        "note": "Hours and book-on/off of leave, training, spare and special codes, from the duty no. table (Ice, 2026-10-27). null = NIL (no fixed time). Written by tools/duty-codes.py; a code listed twice keeps the last row. tml-roster fills a missing hour or time from here; pasted roster data wins.",
        "codes": dict(sorted(codes.items())),
    }
    path = Path(__file__).resolve().parent.parent / "data" / "duty-codes.json"
    lines = [f"{json.dumps(k)}:{json.dumps(v, separators=(',', ':'))}" for k, v in out["codes"].items()]
    path.write_text('{"note":' + json.dumps(out["note"], ensure_ascii=False) + ',"codes":{\n' + ",\n".join(lines) + "\n}}\n", encoding="utf-8")
    print(f"{len(codes)} codes -> {path}")
