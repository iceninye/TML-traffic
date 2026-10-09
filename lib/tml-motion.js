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
// offset follows at no more than 0.3 s per second while running: the train runs
// between 0.7x and 1.3x its scheduled pace until it is back on the estimate.
// It never stops mid-section, jumps, or runs backwards; at a station it
// dwells longer or shorter, as long as it takes (a held train waits there).

import { directionOf } from "./tml-model.js"
import { serviceDayStart, tripState, tripUpcoming } from "./tml-timetable.js"

// How fast the displayed clock may close on the estimate (s per s).
const CATCH_UP = 0.3
// Standing at a platform the clock may close at up to 1 s/s: a train that
// has fallen behind its dot waits there (or, ahead of it, leaves sooner)
// instead of running on at 0.7x into the next section.
const PLATFORM_CATCH_UP = 1
const AT_PLATFORM = new Set(["wait", "dwell", "arrived"])
// A gap this large is a re-match, not drift: jump straight to it.
const SNAP_SEC = 150
// Keep a trip this long after its last board reading. Trains on their last
// hop vanish from the boards (a terminus does not list arrivals), so those
// are kept until they arrive.
const SEEN_MS = 45_000
// Duplicates are judged on evidence, not distance: a candidate (a fallback
// chain, or a trip no board mentions any more) is the same train as one
// already placed when that train's predicted arrivals explain every one of
// the candidate's readings to within AGREE_SEC. Distance alone only decides
// below SAME_SPOT_KM: one train length plus a queueing gap, closer than two
// trains on one track ever get, even bunched on CBTC moving block.
const AGREE_SEC = 75
const SAME_SPOT_KM = 0.25
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
    const placeTrip = (trip, delay, km) => {
      const at = new Map(tripUpcoming(trip, tau - delay, delay, dayStart).map((u) => [u.code, u.at]))
      placed.push({ dir: trip.dir, km, at })
    }
    for (const [id, entry] of matched) {
      const old = byId.get(id)
      const now = tripState(entry.trip, tau - entry.delay, model)
      if (now.phase === "run" || now.phase === "dwell") placeTrip(entry.trip, entry.delay, now.km)
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
      const nextStop = tripUpcoming(old.trip, tau - old.delayEst, old.delayEst, dayStart)[0]
      const evidence = nextStop ? [{ station: nextStop.code, at: nextStop.at }] : []
      if (old.km != null && isDuplicate(old.dir, old.km, evidence)) continue
      next.push(old)
      if (old.km != null) placeTrip(old.trip, old.delayEst, old.km)
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
      const evidence = (raw.obs ?? []).filter((o) => o.ttnt >= 1).map((o) => ({ station: o.station, at: o.dueAt - 30_000 }))
      if (isDuplicate(dir, pos.km, evidence)) continue
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

    function isDuplicate(dir, km, evidence) {
      for (const p of placed) {
        if (p.dir !== dir) continue
        if (Math.abs(p.km - km) < SAME_SPOT_KM) return true
        if (evidence.length && evidence.every((e) => {
          const at = p.at.get(e.station)
          return at != null && Math.abs(at - e.at) <= AGREE_SEC * 1000
        })) return true
      }
      return false
    }
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
    // No timetable behind these trains, so no "late": only how much longer
    // the gap to the train in front is than the line's measured headway.
    return list.map((run) => {
      if (run.kind !== "model") return run
      const gap = headwayLate.get(run.id) ?? 0
      return { ...run, late: { sec: Math.round(gap / 5) * 5, source: "spacing", parts: { spacing: gap } } }
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
        // A train held at a platform shows up on the boards as its delay
        // growing a second per second. Up to v0.7.5 the dot still left at
        // 0.7x and ran on: at 18:40 on 2026-10-07 Run 73 read +110 s but
        // was drawn at about +50 s, half way past To Kwa Wan while its board
        // still counted down to it. At a platform the dot now waits.
        // Running to a platform: the dot may not get there before the train.
        // If the dot is ahead of the estimate by more than the display clock
        // can still close at CATCH_UP before it arrives, it stands still
        // short of the platform until the estimate has caught up.
        const ahead = run.delayEst - run.delayDisp
        const reachesEarly = run.pos?.phase === "run" && ahead > (CATCH_UP * run.pos.secsToNext) / (1 - CATCH_UP)
        const cap = AT_PLATFORM.has(run.pos?.phase) || reachesEarly ? PLATFORM_CATCH_UP : CATCH_UP
        const [disp, vel] = follow(run.delayDisp, run.delayVel ?? 0, run.delayEst, dt, cap)
        pos = tripState(run.trip, tauNow - disp, model)
        next = { ...run, delayDisp: disp, delayVel: vel }
      } else {
        const disp = Number.isFinite(run.t0)
          ? (Number.isFinite(run.t0Disp) ? follow(run.t0Disp / 1000, 0, run.t0 / 1000, dt)[0] * 1000 : run.t0)
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
    const byTrip = new Map(kept.filter((r) => r.kind === "sched").map((r) => [r.trip.id, r]))
    return kept.filter((r) => visible(r, byTrip))
  }

  // One physical train per Run at a terminus: the arriving trip hands over
  // to the same Run's departing trip, which stands at the platform through
  // the layover and leaves on the boards' departure countdown.
  function visible(run, byTrip) {
    const phase = run.pos.phase
    if (phase === "before") return false
    if (run.kind === "sched" && phase === "arrived" && run.trip.next) {
      const next = byTrip.get(run.trip.next)
      if (next && next.pos.phase !== "before") return false
    }
    if (phase === "wait") {
      if (run.kind === "sched" && (run.trip.prev || run.trip.platformKnown)) {
        // Known to be at the platform (layover, or brought in from the
        // depot); unless still on its way in as the previous trip.
        const prev = run.trip.prev ? byTrip.get(run.trip.prev) : null
        return !(prev && (prev.pos.phase === "run" || prev.pos.phase === "dwell"))
      }
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
    // Leaving the timetable: drop every timetable-matched train at once, so
    // none lingers with a delay measured against the wrong timetable.
    dropScheduled() {
      runs = runs.filter((r) => r.kind !== "sched")
    },
    get runs() {
      return runs
    },
  }

  function progressOf(run) {
    return run.dir === "DOWN" ? run.km : model.totalKm - run.km
  }
}

// Move a displayed clock offset toward its estimate like a critically
// damped spring: no sudden change of pace, no overshoot. Its rate is capped
// at `cap` s/s: CATCH_UP between stations, so a running train's own clock
// stays between 0.7x and 1.3x, and up to 1 at a platform, where the clock
// may stand still (the train waits) but never runs backwards. A gap over
// SNAP_SEC is a re-match: jump to it.
const SPRING = 0.6
function follow(disp, vel, target, dt, cap = CATCH_UP) {
  if (!Number.isFinite(disp)) return [target, 0]
  if (Math.abs(target - disp) > SNAP_SEC) return [target, 0]
  let x = disp
  let v = vel
  for (let left = dt; left > 1e-6; left -= 0.1) {
    const h = Math.min(0.1, left)
    v += (SPRING * SPRING * (target - x) - 2 * SPRING * v) * h
    v = Math.max(-cap, Math.min(cap, v))
    x += v * h
  }
  return [x, v]
}
