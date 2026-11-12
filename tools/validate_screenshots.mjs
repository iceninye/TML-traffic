// Two cases rebuilt from the board numbers of screenshots taken at 2026-11-12
// 11:32 (Duty Sheet 1101, off-peak, headway 6 min), fed to matchReadings with
// no history. Each is [up (to Tuen Mun), down (to Wu Kai Sha / DIH...)] per
// station, minutes as the boards read.
//   node tools/validate_screenshots.mjs
// 1. Heng On 2 and Ma On Shan 3 are ONE train (Run 3). Their line times are
//    81 s apart, so orderPriors used to split them and hand the Ma On Shan
//    reading to Run 2, which had already finished, at +349 s ("Run 2 +345s").
// 2. Run 7's near readings (Hung Hom 3, Ho Man Tin 4) read +100..170 s, its
//    far ones (Diamond Hill 11) about 0 s (the board forecast assumes the
//    train recovers). The Diamond Hill reading was left over and drawn as a
//    "–" train beside Run 7.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createModel } from "../lib/tml-model.js"
import { createTimetables, matchReadings } from "../lib/tml-timetable.js"

const here = dirname(fileURLToPath(import.meta.url))
const read = (p) => JSON.parse(readFileSync(join(here, "..", p), "utf8"))
const model = createModel(read("data/tml-timetable.json"), read("data/tml-track.json"))
const book = createTimetables({ DS1101: read("data/timetables/DS1101.json") }, model).books.DS1101
const DAY0 = Date.UTC(2026, 10, 11, 16, 0, 0)
const dest = { UP: "TUM", DOWN: "WKS" }

function run(sec, boards) {
  const ms = DAY0 + (11 * 3600 + 32 * 60 + sec) * 1000
  const readings = []
  for (const [station, [up, down]] of Object.entries(boards)) {
    for (const [dir, list] of [["UP", up], ["DOWN", down]]) {
      for (const ttnt of list) readings.push({ station, dir, dest: dest[dir], ttnt, dueAt: ms + ttnt * 60_000, seenAt: ms })
    }
  }
  return matchReadings(book, readings, ms, new Map())
}
const find = (res, dir, runNo) => [...res.trips.values()].find((e) => e.trip.dir === dir && e.trip.run === runNo)
const stations = (e) => (e?.readings ?? []).map((r) => r.station)

let failed = 0
const check = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`)
  if (!ok) failed += 1
}

const east = run(27, {
  STW: [[1, 7, 14], [4, 10, 16]], CIO: [[5, 12, 19], [6, 12, 18]], SHM: [[3, 11, 18], [2, 8, 14]],
  TSH: [[7, 14, 21], [5, 11, 17]], HEO: [[5, 12, 19], [2, 7, 13]], MOS: [[3, 10, 17], [3, 9, 15]], WKS: [[1, 8, 15], []],
})
const r3 = find(east, "DOWN", 3)
check(!find(east, "DOWN", 2), "finished Run 2 is not revived (was +349 s)")
check(stations(r3).includes("HEO") && stations(r3).includes("MOS"), "Heng On 2 and Ma On Shan 3 both belong to Run 3")
check(r3 && Math.abs(r3.delay) < 120, `Run 3 delay is small (${Math.round(r3?.delay ?? NaN)} s)`)

const kowloon = run(5, {
  MEF: [[4, 10, 16], [1, 7, 13]], NAC: [[1, 7, 13], [4, 10, 16]], AUS: [[5, 11, 17], [1, 7, 13]], ETS: [[2, 7, 13], [4, 10, 16]],
  HUH: [[5, 11, 17], [3, 7, 13]], HOM: [[3, 9, 15], [4, 9, 15]], TKW: [[6, 12, 18], [6, 11, 17]], SUW: [[4, 10, 16], [2, 7, 13]],
  KAT: [[2, 8, 14], [3, 9, 15]], DIH: [[6, 12, 19], [6, 11, 17]],
})
check(stations(find(kowloon, "DOWN", 7)).includes("DIH"), "Run 7 keeps its Diamond Hill reading")
check(kowloon.leftover.length === 0, `no leftover readings (${kowloon.leftover.map((r) => r.station + r.ttnt).join(",") || "none"})`)

process.exit(failed ? 1 : 0)
