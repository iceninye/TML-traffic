// 日期對應檢查：data/calendar.json 嘅假期、指定 Duty Sheet，同 index 內嘅運行日有冇撞。
//   node tools/validate_calendar.mjs
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { applyOverlays, pendingNotices, serviceDate } from "../lib/tml-timetable.js"

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

// Run 851 保留兩星期內 19/11 前嘅平日，19/11 起取消；唔改其他班次。
const { overlays, notices } = read("data/overlays.json")
const running851 = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18"]
const extra851 = overlays.find((o) => o.id === "2026-w46-run851")
check(isDeepStrictEqual(extra851?.dates, running851), "Run 851 只喺 9–13/11 同 16–18/11 運行")
for (const entry of books) {
  const raw = read(`data/timetables/${entry.file}`)
  const before = JSON.stringify(raw)
  for (let day = 1; day <= 30; day += 1) {
    const date = `2026-11-${String(day).padStart(2, "0")}`
    const active = raw.day === "weekday" && running851.includes(date)
    const result = applyOverlays(raw, overlays, date)
    const run851 = result.trips.filter((t) => t.run === 851)
    check(run851.length === (active ? 2 : 0), `${entry.code} ${date}: Run 851 ${active ? "有上下行各一程" : "唔應該出現"}`)
    check(isDeepStrictEqual(result.trips.filter((t) => t.run !== 851), raw.trips), `${entry.code} ${date}: 其他班次不變`)
    check(active || result === raw, `${entry.code} ${date}: 冇加班車時保留原表`)
  }
  check(JSON.stringify(raw) === before, `${entry.code}: 原表冇被修改`)
}
const lastServiceDate = serviceDate(Date.parse("2026-11-19T03:59:59+08:00"))
const cancelledServiceDate = serviceDate(Date.parse("2026-11-19T04:00:00+08:00"))
check(lastServiceDate === "2026-11-18" && cancelledServiceDate === "2026-11-19", "取消日期沿用香港時間 04:00 營運日分界")
check(calendar.sheets["2026-11-17"] === "DS8027", "17/11 指定 Duty Sheet 8027 不變")
const oldNotice = notices.find((n) => n.id === "2026-w46-duty-sheets")
check(isDeepStrictEqual(oldNotice?.dates, running851.slice(0, 5)), "上星期提示日期不變")
const cancellation = notices.find((n) => n.id === "2026-w47-run851-cancelled")
check(isDeepStrictEqual(cancellation?.dates, ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]), "本星期每日都有取消提示")
check(cancellation?.text.includes("11月19日（星期四）起取消"), "提示列明 19/11 起取消")
for (const date of ["2026-11-18", "2026-11-19", "2026-11-20"]) {
  check(pendingNotices(notices, date, (id) => id === "2026-w46-duty-sheets").some((n) => n.id === cancellation?.id), `${date}: 已確認上星期提示仍會見到新提示`)
  check(pendingNotices(notices, date, () => true).length === 0, `${date}: 新提示確認後唔重複彈出`)
}
check(pendingNotices(notices, "2026-11-21", () => false).length === 0, "本星期完結後取消提示到期")

if (failed) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log(`validate_calendar OK (${seen.size} holidays, ${Object.keys(calendar.sheets ?? {}).length} sheets, Run 851 cancellation)`)
