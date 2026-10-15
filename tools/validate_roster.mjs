// Checks lib/tml-roster.js on a made-up roster (a real one never goes in the repo):
//   node tools/validate_roster.mjs
import { classify, cleanRoster, dayEntry, mondayOf, newRoster, parseRoster, rowLabelFor, setOverride, weekDates, weekdayIndex } from "../lib/tml-roster.js"

let failed = 0
const check = (ok, what) => {
  if (!ok) failed += 1
  console.log(`${ok ? "✓" : "✗"} ${what}`)
}

// Three weekly rows labelled 7, 8, 9 (so the cycle wraps 9 -> 7).
const csv = [
  ",Mon,Tue,Wed,Thu,Fri,Sat,Sun",
  "7,1101101,1101102,RD,1101104,1101105,6091101,RD",
  "8,AL,AL,AL,SH,SH,RD,RD",
  "9,HSP1,KSP3,1101103,RD,HC,RD,7091102",
].join("\n")
const parsed = parseRoster(csv)
check(parsed.rows.length === 3 && parsed.issues.length === 0, "a header line is skipped and 3 rows read")
check(parsed.numbers.join() === "7,8,9", "the row labels are kept")
check(parseRoster(csv.replace(/,/g, "\t")).rows.length === 3, "tab separated rows read too")
check(parseRoster("1101101 RD RD 1101104 1101105 RD RD").rows.length === 1, "white space separated rows without a label read too")
check(parseRoster("1,1101101,RD").issues.length === 1, "a short line is reported, not guessed")
check(parseRoster("1,1101101,RD,RD,RD,RD,RD,??").issues.length === 1, "a cell that is no duty or status is reported")

const roster = newRoster(parsed, { row: 8, monday: "2026-10-12" })
check(weekdayIndex("2026-10-12") === 0 && weekdayIndex("2026-10-18") === 6, "12 Oct 2026 is a Monday and 18 Oct a Sunday")
check(mondayOf("2026-10-18") === "2026-10-12" && mondayOf("2026-10-19") === "2026-10-19", "a week runs Monday to Sunday")
check(weekDates("2026-10-12").join() === "2026-10-12,2026-10-13,2026-10-14,2026-10-15,2026-10-16,2026-10-17,2026-10-18", "weekDates lists 7 days")
check(rowLabelFor(roster, "2026-10-12") === 8, "the anchor week is the anchor row")
check(rowLabelFor(roster, "2026-10-19") === 9, "the next week is the next row")
check(rowLabelFor(roster, "2026-10-26") === 7, "after the last row it goes back to the first")
check(rowLabelFor(roster, "2026-10-05") === 7, "the week before goes back one row, wrapping the other way")
check(rowLabelFor(roster, "2027-03-01") === rowLabelFor(roster, "2026-10-12") || rowLabelFor(roster, "2027-03-01") !== null, "any later date still lands on a row")
check(rowLabelFor(roster, "2026-11-02") === rowLabelFor(roster, "2026-10-12"), "a full cycle (3 weeks) later is the same row")
check(dayEntry(roster, "2026-10-15").code === "SH" && dayEntry(roster, "2026-10-15").source === "cycle", "Thursday of the anchor week is SH from the cycle")
check(dayEntry(roster, "2026-10-19").code === "HSP1", "Monday of the next week is HSP1")
check(dayEntry(roster, "2026-10-25").code === "7091102" && dayEntry(roster, "2026-10-25").row === 9, "Sunday of the next week is 7091102 (row 9)")

const changed = setOverride(roster, "2026-10-24", "8022131")
check(dayEntry(changed, "2026-10-24").code === "8022131" && dayEntry(changed, "2026-10-24").source === "override" && dayEntry(changed, "2026-10-24").defaultCode === "RD",
  "an override replaces the cycle's cell and remembers the default")
check(dayEntry(roster, "2026-10-24").code === "RD", "setOverride does not change the roster it was given")
check(Object.keys(setOverride(changed, "2026-10-24", "RD").overrides).length === 0, "setting a day back to the cycle's cell clears the override")
check(Object.keys(setOverride(changed, "2026-10-24", null).overrides).length === 0, "null clears the override")
check(dayEntry(null, "2026-10-12") === null && dayEntry(roster, "x") === null, "no roster or a bad date gives null")
check(dayEntry({ ...roster, anchor: { row: 99, monday: "2026-10-12" } }, "2026-10-12") === null, "an anchor row that does not exist gives null")

check(classify("1101179").sheet === "1101" && classify("8022131").kind === "duty", "a 7-digit number is a duty and its sheet is the first four digits")
check(classify("rd").kind === "status" && classify("KSP3").kind === "spare" && classify("HSP1").kind === "spare" && classify("E43").kind === "other", "RD is a status, KSP/HSP are spare, anything else is other")

const round = cleanRoster(JSON.parse(JSON.stringify(changed)))
check(round && dayEntry(round, "2026-10-24").code === "8022131", "a saved roster survives a JSON round trip")
check(cleanRoster({ v: 1, rows: [["1", "2"]], anchor: {} }) === null, "a broken roster is refused")
check(cleanRoster({ ...roster, anchor: { row: 7, monday: "2026-10-14" } }).anchor.monday === "2026-10-12", "an anchor date in mid-week moves to its Monday")

process.exit(failed ? 1 : 0)
