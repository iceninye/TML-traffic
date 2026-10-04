// Live end-to-end probe for the extracted Tuen Ma Line pipeline.
//
//   node tools/probe-tml.mjs            # one refresh pass over all 27 stations
//   node tools/probe-tml.mjs --json     # same, machine-readable
//
// Reads the real rt.data.gov.hk feed, chains observations into trains, projects
// each train onto the line, and prints where it is.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { readSchedule } from "../lib/mtr-schedule.js"
import { carryArrivalClock, estimateTrains, projectTrain, metresBetween } from "../lib/mtr-estimate.js"
import { createNetwork } from "../lib/mtr-network.js"
import { createFeed } from "../lib/mtr-feed.js"

const here = dirname(fileURLToPath(import.meta.url))
const networkJson = JSON.parse(readFileSync(join(here, "..", "data", "tml-network.json"), "utf8"))
const network = createNetwork(networkJson)

const asJson = process.argv.includes("--json")
const locale = process.argv.includes("--en") ? "en" : "tc"
const pass = Number(process.env.PASSES ?? 1)

const feed = createFeed(network, { readSchedule, carryArrivalClock, estimateTrains })

const t0 = Date.now()
let read = 0
for (let index = 0; index < pass; index += 1) {
  read += await feed.refresh()
  if (index < pass - 1) await new Promise((done) => setTimeout(done, 1500))
}
const elapsed = Date.now() - t0

const snapshot = feed.snapshot()

if (asJson) {
  console.log(JSON.stringify({ ...snapshot, elapsedMs: elapsed, stationsRead: read }, null, 2))
  process.exit(snapshot.ok ? 0 : 1)
}

console.log(`Tuen Ma Line probe · ${pass} pass(es) · ${read} station reads · ${elapsed} ms`)
console.log(`line: ${network.meta.tc} / ${network.meta.en}  color ${network.meta.color}`)
console.log(`stations in network: ${Object.keys(network.stations).length} · routes: ${network.routes.map((r) => r.id).join(", ")}`)
console.log()

if (!snapshot.ok) {
  console.log(`FEED FAILED: ${snapshot.error}`)
  process.exit(1)
}

console.log(`observedAt: ${snapshot.observedAt}`)
console.log(`boards received: ${snapshot.boards.length} / 27`)
console.log(`trains estimated: ${snapshot.trains.length}`)
console.log()

const rows = snapshot.trains.map((train) => {
  const spot = projectTrain({ ...train, observedAt: train.observedAtMs }, network.point.bind(network), Date.now())
  return { train, spot }
})

rows.sort((a, b) => {
  if (a.train.dest !== b.train.dest) return a.train.dest < b.train.dest ? -1 : 1
  return a.train.observedAtMs - b.train.observedAtMs
})

console.log(
  [
    "dest".padEnd(6),
    "to".padEnd(22),
    "ttnt".padStart(5),
    "plat".padStart(5),
    "anchor".padEnd(7),
    "now between".padEnd(26),
    "next".padEnd(22),
    "min".padStart(5),
    "type".padStart(5),
    "delay".padStart(6),
  ].join(" "),
)
console.log("-".repeat(120))
for (const { train, spot } of rows) {
  const destName = network.name(train.dest, locale)
  const lastPath = train.path[train.path.length - 1]
  const between =
    spot && spot.from !== spot.to
      ? `${network.name(spot.from, "en")} -> ${network.name(spot.to, "en")}`
      : spot
        ? `at ${network.name(spot.from, "en")}${spot.clamp !== "none" ? ` (${spot.clamp})` : ""}`
        : "n/a"
  console.log(
    [
      train.dest.padEnd(6),
      destName.padEnd(22),
      String(train.ttnt).padStart(5),
      String(train.plat || "-").padStart(5),
      train.anchor.padEnd(7),
      between.padEnd(26),
      (spot ? network.name(spot.to, locale) : "-").padEnd(22),
      (spot ? spot.minutes.toFixed(1) : "-").padStart(5),
      train.timeType.padStart(5),
      (train.delay ? "Y" : "-").padStart(6),
    ].join(" "),
  )
  if (train.path[0] !== spot?.from && lastPath) {
    // path origin is informational only; nothing to assert here
  }
}
console.log()

// Sanity: every projected spot must sit on the line. The line's longest hop is
// Tsuen Wan West <-> Kam Sheung Road at 8807 m (Tai Lam Tunnel), so a train
// caught mid-tunnel is legitimately ~4.4 km from either station.
const LONGEST_HOP_HALF_M = 4404
let worst = 0
for (const { spot } of rows) {
  if (!spot) continue
  let nearest = Infinity
  for (const code of Object.keys(network.stations)) {
    const distance = metresBetween(spot, network.point(code))
    if (distance < nearest) nearest = distance
  }
  if (nearest > worst) worst = nearest
}
console.log(`furthest projected train from any station: ${Math.round(worst)} m (limit ${LONGEST_HOP_HALF_M} m — half the Tai Lam Tunnel hop)`)
console.log(`off-line projection detected: ${worst > LONGEST_HOP_HALF_M + 50 ? "YES - BUG" : "no"}`)
console.log(`coverage: ${snapshot.boards.length}/27 stations answered`)
