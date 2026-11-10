// Timetable-matched train positions.
//
// The working timetables (data/timetables/index.json: the normal weekday,
// Saturday and Sunday/PH ones, their Duty Sheet versions, and special ones;
// parsed by tools/parse_timetables.py and tools/parse_dutysheet.py) list every
// trip's time at every station. The Next Train API lists, per station and direction, the
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
// where a trip is expected (its own last delay, or its direction's delay for
// a trip not yet tracked). A tracked trip may also run later than that, up to
// LATE_REACH, at extra cost: a train being held keeps its identity. A reading
// that fits nothing costs SKIP and goes to the fallback model: an extra train,
// or one far off its timetable.
const MATCH_WINDOW_SEC = 150
const LATE_REACH_SEC = 600
const SKIP_COST = 120
// Inside the window a reading costs its distance scaled so the window edge
// equals SKIP. A tracked train running later than its last estimate (held
// at a station) costs at most HELD_BASE plus HELD_SLOPE per second beyond
// HELD_FROM, which stays under SKIP all the way to LATE_REACH. Up to v0.6.3
// the cost jumped: readings 120-150 s off cost more than SKIP and were
// always dropped, while 150-600 s late ones were cheap, so a train slipping
// behind lost its own readings and they were drawn again as an unnumbered
// "–" train beside it.
const HELD_BASE_COST = 60
const HELD_FROM_SEC = 75
const HELD_SLOPE = 0.1
const ABSORB_SEC = 90
// Readings at one station more than this far apart must keep their trips'
// order: trains cannot overtake.
const ORDER_TOL_MS = 60_000
// Line delay search (s), and the per-second charges that favour a late line
// over an early one when the boards fit both.
const LINE_DELAY_MIN = -120
const LINE_DELAY_MAX = 600
const LATE_CHARGE = 0.1
const EARLY_CHARGE = 0.6
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
// `holidays` (optional Set of YYYY-MM-DD from data/calendar.json): a public
// holiday that falls Monday to Friday runs the Sunday timetable. Saturdays
// keep Saturday's, and the readings can still overrule the guess.
export function calendarDay(ms, holidays = null) {
  const d = new Date(ms + HK_OFFSET_MS)
  let day = d.getUTCDay()
  if (d.getUTCHours() < 4) day = (day + 6) % 7
  if (day >= 1 && day <= 5 && holidays?.has(serviceDate(ms))) return "sunday"
  return day === 0 ? "sunday" : day === 6 ? "saturday" : "weekday"
}

// Start of the service day (04:00 cut-over) in epoch ms, HK time.
export function serviceDayStart(ms) {
  const local = ms + HK_OFFSET_MS
  let midnight = Math.floor(local / DAY_MS) * DAY_MS
  if (local - midnight < 4 * 3_600_000) midnight -= DAY_MS
  return midnight - HK_OFFSET_MS
}

// Today's service date (04:00 cut-over, HK time) as YYYY-MM-DD.
export function serviceDate(ms) {
  return new Date(serviceDayStart(ms) + 8 * 3_600_000).toISOString().slice(0, 10)
}

// Entries that may run on a service date. A book with "dates" (a Duty Sheet
// for one particular day, such as an event day) runs on those dates only and
// is left out on every other day; all other entries are always kept.
// `calendar.sheets[date]` (data/calendar.json) names the sheet for one date.
export function entriesForDate(entries, date, calendar = null) {
  const named = calendar?.sheets?.[date]
  return entries.filter((e) => !e.dates || e.dates.includes(date) || e.alsoOn?.includes(date) || e.code === named)
}

// The timetable to load first: a book dated for today's service date, or a
// sheet that is also announced for this date ("alsoOn": a weekday running
// Sunday's sheet, for example) wins; else a
// Duty Sheet marked primary (not older than its base timetable) already in
// force, else the first normal timetable for the day.
export function pickFirstEntry(entries, day, date, calendar = null) {
  const named = calendar?.sheets?.[date]
  const dated = (named && entries.find((e) => e.code === named)) || entries.find((e) => e.dates?.includes(date) || e.alsoOn?.includes(date))
  if (dated) return dated
  const normal = entries.filter((e) => !e.dates && e.day === day && e.kind === "normal")
  const duty = normal
    .filter((e) => e.source === "dutysheet" && (e.effective ?? "") <= date)
    .sort((a, b) => (b.effective ?? "").localeCompare(a.effective ?? "") || (b.revision ?? 0) - (a.revision ?? 0))
  return duty[0] ?? normal.find((e) => e.source !== "dutysheet") ?? entries.find((e) => !e.dates) ?? entries[0]
}

// Dated additions (data/overlays.json): extra trips, such as a special train
// announced for one week, put on top of a working timetable of the right day
// type. The book is copied, never changed, and returned as is when nothing
// applies, so a date without an overlay behaves exactly as before. Trips of a
// timetable that already has that Run are left alone (no duplicates).
export function applyOverlays(schedule, overlays, date) {
  if (!schedule?.trips) return schedule
  const extra = []
  for (const o of overlays ?? []) {
    if (!o.dates?.includes(date) || (o.days && !o.days.includes(schedule.day))) continue
    for (const trip of o.trips ?? []) {
      if (schedule.trips.some((t) => t.run === trip.run && t.dir === trip.dir && t.stops?.[0]?.[2] === trip.stops[0][2])) continue
      extra.push(trip)
    }
  }
  return extra.length ? { ...schedule, trips: [...schedule.trips, ...extra] } : schedule
}

// Notices that apply to a service date and are not yet acknowledged.
export function pendingNotices(notices, date, acknowledged) {
  return (notices ?? []).filter((n) => n.dates?.includes(date) && !acknowledged(n.id))
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
      // [duty, from station] pairs (更份), only on trips from a Duty Sheet.
      duties: raw.duties ?? null,
      // L: the train's last trip, it goes back to depot at the end (Duty
      // Sheet flag, kept by tools/parse_dutysheet.py as a trip note).
      last: (raw.notes ?? []).some((note) => note.startsWith("LAST TRIP")),
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
  const order = indexOrder(trips)
  // "dutysheet" books are rebuilt from a Duty Sheet (tools/parse_dutysheet.py):
  // departures are exact, the stops between are modelled.
  const source = schedule.schema?.startsWith("dutysheet") ? "dutysheet" : "timetable"
  return { timetable: schedule.timetable, day: schedule.day, kind: schedule.kind ?? "normal", source, dutysheet: schedule.dutysheet ?? null, effective: schedule.effective ?? null, dates: schedule.dates ?? null, headways: schedule.headways, trips, tripById: new Map(trips.map((t) => [t.id, t])), events, order }
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

  // Line-wide delay first, from near readings, so a uniformly late line
  // still matches the right trips. With trains every ~3 minutes a reading
  // 90 s after one slot is also 90 s before the next, so "nearest slot" alone
  // reads a line running 90 s late as one running 90 s early, and every train
  // then takes the Run number of the one behind it. Score each candidate
  // delay over all near readings instead, and charge running early more
  // than running late: trains are seldom early, often late. Each direction
  // gets its own estimate, since an incident usually holds one track.
  const near = { UP: [], DOWN: [] }
  for (const r of readings) {
    if (r.ttnt > 2) continue
    const all = book.events.get(`${r.station}|${r.dir}|${r.dest}`)
    if (!all || !near[r.dir]) continue
    const c = centre(r)
    // Only the slots a delay in the search range could reach.
    const list = all.filter((e) => e.arr >= c - LINE_DELAY_MAX - 300 && e.arr <= c - LINE_DELAY_MIN + 300)
    if (list.length) near[r.dir].push({ c, list })
  }
  const lineDelay = estimateLineDelay([...near.UP, ...near.DOWN])
  const dirDelay = {
    UP: near.UP.length >= 3 ? estimateLineDelay(near.UP) : lineDelay,
    DOWN: near.DOWN.length >= 3 ? estimateLineDelay(near.DOWN) : lineDelay,
  }

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
  // A trip with no history of its own takes its delay from the order
  // alignment (orderPriors) when that placed it, else the direction's delay.
  const ordered = orderPriors(book, readings, ms, history, dirDelay)
  const expectedDelay = (trip) => history?.get(trip.id)?.delay ?? ordered.get(trip.id)
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
      const gap = c - (e.arr + (prior ?? dirDelay[e.trip.dir] ?? lineDelay))
      const close = Math.abs(gap) <= MATCH_WINDOW_SEC ? (Math.abs(gap) * SKIP_COST) / MATCH_WINDOW_SEC : Infinity
      if (prior === undefined || gap <= 0 || gap > LATE_REACH_SEC) return close
      return Math.min(close, HELD_BASE_COST + HELD_SLOPE * Math.max(0, gap - HELD_FROM_SEC))
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
  // Trains cannot overtake: at one station, a reading more than a minute
  // before or after another must belong to a trip scheduled in that order.
  const placed = new Map()
  for (const entry of assigned.values()) for (const x of entry.readings) push(placed, `${x.station}|${x.dir}`, x)
  const inOrder = (r, arr) => (placed.get(`${r.station}|${r.dir}`) ?? []).every((x) =>
    !(x.dueAt + ORDER_TOL_MS < r.dueAt && x.arr > arr) && !(r.dueAt + ORDER_TOL_MS < x.dueAt && arr > x.arr))
  const stillLeft = []
  for (const r of leftover) {
    const events = book.events.get(`${r.station}|${r.dir}|${r.dest}`) ?? []
    const c = centre(r)
    let best = null
    for (const e of events) {
      const entry = assigned.get(e.trip.id)
      if (!entry || entry.readings.some((x) => x.station === r.station) || !inOrder(r, e.arr)) continue
      const gap = Math.abs(c - (e.arr + entry.delay))
      if (gap <= ABSORB_SEC && (!best || gap < best.gap)) best = { e, entry, gap }
    }
    if (!best) {
      stillLeft.push(r)
      continue
    }
    const x = { ...r, k: best.e.k, arr: best.e.arr, at: serviceAt(r.dueAt, ms) }
    best.entry.readings.push(x)
    push(placed, `${x.station}|${x.dir}`, x)
  }
  leftover.length = 0
  leftover.push(...stillLeft)

  // A train on its last hop into a terminus is on no board (the terminus
  // lists no arrivals), so a page opened then could not draw it until its
  // next trip's scheduled start, and it popped up at the platform (2026-11-04
  // 11:20, Run 11 at Tuen Mun). When the terminus board already names the
  // Run's next trip, the train is shown on that last hop at its direction's
  // delay. The tracker uses these only for trains it is not already showing.
  const tau = serviceAt(ms, ms)
  const approaching = []
  for (const entry of assigned.values()) {
    const prev = entry.trip.prev ? book.tripById?.get(entry.trip.prev) : null
    if (!prev || assigned.has(prev.id) || !prev.passenger) continue
    const delay = Math.max(0, dirDelay[prev.dir] ?? 0)
    const stops = prev.stops
    const from = stops[stops.length - 2]
    const last = stops[stops.length - 1]
    const t = tau - delay
    if (from && t >= from.arr && t < last.arr) approaching.push({ trip: prev, delay })
  }
  return { trips: assigned, leftover, lineDelay, approaching }
}

// ------------------------------------------------------------ order prior
//
// Per-board matching gives a trip it has not tracked yet the direction's
// delay as its expected delay. When the page is opened (or comes back from
// the background) during an incident, a queue of trains each running 2-5
// minutes late fits the NEXT trip's slot at that delay on every board, and
// the whole queue takes the Run numbers one slot behind (2026-11-04 08:35:
// Run 5, five minutes late at Tsuen Wan West, was drawn at Mei Foo on Run
// 26's train). One board cannot tell the two apart; the order of trains
// along the line can. A scheduled trip does not vanish: if the trains
// ahead are on time, the first late train is the next trip, not the one
// after it. So, per direction:
//   1. Put every station on one time axis ("line time": the time a train
//      would have been at the start of the line, from typical running
//      times), and group the near readings into trains on that axis.
//   2. Align the trains, in order, with the scheduled trips, in order.
//      A late train is cheap when the train ahead is late too (a queue),
//      a scheduled trip left without a train costs a little (it may be
//      cancelled), a train left without a trip costs more, and running
//      early is expensive. The queue shifted one slot only fits by leaving
//      a trip out at its head AND a train out (or early) at its tail, where
//      trains not yet at the blockage are on time again.
//   3. The alignment's delays become the expected delays of trips with no
//      history; per-board matching then runs as before.
// tools/validate_matching.mjs "queue" and "cancelled" scenarios.

// Group readings closer than GAP on the line-time axis, at most SPAN wide.
const ORDER_GAP_SEC = 60
// A reading left alone by that grouping joins the nearest neighbouring
// train within this gap (if that train has no reading at its station and
// stays within SPAN). Boards round to whole minutes and real running times
// differ from the timetable's, so one train's readings at neighbouring
// stations can land just over GAP apart. On 2026-11-04 10:23 a train due at
// Long Ping in 50 s and Yuen Long in 103 s landed 61 s apart: the lone Yuen
// Long reading took the trip ahead at +354 s and that trip's real train was
// drawn "–". Widening GAP itself merged trains in long holds (100 s apart);
// a lone reading is the only case that needs it.
const ORDER_LONE_JOIN_SEC = 75
const ORDER_SPAN_SEC = 110
// Readings used to place trains (minutes). 0 is left out: boards keep a
// departed train at 0 for a while.
const ORDER_TTNT_MAX = 5
const ORDER_EARLY_FREE = 40
// Costs (per second where noted). Tuned on the harness: a late charge of
// 0.03/s instead of 0.02 already lets a shifted queue win again in the
// +320..+480 s scenarios, so keep it small.
const ORDER_EARLY_CHARGE = 0.6
const ORDER_RISE_CHARGE = 0.05
const ORDER_LATE_CHARGE = 0.02
const ORDER_HOLE_COST = 5
const ORDER_EXTRA_COST = 60
const ORDER_EXTRA_LONE = 25
const ORDER_EARLY_MAX = 150
// How late a train may be against its trip in the alignment. Up to v0.8.26
// this was LATE_REACH (10 min); on 2026-11-04 the up line reached +605 s
// and trains beyond 10 min could only take a later trip or become "–".
const ORDER_LATE_MAX = 1200
const ORDER_STEP_TRAINS = 4
const ORDER_STEP_TRIPS = 6

// Line offsets: per direction, the median time from a full trip's first
// board time to each station's board time. Each passenger trip gets `order`,
// its median line time.
function indexOrder(trips) {
  const offsets = { UP: new Map(), DOWN: new Map() }
  for (const dir of ["UP", "DOWN"]) {
    const list = trips.filter((t) => t.passenger && t.dir === dir)
    const servedOf = (t) => t.stops.filter((st) => !st.empty)
    const most = Math.max(0, ...list.map((t) => servedOf(t).length))
    const by = new Map()
    for (const t of list) {
      const served = servedOf(t)
      if (served.length !== most) continue
      const t0 = served[0].dep
      served.forEach((st, k) => push(by, st.code, (k === 0 ? st.dep : st.arr) - t0))
    }
    for (const [code, xs] of by) offsets[dir].set(code, median(xs))
  }
  const lineTime = (dir, code, at) => {
    const off = offsets[dir]?.get(code)
    return off === undefined ? undefined : at - off
  }
  const byDir = { UP: [], DOWN: [] }
  for (const t of trips) {
    if (!t.passenger || !byDir[t.dir]) continue
    const firstServed = t.stops.findIndex((st) => !st.empty)
    const xs = []
    t.stops.forEach((st, k) => {
      if (st.empty) return
      const v = lineTime(t.dir, st.code, k === firstServed ? st.dep : st.arr)
      if (v !== undefined) xs.push(v)
    })
    if (!xs.length) continue
    t.order = median(xs)
    t.boardAt = new Map(t.stops.map((st, k) => [st.code, k === firstServed ? st.dep : st.arr]).filter((_, k) => !t.stops[k].empty))
    byDir[t.dir].push(t)
  }
  for (const list of Object.values(byDir)) list.sort((a, b) => a.order - b.order)
  return { lineTime, trips: byDir }
}

// Expected delays (Map tripId -> s) for trips with no history, from the
// order alignment above.
function orderPriors(book, readings, ms, history, dirDelay) {
  const out = new Map()
  if (!book.order) return out
  for (const dir of ["UP", "DOWN"]) {
    const pts = []
    for (const r of readings) {
      if (r.dir !== dir || r.ttnt < 1 || r.ttnt > ORDER_TTNT_MAX) continue
      const v = book.order.lineTime(dir, r.station, serviceAt(r.dueAt, ms) - 30)
      if (v !== undefined) pts.push({ v, station: r.station, dest: r.dest, c: serviceAt(r.dueAt, ms) - 30 })
    }
    if (!pts.length) continue
    pts.sort((a, b) => a.v - b.v)
    const trains = []
    let cur = null
    for (const p of pts) {
      if (cur && p.v - cur.last <= ORDER_GAP_SEC && p.v - cur.first <= ORDER_SPAN_SEC && !cur.stations.has(p.station)) {
        cur.vs.push(p.v)
        cur.pts.push(p)
        cur.stations.add(p.station)
        cur.last = p.v
        continue
      }
      cur = { vs: [p.v], pts: [p], stations: new Set([p.station]), first: p.v, last: p.v }
      trains.push(cur)
    }
    // Lone readings join the nearer neighbouring train (ORDER_LONE_JOIN_SEC).
    for (let i = 0; i < trains.length; i += 1) {
      const t = trains[i]
      if (t.pts.length !== 1) continue
      const p = t.pts[0]
      const fits = (o) => o && !o.stations.has(p.station) && Math.max(o.last, p.v) - Math.min(o.first, p.v) <= ORDER_SPAN_SEC
      const prev = trains[i - 1]
      const next = trains[i + 1]
      const dPrev = fits(prev) ? p.v - prev.last : Infinity
      const dNext = fits(next) ? next.first - p.v : Infinity
      const into = dPrev <= dNext ? (dPrev <= ORDER_LONE_JOIN_SEC ? prev : null) : dNext <= ORDER_LONE_JOIN_SEC ? next : null
      if (!into) continue
      into.vs.push(p.v)
      into.pts.push(p)
      into.stations.add(p.station)
      into.first = Math.min(into.first, p.v)
      into.last = Math.max(into.last, p.v)
      trains.splice(i, 1)
      i -= 1
    }
    for (const t of trains) t.v = median(t.vs)
    const lo = trains[0].v - ORDER_LATE_MAX - 60
    const hi = trains[trains.length - 1].v + ORDER_EARLY_MAX
    const trips = book.order.trips[dir].filter((t) => t.order >= lo && t.order <= hi)
    if (!trips.length) continue
    const base = Math.max(0, dirDelay[dir] ?? 0)
    const n = trains.length
    const m = trips.length
    const extra = (i) => (trains[i].vs.length > 1 ? ORDER_EXTRA_COST : ORDER_EXTRA_LONE)
    // extraBefore[i]: cost of leaving trains 0..i-1 without a trip.
    const extraBefore = [0]
    for (let i = 0; i < n; i += 1) extraBefore.push(extraBefore[i] + extra(i))
    // A train's delay against a trip, station by station (line time is
    // only good enough to order and group: running times vary by hour).
    const delays = trains.map(() => new Map())
    const delayOf = (i, j) => {
      const memo = delays[i]
      if (memo.has(j)) return memo.get(j)
      const xs = []
      for (const p of trains[i].pts) {
        // A board names the train's destination: a train for Wu Kai Sha is
        // not the Diamond Hill short working beside it in the timetable.
        if (p.dest !== trips[j].dest) continue
        const at = trips[j].boardAt.get(p.station)
        if (at !== undefined) xs.push(p.c - at)
      }
      const d = xs.length ? median(xs) : NaN
      memo.set(j, d)
      return d
    }
    const matchCost = (i, j, prev) => {
      const d = delayOf(i, j)
      if (Number.isNaN(d)) return Infinity
      if (d < -ORDER_EARLY_MAX || d > ORDER_LATE_MAX) return Infinity
      return ORDER_EARLY_CHARGE * Math.max(0, -d - ORDER_EARLY_FREE) + ORDER_RISE_CHARGE * Math.max(0, d - Math.max(prev, base)) + ORDER_LATE_CHARGE * Math.max(0, d - base)
    }
    // best[i][j]: cheapest alignment of trains 0..i ending with train i on
    // trip j; from[i][j] its predecessor pair.
    const best = Array.from({ length: n }, () => new Array(m).fill(Infinity))
    const from = Array.from({ length: n }, () => new Array(m).fill(null))
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < m; j += 1) {
        const d = delayOf(i, j)
        // Start here: trains before i have no trip, trips before j are
        // ahead of the line's first train (finished): free.
        let b = extraBefore[i] + matchCost(i, j, base)
        let f = null
        if (!(d >= -ORDER_EARLY_MAX && d <= ORDER_LATE_MAX)) continue
        for (let i2 = i - 1; i2 >= Math.max(0, i - ORDER_STEP_TRAINS); i2 -= 1) {
          let skip = 0
          for (let k = i2 + 1; k < i; k += 1) skip += extra(k)
          for (let j2 = j - 1; j2 >= Math.max(0, j - ORDER_STEP_TRIPS); j2 -= 1) {
            if (!Number.isFinite(best[i2][j2])) continue
            const prev = delayOf(i2, j2)
            const c = best[i2][j2] + skip + ORDER_HOLE_COST * (j - j2 - 1) + matchCost(i, j, prev)
            if (c < b) {
              b = c
              f = [i2, j2]
            }
          }
        }
        best[i][j] = b
        from[i][j] = f
      }
    }
    // End: trains after the last matched one have no trip.
    let end = null
    let endCost = Infinity
    for (let i = 0; i < n; i += 1) {
      const tail = extraBefore[n] - extraBefore[i + 1]
      for (let j = 0; j < m; j += 1) {
        // Trips after the last match whose slot the last train has passed
        // would have been on the boards: left out, they count as holes.
        let holes = 0
        for (let k = j + 1; k < m && trips[k].order <= trains[n - 1].v; k += 1) holes += 1
        const c = best[i][j] + tail + ORDER_HOLE_COST * holes
        if (c < endCost) {
          endCost = c
          end = [i, j]
        }
      }
    }
    for (let at = end; at; at = from[at[0]][at[1]]) {
        const trip = trips[at[1]]
      if (history?.get(trip.id)?.delay === undefined) out.set(trip.id, delayOf(at[0], at[1]))
    }
  }
  return out
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : undefined
}

// The line's delay from near readings [{ c, list }]: the candidate delay with
// the lowest total distance from each reading to its nearest scheduled event,
// plus a small charge per second late and a larger one per second early. The
// result is the median offset of the readings at that delay.
function estimateLineDelay(near) {
  if (near.length === 0) return 0
  const nearest = (n, d) => {
    let best = null
    for (const e of n.list) {
      const gap = n.c - d - e.arr
      if (best === null || Math.abs(gap) < Math.abs(best)) best = gap
    }
    return best ?? Infinity
  }
  let bestD = 0
  let bestCost = Infinity
  for (let d = LINE_DELAY_MIN; d <= LINE_DELAY_MAX; d += 5) {
    let cost = 0
    for (const n of near) cost += Math.min(Math.abs(nearest(n, d)), 90)
    cost += near.length * (d < 0 ? EARLY_CHARGE * -d : LATE_CHARGE * d)
    if (cost < bestCost - 1e-9) {
      bestCost = cost
      bestD = d
    }
  }
  const offsets = near.map((n) => bestD + nearest(n, bestD)).filter((x) => Math.abs(x - bestD) <= 90).sort((a, b) => a - b)
  return offsets.length ? offsets[offsets.length >> 1] : bestD
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
// The timetable's own headway at tau, measured the way measuredHeadways
// reads the boards: per station and direction, the span of the next four
// scheduled trains over three gaps, median over stations. The `headways`
// bands (headwayAt) are keyed by departure from the first station, so for
// up to a trip's length after a band changes they disagree with what the
// stations actually see (DS1101 DOWN: band 6 min from 09:15, but trains
// still every 3 min at Tsuen Wan West to about 09:50).
export function scheduledHeadway(book, dir, tauSec) {
  if (!book.stationTimes) {
    const by = new Map()
    for (const [key, list] of book.events) {
      const [station, d] = key.split("|")
      for (const e of list) push(by, `${station}|${d}`, e.arr)
    }
    for (const list of by.values()) list.sort((a, b) => a - b)
    book.stationTimes = by
  }
  const spans = []
  for (const [key, list] of book.stationTimes) {
    if (!key.endsWith(`|${dir}`)) continue
    let i = 0
    while (i < list.length && list[i] < tauSec) i += 1
    const next = list.slice(i, i + 4).filter((t) => t <= tauSec + 1500)
    if (next.length >= 2) spans.push((next[next.length - 1] - next[0]) / (next.length - 1))
  }
  spans.sort((a, b) => a - b)
  return spans.length ? spans[spans.length >> 1] : null
}

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
