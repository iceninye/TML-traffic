// Replays board readings copied from the live page (hidden panel,
// 「複製站牌數據」) through matchReadings and checks the trains that were
// wrong on the day now get the right trip. Each fixture in tools/fixtures/
// named boards-*.json holds { book, snaps, expect }.
//   node tools/validate_replay.mjs
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createModel } from "../lib/tml-model.js"
import { createTimetables, matchReadings } from "../lib/tml-timetable.js"

const here = dirname(fileURLToPath(import.meta.url))
const read = (p) => JSON.parse(readFileSync(join(here, "..", p), "utf8"))
const model = createModel(read("data/tml-timetable.json"), read("data/tml-track.json"))
// Up-line trains run towards Tuen Mun (or the Mei Foo short workings).
const dirOf = (dest) => (dest === "TUM" || dest === "MEF" ? "UP" : "DOWN")

let failed = 0
for (const name of readdirSync(join(here, "fixtures")).filter((f) => /^boards-.*\.json$/.test(f)).sort()) {
  const fx = read(`tools/fixtures/${name}`)
  const book = createTimetables({ [fx.book]: read(`data/timetables/${fx.book}.json`) }, model).books[fx.book]
  let history = new Map()
  const results = fx.snaps.map((s) => {
    const ms = Date.parse(s.at)
    const readings = s.readings.map(([station, dest, ttnt, sec]) => ({ station, dir: dirOf(dest), dest, ttnt, dueAt: ms + sec * 1000, seenAt: ms }))
    const res = matchReadings(book, readings, ms, history)
    history = new Map([...res.trips].map(([id, e]) => [id, { readings: e.history, delay: e.delay }]))
    return res
  })
  for (const ex of fx.expect) {
    const res = results[ex.snap]
    const errs = []
    if (ex.leftover !== undefined && res.leftover.length > ex.leftover) errs.push(`${res.leftover.length} readings unmatched: ${res.leftover.map((r) => `${r.station}>${r.dest} ${r.ttnt}`).join(" ")}`)
    const hit = [...res.trips.values()].find((e) => e.trip.run === ex.run && e.trip.dir === ex.dir)
    if (!hit) errs.push(`Run ${ex.run} ${ex.dir} not matched`)
    else {
      const got = new Set(hit.readings.map((r) => `${r.station}|${r.ttnt}`))
      const miss = ex.has.filter((k) => !got.has(k))
      if (miss.length) errs.push(`Run ${ex.run} lacks ${miss.join(", ")} (has ${[...got].join(", ")})`)
      if (Math.abs(hit.delay) > ex.maxDelay) errs.push(`Run ${ex.run} delay ${Math.round(hit.delay)} s`)
    }
    console.log(`${errs.length ? "FAIL" : "ok  "} ${name} snap ${ex.snap} Run ${ex.run} ${ex.dir}${errs.length ? `\n     ${errs.join("\n     ")}` : ""}`)
    failed += errs.length ? 1 : 0
  }
}
if (failed) {
  console.error(`validate_replay: ${failed} failed`)
  process.exit(1)
}
console.log("validate_replay OK")
