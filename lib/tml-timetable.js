// Timetable-matched train positions.
//
// The working timetables (TML1100B weekday, TML6090A Saturday, TML7090
// Sunday/PH; parsed by tools/parse_timetables.py) list every trip's time at
// every station. The Next Train API lists, per station and direction, the
// next four trains with their destination and whole minutes to arrival.
//
// Measured against the timetables (docs/ALGORITHM.md §2):
//   ttnt = ceil((scheduled arrival + delay − now) / 60)
// i.e. "2 min" means the train arrives in more than 1 and at most 2 minutes.
// So each reading pins its trip's delay to a 60-second window, and readings
// at other stations and from earlier snapshots narrow that window further.
//
// For every reading this module finds the scheduled trip it belongs to,
// estimates each trip's delay from all readings that agree, and lays the
// train out on the exact scheduled timeline shifted by that delay: real
// per-direction run and dwell times, depot pull-outs mid-line, short trips.

const HK_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000
// Readings this old still constrain a trip's delay (if it has not changed).
const HISTORY_MS = 75_000
// A reading further than this from every scheduled event, after removing the
// line-wide delay, is not a timetabled train; the fallback model handles it.
const MATCH_WINDOW_SEC = 240
// Far readings disagree with the timetable more often (±1 min), so they
// count for less.
const weightOf = (ttnt) => (ttnt <= 2 ? 1 : ttnt <= 5 ? 0.4 : 0.15)

export const DAY_TYPES = ["weekday", "saturday", "sunday"]

export function createTimetables(schedules, model) {
  const books = {}
  for (const day of DAY_TYPES) if (schedules[day]) books[day] = indexBook(schedules[day], model)
  return {
    books,
    calendarDay,
    serviceSeconds,
    serviceDayStart,
    pickDay(readings, ms) {
      return pickDay(books, readings, ms)
    },
  }
}

// Calendar guess; the readings can overrule it (public holidays, specials).
export function calendarDay(ms) {
  const d = new Date(ms + HK_OFFSET_MS)
  let day = d.getUTCDay()
  if (d.getUTCHours() < 4) day = (day + 6) % 7
  return day === 0 ? "sunday" : day === 6 ? "saturday" : "weekday"
}

// Start of the service day (04:00 cut-over) in epoch ms, HK time.
export function serviceDayStart(ms) {
  const local = ms + HK_OFFSET_MS
  let midnight = Math.floor(local / DAY_MS) * DAY_MS
  if (local - midnight < 4 * 3_600_000) midnight -= DAY_MS
  return midnight - HK_OFFSET_MS
}

export function serviceSeconds(ms) {
  return (ms - serviceDayStart(ms)) / 1000
}

function indexBook(schedule, model) {
  const dwellOf = new Map()
  for (const [dir, table] of Object.entries(schedule.sectionA ?? {})) {
    for (const hop of table.hops) {
      // Section A puts the dwell on the hop's arrival station; use the
      // non-peak column (the second run/dwell pair).
      const dwell = hop.cols?.[3] ?? hop.cols?.[1]
      if (Number.isFinite(dwell)) dwellOf.set(`${dir}|${hop.to}`, dwell)
    }
  }
  const trips = schedule.trips.map((raw, index) => {
    const stops = raw.stops.map(([code, arr, dep], k) => {
      const dwell = dwellOf.get(`${raw.dir}|${code}`) ?? 25
      const a = arr ?? (k === 0 ? dep : dep - dwell)
      const d = dep ?? arr
      return { code, arr: a, dep: d, km: model.km(code) }
    })
    return {
      id: `${schedule.timetable}:${index}`,
      index,
      dir: raw.dir,
      run: raw.run,
      trip: raw.trip,
      dest: stops[stops.length - 1].code,
      origin: stops[0].code,
      stops,
      start: stops[0].arr,
      end: stops[stops.length - 1].arr,
    }
  })
  // (station|dir|dest) -> events sorted by arrival
  const events = new Map()
  for (const trip of trips) {
    trip.stops.forEach((stop, k) => {
      const key = `${stop.code}|${trip.dir}|${trip.dest}`
      const list = events.get(key) ?? []
      list.push({ trip, k, arr: stop.arr })
      events.set(key, list)
    })
  }
  for (const list of events.values()) list.sort((a, b) => a.arr - b.arr)
  return { timetable: schedule.timetable, day: schedule.day, headways: schedule.headways, trips, events }
}

// Which timetable is running: the one whose events sit closest to the near
// readings. Returns { day, scores }.
function pickDay(books, readings, ms) {
  const scores = {}
  for (const [day, book] of Object.entries(books)) {
    const res = []
    for (const r of readings) {
      if (r.ttnt > 2) continue
      const list = book.events.get(`${r.station}|${r.dir}|${r.dest}`)
      if (!list) continue
      const centre = serviceAt(r.dueAt, ms) - 30
      let best = Infinity
      for (const e of list) best = Math.min(best, Math.abs(centre - e.arr))
      res.push(best)
    }
    res.sort((a, b) => a - b)
    scores[day] = res.length ? { n: res.length, median: res[res.length >> 1], close: res.filter((x) => x <= 40).length / res.length } : null
  }
  let day = null
  for (const [name, s] of Object.entries(scores)) {
    if (!s) continue
    if (!day || s.close > scores[day].close) day = name
  }
  return { day, scores }
}

function serviceAt(epochMs, refMs) {
  return (epochMs - serviceDayStart(refMs)) / 1000
}

// ------------------------------------------------------------- matching

// Assign readings to trips and estimate each trip's delay.
//   readings: [{ station, dir, dest, ttnt, dueAt (epoch ms), seenAt }]
//   history:  Map tripId -> [{...reading, k, arr}] from earlier snapshots
// Returns { trips: Map tripId -> {trip, delay, lo, hi, readings}, leftover, lineDelay }
export function matchReadings(book, readings, ms, history) {
  const centre = (r) => serviceAt(r.dueAt, ms) - 30

  // Line-wide delay first, from near readings against their nearest event,
  // so a uniformly late line still matches the right trips.
  const near = []
  for (const r of readings) {
    if (r.ttnt > 2) continue
    const list = book.events.get(`${r.station}|${r.dir}|${r.dest}`)
    if (!list) continue
    const c = centre(r)
    let best = null
    for (const e of list) if (best === null || Math.abs(c - e.arr) < Math.abs(best)) best = c - e.arr
    if (best !== null && Math.abs(best) < 600) near.push(best)
  }
  near.sort((a, b) => a - b)
  const lineDelay = near.length ? near[near.length >> 1] : 0

  // Each board lists a station's next trains in order, so match each
  // reading to the event closest to (reading − line delay); no two readings
  // on one board may take the same trip.
  const assigned = new Map()
  const leftover = []
  const boards = new Map()
  for (const r of readings) {
    const key = `${r.station}|${r.dir}|${r.dest}`
    const list = boards.get(key) ?? []
    list.push(r)
    boards.set(key, list)
  }
  for (const [key, list] of boards) {
    const events = book.events.get(key)
    if (!events) {
      leftover.push(...list)
      continue
    }
    const taken = new Set()
    list.sort((a, b) => a.dueAt - b.dueAt)
    for (const r of list) {
      const c = centre(r) - lineDelay
      let best = null
      for (const e of events) {
        if (taken.has(e.trip.id)) continue
        const gap = Math.abs(c - e.arr)
        if (gap <= MATCH_WINDOW_SEC && (best === null || gap < best.gap)) best = { e, gap }
      }
      if (!best) {
        leftover.push(r)
        continue
      }
      taken.add(best.e.trip.id)
      const entry = assigned.get(best.e.trip.id) ?? { trip: best.e.trip, readings: [] }
      entry.readings.push({ ...r, k: best.e.k, arr: best.e.arr, at: serviceAt(r.dueAt, ms) })
      assigned.set(best.e.trip.id, entry)
    }
  }

  // Delay per trip: the value inside the most (weighted) reading windows,
  // over this snapshot and the recent history.
  for (const [id, entry] of assigned) {
    const past = (history?.get(id) ?? []).filter((h) => ms - h.seenAt <= HISTORY_MS)
    const all = [...entry.readings, ...past]
    const windows = all.map((r) => {
      const age = Math.max(0, ms - r.seenAt)
      const w = weightOf(r.ttnt) * (age > 0 ? 0.7 : 1)
      const hi = r.at - r.arr
      // ttnt = 0: arrived by the first time 0 was seen; the earlier "1"
      // reading in the history supplies the lower bound.
      const lo = r.ttnt === 0 ? hi - 90 : hi - 60
      return { lo, hi, w }
    })
    const est = stab(windows)
    entry.delay = est.value
    entry.lo = est.lo
    entry.hi = est.hi
    entry.support = est.weight / windows.reduce((s, x) => s + x.w, 0)
    entry.history = all.filter((r) => ms - r.seenAt <= HISTORY_MS)
  }
  return { trips: assigned, leftover, lineDelay }
}

// Weighted interval stabbing: sweep the window edges, find the stretch
// covered by the most weight, return its middle.
function stab(windows) {
  const edges = []
  for (const w of windows) edges.push({ x: w.lo, d: w.w }, { x: w.hi, d: -w.w })
  // Openings before closings at the same x, so touching windows overlap.
  edges.sort((a, b) => a.x - b.x || b.d - a.d)
  const segs = []
  let cur = 0
  for (let i = 0; i < edges.length - 1; i += 1) {
    cur += edges[i].d
    segs.push({ lo: edges[i].x, hi: edges[i + 1].x, w: cur })
  }
  if (segs.length === 0) return { value: windows[0]?.hi ?? 0, lo: 0, hi: 0, weight: 0 }
  const top = Math.max(...segs.map((x) => x.w))
  let i = segs.findIndex((x) => x.w >= top - 1e-9)
  const lo = segs[i].lo
  let hi = segs[i].hi
  while (segs[i + 1] && segs[i + 1].w >= top - 1e-9 && segs[i + 1].lo <= hi) {
    i += 1
    hi = segs[i].hi
  }
  return { value: (lo + hi) / 2, lo, hi, weight: top }
}

// ------------------------------------------------------------ positions

// State of a scheduled trip at service time `tau` (schedule clock, i.e.
// real time minus the trip's delay).
//   phase: "before" (not yet at its first platform), "wait" (at the first
//   platform before departure), "run", "dwell", "arrived", "done"
export function tripState(trip, tau, model) {
  const stops = trip.stops
  const first = stops[0]
  if (tau < first.arr) {
    return { phase: "before", km: first.km, from: first.code, to: first.code, secsToNext: first.dep - tau, speedKmh: 0 }
  }
  for (let k = 0; k < stops.length; k += 1) {
    const s = stops[k]
    if (tau < s.dep && tau >= s.arr && k < stops.length - 1) {
      return { phase: k === 0 ? "wait" : "dwell", km: s.km, from: s.code, to: s.code, secsToNext: s.dep - tau, speedKmh: 0 }
    }
    const n = stops[k + 1]
    if (!n) break
    if (tau >= s.dep && tau < n.arr) {
      const run = n.arr - s.dep
      const f = run > 0 ? (tau - s.dep) / run : 1
      const frac = model.ease(f)
      const kmh = run > 0 ? (Math.abs(n.km - s.km) / (run / 3600)) * model.easeRate(f) : 0
      return { phase: "run", km: s.km + (n.km - s.km) * frac, from: s.code, to: n.code, secsToNext: n.arr - tau, speedKmh: kmh }
    }
  }
  const last = stops[stops.length - 1]
  return { phase: tau - last.arr > 30 ? "done" : "arrived", km: last.km, from: last.code, to: last.code, secsToNext: 0, speedKmh: 0 }
}

// Upcoming stops with estimated arrival epoch ms.
export function tripUpcoming(trip, tau, delaySec, dayStartMs) {
  const out = []
  for (const s of trip.stops) {
    if (s.arr <= tau) continue
    out.push({ code: s.code, at: dayStartMs + (s.arr + delaySec) * 1000 })
  }
  return out
}

// Median run and dwell seconds per hop and direction around a time, from
// the scheduled trips themselves; feeds the fallback model.
export function hopTimesAround(book, tauSec, windowSec = 1800) {
  const runs = new Map()
  const dwells = new Map()
  for (const trip of book.trips) {
    if (trip.end < tauSec - windowSec || trip.start > tauSec + windowSec) continue
    trip.stops.forEach((s, k) => {
      const n = trip.stops[k + 1]
      if (k > 0 && n) push(dwells, s.code, s.dep - s.arr)
      if (n) push(runs, `${s.code}>${n.code}`, n.arr - s.dep)
    })
  }
  return { runs: medians(runs), dwells: medians(dwells) }
}

function push(map, key, value) {
  const list = map.get(key) ?? []
  list.push(value)
  map.set(key, list)
}

function medians(map) {
  const out = new Map()
  for (const [k, list] of map) {
    list.sort((a, b) => a - b)
    out.set(k, list[list.length >> 1])
  }
  return out
}

export function headwayAt(book, dir, tauSec) {
  const bands = book.headways?.[dir] ?? []
  for (const b of bands) {
    let from = hhmm(b.from)
    let to = hhmm(b.to)
    if (from < 4 * 3600) from += 86400
    if (to <= from) to += 86400
    if (tauSec >= from && tauSec < to) return b.headway
  }
  return null
}

function hhmm(value) {
  const [h, m] = value.split(":").map(Number)
  return h * 3600 + m * 60
}
