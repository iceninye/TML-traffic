// data/duty-codes.json 檢查：每個代碼 [工時, 上班, 落班]，上落班要一齊有或者一齊冇（NIL），
// 有時間嘅話落班時間夠長，工時同 Ice 定嘅幾個重點代碼對得上。
//   node tools/validate-duty-codes.mjs
import { readFileSync } from "node:fs"

const { codes } = JSON.parse(readFileSync(new URL("../data/duty-codes.json", import.meta.url), "utf8"))
let failed = 0
const check = (ok, message) => {
  if (!ok) {
    failed += 1
    console.error(`FAIL ${message}`)
  }
}

check(Object.keys(codes).length > 300, "duty-codes.json 有幾百個代碼")
for (const [code, row] of Object.entries(codes)) {
  const [hours, on, off] = row
  check(/^[A-Z0-9/]+$/.test(code), `${code} 代碼格式`)
  check(Number.isFinite(hours) && hours >= 0 && hours <= 12.5, `${code} 工時 ${hours}`)
  check((on === null) === (off === null), `${code} 上班同落班要一齊有或者一齊冇`)
  if (on !== null) check(on >= 0 && on < 86400 && off > on && off <= 86400 * 2, `${code} 時間 ${on}–${off}`)
}

// 表入面重複嘅代碼以表下半部（新版）為準；NIL = 冇固定時間；SPT11／SPT12 係 10 小時。
check(codes.S[2] === 15 * 3600 + 45 * 60 && codes.OF[2] === 15 * 3600 + 45 * 60, "S、OF 落班 15:45")
check(codes.OD[2] === 23 * 3600, "OD 落班 23:00")
check(codes.SPT11[0] === 10 && codes.SPT12[0] === 10, "SPT11／SPT12 係 10 小時")
check(codes.AL[0] === 7 && codes.AL[1] === null && codes.RD[0] === 0 && codes.CL[0] === 0, "AL 7 小時 NIL、RD／CL 0")
check(codes.KSP4[1] === 17 * 3600 && codes.KSP4[2] === 26 * 3600, "KSP4 17:00–02:00（隔日）")

if (failed) {
  console.error(`${failed} 個檢查失敗`)
  process.exit(1)
}
console.log(`duty-codes: ${Object.keys(codes).length} 個代碼，檢查通過`)
