// Synthetic-feed check of where trains are drawn (lib/tml-timetable.js
// delay estimate + lib/tml-motion.js display clock), against where they are.
//
//   node tools/validate_position.mjs [DS1101|TML1100B|...] [HH:MM]
//   DEBUG="<scenario name>" node tools/validate_position.mjs   (trace the held train)
//
// validate_matching.mjs gives each train one delay that ramps up, the same at
// every station. A train held at a platform is different: it stands still,
// its delay grows a second per second, the stations ahead count down to it
// as if it were leaving now, its own platform keeps showing 0, and the trains
// behind it wait at the platform before. This simulates that physically:
// every train keeps its scheduled run and dwell times, may not leave a
// platform before its scheduled time plus its base delay, may not enter a
// platform until SEP s after the train in front left it, and one train may be
// held at one station or run a few sections slowly. Boards: ttnt =
// ceil((scheduled arrival + current lateness - now) / 60), 0 while the train
// is at the platform and for LAG s after it leaves, next four per station
// and direction.
//
// The app's pipeline runs on that (a snapshot every 20.5 s, history carried
// over, the display clock stepped every 0.25 s) and each drawn Run is
// compared with its train once a second. Reported per scenario, for the
// affected trains (the held one and the ones queued behind it) and for the
// rest separately:
//   ahead p90 / max   how far the dot runs ahead of the train (m)
//   >300 m ahead      share of seconds the dot is a platform length or more
//                     ahead of the train
//   passed            share of seconds the dot has left a platform the train
//                     has not reached yet (the 18:40 report, docs/ALGORITHM.md
//                     §3h)
//   behind p90        how far the dot trails the train (m)

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createModel } from "../lib/tml-model.js"
import { createTracker } from "../lib/tml-motion.js"
import { createTimetables, matchReadings, serviceDayStart, tripState } from "../lib/tml-timetable.js"

const here = dirname(fileURLToPath(import.meta.url))
const read = (p) => JSON.parse(readFileSync(join(here, "..", p), "utf8"))
const model = createModel(read("data/tml-timetable.json"), read("data/tml-track.json"))
const book = process.argv[2] ?? "DS1101"
const clock = process.argv[3] ?? "18:30"
const bk = createTimetables({ [book]: read(`data/timetables/${book}.json`) }, model).books[book]

// Midnight HKT on 2026-10-07 (a Wednesday); schedule times are seconds after it.
const DAY0 = Date.UTC(2026, 9, 6, 16, 0, 0)
const [h, m] = clock.split(":").map(Number)
const T0 = DAY0 + (h * 3600 + m * 60) * 1000
if (serviceDayStart(T0) !== DAY0) throw new Error("service day mismatch")
const t0 = (T0 - DAY0) / 1000
const SNAP_SEC = 20.5
const RUN_SEC = 900
const SEP = 40
const TERMINI = new Set(["TUM", "WKS"])

const live = bk.trips.filter((t) => t.passenger && t.start - 900 <= t0 + RUN_SEC && t.end + 300 >= t0)
// Order trips in a direction by their time at a station both serve.
function ordered(dir) {
  return live.filter((t) => t.dir === dir).sort((a, b) => {
    const at = new Map(a.stops.map((s) => [s.code, s.arr]))
    const common = b.stops.find((s) => at.has(s.code))
    return common ? at.get(common.code) - common.arr : a.start - b.start
  })
}

// Real arrival/departure per stop. base: trip id -> delay (s); hold:
// { id, code, sec } holds a train at a platform; slow: { id, code, hops,
// factor } runs its next `hops` sections from that station `factor` times
// slower.
function simulate(base, hold, slow) {
  const real = new Map()
  for (const dir of ["DOWN", "UP"]) {
    const trips = ordered(dir)
    trips.forEach((trip, i) => {
      const front = i > 0 ? real.get(trips[i - 1].id) : null
      const d0 = base.get(trip.id) ?? 0
      const from = slow?.id === trip.id ? trip.stops.findIndex((x) => x.code === slow.code) : -1
      const slowBy = (k) => (from >= 0 && k >= from && k < from + slow.hops ? slow.factor : 1)
      const arr = []
      const dep = []
      trip.stops.forEach((s, k) => {
        let a = k === 0 ? s.arr + d0 : dep[k - 1] + (s.arr - trip.stops[k - 1].dep) * slowBy(k - 1)
        // Wait outside (at the platform before) until the train in front
        // left. The termini have two platforms each.
        const fd = front?.depOf.get(s.code)
        if (k > 0 && !TERMINI.has(s.code) && fd != null && a < fd + SEP) {
          const wait = fd + SEP - a
          dep[k - 1] += wait
          a += wait
        }
        arr.push(a)
        let d = Math.max(a + (s.dep - s.arr), s.dep + d0)
        if (hold && hold.id === trip.id && hold.code === s.code) d = Math.max(d, s.dep + d0 + hold.sec)
        dep.push(d)
      })
      real.set(trip.id, { trip, arr, dep, depOf: new Map(trip.stops.map((s, k) => [s.code, dep[k]])) })
    })
  }
  return real
}

// Schedule time (tau) a train is at, at real time t: where its timetable
// says a train is, which is how the app draws it.
function tauOf(r, t) {
  const { trip, arr, dep } = r
  const stops = trip.stops
  if (t < arr[0]) return stops[0].arr - (arr[0] - t)
  for (let k = 0; k < stops.length; k += 1) {
    if (t < arr[k]) {
      // Running from k-1: through the scheduled run, at its real pace.
      const run = stops[k].arr - stops[k - 1].dep
      return stops[k - 1].dep + ((t - dep[k - 1]) * run) / (arr[k] - dep[k - 1])
    }
    if (t <= dep[k]) return Math.min(stops[k].dep, stops[k].arr + (t - arr[k]))
  }
  return stops[stops.length - 1].arr + (t - arr[stops.length - 1])
}

function boards(real, t, lag) {
  const by = new Map()
  for (const r of real.values()) {
    const { trip, arr, dep } = r
    const tau = tauOf(r, t)
    const late = t - tau
    const firstServed = trip.stops.findIndex((s) => !s.empty)
    trip.stops.forEach((s, k) => {
      if (s.empty || s.code === trip.dest) return
      let ttnt
      if (t >= arr[k] && t <= dep[k] + lag && k !== firstServed) ttnt = 0
      else if (t > dep[k]) return
      else {
        const board = k === firstServed ? s.dep : s.arr
        const due = board + late
        if (due > t + 1500) return
        ttnt = Math.max(0, Math.ceil((due - t) / 60))
      }
      const key = `${s.code}|${trip.dir}`
      const list = by.get(key) ?? []
      list.push({ station: s.code, dir: trip.dir, dest: trip.dest, ttnt, order: k === firstServed ? dep[k] : arr[k], truth: trip.id })
      by.set(key, list)
    })
  }
  const out = []
  const ms = DAY0 + t * 1000
  for (const list of by.values()) {
    list.sort((a, b) => a.order - b.order)
    for (const e of list.slice(0, 4)) out.push({ station: e.station, dir: e.dir, dest: e.dest, ttnt: e.ttnt, dueAt: ms + e.ttnt * 60_000, seenAt: ms, truth: e.truth })
  }
  return out
}

const pct = (xs, p) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

function scenario(name, base, hold, lag = 20, slow = null) {
  const real = simulate(base, hold, slow)
  // Affected: delayed beyond its base anywhere (the held train, the queue).
  const affected = new Set()
  for (const r of real.values()) {
    const d0 = base.get(r.trip.id) ?? 0
    if (r.dep.some((d, k) => d - r.trip.stops[k].dep - d0 > 15)) affected.add(r.trip.id)
  }
  const tracker = createTracker(model)
  let history = new Map()
  const errs = { hit: [], rest: [] }
  let nextSnap = 0
  for (let s = 0; s <= RUN_SEC; s += 0.25) {
    const t = t0 + s
    const ms = DAY0 + t * 1000
    if (s >= nextSnap) {
      nextSnap += SNAP_SEC
      const readings = boards(real, t, lag)
      const res = matchReadings(bk, readings, ms, history)
      history = new Map([...res.trips].map(([id, e]) => [id, { readings: e.history, delay: e.delay }]))
      tracker.update({ matched: res.trips, fallback: [], headwayOf: () => 180 }, ms)
      if (process.env.DEBUG === name && hold) {
        const e = res.trips.get(hold.id)
        const r = real.get(hold.id)
        const own = readings.filter((x) => x.truth === hold.id).map((x) => `${x.station}:${x.ttnt}`).join(" ")
        const run = tracker.runs.find((x) => x.id === hold.id)
        console.log(`  +${s.toFixed(1).padStart(5)}s true late ${Math.round(t - tauOf(r, t)).toString().padStart(4)}  est ${e ? Math.round(e.delay).toString().padStart(4) : "   -"}  disp ${run ? Math.round(run.delayDisp).toString().padStart(4) : "   -"}  boards ${own}`)
      }
    }
    const runs = tracker.frame(ms)
    if (s < 60 || s % 1 !== 0) continue
    for (const run of runs) {
      if (run.kind !== "sched") continue
      const r = real.get(run.id)
      if (!r) continue
      const truth = tripState(r.trip, tauOf(r, t), model)
      if (truth.phase === "before" || truth.phase === "done" || truth.phase === "arrived") continue
      const ahead = (run.pos.km - truth.km) * (r.trip.dir === "DOWN" ? 1 : -1) * 1000
      // The dot has left a platform the train has not reached yet (the
      // 18:40 report: drawn past To Kwa Wan while its board still counts
      // down to the train).
      const tauDot = t - run.delayDisp
      const tauTrue = tauOf(r, t)
      const passed = r.trip.stops.some((st, k) => k > 0 && k < r.trip.stops.length - 1 && tauDot > st.dep && tauTrue < st.arr)
      ;(affected.has(run.id) ? errs.hit : errs.rest).push({ ahead, passed })
    }
  }
  const fmt = (list) => {
    if (!list.length) return "n/a"
    const xs = list.map((x) => x.ahead)
    const ahead = xs.map((x) => Math.max(0, x))
    const behind = xs.map((x) => Math.max(0, -x))
    const share = (n) => `${((100 * n) / xs.length).toFixed(1).padStart(4)}%`
    return `ahead p90 ${pct(ahead, 0.9).toFixed(0).padStart(4)} max ${Math.max(...ahead).toFixed(0).padStart(4)}, >300 m ${share(xs.filter((x) => x > 300).length)}, passed ${share(list.filter((x) => x.passed).length)}, behind p90 ${pct(behind, 0.9).toFixed(0).padStart(4)}`
  }
  console.log(`${name.padEnd(30)} affected: ${fmt(errs.hit)} | others: ${fmt(errs.rest)}`)
  return errs
}

const none = new Map()
scenario("on time", none, null)
scenario("on time, board lag 40 s", none, null, 40)
{
  const d = new Map(live.map((t) => [t.id, 90]))
  scenario("whole line +90 s", d, null)
}
// The train two places into the DOWN queue at the start, held at a station
// it reaches a few minutes in (Ho Man Tin, as in the 18:40 report).
const down = ordered("DOWN").filter((t) => t.stops.some((s) => s.code === "HOM"))
const target = down.find((t) => t.stops.find((s) => s.code === "HOM").dep > t0 + 150)
for (const sec of [45, 90, 150, 240]) {
  scenario(`held HOM ${sec} s, queue behind`, none, { id: target.id, code: "HOM", sec })
}
for (const sec of [90, 240]) {
  scenario(`held HOM ${sec} s, board lag 40 s`, none, { id: target.id, code: "HOM", sec }, 40)
}
scenario("held TKW 120 s, queue behind", none, { id: target.id, code: "TKW", sec: 120 })
{
  const up = ordered("UP").filter((t) => t.stops.some((s) => s.code === "NAC"))
  const u = up.find((t) => t.stops.find((s) => s.code === "NAC").dep > t0 + 150)
  scenario("held UP NAC 150 s, queue behind", none, { id: u.id, code: "NAC", sec: 150 })
}
scenario("slow DOWN: 4 hops at 1.5x", none, null, 20, { id: target.id, code: "AUS", hops: 4, factor: 1.5 })
