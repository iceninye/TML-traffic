// Train tracker and animation clock.
//
// Two kinds of run:
//
//   sched  a scheduled trip matched to the live boards (lib/tml-timetable.js).
//          Identity is the trip itself. Position is the trip's timetable,
//          shifted by its delay.
//   model  readings that match no scheduled trip (special service, heavy
//          disruption). Placed by the running-time model from the chain of
//          readings (lib/tml-model.js), as in v0.3.
//
// Both are driven by a clock offset (a delay, or a fitted departure time)
// rather than a distance. When a snapshot moves the estimate, the displayed
// offset follows at no more than half a second per second: the train runs
// between 0.5x and 1.5x its scheduled pace until it is back on the estimate.
// It never stops mid-section, jumps, or runs backwards; at a station it just
// dwells a little longer or shorter.

import { directionOf } from "./tml-model.js"
import { serviceDayStart, tripState, tripUpcoming } from "./tml-timetable.js"

// How fast the displayed clock may close on the estimate (s per s).
const CATCH_UP = 0.5
// A gap this large is a re-match, not drift: jump straight to it.
const SNAP_SEC = 150
// Keep a trip this long after its last board reading. Trains on their last
// hop vanish from the boards (a terminus does not list arrivals), so those
// are kept until they arrive.
const SEEN_MS = 45_000
// Two trains on one track cannot be closer than this while running; a pair
// that close is one train counted twice (a re-matched trip, or a fallback
// chain built from a reading the matcher did not place).
const SAME_TRAIN_KM = 0.85
// Show a train at its first platform only this close to departure: a
// terminus holds the train through its layover (a few minutes); a depot
// pull-out (KSR, TWW, TAW ...) reaches the platform shortly before leaving.
const SHOW_WAIT_TERMINUS_SEC = 300
const SHOW_WAIT_SEC = 120
const TERMINI = new Set(["TUM", "WKS"])
// Fallback runs (as v0.3).
const MATCH_KM = 2.6
const COAST_MS = 25_000
const T0_RESET_MS = 180_000
const HEADWAY_SANE = 2.5

let nextId = 1

export function createTracker(model) {
  let runs = []
  let lastFrame = 0

  // matched: Map tripId -> { trip, delay, readings, history, support }
  // fallback: estimator trains built from readings no trip claimed
  function update({ matched, fallback, book, headwayOf }, ms) {
    const next = []
    const byId = new Map(runs.map((r) => [r.id, r]))

    const dayStart = serviceDayStart(ms)
    const tau = (ms - dayStart) / 1000
    const placed = []
    for (const [id, entry] of matched) {
      const old = byId.get(id)
      const now = tripState(entry.trip, tau - entry.delay, model)
      if (now.phase === "run" || now.phase === "dwell") placed.push({ dir: entry.trip.dir, km: now.km })
      const reading = entry.readings[0]
      next.push({
        kind: "sched",
        id,
        trip: entry.trip,
        dir: entry.trip.dir,
        dest: entry.trip.dest,
        plat: reading?.plat ?? old?.plat ?? "",
        delay: entry.readings.some((r) => r.delay),
        delayEst: entry.delay,
        delayDisp: old?.delayDisp ?? entry.delay,
        support: entry.support,
        readings: entry.history.length,
        seenAt: ms,
        km: old?.km,
        pos: old?.pos,
        late: lateOfSched(entry.delay),
      })
      byId.delete(id)
    }
    // Trips no board mentions this time: keep while recently seen, or while
    // on the final approach to their terminus.
    for (const old of byId.values()) {
      if (old.kind !== "sched") continue
      const finalHop = old.pos && old.pos.to === old.trip.dest
      if (!(ms - old.seenAt <= SEEN_MS || finalHop)) continue
      // Its train has been matched to a neighbouring trip: drop the copy.
      if (old.km != null && placed.some((p) => p.dir === old.dir && Math.abs(p.km - old.km) < SAME_TRAIN_KM)) continue
      next.push(old)
      if (old.km != null) placed.push({ dir: old.dir, km: old.km })
    }

    // Fallback runs, skipping any that duplicate a scheduled one.
    const incoming = []
    for (const raw of fallback) {
      // One stray reading is not a train; it takes two that agree.
      if ((raw.obs?.length ?? 0) < 2) continue
      const fit = model.fitOrigin(raw, ms)
      const train = fit ? { ...raw, t0Ms: fit.t0 } : raw
      const pos = model.position(train, ms)
      if (!pos || pos.phase === "done") continue
      const dir = directionOf(train.path, model)
      if (placed.some((p) => p.dir === dir && Math.abs(p.km - pos.km) < SAME_TRAIN_KM)) continue
      incoming.push({ train, fit, pos, dir })
    }
    const used = new Set()
    const olds = runs.filter((r) => r.kind === "model").sort((a, b) => progressOf(b) - progressOf(a))
    for (const run of olds) {
      let best = -1
      let bestGap = MATCH_KM
      incoming.forEach((item, index) => {
        if (used.has(index) || item.dir !== run.dir || item.train.dest !== run.dest) return
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
      let t0First = run.t0First
      if (Number.isFinite(fresh) && Number.isFinite(run.t0) && Math.abs(fresh - run.t0) > T0_RESET_MS) t0First = fresh
      next.push({
        ...run,
        train: item.train,
        plat: item.train.plat,
        t0: fresh ?? run.t0,
        t0First: Number.isFinite(t0First) ? t0First : fresh,
        apiSlowSec: item.fit?.apiSlowSec ?? 0,
        readings: item.fit?.readings ?? 0,
        delay: item.train.delay,
        seenAt: ms,
      })
    }
    incoming.forEach((item, index) => {
      if (used.has(index)) return
      next.push({
        kind: "model",
        id: `m${nextId++}`,
        dir: item.dir,
        dest: item.train.dest,
        train: item.train,
        plat: item.train.plat,
        t0: item.fit?.t0,
        t0First: item.fit?.t0,
        t0Disp: item.fit?.t0,
        apiSlowSec: item.fit?.apiSlowSec ?? 0,
        readings: item.fit?.readings ?? 0,
        km: item.pos.km,
        pos: item.pos,
        seenAt: ms,
        delay: item.train.delay,
      })
    })
    runs = withModelLateness(next, headwayOf)
    return runs
  }

  function lateOfSched(delaySec) {
    const sec = Math.round(Math.max(0, delaySec) / 5) * 5
    return { sec, source: "timetable", parts: { timetable: delaySec } }
  }

  function withModelLateness(list, headwayOf) {
    const groups = new Map()
    for (const run of list) {
      if (run.kind !== "model" || !Number.isFinite(run.t0)) continue
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
        const headway = headwayOf?.(group[i].dir, group[i].t0)
        if (!headway) continue
        const excess = gap - headway
        if (excess > 0 && gap < headway * HEADWAY_SANE) headwayLate.set(group[i].id, excess)
      }
    }
    return list.map((run) => {
      if (run.kind !== "model") return run
      const runLate = Number.isFinite(run.t0) && Number.isFinite(run.t0First) ? Math.max(0, (run.t0 - run.t0First) / 1000) : 0
      const parts = { run: runLate, feed: run.apiSlowSec ?? 0, headway: headwayLate.get(run.id) ?? 0 }
      let source = "run"
      for (const key of ["feed", "headway"]) if (parts[key] > parts[source]) source = key
      return { ...run, late: { sec: Math.round(parts[source] / 5) * 5, source, parts } }
    })
  }

  // Advance every run to `ms`. Returns the runs to draw.
  function frame(ms) {
    const dt = lastFrame ? Math.min(5, Math.max(0, (ms - lastFrame) / 1000)) : 0
    lastFrame = ms
    const dayStart = serviceDayStart(ms)
    const tauNow = (ms - dayStart) / 1000
    const kept = []
    for (const run of runs) {
      let pos
      let next = run
      if (run.kind === "sched") {
        const disp = follow(run.delayDisp, run.delayEst, dt)
        pos = tripState(run.trip, tauNow - disp, model)
        next = { ...run, delayDisp: disp }
      } else {
        const disp = Number.isFinite(run.t0)
          ? (Number.isFinite(run.t0Disp) ? follow(run.t0Disp / 1000, run.t0 / 1000, dt) * 1000 : run.t0)
          : undefined
        const train = Number.isFinite(disp) ? { ...run.train, t0Ms: disp } : run.train
        pos = model.position(train, ms)
        next = { ...run, t0Disp: disp }
      }
      if (!pos || pos.phase === "done") continue
      next = { ...next, pos, km: pos.km }
      kept.push(next)
    }
    runs = kept
    return kept.filter(visible)
  }

  function visible(run) {
    const phase = run.pos.phase
    if (phase === "before") return false
    if (phase === "wait") {
      const origin = run.kind === "sched" ? run.trip.origin : run.train.path[0]
      return run.pos.secsToNext <= (TERMINI.has(origin) ? SHOW_WAIT_TERMINUS_SEC : SHOW_WAIT_SEC)
    }
    return true
  }

  // Estimated arrival at each remaining stop.
  function upcoming(run, ms) {
    if (run.kind === "sched") {
      const dayStart = serviceDayStart(ms)
      const tau = (ms - dayStart) / 1000 - run.delayDisp
      return tripUpcoming(run.trip, tau, run.delayDisp, dayStart)
    }
    return model.upcoming(run.train, run.pos, ms)
  }

  return {
    update,
    frame,
    upcoming,
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

// Move a displayed clock offset toward its estimate without ever making the
// train's own clock run backwards or faster than 1.5x.
function follow(disp, target, dt) {
  if (!Number.isFinite(disp)) return target
  const gap = target - disp
  if (Math.abs(gap) > SNAP_SEC) return target
  const step = CATCH_UP * dt
  return Math.abs(gap) <= step ? target : disp + Math.sign(gap) * step
}
