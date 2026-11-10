// 未來幾日預計用邊份時間表／Duty Sheet，同有冇需要人手處理嘅缺口。
//   node tools/coverage.mjs [--days 14] [--md]
// --md：輸出 Markdown（每週 GitHub Action 用嚟開 Issue）。有警告時 exit code 為 2。
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { calendarDay, entriesForDate, pickFirstEntry, serviceDate } from "../lib/tml-timetable.js"

const root = new URL("..", import.meta.url).pathname
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"))
const argv = process.argv.slice(2)
const days = Number(argv[argv.indexOf("--days") + 1]) || 14
const md = argv.includes("--md")

const books = read("data/timetables/index.json").timetables
const calendar = read("data/calendar.json")
const holidays = new Map((calendar.holidays ?? []).map((h) => [h.date, h.name]))
const holidaySet = new Set(holidays.keys())
const names = ["日", "一", "二", "三", "四", "五", "六"]

const rows = []
const warnings = []
const start = Date.now()
for (let i = 0; i < days; i++) {
  const ms = start + i * 86_400_000
  const date = serviceDate(ms)
  const noon = Date.parse(`${date}T12:00:00+08:00`)
  const day = calendarDay(noon, holidaySet)
  const entries = entriesForDate(books.filter((e) => e.source !== "dutysheet" || e.primary), date, calendar)
  const pick = pickFirstEntry(entries, day, date, calendar)
  const dow = names[new Date(noon + 8 * 3_600_000).getUTCDay()]
  let why = "常規"
  if (calendar.sheets?.[date]) why = "calendar.json 指定"
  else if (pick?.dates?.includes(date)) why = "該日專屬"
  else if (holidays.has(date)) why = `假期（${holidays.get(date)}）`
  if (!pick) warnings.push(`${date}（${dow}）：搵唔到任何時間表`)
  else if (pick.source !== "dutysheet") warnings.push(`${date}（${dow}）：用 ${pick.code}，冇 Duty Sheet，App 會顯示「不適用」`)
  rows.push({ date, dow, day, code: pick?.code ?? "—", why })
}
const last = [...holidaySet].sort().at(-1)
if (!last || last < new Date(start + 60 * 86_400_000).toISOString().slice(0, 10)) warnings.push(`公眾假期清單只去到 ${last ?? "（空）"}，請按政府公佈更新 data/calendar.json`)
const unverified = (calendar.holidays ?? []).filter((h) => h.verified === false && h.date >= serviceDate(start)).length
if (unverified) warnings.push(`有 ${unverified} 個將來嘅假期仍未核對憲報（verified:false）`)

if (md) {
  console.log(`## 未來 ${days} 日預計使用嘅 Duty Sheet\n`)
  console.log("請睇有冇日子應該用另一份（例如特別日）：改 `data/calendar.json` 嘅 `sheets` 即可。\n")
  console.log("| 日期 | 星期 | 日型 | 預計使用 | 原因 |\n|---|---|---|---|---|")
  for (const r of rows) console.log(`| ${r.date} | ${r.dow} | ${r.day} | ${r.code} | ${r.why} |`)
  console.log(warnings.length ? `\n### 需要留意\n${warnings.map((w) => `- ${w}`).join("\n")}` : "\n沒有需要留意嘅缺口。")
} else {
  for (const r of rows) console.log(`${r.date} (${r.dow}) ${r.day.padEnd(8)} ${r.code.padEnd(8)} ${r.why}`)
  for (const w of warnings) console.log(`⚠ ${w}`)
}
process.exit(warnings.length ? 2 : 0)
