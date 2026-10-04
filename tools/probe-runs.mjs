// Verifies the animation layer against two live snapshots taken 12 s apart.
//
//   node tools/probe-runs.mjs
//
// Two snapshots of the same line rarely agree on where a train is: the feed's
// countdown is whole minutes, so a naive redraw makes dots jump. mergeRuns() is
// supposed to stop that by keeping the tracked run's own distance and letting
// advanceRuns() walk it forward. This prints the jump both ways.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { readSchedule } from "../lib/mtr-schedule.js"
import { carryArrivalClock, estimateTrains } from "../lib/mtr-estimate.js"
import { createNetwork } from "../lib/mtr-network.js"
import { createFeed } from "../lib/mtr-feed.js"
import { advanceRuns, mergeRuns, runCollection, runsFromTrains } from "../lib/mtr-run.js"

const here = dirname(fileURLToPath(import.meta.url))
const network = createNetwork(JSON.parse(readFileSync(join(here, "..", "data", "tml-network.json"), "utf8")))
const locate = network.point.bind(network)

const GAP_MS = Number(process.env.GAP_MS ?? 12_000)
const feed = createFeed(network, { readSchedule, carryArrivalClock, estimateTrains })

const t1 = Date.now()
await feed.refresh(t1)
const snap1 = feed.snapshot(t1)
const runs1 = runsFromTrains(snap1.trains, locate, () => network.meta.color, t1)
console.log(`snapshot 1 · ${snap1.trains.length} trains -> ${runs1.length} runs`)

console.log(`waiting ${(GAP_MS / 1000).toFixed(0)} s...`)
await new Promise((done) => setTimeout(done, GAP_MS))

const t2 = Date.now()
await feed.refresh(t2)
const snap2 = feed.snapshot(t2)
const runs2 = runsFromTrains(snap2.trains, locate, () => network.meta.color, t2)
console.log(`snapshot 2 · ${snap2.trains.length} trains -> ${runs2.length} runs`)
console.log()

// The real question: at the moment a new snapshot lands, how far does a dot move?
// Correct usage keeps a running animation state, advances it every frame, and
// merges each new snapshot INTO it. The wrong way is to redraw the raw snapshot.
//
//   right: state = advanceRuns(state, dt)  ... every frame
//          state = mergeRuns(state, runsFromTrains(snapshot), now)  ... on refresh
//   wrong: state = runsFromTrains(snapshot)   <- dot teleports
const ticked = advanceRuns(runs1, GAP_MS / 1000, locate)
const merged = mergeRuns(ticked, runs2, t2)

const naive = pairJumps(ticked, runs2)
const trackedJumps = pairJumps(ticked, merged.filter((run) => ticked.some((old) => old.id === run.id)))

const tracked = merged.filter((run) => ticked.some((old) => old.id === run.id))
const newRuns = merged.length - tracked.length
const carriedOver = ticked.filter((run) => merged.some((item) => item.id === run.id))

console.log(`runs after merge      : ${merged.length}  (tracked ${tracked.length}, new ${newRuns})`)
console.log(`dropped from frame 1  : ${ticked.length - carriedOver.length}`)
console.log()
console.log(`how far a dot moves when the new snapshot lands (metres):`)
console.log(`  rebuild from snapshot (no animation layer) : ${describe(naive)}`)
console.log(`  mergeRuns into running state                : ${describe(trackedJumps)}`)
console.log()
console.log(`expected forward travel over ${(GAP_MS / 1000).toFixed(0)} s at ~18 m/s: ~${Math.round(18 * (GAP_MS / 1000))} m`)
console.log(`actual advanceRuns travel              : ${describe(pairJumps(runs1, ticked))}`)
console.log()
const collection = runCollection(merged, locate)
console.log(`runCollection -> ${collection.features.length} drawable points (stacking removed ${merged.length - collection.features.length})`)
const doubled = merged.length - collection.features.length
console.log(`duplicate/stacked runs suppressed: ${doubled}`)
console.log()
if (collection.features.length === 0) {
  console.log("FAIL: nothing drawable")
  process.exit(1)
}
console.log("OK")

function pairJumps(from, to) {
  const jumps = []
  for (const run of from) {
    let best = Infinity
    for (const item of to) {
      if (item.line !== run.line || item.dest !== run.dest) continue
      const gap = Math.abs(item.distance - run.distance)
      if (gap < best) best = gap
    }
    if (Number.isFinite(best)) jumps.push(best)
  }
  return jumps
}

function describe(values) {
  if (values.length === 0) return "n/a"
  const sorted = [...values].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const max = sorted[sorted.length - 1]
  return `median ${Math.round(median)} m · max ${Math.round(max)} m · n=${values.length}`
}
