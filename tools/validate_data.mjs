// 資料檢查：壞一個 JSON，TML-traffic 同 tml-roster 兩個網站一齊壞，所以每個 PR 都行。
//   node tools/validate_data.mjs
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

let failed = 0
const check = (ok, what) => {
  if (!ok) {
    failed += 1
    console.log(`✗ ${what}`)
  }
}
const root = new URL("..", import.meta.url).pathname

// data/ 入面每個 JSON 都讀得通
let files = 0
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name.endsWith(".json")) {
      files += 1
      try { JSON.parse(readFileSync(path, "utf8")) } catch (e) { check(false, `${path.slice(root.length)} 讀唔到：${e.message}`) }
    }
  }
}
walk(join(root, "data"))

const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"))
const index = read("data/duties/index.json")
const basic = read("data/duty-basic.json").duties ?? {}
for (const entry of index.sheets) {
  const where = `DS${entry.code}`
  let card
  try { card = read(`data/duties/${entry.file}`) } catch { check(false, `${where}: ${entry.file} 搵唔到`); continue }
  check(card.sha256 === entry.sha256, `${where}: 卡片 sha256 同 index 一致`)
  check(card.duties.length === entry.duties, `${where}: index 寫 ${entry.duties} 個更份，卡片有 ${card.duties.length}`)
  const seen = new Set()
  for (const d of card.duties) {
    check(/^\d{7}$/.test(d.id), `${where}: 更份編號 ${d.id} 唔係 7 位數字`)
    check(!seen.has(d.id), `${where}: 更份 ${d.id} 重複`)
    seen.add(d.id)
    check(Array.isArray(d.on) && Array.isArray(d.off), `${where}: ${d.id} 冇上班／下班時間`)
  }
}
const days = (e) => [...(e.dates ?? []), ...(e.alsoOn ?? [])].sort().join()
const books = read("data/timetables/index.json").timetables
for (const entry of index.sheets) {
  const book = books.find((b) => b.code === `DS${entry.code}`)
  check(!book || days(book) === days(entry), `DS${entry.code}: 兩份 index 嘅運行日一致`)
}
check(Object.keys(basic).length > 0, "duty-basic.json 有更份")

if (failed) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log(`validate_data OK (${files} JSON, ${index.sheets.length} sheets)`)
