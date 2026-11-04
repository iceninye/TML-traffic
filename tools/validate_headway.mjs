// Synthetic check of the "headway off" signal (assets/app.js): with every
// train on time, the headway measured from the boards should agree with the
// timetable's planned headway, or the page counts a false signal towards
// switching to countdown mode (特別車務), where Run numbers are hidden.
//
//   node tools/validate_headway.mjs
//
// For each timetable and every 5 minutes of the service day it builds the
// next-train boards (next four trains per station and direction, ttnt =
// ceil), then reports how often |measured - planned| / planned > 0.3 with
// planned from the headway bands (headwayAt, up to v0.8.25) and from the
// scheduled trains around now (scheduledHeadway, v0.8.26).

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createModel } from "../lib/tml-model.js"
import { createTimetables, headwayAt, measuredHeadways, scheduledHeadway } from "../lib/tml-timetable.js"

const here = dirname(fileURLToPath(import.meta.url))
const read = (p) => JSON.parse(readFileSync(join(here, "..", p), "utf8"))
const model = createModel(read("data/tml-timetable.json"), read("data/tml-track.json"))
const BOOKS = ["DS1101", "DS6091", "DS7091", "TML1100B", "TML6090A", "TML7090"]
const OFF = 0.3

function boards(bk, tau) {
  const by = new Map()
  for (const [key, list] of bk.events) {
    const [station, dir] = key.split("|")
    const k = `${station}|${dir}`
    for (const e of list) if (e.arr >= tau - 20 && e.arr <= tau + 1500) by.set(k, [...(by.get(k) ?? []), e.arr])
  }
  const out = []
  for (const [k, list] of by) {
    const [station, dir] = k.split("|")
    list.sort((a, b) => a - b)
    for (const arr of list.slice(0, 4)) {
      const ttnt = Math.max(0, Math.ceil((arr - tau) / 60))
      out.push({ station, dir, ttnt, dueAt: (tau + ttnt * 60) * 1000 })
    }
  }
  return out
}

let worst = 0
for (const code of BOOKS) {
  const bk = createTimetables({ [code]: read(`data/timetables/${code}.json`) }, model).books[code]
  let n = 0
  let bandOff = 0
  let schedOff = 0
  const bad = []
  for (let tau = 6 * 3600; tau <= 23 * 3600; tau += 300) {
    const measured = measuredHeadways(boards(bk, tau))
    for (const dir of ["UP", "DOWN"]) {
      const m = measured[dir]
      const band = headwayAt(bk, dir, tau)
      const sched = scheduledHeadway(bk, dir, tau)
      if (!m || !band || !sched) continue
      n += 1
      if (Math.abs(m - band) / band > OFF) bandOff += 1
      if (Math.abs(m - sched) / sched > OFF) {
        schedOff += 1
        bad.push(`${dir} ${String(Math.floor(tau / 3600)).padStart(2, "0")}:${String((tau / 60) % 60).padStart(2, "0")}`)
      }
    }
  }
  const pct = (x) => `${((100 * x) / n).toFixed(1)}%`
  worst = Math.max(worst, schedOff / n)
  console.log(`${code.padEnd(9)} false "headway off": bands ${pct(bandOff).padStart(6)}, scheduled ${pct(schedOff).padStart(6)}  (${n} checks)${bad.length ? `  ${bad.slice(0, 6).join(", ")}` : ""}`)
}
if (worst > 0.05) {
  console.log(`FAIL: scheduled headway disagrees with on-time boards in ${(100 * worst).toFixed(1)}% of checks`)
  process.exit(1)
}
console.log("validate_headway OK")
