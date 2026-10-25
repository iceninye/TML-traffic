// Log-only measurement: how long a station board keeps reporting 0 for a
// train after the train's dot has left that platform.
//
// A train held at a platform shows on the boards as "0" that does not go
// away, but a train that has just left also stays at 0 for a while (docs/
// ALGORITHM.md §3d, §3g, §3j). Whether "0 for longer than X s after the dot
// left" can be read as "held" depends on how long that lag really is, which
// only live boards can say. This records it. It never touches a position.
//
// Per matched trip and platform: the dot "leaves" at the stop's scheduled
// departure plus the display delay; the board's last 0 for that trip is the
// last snapshot that listed one. lag = last 0 - dot departure (>= 0), with the
// snapshot interval (about 20 s) as its resolution. Only the samples are
// kept (station, lag, time), the most recent MAX_SAMPLES of them.

const MAX_SAMPLES = 500
// A 0 still showing this long after the dot left ends the record as "held".
const HELD_CAP_SEC = 180
// Forget a platform record this long after its trip last appeared.
const FORGET_MS = 120_000
export const THRESHOLDS = [20, 30, 40, 60, 90]

export function createLagStats(samples = []) {
  const recs = new Map()
  let list = samples.filter((s) => s && typeof s.code === "string" && Number.isFinite(s.lag) && Number.isFinite(s.at)).slice(-MAX_SAMPLES)
  let changed = false

  function finish(key, rec) {
    // A 0 that is still listed keeps its (finished) record so it is not
    // started again; it goes when the 0 does or the trip is forgotten.
    if (rec.done) return
    rec.done = true
    if (rec.lastZero == null) return
    list.push({ code: rec.code, lag: Math.min(HELD_CAP_SEC, Math.max(0, Math.round((rec.lastZero - rec.dep) / 1000))), at: rec.lastZero })
    if (list.length > MAX_SAMPLES) list.shift()
    changed = true
  }

  // matched: Map tripId -> { trip, readings }; delayOf: tripId -> display
  // delay (s) or undefined; dayStart: epoch ms of the service day's start.
  function observe({ matched, delayOf, dayStart, now }) {
    for (const [id, entry] of matched) {
      const delay = delayOf(id)
      if (!Number.isFinite(delay)) continue
      const stops = entry.trip.stops
      for (let k = 1; k < stops.length - 1; k += 1) {
        const stop = stops[k]
        if (stop.empty) continue
        const dep = dayStart + (stop.dep + delay) * 1000
        const key = `${id}|${stop.code}`
        let rec = recs.get(key)
        const zero = entry.readings.some((r) => r.station === stop.code && r.ttnt === 0)
        if (zero && !rec) {
          rec = { code: stop.code, dep, lastZero: null, seen: now, done: false }
          recs.set(key, rec)
        }
        if (!rec) continue
        if (zero && !rec.done) rec.lastZero = now
        rec.seen = now
        rec.dep = dep
        if (now < dep) continue
        // The dot has left. The 0 has gone, or has stood too long.
        if (!zero) {
          finish(key, rec)
          recs.delete(key)
        } else if (now - dep > HELD_CAP_SEC * 1000) finish(key, rec)
      }
    }
    for (const [key, rec] of recs) {
      if (now - rec.seen <= FORGET_MS) continue
      finish(key, rec)
      recs.delete(key)
    }
  }

  // Share of samples whose lag exceeds each threshold, and per-station
  // median / 90th percentile.
  function summary() {
    const n = list.length
    const over = THRESHOLDS.map((t) => ({ sec: t, share: n ? list.filter((s) => s.lag > t).length / n : 0 }))
    const by = new Map()
    for (const s of list) by.set(s.code, [...(by.get(s.code) ?? []), s.lag])
    const pick = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]
    const stations = [...by].map(([code, xs]) => {
      const sorted = [...xs].sort((a, b) => a - b)
      return { code, n: xs.length, median: pick(sorted, 0.5), p90: pick(sorted, 0.9) }
    }).sort((a, b) => b.n - a.n)
    return { n, over, stations }
  }

  return {
    observe,
    summary,
    samples: () => list,
    // True once since the last call if samples were added.
    takeChanged() {
      const was = changed
      changed = false
      return was
    },
    clear() {
      list = []
      recs.clear()
      changed = true
    },
  }
}
