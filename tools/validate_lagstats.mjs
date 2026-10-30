// Check lib/tml-lagstats.js on a synthetic trip: the board keeps 0 for a
// known number of seconds after the dot leaves, and the recorded lag must
// land within one snapshot interval of it.
//
//   node tools/validate_lagstats.mjs
import { createLagStats } from "../lib/tml-lagstats.js"
import { createRideLog } from "../lib/tml-ridelog.js"

const SNAP = 20.5
const stops = [
  { code: "AAA", arr: 0, dep: 30 },
  { code: "BBB", arr: 100, dep: 130 },
  { code: "CCC", arr: 200, dep: 230 },
  { code: "DDD", arr: 300, dep: 300 },
]
const trip = { id: "t1", stops }
const dayStart = 0
let failed = 0

function run(lagSec, holdSec = 0) {
  const stats = createLagStats()
  for (let t = 0; t < 400; t += SNAP) {
    // The board lists a 0 at BBB from arrival until lagSec (+ hold) after the dot's departure.
    const zero = t >= 100 && t <= 130 + holdSec + lagSec
    const readings = zero ? [{ station: "BBB", ttnt: 0 }] : [{ station: "CCC", ttnt: 2 }]
    stats.observe({ matched: new Map([["t1", { trip, readings }]]), delayOf: () => 0, dayStart, now: t * 1000 })
  }
  return stats.samples()
}

function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`)
}

for (const lag of [0, 20, 40, 75]) {
  const s = run(lag)
  const got = s.length === 1 ? s[0].lag : null
  check(`board lag ${lag} s`, s.length === 1 && s[0].code === "BBB" && got !== null && Math.abs(got - lag) <= SNAP, `recorded ${got}`)
}
{
  // The board reads 0 from t = 100 (the dot's arrival): arr within a snapshot.
  const s = run(20)
  check("arrival offset", s.length === 1 && Number.isFinite(s[0].arr) && Math.abs(s[0].arr) <= SNAP, `arr ${s[0]?.arr}`)
}
{
  const s = run(0, 400)
  check("held: capped, one sample", s.length === 1 && s[0].lag >= 120, `recorded ${s[0]?.lag}`)
}
{
  const stats = createLagStats()
  stats.observe({ matched: new Map([["t1", { trip, readings: [] }]]), delayOf: () => undefined, dayStart, now: 0 })
  check("no delay, nothing recorded", stats.samples().length === 0)
}
{
  const stats = createLagStats(run(40))
  const sum = stats.summary()
  check("summary", sum.n === 1 && sum.over.find((x) => x.sec === 20).share === 1 && sum.over.find((x) => x.sec === 60).share === 0, JSON.stringify(sum.over.map((x) => x.share)))
  check("reload ignores junk", createLagStats([null, { code: 1 }, { code: "X", lag: 5, at: 1 }]).samples().length === 1)
}
{
  // Ride log: taps always kept, location fixes thinned to one per 5 s.
  const log = createRideLog()
  const dot = { id: "t1", trip: { run: 12, trip: 101 }, pos: { km: 3.21456, phase: "dwell", from: "BBB", to: "BBB" }, delayDisp: 12.34, delayEst: 15 }
  log.start("t1", "12", 0)
  log.add("arr", 1000, dot)
  log.add("gps", 1000, dot, { lat: 22.3, lon: 114.2, acc: 8 })
  log.add("gps", 3000, dot, { lat: 22.3, lon: 114.2, acc: 8 })
  log.add("gps", 7000, dot, { lat: 22.3, lon: 114.2, acc: 8 })
  log.add("dep", 8000, null)
  const e = log.current.entries
  check("ride log entries", e.length === 4 && e[0].dot.km === 3.215 && e[0].dot.run === 12 && e[3].dot === null, e.map((x) => x.kind).join(","))
  log.stop()
  check("ride log stopped", !log.add("arr", 9000, dot) && createRideLog(log.rides()).rides().length === 1)
}
if (failed) process.exit(1)
console.log("validate_lagstats OK")
