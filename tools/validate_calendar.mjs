// 日期對應檢查：data/calendar.json 嘅假期、指定 Duty Sheet，同 index 內嘅運行日有冇撞。
//   node tools/validate_calendar.mjs
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"))
let failed = 0
const check = (ok, what) => {
  if (!ok) {
    failed += 1
    console.log(`✗ ${what}`)
  }
}
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d

const calendar = read("data/calendar.json")
const books = read("data/timetables/index.json").timetables
const codes = new Set(books.map((b) => b.code))

const seen = new Set()
for (const h of calendar.holidays ?? []) {
  check(isDate(h.date), `假期日期格式錯：${h.date}`)
  check(!seen.has(h.date), `假期 ${h.date} 重複`)
  seen.add(h.date)
}
for (const [date, code] of Object.entries(calendar.sheets ?? {})) {
  check(isDate(date), `sheets 日期格式錯：${date}`)
  check(codes.has(code), `${date} 指定嘅 ${code} 唔喺 data/timetables/index.json`)
}
// 同一日有兩份 Duty Sheet 都話自己係嗰日（index 內 dates／alsoOn），又冇喺 calendar.sheets 指明揀邊份
const claims = new Map()
for (const b of books) for (const d of [...(b.dates ?? []), ...(b.alsoOn ?? [])]) claims.set(d, [...(claims.get(d) ?? []), b.code])
for (const [date, list] of claims) {
  const chosen = calendar.sheets?.[date]
  check(list.length < 2 || (chosen && list.includes(chosen)), `${date} 有 ${list.join("、")} 都話自己嗰日行，請喺 calendar.json 嘅 sheets 指明用邊份`)
}
// 提醒（唔算失敗）：假期清單快用完
const last = [...seen].sort().at(-1)
const horizon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
if (!last || last < horizon) console.log(`⚠ 假期清單只去到 ${last ?? "（空）"}，請按政府公佈更新 data/calendar.json`)
const unverified = (calendar.holidays ?? []).filter((h) => h.verified === false).length
if (unverified) console.log(`⚠ 有 ${unverified} 個假期未核對憲報（verified:false）`)

if (failed) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log(`validate_calendar OK (${seen.size} holidays, ${Object.keys(calendar.sheets ?? {}).length} sheets)`)
