// Check lib/tml-lagstats.js on a synthetic trip: the board keeps 0 for a
// known number of seconds after the dot leaves, and the recorded lag must
// land within one snapshot interval of it.
//
//   node tools/validate_lagstats.mjs
import { createLagStats } from "../lib/tml-lagstats.js"

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
if (failed) process.exit(1)
console.log("validate_lagstats OK")
