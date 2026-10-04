// Derived TML artifact: per-hop straight-line distance and the estimator's
// modelled running time. Regenerate with: node tools/build-segments.mjs
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createNetwork } from "../lib/mtr-network.js"
import { metresBetween, segmentMinutes } from "../lib/mtr-estimate.js"

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, "..", "data", "tml-network.json")
const network = createNetwork(JSON.parse(readFileSync(file, "utf8")))
const order = network.routes.find((r) => r.id === "TML-UT").stations

const hops = []
for (let index = 1; index < order.length; index += 1) {
  const from = order[index - 1]
  const to = order[index]
  const metres = metresBetween(network.point(from), network.point(to))
  hops.push({
    from,
    to,
    metres: Math.round(metres),
    minutes: Number(segmentMinutes(metres).toFixed(3)),
  })
}
const totalMetres = hops.reduce((sum, hop) => sum + hop.metres, 0)
const totalMinutes = hops.reduce((sum, hop) => sum + hop.minutes, 0)
writeFileSync(
  join(here, "..", "data", "tml-segments.json"),
  JSON.stringify(
    {
      line: "TML",
      order: "TML-UT (Wu Kai Sha -> Tuen Mun)",
      note: "minutes is the estimator's running-time model (no station dwell). Straight-line distance, not track length.",
      totalMetres,
      totalKm: Number((totalMetres / 1000).toFixed(1)),
      totalMinutes: Number(totalMinutes.toFixed(1)),
      hops,
    },
    null,
    1,
  ) + "\n",
)
console.log(`wrote data/tml-segments.json — ${hops.length} hops, ${(totalMetres / 1000).toFixed(1)} km, ${totalMinutes.toFixed(1)} min modelled`)
