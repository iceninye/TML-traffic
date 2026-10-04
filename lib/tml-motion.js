// Animation layer for the timetable model.
//
// Each run carries the latest estimator observation for one train plus a
// fitted origin clock `t0` (when it left, or will leave, the start of its
// path). Its target position is a pure function of t0 and the clock
// (lib/tml-model.js), so between snapshots nothing needs extrapolating.
//
// Per snapshot:
//   1. fit t0 from every board reading chained to the train (model.fitOrigin)
//   2. blend it with the run's previous t0, so whole-minute rounding in the
//      feed averages out over successive snapshots instead of jerking the
//      train back and forth
//   3. fold the remaining gap in screen position into an offset that decays
//      over a few seconds, capped in speed; a train never runs backwards
//   4. work out how far behind the timetable the train is running
//
// Delay sources, the largest one wins:
//   run      t0 has drifted later since the train was first seen: it has lost
//            that much against timetable run + dwell times
//   feed     the board's own readings further down the line imply it will
//            lose time ahead (model.fitOrigin apiSlowSec)
//   headway  the gap to the train in front, same direction and origin, is
//            longer than the timetable headway for the period

import { directionOf } from "./tml-model.js"

// A new observation further than this from a run is a different train.
const MATCH_KM = 2.6
// A train the feed loses keeps running on its last observation this long.
const COAST_MS = 25_000
// Time constant of the soft correction, and a cap on how fast it may move a
// train beyond its modelled speed.
const SETTLE_SEC = 5
const MAX_CORRECT_KM_PER_SEC = 0.045
// Share of a new t0 fit taken per snapshot. A jump larger than T0_RESET_MS is
// taken whole (a real hold, or a different train) and restarts delay tracking.
const T0_BLEND = 0.4
const T0_RESET_MS = 180_000
// Headway gaps beyond this many headways are a missing train, not a late one.
const HEADWAY_SANE = 2.5

let nextId = 1

export function createTracker(model) {
  let runs = []
  let lastFrame = 0

  function update(trains, ms) {
    const incoming = []
    for (const raw of trains) {
      const fit = model.fitOrigin(raw, ms)
      const train = fit ? { ...raw, t0Ms: fit.t0 } : raw
      const pos = model.position(train, ms)
      if (!pos || pos.phase === "done") continue
      incoming.push({ train, fit, pos, dir: directionOf(train.path, model) })
    }

    const used = new Set()
    const next = []
    // Match leaders first so a following train cannot steal their slot.
    const ordered = [...runs].sort((a, b) => progressOf(b) - progressOf(a))
    for (const run of ordered) {
      let best = -1
      let bestGap = MATCH_KM
      incoming.forEach((item, index) => {
        if (used.has(index) || item.dir !== run.dir || item.train.dest !== run.train.dest) return
        const gap = Math.abs(item.pos.km - run.km)
        if (gap < bestGap) {
          best = index
          bestGap = gap
        }
      })
      if (best < 0) {
        if (ms - run.seenAt < COAST_MS) next.push(run)
        continue
      }
      used.add(best)
      const item = incoming[best]
      const fresh = item.fit?.t0
      let t0 = fresh
      let t0First = run.t0First
      if (Number.isFinite(fresh) && Number.isFinite(run.t0)) {
        const diff = fresh - run.t0
        if (Math.abs(diff) > T0_RESET_MS) t0First = fresh
        else t0 = run.t0 + T0_BLEND * diff
      }
      if (!Number.isFinite(t0First)) t0First = t0
      const train = Number.isFinite(t0) ? { ...item.train, t0Ms: t0 } : item.train
      const pos = model.position(train, ms)
      next.push({
        ...run,
        train,
        t0,
        t0First,
        apiSlowSec: item.fit?.apiSlowSec ?? 0,
        readings: item.fit?.readings ?? 0,
        offset: pos ? run.km - pos.km : 0,
        seenAt: ms,
        delay: item.train.delay,
      })
    }
    incoming.forEach((item, index) => {
      if (used.has(index)) return
      next.push({
        id: `t${nextId++}`,
        dir: item.dir,
        train: item.train,
        t0: item.fit?.t0,
        t0First: item.fit?.t0,
        apiSlowSec: item.fit?.apiSlowSec ?? 0,
        readings: item.fit?.readings ?? 0,
        km: item.pos.km,
        offset: 0,
        pos: item.pos,
        seenAt: ms,
        bornAt: ms,
        delay: item.train.delay,
      })
    })
    runs = withLateness(next)
    return runs
  }

  function withLateness(list) {
    // Headway: order trains of one direction and origin by t0.
    const groups = new Map()
    for (const run of list) {
      if (!Number.isFinite(run.t0)) continue
      const key = `${run.dir}|${run.train.path[0]}`
      const group = groups.get(key) ?? []
      group.push(run)
      groups.set(key, group)
    }
    const headwayLate = new Map()
    for (const group of groups.values()) {
      group.sort((a, b) => a.t0 - b.t0)
      for (let i = 1; i < group.length; i += 1) {
        const gap = (group[i].t0 - group[i - 1].t0) / 1000
        const band = model.period(group[i].t0).band
        if (!band) continue
        const excess = gap - band.headway
        if (excess > 0 && gap < band.headway * HEADWAY_SANE) headwayLate.set(group[i].id, excess)
      }
    }
    return list.map((run) => {
      const runLate = Number.isFinite(run.t0) && Number.isFinite(run.t0First) ? Math.max(0, (run.t0 - run.t0First) / 1000) : 0
      const parts = { run: runLate, feed: run.apiSlowSec ?? 0, headway: headwayLate.get(run.id) ?? 0 }
      let source = "run"
      for (const key of ["feed", "headway"]) if (parts[key] > parts[source]) source = key
      const lateSec = Math.round(parts[source] / 5) * 5
      return { ...run, late: { sec: lateSec, source, parts } }
    })
  }

  // Advance every run to `ms`. Returns the live list.
  function frame(ms) {
    const dt = lastFrame ? Math.min(5, Math.max(0, (ms - lastFrame) / 1000)) : 0
    lastFrame = ms
    const decay = dt > 0 ? Math.exp(-dt / SETTLE_SEC) : 1
    const out = []
    for (const run of runs) {
      const pos = model.position(run.train, ms)
      if (!pos || pos.phase === "done") continue
      const sign = run.dir === "DOWN" ? 1 : -1
      let offset = Math.abs(run.offset) < 0.002 ? 0 : run.offset * decay
      const limit = MAX_CORRECT_KM_PER_SEC * dt
      if (Math.abs(run.offset - offset) > limit) offset = run.offset - Math.sign(run.offset) * limit
      let km = pos.km + offset
      // Never backwards: if the estimate fell behind, hold until it catches up.
      if (dt > 0 && sign * (km - run.km) < 0) km = run.km
      km = Math.min(model.totalKm, Math.max(0, km))
      out.push({ ...run, offset, km, pos })
    }
    runs = out
    return runs
  }

  return {
    update,
    frame,
    clear() {
      runs = []
      lastFrame = 0
    },
    get runs() {
      return runs
    },
  }

  function progressOf(run) {
    return run.dir === "DOWN" ? run.km : model.totalKm - run.km
  }
}
