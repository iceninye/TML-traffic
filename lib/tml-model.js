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
  const runSec = (from, to, ms) => {
    const item = hop(from, to)
    if (!item) return null
    return isPeak(ms) ? item.peak : item.off
  }
  const dwellSec = (code) => timetable.dwell[code] ?? 0

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

  // Where a train is at `ms`. `train` is the estimator output plus `dueAtMs`
  // (when it reaches `anchor`, or leaves it for a departure reading).
  function position(train, ms) {
    const path = train.path
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
    position,
    upcoming,
    pointAtKm,
    stationPoint,
    trackCoords: coords,
    ease,
  }
}

// Direction of a train from its path: DOWN runs toward Wu Kai Sha (km rising).
export function directionOf(path, model) {
  const a = model.km(path[0])
  const b = model.km(path[path.length - 1])
  return b >= a ? "DOWN" : "UP"
}

function hhmm(value) {
  const [h, m] = value.split(":").map(Number)
  return h * 60 + m
}
