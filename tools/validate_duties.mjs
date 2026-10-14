// Checks the duty cards (data/duties) and lib/tml-duties.js on the real data:
//   node tools/validate_duties.mjs
import { readFileSync } from "node:fs"
import { dutyState, onDuty, GROUPS } from "../lib/tml-duties.js"

let failed = 0
const check = (ok, what) => {
  if (!ok) failed += 1
  console.log(`${ok ? "✓" : "✗"} ${what}`)
}
const load = (code) => JSON.parse(readFileSync(new URL(`../data/duties/DS${code}.json`, import.meta.url), "utf8"))
const index = JSON.parse(readFileSync(new URL("../data/duties/index.json", import.meta.url), "utf8"))

for (const entry of index.sheets) {
  const book = load(entry.code)
  check(book.duties.length === entry.duties, `DS${entry.code}: index count ${entry.duties} matches ${book.duties.length}`)
  check(new Set(book.duties.map((d) => d.id)).size === book.duties.length, `DS${entry.code}: duty numbers are unique`)
  check(book.duties.every((d) => GROUPS.includes(d.group) && d.id[4] === { KSR: "1", TAD: "3", HHS: "5" }[d.group]),
    `DS${entry.code}: group agrees with the fifth digit`)
  if (book.cards === false) continue
  let bad = 0
  let timeline = 0
  for (const d of book.duties) {
    const ok =
      d.off[0] > d.on[0] &&
      d.legs.length > 0 &&
      d.legs.every((l) => l[3] >= d.on[0] && (l[5] ?? l[3]) <= d.off[0] + 1800 && (l[5] == null || l[5] >= l[3])) &&
      (!d.meal || (d.meal[0] >= d.on[0] && d.meal[1] <= d.off[0] && d.meal[1] > d.meal[0]))
    if (!ok) bad += 1
    // Every second minute from book on to book off has a state that ends later and names a next step.
    for (let tau = d.on[0]; tau < d.off[0]; tau += 120) {
      const st = dutyState(d, tau)
      if (!st || !(st.until > tau) || st.until > d.off[0] || !st.next) timeline += 1
    }
    if (dutyState(d, d.on[0] - 1) !== null || dutyState(d, d.off[0]) !== null) timeline += 1
  }
  check(bad === 0, `DS${entry.code}: ${book.duties.length} cards ordered inside book on/off (${bad} off)`)
  check(timeline === 0, `DS${entry.code}: every duty has a state at every point of its day (${timeline} gaps)`)
  const hours = [4.9, 6, 10, 14, 18, 22, 24.5].map((h) => [h, onDuty(book.duties, h * 3600).length])
  check(hours.every(([, n]) => n > 0), `DS${entry.code}: duties on at ${hours.map(([h, n]) => `${h}h=${n}`).join(" ")}`)
}

const d101 = load("8022").duties.find((d) => d.id === "8022101")
const at = (h, m, s = 0) => h * 3600 + m * 60 + s
let st = dutyState(d101, at(5, 50))
check(st.phase === "drive" && st.run === 25 && st.from === "TUM" && st.to === "WKS", "8022101 05:50 drives Run 25 TUM→WKS")
check(dutyState(d101, at(4, 50)).phase === "prep", "8022101 04:50 is preparing")
st = dutyState(d101, at(8, 56))
check(st.phase === "wait" && st.place === "KSR2" && st.until === at(8, 58, 5) && st.next.type === "meal", "8022101 08:56 waits at KSR2 for the meal")
check(dutyState(d101, at(9, 0)).phase === "meal", "8022101 09:00 is on the meal break")
check(dutyState(d101, at(13, 15)) === null && dutyState(d101, at(4, 44)) === null, "8022101 is off duty before 04:45 and from 13:15")
const late = load("8022").duties.find((d) => d.id === "8022509")
check(dutyState(late, at(0, 10) + 86400) !== null && dutyState(late, at(0, 30) + 86400) === null, "8022509 crosses midnight and ends 00:26")
process.exit(failed ? 1 : 0)
