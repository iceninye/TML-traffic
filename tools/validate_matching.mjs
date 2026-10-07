// Synthetic-feed check of the trip matcher (lib/tml-timetable.js).
//
//   node tools/validate_matching.mjs [DS1101|TML1100B|...] [HH:MM]
//   DEBUG="<scenario name>" OPENED=1 node tools/validate_matching.mjs   (list wrong matches)
//
// The live MTR feed cannot be replayed offline, so this builds the next-train
// boards a given set of train delays would produce (ttnt = ceil((arrival +
// delay - now) / 60), next four trains per station and direction), runs
// matchReadings() and the tracker the way the app does (a snapshot every
// 20.5 s, history carried over), and reports per scenario:
//   unmatched  readings no scheduled trip claimed (they go to the countdown
//              model, whose trains show "–" instead of a Run number)
//   wrong trip readings matched to a trip other than the train's own
//   "–"        countdown-model trains on screen, per snapshot
//
// Scenarios: the screenshot's few trains 80-130 s late, one train held 3, 5
// or 8 minutes with the trains behind it queueing, and a late line.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { estimateTrains } from "../lib/mtr-estimate.js"
import { createNetwork } from "../lib/mtr-network.js"
import { createModel } from "../lib/tml-model.js"
import { createTracker } from "../lib/tml-motion.js"
import { createTimetables, matchReadings, serviceDayStart } from "../lib/tml-timetable.js"

const here = dirname(fileURLToPath(import.meta.url))
const read = (p) => JSON.parse(readFileSync(join(here, "..", p), "utf8"))
const model = createModel(read("data/tml-timetable.json"), read("data/tml-track.json"))
const network = createNetwork(read("data/tml-network.json"))
const book = process.argv[2] ?? "DS1101"
const clock = process.argv[3] ?? "08:56"
const timetables = createTimetables({ [book]: read(`data/timetables/${book}.json`) }, model)
const bk = timetables.books[book]

// Midnight HKT on 2026-10-07 (a Wednesday); schedule times are seconds after it.
const DAY0 = Date.UTC(2026, 9, 6, 16, 0, 0)
const [h, m] = clock.split(":").map(Number)
const T0 = DAY0 + (h * 3600 + m * 60) * 1000
if (serviceDayStart(T0) !== DAY0) throw new Error("service day mismatch")
const secOf = (ms) => (ms - DAY0) / 1000

// Boards at time `ms`: for every station and direction, the next four trains.
function boards(ms, delayOf) {
  const tau = (ms - DAY0) / 1000
  const by = new Map()
  for (const trip of bk.trips) {
    if (!trip.passenger) continue
    const d = delayOf(trip)
    const firstServed = trip.stops.findIndex((s) => !s.empty)
    trip.stops.forEach((stop, k) => {
      // A terminus board does not list arrivals (the app drops them too).
      if (stop.empty || stop.code === trip.dest) return
      const arr = (k === firstServed ? stop.dep : stop.arr) + d
      if (arr < tau - 20 || arr > tau + 1500) return
      const key = `${stop.code}|${trip.dir}`
      const list = by.get(key) ?? []
      list.push({ station: stop.code, dir: trip.dir, dest: trip.dest, arr, trip })
      by.set(key, list)
    })
  }
  const out = []
  for (const list of by.values()) {
    list.sort((a, b) => a.arr - b.arr)
    for (const e of list.slice(0, 4)) {
      const ttnt = Math.max(0, Math.ceil((e.arr - tau) / 60))
      const dueAt = ms + ttnt * 60_000
      const obs = { line: "TML", station: e.station, dest: e.dest, plat: "1", ttnt, dueAt, observedAt: ms, delay: false, timeType: "A", viaRacecourse: false }
      out.push({ station: e.station, dir: e.dir, dest: e.dest, ttnt, dueAt, seenAt: ms, truth: e.trip.id, obs })
    }
  }
  return out
}

// Trips on the line at T0 (started, not finished) ordered by position.
const live = bk.trips.filter((t) => t.passenger && t.start - 600 <= secOf(T0) && t.end + 200 >= secOf(T0))
const byDir = (dir) => live.filter((t) => t.dir === dir).sort((a, b) => a.start - b.start)

// Each scenario runs 30 snapshots (about 10 minutes). Delays build up over
// the first RAMP_SNAPS snapshots, as an incident does, then hold; only the
// snapshots after the ramp are scored. "warm" is a page open since before the
// incident; "opened" is a page opened once the delays are already there.
// Both carry the history from one snapshot to the next as the app does.
const SNAPS = 30
const RAMP_SNAPS = 12
function scenario(name, delays) {
  const run = (opened) => {
    let history = new Map()
    let wrong = 0
    let left = 0
    let total = 0
    let dashes = 0
    let snaps = 0
    const tracker = createTracker(model)
    for (let i = 0; i < SNAPS; i += 1) {
      const ms = T0 + (i - RAMP_SNAPS) * 20_500
      const ramp = Math.min(1, (i + 1) / RAMP_SNAPS)
      const delayOf = (trip) => (delays.get(trip.id) ?? 0) * ramp
      const readings = boards(ms, delayOf)
      if (opened && i < RAMP_SNAPS) continue
      const res = matchReadings(bk, readings, ms, history)
      history = new Map([...res.trips].map(([id, e]) => [id, { readings: e.history, delay: e.delay }]))
      // As the app does (assets/app.js placeTrains): leftover readings go to
      // the countdown model; its trains carry no Run number.
      const fallback = res.leftover.length
        ? estimateTrains(network.routes_(), res.leftover.map((r) => r.obs), network.point.bind(network)).map((t) => ({ ...t, observedAtMs: t.observedAt, dueAtMs: t.dueAt }))
        : []
      const runs = tracker.update({ matched: res.trips, fallback, headwayOf: () => 180 }, ms)
      if (i < RAMP_SNAPS) continue
      snaps += 1
      dashes += runs.filter((r) => r.kind === "model").length
      total += readings.length
      left += res.leftover.length
      for (const [id, e] of res.trips) for (const r of e.readings) if (r.truth !== id) {
        wrong += 1
        if (process.env.DEBUG === name && opened === (process.env.OPENED === "1")) console.log(`  snap ${i} ${r.station} ${r.dir}>${r.dest} ttnt ${r.ttnt}: trip ${r.truth.split(":")[1]} (+${Math.round(delayOf({ id: r.truth }))}) taken as ${id.split(":")[1]} (est ${Math.round(e.delay)}) line ${Math.round(res.lineDelay)}`)
      }
    }
    return { total, left, wrong, dashes: dashes / Math.max(1, snaps) }
  }
  if (process.env.DEBUG) console.log([...delays].filter(([, v]) => v).map(([k, v]) => `${k.split(":")[1]}+${Math.round(v)}`).join(" "))
  const warm = run(false)
  const opened = run(true)
  const pct = (r) => `${((100 * r.left) / r.total).toFixed(1)}% unmatched, ${((100 * r.wrong) / r.total).toFixed(1)}% wrong trip, ${r.dashes.toFixed(1)} "–"`
  console.log(`${name.padEnd(42)} warm: ${pct(warm)} | opened: ${pct(opened)}`)
  return { warm, opened }
}

const results = {}
const set = (map, list, f) => list.forEach((t, i) => map.set(t.id, f(i)))

// Trains cannot overtake: a train delayed into the slot of the one behind
// delays that one too, keeping at least MIN_SEP seconds between them at
// every station both serve.
const MIN_SEP = 100
function physical(delays) {
  for (const dir of ["DOWN", "UP"]) {
    // Order by the time at a station both trips serve (short trips start
    // mid-line, so the first departure does not give the order).
    const trips = byDir(dir).sort((a, b) => {
      const at = new Map(a.stops.map((s) => [s.code, s.arr]))
      const common = b.stops.find((s) => at.has(s.code))
      return common ? at.get(common.code) - common.arr : a.start - b.start
    })
    for (let i = 1; i < trips.length; i += 1) {
      const a = trips[i - 1]
      const b = trips[i]
      const at = new Map(a.stops.map((s) => [s.code, s.arr]))
      let need = delays.get(b.id) ?? 0
      for (const s of b.stops) {
        if (!at.has(s.code)) continue
        need = Math.max(need, at.get(s.code) + (delays.get(a.id) ?? 0) + MIN_SEP - s.arr)
      }
      if (need > 0) delays.set(b.id, need)
    }
  }
  return delays
}

results.ontime = scenario("baseline: everything on time", new Map())
// 1. Delays like the screenshot: a few trains +80..+130 s.
{
  const d = new Map()
  set(d, byDir("DOWN"), (i) => (i % 5 === 0 ? 105 : 0))
  set(d, byDir("UP"), (i) => (i % 6 === 2 ? 130 : i % 6 === 4 ? 80 : 0))
  results.mild = scenario("mild: a few trains +80..130 s", physical(d))
}
// 2. One train held, the ones behind it queue up.
for (const dir of ["DOWN", "UP"]) {
  for (const sec of [180, 320, 480]) {
    const trips = byDir(dir)
    const d = new Map([[trips[Math.floor(trips.length / 2)].id, sec]])
    results[`held-${dir}-${sec}`] = scenario(`held ${dir} train +${sec} s, queue behind it`, physical(d))
  }
}
// 3. Whole line a little late, two trains much later.
{
  const d = new Map()
  for (const t of live) d.set(t.id, 90)
  const trips = byDir("UP")
  d.set(trips[3].id, 300)
  d.set(trips[9].id, 240)
  results.late = scenario("line +90 s, two UP trains +300/+240", physical(d))
}

const rows = Object.values(results)
const worst = Math.max(...rows.map((r) => Math.max(r.warm.left / r.warm.total, r.opened.left / r.opened.total)))
const wrongShare = Math.max(...rows.map((r) => Math.max(r.warm.wrong / r.warm.total, r.opened.wrong / r.opened.total)))
console.log(`worst unmatched share ${(100 * worst).toFixed(1)}%, worst wrong-trip share ${(100 * wrongShare).toFixed(1)}%`)
if (process.env.STRICT && (worst > 0.02 || wrongShare > 0.05)) process.exit(1)
