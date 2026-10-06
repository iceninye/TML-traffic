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
// Matching tolerances (seconds). A reading must sit within MATCH_WINDOW of
// where a trip is expected (its own last delay, or the line-wide delay for a
// trip not yet tracked). A tracked trip may also run later than that, up to
// LATE_REACH, at extra cost: a train being held keeps its identity. A reading
// that fits nothing costs SKIP and goes to the fallback model: an extra train,
// or one far off its timetable.
const MATCH_WINDOW_SEC = 150
const LATE_REACH_SEC = 600
const SKIP_COST = 120
const ABSORB_SEC = 90
// Far readings disagree with the timetable more often (±1 min), so they
// count for less.
const weightOf = (ttnt) => (ttnt <= 2 ? 1 : ttnt <= 5 ? 0.4 : 0.15)

export const DAY_TYPES = ["weekday", "saturday", "sunday"]
const TERMINI = new Set(["TUM", "WKS"])

// Timetables are keyed by code (TML1100B ...); each book also knows its day
// type. More can be added at any time (data/timetables/index.json lists them).
export function createTimetables(schedules, model) {
  const books = {}
  const add = (schedule) => {
    if (schedule?.timetable) books[schedule.timetable] = indexBook(schedule, model)
  }
  for (const schedule of Object.values(schedules ?? {})) add(schedule)
  return {
    books,
    add,
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
  for (const dir of ["DOWN", "UP"]) {
    for (const hop of schedule.sectionA?.[dir]?.hops ?? []) {
      // Section A puts the dwell on the hop's arrival station; use the
      // non-peak column (the second run/dwell pair).
      const dwell = hop.cols?.[3] ?? hop.cols?.[1]
      if (Number.isFinite(dwell)) dwellOf.set(`${dir}|${hop.to}`, dwell)
    }
  }
  const trips = schedule.trips.map((raw, index) => {
    // [code, arr, dep] or [code, arr, dep, 1] for a stop run empty (no
    // passengers: never on a board, but the train is physically there).
    // Arrivals are filled in by the parser from section A; the dwell guess
    // below only covers the odd stop it could not.
    const stops = raw.stops.map(([code, arr, dep, empty], k) => {
      const dwell = dwellOf.get(`${raw.dir}|${code}`) ?? 25
      const a = arr ?? (k === 0 ? dep : dep - dwell)
      const d = dep ?? arr
      return { code, arr: a, dep: d, km: model.km(code), empty: Boolean(empty) }
    })
    const served = stops.filter((st) => !st.empty)
    const trip = {
      id: `${schedule.timetable}:${index}`,
      index,
      dir: raw.dir,
      run: raw.run,
      trip: raw.trip,
      // Boards name the last stop that takes passengers.
      dest: (served[served.length - 1] ?? stops[stops.length - 1]).code,
      passenger: served.length > 0,
      origin: stops[0].code,
      endCode: stops[stops.length - 1].code,
      stops,
      start: stops[0].arr,
      end: stops[stops.length - 1].arr,
    }
    // An empty move from the depot puts the train on its first platform at
    // a known time; it stands there until departure.
    if (Number.isFinite(raw.platformFrom) && raw.platformFrom < stops[0].dep) {
      stops[0].arr = raw.platformFrom
      trip.start = raw.platformFrom
      trip.platformKnown = true
    }
    return trip
  })
  // A train that reaches a terminus goes back out as the same Run (every
  // terminus arrival in all three timetables does). Link the two trips: the
  // departing trip's first platform time becomes the arrival of the one
  // before it, so the train is shown standing in the terminus through its
  // layover instead of vanishing on arrival and reappearing at departure.
  // Tuen Mun and Wu Kai Sha each have two platforms, so two trains can wait.
  const byRun = new Map()
  for (const trip of trips) {
    const list = byRun.get(trip.run) ?? []
    list.push(trip)
    byRun.set(trip.run, list)
  }
  for (const list of byRun.values()) {
    list.sort((a, b) => a.stops[0].dep - b.stops[0].dep)
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1]
      const next = list[i]
      if (!TERMINI.has(prev.endCode) || next.origin !== prev.endCode || next.stops[0].dep < prev.end) continue
      prev.next = next.id
      prev.nextDep = next.stops[0].dep
      next.prev = prev.id
      next.stops[0].arr = prev.end
      next.start = prev.end
    }
  }

  // (station|dir|dest) -> events sorted by board time. A board at a trip's
  // first station counts down to departure; elsewhere, to arrival.
  const events = new Map()
  for (const trip of trips) {
    if (!trip.passenger) continue
    // Where passenger service starts (after any empty leg), the board
    // counts down to departure.
    const firstServed = trip.stops.findIndex((st) => !st.empty)
    trip.stops.forEach((stop, k) => {
      // Empty stops are never on a board: they must not claim readings.
      if (stop.empty) return
      const key = `${stop.code}|${trip.dir}|${trip.dest}`
      const list = events.get(key) ?? []
      list.push({ trip, k, arr: k === firstServed ? stop.dep : stop.arr })
      events.set(key, list)
    })
  }
  for (const list of events.values()) list.sort((a, b) => a.arr - b.arr)
  return { timetable: schedule.timetable, day: schedule.day, kind: schedule.kind ?? "normal", headways: schedule.headways, trips, events }
}

// Which timetable is running: the one whose events sit closest to the near
// readings. Returns { day: <timetable code>, scores }.
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
//   history:  Map tripId -> { readings: [...], delay } from earlier snapshots
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

  // Each board lists a station's next trains in order. Match the board's
  // readings to its scheduled events as an ordered alignment (no crossing,
  // each trip at most once), choosing the cheapest overall: one odd train
  // (held, extra, withdrawn) cannot push every other train onto the wrong trip.
  const assigned = new Map()
  const leftover = []
  const boards = new Map()
  for (const r of readings) {
    const key = `${r.station}|${r.dir}|${r.dest}`
    const list = boards.get(key) ?? []
    list.push(r)
    boards.set(key, list)
  }
  const expectedDelay = (trip) => history?.get(trip.id)?.delay
  for (const [key, list] of boards) {
    const all = book.events.get(key)
    if (!all) {
      leftover.push(...list)
      continue
    }
    list.sort((a, b) => a.dueAt - b.dueAt)
    const cs = list.map(centre)
    const lo = Math.min(...cs) - LATE_REACH_SEC - 600
    const hi = Math.max(...cs) + 600
    const events = all.filter((e) => e.arr >= lo && e.arr <= hi)
    const cost = (c, e) => {
      const prior = expectedDelay(e.trip)
      const gap = c - (e.arr + (prior ?? lineDelay))
      if (Math.abs(gap) <= MATCH_WINDOW_SEC) return Math.abs(gap)
      if (prior !== undefined && gap > 0 && gap <= LATE_REACH_SEC) return 60 + 0.2 * (gap - MATCH_WINDOW_SEC)
      return Infinity
    }
    const pairs = align(cs, events, cost)
    list.forEach((r, i) => {
      const e = pairs[i]
      if (!e) {
        leftover.push(r)
        return
      }
      const entry = assigned.get(e.trip.id) ?? { trip: e.trip, readings: [] }
      entry.readings.push({ ...r, k: e.k, arr: e.arr, at: serviceAt(r.dueAt, ms) })
      assigned.set(e.trip.id, entry)
    })
  }

  // Delay per trip: the value inside the most (weighted) reading windows,
  // over this snapshot and the recent history.
  for (const [id, entry] of assigned) {
    const past = (history?.get(id)?.readings ?? []).filter((h) => ms - h.seenAt <= HISTORY_MS)
    const all = [...entry.readings, ...past]
    // "0 min" means arrived by the FIRST time it read 0. Boards keep showing
    // 0 while the train stands (and sometimes after it leaves); taking each
    // later 0 as a fresh arrival would make the train look ever later.
    const firstZero = new Map()
    for (const r of all) {
      if (r.ttnt !== 0) continue
      const prior = firstZero.get(r.station)
      if (prior === undefined || r.at < prior) firstZero.set(r.station, r.at)
    }
    const windows = all.map((r0) => {
      const r = r0.ttnt === 0 ? { ...r0, at: firstZero.get(r0.station) } : r0
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

  // Second pass. At peak, trains bunch and spread by a minute or more, so a
  // board can list a train between two scheduled slots. If a leftover reading
  // fits a trip already placed (within ABSORB of that trip's own delay, and
  // the trip has no reading on that board yet), it is that train: attach it
  // rather than letting the fallback draw the same train twice.
  const stillLeft = []
  for (const r of leftover) {
    const events = book.events.get(`${r.station}|${r.dir}|${r.dest}`) ?? []
    const c = centre(r)
    let best = null
    for (const e of events) {
      const entry = assigned.get(e.trip.id)
      if (!entry || entry.readings.some((x) => x.station === r.station)) continue
      const gap = Math.abs(c - (e.arr + entry.delay))
      if (gap <= ABSORB_SEC && (!best || gap < best.gap)) best = { e, entry, gap }
    }
    if (!best) {
      stillLeft.push(r)
      continue
    }
    best.entry.readings.push({ ...r, k: best.e.k, arr: best.e.arr, at: serviceAt(r.dueAt, ms) })
  }
  leftover.length = 0
  leftover.push(...stillLeft)
  return { trips: assigned, leftover, lineDelay }
}

// Ordered alignment of readings (sorted) to events (sorted): dynamic
// programming over "skip reading", "skip event", "match". Returns, per
// reading, its event or null.
function align(cs, events, cost) {
  const n = cs.length
  const m = events.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity))
  const how = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let j = 0; j <= m; j += 1) dp[0][j] = 0
  for (let i = 1; i <= n; i += 1) {
    dp[i][0] = dp[i - 1][0] + SKIP_COST
    how[i][0] = 1
    for (let j = 1; j <= m; j += 1) {
      let best = dp[i][j - 1]
      let move = 2
      if (dp[i - 1][j] + SKIP_COST < best) {
        best = dp[i - 1][j] + SKIP_COST
        move = 1
      }
      const c = cost(cs[i - 1], events[j - 1])
      if (dp[i - 1][j - 1] + c < best) {
        best = dp[i - 1][j - 1] + c
        move = 3
      }
      dp[i][j] = best
      how[i][j] = move
    }
  }
  const out = new Array(n).fill(null)
  let i = n
  let j = m
  while (i > 0) {
    const move = how[i][j]
    if (move === 3) {
      out[i - 1] = events[j - 1]
      i -= 1
      j -= 1
    } else if (move === 1) {
      i -= 1
    } else {
      j -= 1
    }
  }
  return out
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
      const p = model.profile(f, Math.abs(n.km - s.km) * 1000, run)
      return { phase: "run", km: s.km + (n.km - s.km) * p.frac, from: s.code, to: n.code, secsToNext: n.arr - tau, speedKmh: p.speed * 3.6 }
    }
  }
  const last = stops[stops.length - 1]
  // Continuing Run: stands in the terminus until its next trip leaves.
  const until = trip.nextDep ?? last.arr + 30
  return { phase: tau > until ? "done" : "arrived", km: last.km, from: last.code, to: last.code, secsToNext: Math.max(0, until - tau), speedKmh: 0 }
}

// Upcoming stops with estimated epoch ms, in board terms: departure where
// passenger service starts (that is what the board counts down to there,
// and the train may stand at that platform long before), arrival elsewhere.
export function tripUpcoming(trip, tau, delaySec, dayStartMs) {
  const out = []
  const first = trip.stops.findIndex((st) => !st.empty)
  trip.stops.forEach((s, k) => {
    if (s.empty) return
    const board = k === first ? s.dep : s.arr
    if (board <= tau) return
    out.push({ code: s.code, at: dayStartMs + (board + delaySec) * 1000 })
  })
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

// Line headway measured from the boards alone, per direction: on each
// station's board, the span from its first to its last listed train divided
// by the gaps between them. Spans rather than single gaps, because each
// reading is rounded to the minute. Returns { UP: s, DOWN: s } (or null).
export function measuredHeadways(readings) {
  const boards = new Map()
  for (const r of readings) {
    const key = `${r.station}|${r.dir}`
    const list = boards.get(key) ?? []
    list.push(r.dueAt)
    boards.set(key, list)
  }
  const out = {}
  for (const dir of ["UP", "DOWN"]) {
    const spans = []
    for (const [key, list] of boards) {
      if (!key.endsWith(`|${dir}`) || list.length < 2) continue
      list.sort((a, b) => a - b)
      spans.push((list[list.length - 1] - list[0]) / 1000 / (list.length - 1))
    }
    spans.sort((a, b) => a - b)
    out[dir] = spans.length ? spans[spans.length >> 1] : null
  }
  return out
}

function hhmm(value) {
  const [h, m] = value.split(":").map(Number)
  return h * 3600 + m * 60
}
