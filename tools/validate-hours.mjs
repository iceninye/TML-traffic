// 工時一致性審計：官表（data/duty-basic.json 嘅 Index 表）同 duty sheet 嘅工作時數
// 要對得上，唔對就會令一週總工時靜靜多／少半個鐘。
//   node tools/validate-hours.mjs
// 由 tml-roster 搬過嚟（2026-10-21）：Duty 資料統一喺呢個 repo。
// 已知例外要寫落 KNOWN 並講原因，新嘅唔一致會令 exit code 1。
import { readFileSync, readdirSync } from "node:fs"

const index = JSON.parse(readFileSync(new URL("../data/duty-basic.json", import.meta.url), "utf8")).duties
const fixes = JSON.parse(readFileSync(new URL("../data/duty-hours-fixes.json", import.meta.url), "utf8")).hours ?? {}
const dir = new URL("../data/duties/", import.meta.url)

// id → 原因。呢啲係刻意保留嘅差異，唔算 bug。
const KNOWN = {
  "1101160": "duty sheet 原文寫 7.0，官表 7.5 才對（tml-roster 用官表；卡片照原文）",
}

let failed = 0
let checked = 0
const seen = new Set()

for (const file of readdirSync(dir).filter((name) => /^DS\d+\.json$/.test(name))) {
  const book = JSON.parse(readFileSync(new URL(file, dir), "utf8"))
  for (const duty of book.duties) {
    if (!duty.on || duty.work == null) continue
    const row = index[duty.id]
    if (!row) continue
    checked += 1
    seen.add(duty.id)
    const sheet = duty.work / 60
    const indexHours = row[4]
    if (Math.abs(sheet - indexHours) < 1e-9) continue
    const known = KNOWN[duty.id]
    if (known) {
      console.log(`· ${duty.id}: duty sheet ${sheet} 小時 / 官表 ${indexHours} 小時 — ${known}`)
      continue
    }
    failed += 1
    console.log(`✗ ${duty.id}: duty sheet ${sheet} 小時 / 官表 ${indexHours} 小時（差 ${+(indexHours - sheet).toFixed(2)}）`)
  }
}

// 修正表唔應該指向唔存在嘅更份
for (const code of Object.keys(fixes)) {
  if (!index[code]) {
    failed += 1
    console.log(`✗ data/duty-hours-fixes.json 有 ${code}，但官表冇呢個更份`)
  }
}

// 後備更（KSP／HSP）只有官表有，一定要有時數
for (const [code, row] of Object.entries(index)) {
  if (!/^(KSP|HSP)\d$/.test(code)) continue
  if (typeof row[4] !== "number" || row[4] <= 0) {
    failed += 1
    console.log(`✗ 後備更 ${code} 冇時數`)
  }
}

console.log(failed ? `${failed} 個工時問題` : `✓ ${checked} 個更份工時一致（${Object.keys(KNOWN).length} 個已知例外）`)
process.exit(failed ? 1 : 0)
