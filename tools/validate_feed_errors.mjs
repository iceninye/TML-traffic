// Synthetic check of the "can't reach" reason (lib/mtr-feed.js `problem`).
//   node tools/validate_feed_errors.mjs
// The live MTR API cannot be reached offline, so fetch is stubbed.
import { createFeed } from "../lib/mtr-feed.js"

const network = { queries: () => [{ line: "TML", station: "TUM" }] }
const base = { carryArrivalClock: (_, o) => o, estimateTrains: () => [] }
const json = (body, status = 200) => async () => ({ status, json: async () => body })
const cases = [
  ["fetch rejects (offline/CORS/blocked)", async () => { throw new TypeError("Failed to fetch") }, undefined, "network"],
  ["timeout", async () => { throw new DOMException("t", "TimeoutError") }, undefined, "timeout"],
  ["HTML body", async () => ({ status: 200, json: async () => { throw new SyntaxError("x") } }), undefined, "data"],
  ["parser bug (TypeError after a good fetch)", json({ status: 1 }), () => { throw new TypeError("x is undefined") }, "data"],
  ["HTTP 503", json({}, 503), undefined, "HTTP 503"],
]
let bad = 0
for (const [name, fetchImpl, readSchedule, want] of cases) {
  const feed = createFeed(network, { ...base, fetchImpl, readSchedule: readSchedule ?? (() => null) })
  await feed.refresh()
  const ok = feed.problem === want
  if (!ok) bad += 1
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${feed.problem}`)
}
process.exit(bad ? 1 : 0)
