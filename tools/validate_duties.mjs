// Checks the duty cards (data/duties) and lib/tml-duties.js on the real data:
//   node tools/validate_duties.mjs
import { readFileSync } from "node:fs"
import { dutyState, onDuty, mealMates, GROUPS } from "../lib/tml-duties.js"

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
      d.legs.every((l) => l[3] >= d.on[0] && (l[5] ?? l[3]) <= d.off[0] + 3600 && (l[5] == null || l[5] >= l[3])) &&
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
// The meal runs from getting off a train to picking up the next one.
check(d101.meal[0] === at(8, 54, 5) && d101.meal[1] === at(10, 39, 55), "8022101 meal is 08:54:05 (alights) to 10:39:55 (picks up)")
st = dutyState(d101, at(8, 56))
check(st.phase === "meal" && st.place === "KSR2" && st.until === at(10, 39, 55), "8022101 08:56 is on the meal break at KSR2")
check(dutyState(d101, at(10, 40)).phase === "drive", "8022101 10:40 drives again")
const d1165 = load("1101").duties.find((d) => d.id === "1101165")
check(d1165.meal[0] === at(19, 44) && d1165.meal[1] === at(20, 57, 55) && d1165.meal[2] === "KSR1" && d1165.meal[3] === "KSR2", "1101165 meal is 19:44 KSR1 to 20:57 KSR2")
const d1101 = load("1101").duties
// 飯腳: same place, meals overlapping by 45 min or more, symmetric.
const mates = mealMates(d1165, d1101)
check(mates.length > 0 && mates.every(({ duty, from, to }) => duty.meal[2] === d1165.meal[2] && to - from >= 2700 && to <= Math.min(d1165.meal[1], duty.meal[1]) && from >= Math.max(d1165.meal[0], duty.meal[0])), `1101165 has ${mates.length} 飯腳, all at KSR1 with 45 min or more of overlap`)
check(mates.every(({ duty }) => mealMates(duty, d1101).some((m) => m.duty.id === "1101165")), "飯腳 is symmetric")
const edge = (start) => mealMates({ id: "x", meal: [0, 4000, "KSR1", "KSR2"] }, [{ id: "y", meal: [start, 4000, "KSR1", "KSR2"] }]).length
check(edge(1300) === 1 && edge(1301) === 0 && mealMates({ id: "x", meal: [0, 4000, "KSR1", "KSR2"] }, [{ id: "z", meal: [0, 4000, "KSR2", "KSR2"] }]).length === 0, "飯腳 edge: exactly 45 min counts, 44:59 does not, another place does not")
const d1334 = d1101.find((d) => d.id === "1101334")
const park = (run, from) => d1334.legs.find((l) => l[1] === run && l[2] === from)
check(park(20, "HUH3")?.[0] === "park" && park(20, "HUH3")[3] === at(16, 58, 24) && park(62, "ETS2")?.[0] === "park", "1101334 Run 20 HUH3→ETS1 16:58:24 and Run 62 ETS2→HUH2 are 泊車")
check(![...["1101", "6091", "7091", "8022", "8023"]].some((c) => load(c).duties.some((d) => d.legs.some((l) => l[0] === "drive" && ((l[2] === "HUH3" && l[4] === "ETS1") || (l[2] === "ETS2" && l[4] === "HUH2"))))), "no HUH3→ETS1 or ETS2→HUH2 leg is left as 載客")
check(!d1101.some((d) => d.id === "1101586") && d1101.find((d) => d.id === "1101107").work === 390 && d1101.find((d) => d.id === "1101131").work === 480, "1101586 skipped, 1101107 and 1101131 keep 6.5 h and 8 h")
check(dutyState(d101, at(13, 15)) === null && dutyState(d101, at(4, 44)) === null, "8022101 is off duty before 04:45 and from 13:15")
const late = load("8022").duties.find((d) => d.id === "8022509")
check(dutyState(late, at(0, 10) + 86400) !== null && dutyState(late, at(0, 30) + 86400) === null, "8022509 crosses midnight and ends 00:26")
process.exit(failed ? 1 : 0)
