// Animation layer for the timetable model.
//
// Each run carries the latest estimator observation for one train. Its target
// position is a pure function of the clock (lib/tml-model.js), so between
// snapshots nothing needs extrapolating. When a new snapshot moves the target,
// the gap is folded into an offset that decays over a few seconds: the train
// speeds up or eases off to meet the new estimate rather than teleporting.
// A train never runs backwards on screen.

import { directionOf } from "./tml-model.js"

// A new observation further than this from a run is a different train.
const MATCH_KM = 2.6
// A train the feed loses keeps running on its last observation this long.
const COAST_MS = 25_000
// Time constant of the soft correction, and a cap on how fast it may move a
// train beyond its modelled speed, so a big correction reads as a train
// running a little fast rather than sliding across the screen.
const SETTLE_SEC = 5
const MAX_CORRECT_KM_PER_SEC = 0.045

let nextId = 1

export function createTracker(model) {
  let runs = []
  let lastFrame = 0

  function targetOf(train, ms) {
    return model.position(train, ms)
  }

  // Fold a fresh snapshot of estimator trains into the running set.
  function update(trains, ms) {
    const incoming = []
    for (const train of trains) {
      const pos = targetOf(train, ms)
      if (!pos || pos.phase === "done") continue
      incoming.push({ train, pos, dir: directionOf(train.path, model) })
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
      next.push({
        ...run,
        train: item.train,
        offset: run.km - item.pos.km,
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
        km: item.pos.km,
        offset: 0,
        pos: item.pos,
        speedKmh: 0,
        seenAt: ms,
        bornAt: ms,
        delay: item.train.delay,
      })
    })
    runs = next
    return runs
  }

  // Advance every run to `ms`. Returns the live list.
  function frame(ms) {
    const dt = lastFrame ? Math.min(5, Math.max(0, (ms - lastFrame) / 1000)) : 0
    lastFrame = ms
    const decay = dt > 0 ? Math.exp(-dt / SETTLE_SEC) : 1
    const out = []
    for (const run of runs) {
      const pos = targetOf(run.train, ms)
      if (!pos || pos.phase === "done") continue
      const sign = run.dir === "DOWN" ? 1 : -1
      let offset = Math.abs(run.offset) < 0.002 ? 0 : run.offset * decay
      const limit = MAX_CORRECT_KM_PER_SEC * dt
      if (Math.abs(run.offset - offset) > limit) offset = run.offset - Math.sign(run.offset) * limit
      let km = pos.km + offset
      // Never backwards: if the estimate fell behind, hold until it catches up.
      if (dt > 0 && sign * (km - run.km) < 0) km = run.km
      km = Math.min(model.totalKm, Math.max(0, km))
      const speedKmh = dt > 0 ? Math.abs(km - run.km) / (dt / 3600) : run.speedKmh
      out.push({
        ...run,
        offset,
        km,
        pos,
        // Smooth the readout; per-frame speed is noisy.
        speedKmh: dt > 0 ? run.speedKmh * 0.9 + Math.min(140, speedKmh) * 0.1 : run.speedKmh,
      })
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
