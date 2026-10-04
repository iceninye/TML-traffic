// Tuen Ma Line running-time model.
//
// The upstream estimator walks a countdown back along straight-line station
// spacing at two fixed speeds and ignores station stops, so a full trip comes
// out at 57 min against a real 73–75 min. This module replaces that walk with
// the timetable: per-hop run times (peak / off-peak), per-station dwell, track
// kilometres, and an S-shaped speed profile inside each hop.
//
// Everything here is a pure function of (train observation, clock), so the
// position of a train is fully determined between feed snapshots; the
// animation layer only has to smooth the step when a new snapshot lands.

const HK_OFFSET_MS = 8 * 3_600_000
// Share of a hop spent accelerating, and again braking. The rest is cruise.
const RAMP = 0.22
// How long a train is kept on screen after reaching its last stop.
const TERMINAL_HOLD_SEC = 40

export function createModel(timetable, track) {
  const stationKm = new Map(Object.entries(timetable.stations).map(([code, s]) => [code, s.km]))
  const hops = new Map()
  for (const hop of timetable.hops) {
    hops.set(`${hop.from}>${hop.to}`, hop)
    hops.set(`${hop.to}>${hop.from}`, hop)
  }
  const order = timetable.hops.map((hop) => hop.from).concat(timetable.hops.at(-1).to)
  const totalKm = stationKm.get(order.at(-1))

  // ---------------------------------------------------------------- clock

  function hkParts(ms) {
    const d = new Date(ms + HK_OFFSET_MS)
    return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }
  }

  // Service day starts at 04:00 so the after-midnight tail counts as the
  // evening before. Public holidays are not known here and run as weekdays.
  function period(ms) {
    let { day, minutes } = hkParts(ms)
    if (minutes < 240) {
      day = (day + 6) % 7
      minutes += 1440
    }
    const dayType = day === 0 ? "sunday" : day === 6 ? "saturday" : "weekday"
    const plan = timetable.periods[dayType]
    const band = plan.bands.find((item) => minutes >= hhmm(item.from) && minutes < hhmm(item.to)) ?? null
    return { dayType, timetable: plan.timetable, maxTrains: plan.maxTrains, band, inService: Boolean(band) }
  }

  const peakCache = { at: 0, peak: false }
  function isPeak(ms) {
    if (Math.abs(ms - peakCache.at) > 30_000) {
      peakCache.at = ms
      peakCache.peak = Boolean(period(ms).band?.peak)
    }
    return peakCache.peak
  }

  // ------------------------------------------------------------- geometry

  const km = (code) => stationKm.get(code) ?? null
  const hop = (from, to) => hops.get(`${from}>${to}`) ?? null
  // Per-direction run and dwell seconds from the working timetable, set by
  // the app for the current period (see setScheduleTimes). Without them the
  // single-direction table from tml-timetable.json is used.
  let scheduleTimes = null
  function setScheduleTimes(times) {
    scheduleTimes = times
  }
  const baseRunSec = (from, to, ms) => {
    const exact = scheduleTimes?.runs.get(`${from}>${to}`)
    if (Number.isFinite(exact)) return exact
    const item = hop(from, to)
    if (!item) return null
    return isPeak(ms) ? item.peak : item.off
  }
  const runSec = (from, to, ms) => {
    const base = baseRunSec(from, to, ms)
    if (base == null) return null
    return Math.max(30, base + correction(from, to, ms))
  }

  // ------------------------------------------------------ live calibration
  //
  // The timetable gives one run time per hop for both directions, and some
  // are off: leaving Wu Kai Sha is about a minute quicker than the slow
  // approach into it, for one. The feed knows better. A train chained across
  // stations k and k+1 is due at both, so due(k+1) - due(k) - dwell(k) is the
  // feed's own run time for that hop, in that direction. Each board rounds to
  // whole minutes, so one sample is noisy (±60 s), but every snapshot has
  // ~20 per hop; a decaying average shrunk toward the timetable settles to a
  // few seconds within a couple of minutes.
  const LEARN_DECAY = 0.985
  const LEARN_PRIOR = 8
  const LEARN_CLAMP = 120
  const learned = new Map()
  const learnKey = (from, to, ms) => `${isPeak(ms) ? "P" : "O"}|${from}>${to}`

  function correction(from, to, ms) {
    const entry = learned.get(learnKey(from, to, ms))
    if (!entry) return 0
    return Math.max(-LEARN_CLAMP, Math.min(LEARN_CLAMP, entry.sum / (entry.n + LEARN_PRIOR)))
  }

  function learn(trains, ms) {
    let samples = 0
    for (const train of trains) {
      const rows = (train.obs ?? [])
        .filter((o) => o.timeType !== "D" && Number.isFinite(o.dueAt))
        .map((o) => ({ i: train.path.indexOf(o.station), dueAt: o.dueAt }))
        .filter((o) => o.i >= 0)
        .sort((a, b) => a.i - b.i)
      for (let k = 1; k < rows.length; k += 1) {
        const a = rows[k - 1]
        const b = rows[k]
        if (b.i !== a.i + 1) continue
        const from = train.path[a.i]
        const to = train.path[b.i]
        const base = baseRunSec(from, to, ms)
        if (base == null) continue
        const observed = (b.dueAt - a.dueAt) / 1000 - (a.i > 0 ? dwellSec(from) : 0)
        const residual = observed - base
        if (Math.abs(residual) > 180) continue
        const key = learnKey(from, to, ms)
        const entry = learned.get(key) ?? { sum: 0, n: 0 }
        entry.sum = entry.sum * LEARN_DECAY + residual
        entry.n = entry.n * LEARN_DECAY + 1
        learned.set(key, entry)
        samples += 1
      }
    }
    return samples
  }

  function exportLearned() {
    return Object.fromEntries([...learned].map(([k, v]) => [k, { sum: Math.round(v.sum * 10) / 10, n: Math.round(v.n * 100) / 100 }]))
  }

  function importLearned(data) {
    if (!data || typeof data !== "object") return
    for (const [k, v] of Object.entries(data)) {
      if (Number.isFinite(v?.sum) && Number.isFinite(v?.n)) learned.set(k, { sum: v.sum, n: Math.min(v.n, 40) })
    }
  }
  const dwellSec = (code) => scheduleTimes?.dwells.get(code) ?? timetable.dwell[code] ?? 0

  // Minutes from arriving at `from` to arriving at `to`: the stop at `from`,
  // then the run. This is what the estimator chains board readings with.
  function arrivalGapMinutes(from, to, ms = Date.now()) {
    const run = runSec(from, to, ms)
    if (run == null) return null
    return (run + dwellSec(from)) / 60
  }

  // Trapezoid speed profile: time fraction -> distance fraction.
  function ease(f) {
    const x = Math.min(1, Math.max(0, f))
    const vmax = 1 / (1 - RAMP)
    if (x < RAMP) return (0.5 * vmax * x * x) / RAMP
    if (x > 1 - RAMP) return 1 - (0.5 * vmax * (1 - x) ** 2) / RAMP
    return vmax * (x - RAMP / 2)
  }

  // Instantaneous speed as a share of the hop's mean speed.
  function easeRate(f) {
    const x = Math.min(1, Math.max(0, f))
    const vmax = 1 / (1 - RAMP)
    if (x < RAMP) return (vmax * x) / RAMP
    if (x > 1 - RAMP) return (vmax * (1 - x)) / RAMP
    return vmax
  }

  function onHop(from, to, f, ms) {
    const a = km(from)
    const b = km(to)
    const run = runSec(from, to, ms)
    const s = ease(f)
    const speed = (Math.abs(b - a) / (run / 3600)) * easeRate(f)
    return { km: a + (b - a) * s, from, to, phase: "run", secsToNext: (1 - f) * run, speedKmh: speed }
  }

  function atStation(code, phase, secsToNext = 0) {
    return { km: km(code), from: code, to: code, phase, secsToNext, speedKmh: 0 }
  }

  // Seconds from leaving path[0] to arriving at each station on the path.
  function cumArrival(path, ms) {
    const out = [0]
    for (let i = 1; i < path.length; i += 1) {
      const run = runSec(path[i - 1], path[i], ms) ?? 0
      const dwell = i - 1 > 0 ? dwellSec(path[i - 1]) : 0
      out.push(out[i - 1] + dwell + run)
    }
    return out
  }

  // Fit one train against every board reading chained to it.
  //
  // Each reading "due at station k at time d" implies the train left the path
  // origin at t0 = d - cumArrival[k]. Readings are whole minutes, so each t0
  // carries up to ±30 s of rounding; readings at different stations round
  // differently, so combining them cancels much of it. Nearer stations are
  // trusted more because timetable error grows with every hop in between.
  // Outliers (a reading glued onto the wrong train) are dropped first.
  function fitOrigin(train, ms) {
    const path = train.path
    const cum = cumArrival(path, ms)
    const rows = []
    for (const o of train.obs ?? []) {
      const i = path.indexOf(o.station)
      if (i < 0 || !Number.isFinite(o.dueAt)) continue
      const offset = o.timeType === "D" ? cum[i] + (i > 0 ? dwellSec(path[i]) : 0) : cum[i]
      rows.push({ i, t0: o.dueAt - offset * 1000, ttnt: o.ttnt })
    }
    if (rows.length === 0) return null
    rows.sort((a, b) => a.i - b.i)
    const first = rows[0].i
    for (const row of rows) row.w = (1 / (1 + 0.6 * (row.i - first))) * (row.ttnt === 0 ? 1.5 : 1)
    const mid = weightedMedian(rows)
    const kept = rows.filter((row) => Math.abs(row.t0 - mid) <= 90_000)
    const use = kept.length ? kept : rows
    const wsum = use.reduce((sum, row) => sum + row.w, 0)
    const t0 = use.reduce((sum, row) => sum + row.t0 * row.w, 0) / wsum
    // The feed itself expecting the train to lose time further down the line:
    // far readings imply a later t0 than the nearest one. Rounding alone can
    // account for up to a minute of that, so 30 s is taken off as margin.
    const far = use.filter((row) => row.i > first)
    let apiSlowSec = 0
    if (far.length) {
      const diffs = far.map((row) => (row.t0 - use[0].t0) / 1000).sort((a, b) => a - b)
      apiSlowSec = Math.max(0, diffs[diffs.length >> 1] - 30)
    }
    return { t0, readings: rows.length, used: use.length, apiSlowSec }
  }

  // Where a train is at `ms`. With `t0Ms` (fitted departure from the path
  // origin) the whole trip is laid out from that one clock; otherwise from the
  // estimator's single anchor reading.
  function position(train, ms) {
    const path = train.path
    if (Number.isFinite(train.t0Ms)) {
      const since = (ms - train.t0Ms) / 1000
      if (since < 0) return atStation(path[0], "wait", -since)
      return rideForward(path, 0, since, ms, false)
    }
    const at = path.indexOf(train.anchor)
    if (at < 0 || km(train.anchor) == null) return null
    const due = Number.isFinite(train.dueAtMs) ? train.dueAtMs : train.observedAtMs + train.ttnt * 60_000
    const until = (due - ms) / 1000

    if (train.timeType === "D") {
      if (until > 0) return atStation(train.anchor, "wait", until)
      return rideForward(path, at, -until, ms, false)
    }
    if (until > 0) return walkBack(path, at, until, ms)
    return rideForward(path, at, -until, ms, true)
  }

  function walkBack(path, at, secs, ms) {
    let remain = secs
    let index = at
    while (index > 0) {
      const prev = path[index - 1]
      const here = path[index]
      const run = runSec(prev, here, ms)
      if (run == null) break
      if (remain <= run) return onHop(prev, here, 1 - remain / run, ms)
      remain -= run
      index -= 1
      if (index === 0) break
      const dwell = dwellSec(prev)
      if (remain <= dwell) return atStation(prev, "dwell", remain)
      remain -= dwell
    }
    // Still before the origin: the train is waiting to enter service there.
    return atStation(path[index], "wait", remain)
  }

  function rideForward(path, at, secs, ms, dwellFirst) {
    let remain = secs
    let index = at
    if (dwellFirst && index < path.length - 1) {
      const dwell = dwellSec(path[index])
      if (remain <= dwell) return atStation(path[index], "dwell", dwell - remain)
      remain -= dwell
    }
    while (index < path.length - 1) {
      const here = path[index]
      const next = path[index + 1]
      const run = runSec(here, next, ms)
      if (run == null) break
      if (remain <= run) return onHop(here, next, remain / run, ms)
      remain -= run
      index += 1
      if (index === path.length - 1) break
      const dwell = dwellSec(next)
      if (remain <= dwell) return atStation(next, "dwell", dwell - remain)
      remain -= dwell
    }
    const last = path[index]
    return atStation(last, remain > TERMINAL_HOLD_SEC ? "done" : "arrived", 0)
  }

  // Estimated arrival clock at each remaining stop, from a position. For a
  // dwelling or waiting train `secsToNext` is the time until it leaves.
  function upcoming(train, pos, ms) {
    if (!pos || pos.phase === "done" || pos.phase === "arrived") return []
    const path = train.path
    const last = path.length - 1
    const out = []
    let clock = ms + pos.secsToNext * 1000
    let index
    if (pos.phase === "run") {
      index = path.indexOf(pos.to)
      if (index < 0) return out
      out.push({ code: pos.to, at: clock })
      if (index < last) clock += dwellSec(pos.to) * 1000
    } else {
      index = path.indexOf(pos.from)
      if (index < 0) return out
    }
    while (index < last) {
      const next = path[index + 1]
      const run = runSec(path[index], next, ms)
      if (run == null) break
      clock += run * 1000
      out.push({ code: next, at: clock })
      index += 1
      if (index < last) clock += dwellSec(next) * 1000
    }
    return out
  }

  // ---------------------------------------------------------------- track

  // Real alignment: piecewise between station anchors, so a train at a given
  // timetable kilometre lands on the OSM polyline between the right stations.
  const coords = track?.coords ?? null
  const cum = track?.cum ?? null
  const anchors = order.map((code) => ({ km: km(code), along: track?.stations?.[code]?.along ?? null }))

  function alongOf(kmValue) {
    let i = 0
    while (i < anchors.length - 2 && anchors[i + 1].km < kmValue) i += 1
    const a = anchors[i]
    const b = anchors[i + 1]
    const f = b.km === a.km ? 0 : (kmValue - a.km) / (b.km - a.km)
    return a.along + (b.along - a.along) * Math.min(1, Math.max(0, f))
  }

  function pointAtKm(kmValue) {
    if (!coords) return null
    const along = alongOf(Math.min(totalKm, Math.max(0, kmValue)))
    let lo = 0
    let hi = cum.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= along) lo = mid
      else hi = mid
    }
    const a = coords[lo]
    const b = coords[hi]
    const span = cum[hi] - cum[lo]
    const f = span > 0 ? (along - cum[lo]) / span : 0
    const lng = a[0] + (b[0] - a[0]) * f
    const lat = a[1] + (b[1] - a[1]) * f
    // Unit vector of travel (TUM -> WKS) in a local metric frame.
    const kx = Math.cos((lat * Math.PI) / 180)
    const dx = (b[0] - a[0]) * kx
    const dy = b[1] - a[1]
    const n = Math.hypot(dx, dy) || 1
    return { lng, lat, ux: dx / n, uy: dy / n }
  }

  function stationPoint(code) {
    const s = track?.stations?.[code]
    return s ? { lng: s.lng, lat: s.lat } : null
  }

  return {
    order,
    totalKm,
    km,
    hop,
    runSec,
    dwellSec,
    period,
    isPeak,
    arrivalGapMinutes,
    cumArrival,
    fitOrigin,
    learn,
    correction,
    exportLearned,
    importLearned,
    position,
    upcoming,
    pointAtKm,
    stationPoint,
    trackCoords: coords,
    ease,
    easeRate,
    setScheduleTimes,
    timetableRunSec: baseRunSec,
  }
}

// Direction of a train from its path: DOWN runs toward Wu Kai Sha (km rising).
export function directionOf(path, model) {
  const a = model.km(path[0])
  const b = model.km(path[path.length - 1])
  return b >= a ? "DOWN" : "UP"
}

function weightedMedian(rows) {
  const sorted = [...rows].sort((a, b) => a.t0 - b.t0)
  const half = sorted.reduce((sum, row) => sum + row.w, 0) / 2
  let acc = 0
  for (const row of sorted) {
    acc += row.w
    if (acc >= half) return row.t0
  }
  return sorted[sorted.length - 1].t0
}

function hhmm(value) {
  const [h, m] = value.split(":").map(Number)
  return h * 60 + m
}
