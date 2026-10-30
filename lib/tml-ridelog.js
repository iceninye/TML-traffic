// Ride log: ground truth for the dot, recorded on board the train.
//
// The rider picks their train (its train card), starts the log, and taps
// 到站 when the train stops and 開車 when it moves off; the phone's location
// is sampled as well where it has a fix (open-air sections). Each entry
// keeps the rider's time, the event and, for that train, where the dot was
// drawn then (km, phase, stations, display and estimated delay), so the
// dot's arrivals and departures can be checked against the real ones later.
// Stored only in this browser; nothing is sent anywhere.

const MAX_ENTRIES = 3000
const MAX_RIDES = 5
// Location fixes closer together than this are not kept.
const GPS_EVERY_MS = 5000

export function createRideLog(saved = []) {
  let rides = Array.isArray(saved) ? saved.filter((r) => r && Array.isArray(r.entries)).slice(-MAX_RIDES) : []
  let current = null
  let lastGps = -Infinity

  function start(runId, label, now) {
    current = { startedAt: now, runId, label, entries: [] }
    rides = [...rides, current].slice(-MAX_RIDES)
    lastGps = -Infinity
    return current
  }

  // kind: "arr" | "dep" | "gps" | "note"; dot: the run as drawn now (or null).
  function add(kind, now, dot, extra = {}) {
    if (!current) return false
    if (kind === "gps") {
      if (now - lastGps < GPS_EVERY_MS) return false
      lastGps = now
    }
    if (current.entries.length >= MAX_ENTRIES) return false
    current.entries.push({ t: now, kind, ...extra, dot: dot ? snapshotOf(dot) : null })
    return true
  }

  // The train may change id at a terminus (its next trip): follow the Run.
  function follow(runId) {
    if (current) current.runId = runId
  }

  function stop() {
    current = null
  }

  return {
    start,
    add,
    follow,
    stop,
    get current() {
      return current
    },
    rides: () => rides,
    clear() {
      rides = []
      current = null
    },
  }
}

function snapshotOf(run) {
  const pos = run.pos ?? {}
  const round = (x, d = 0) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null)
  return {
    id: run.id,
    run: run.trip?.run ?? null,
    trip: run.trip?.trip ?? null,
    km: round(pos.km, 3),
    phase: pos.phase ?? null,
    from: pos.from ?? null,
    to: pos.to ?? null,
    disp: round(run.delayDisp, 1),
    est: round(run.delayEst, 1),
  }
}
