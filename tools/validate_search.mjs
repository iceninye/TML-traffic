// 技術搜尋 index 同 chainage 解析迴歸：
//   node tools/validate_search.mjs
import { readFileSync } from "node:fs"
import {
  buildTechnicalSearchIndex,
  entryPointsByVccArea,
  findSegmentForChainage,
  mainlineVccAreas,
  pairNeutralZones,
  searchResultMode,
  searchTechnicalIndex,
} from "../lib/td-search.js"

let failed = 0
let passed = 0
const check = (ok, message) => {
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? "✓" : "✗"} ${message}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))

const technical = readJson("../data/td-tml-v2_3_5.json")
const segments = readJson("../data/td-segments.json").segments
const timetable = readJson("../data/tml-timetable.json")
const network = readJson("../data/tml-network.json")
const stationOrder = timetable.hops.map((hop) => hop.from).concat(timetable.hops.at(-1).to)
const stationName = (code) => network.stations[code]?.tc ?? code
const index = buildTechnicalSearchIndex(technical, segments, { stationOrder, stationName })

const counts = {}
for (const item of index.items) counts[item.kind] = (counts[item.kind] ?? 0) + 1
check(same(counts, {
  VCC_AREA: 12,
  VCC_BOUNDARY: 7,
  EP: 240,
  NR: 17,
  EAP: 55,
  CPD: 260,
  NZ: 7,
}), "搜尋 index 各類別數量正確")
check(index.items.length === 598, "搜尋 index 共 598 筆")
check(new Set(index.items.map((item) => item.id)).size === index.items.length, "搜尋結果 ID 唯一")

const facilityKinds = ["VCC_BOUNDARY", "EP", "NR", "EAP", "CPD", "NZ"]
const missingSegments = index.items.filter((item) => facilityKinds.includes(item.kind) && !item.segment)
check(missingSegments.length === 0, `所有技術設施都能解析到站段${missingSegments.length ? `：${missingSegments.slice(0, 5).map((item) => item.id).join("、")}` : ""}`)

const areas = mainlineVccAreas(index)
check(same(areas.map((area) => area.vcc), [1, 2, 4, 5, 6, 7, 8, 9]), "主線 VCC 區域順序為 1、2、4、5、6、7、8、9")
check(areas.every((area) => area.range && Number.isFinite(area.range.from) && Number.isFinite(area.range.to)
  && area.range.from <= area.range.to), "主線 VCC 區域都有有效 chainage 範圍")
const chainageOrderedAreas = [...areas].sort((a, b) => a.range.from - b.range.from)
check(chainageOrderedAreas.every((area, position) => position === 0 || area.range.from === chainageOrderedAreas[position - 1].range.to),
"相鄰 VCC 區域 chainage 範圍連續")

const expectedBoundarySegments = {
  "8:9": "08",
  "7:8": "11",
  "6:7": "13",
  "6:5": "17",
  "5:1": "19",
  "1:2": "22",
  "2:4": "23",
}
for (const boundary of technical.vcc.boundaries) {
  const key = boundary.between.join(":")
  const item = index.items.find((row) => row.id === `vcc-boundary:${key}`)
  check(item?.segment?.id === expectedBoundarySegments[key]
    && item.segments?.UP?.id === expectedBoundarySegments[key]
    && item.segments?.DOWN?.id === expectedBoundarySegments[key],
  `VCC ${boundary.between[0]}↔${boundary.between[1]} 雙向都解析到站段 ${expectedBoundarySegments[key]}`)
}

const epGroups = entryPointsByVccArea(index)
check(epGroups.size === 8, "EP 按 8 個主線 VCC 區域分組")
check([...epGroups.values()].every((group) => group.UP.length > 0 && group.DOWN.length > 0),
"每個主線 VCC 區域都有 UP／DOWN EP")
check([...epGroups.values()].reduce((sum, group) => sum + group.UP.length + group.DOWN.length, 0) === 240,
"EP 分組完整收錄 240 筆")
check(same(epGroups.get(1)?.UP.map((item) => item.data.id).slice(0, 3), ["1-43", "1-1", "1-3"])
  && same(epGroups.get(1)?.DOWN.map((item) => item.data.id).slice(0, 3), ["1-44", "1-2", "1-5"]),
"VCC 1 UP／DOWN EP 按 chainage 排序")

const ep12 = index.items.find((item) => item.id === "ep:1-2")
check(ep12?.track === "DOWN" && ep12.direction === "WKS" && ep12.vccArea === 1 && ep12.segment?.id === "20",
"EP 1-2 正確解析為 DOWN、WKS 方向、VCC 1、站段 20")
const cpdNac43 = index.items.find((item) => item.id === "cpd:NAC43")
check(cpdNac43?.segment?.id === "20" && cpdNac43.track === "BOTH" && cpdNac43.dual === true,
"CPD NAC43 共用軌解析到站段 20 並啟用雙軌")
const eapWks = index.items.find((item) => item.id === "eap:WKS EAP 13")
check(eapWks?.segment?.id === "02" && eapWks.dual === true && searchResultMode(eapWks) === "dual",
"WKS EAP 13 正確包含止衝擋站段 02 並啟用雙軌")
const tkwEap = index.items.find((item) => item.id === "eap:TKW EAP")
const homEap = index.items.find((item) => item.id === "eap:HOM EAP")
check(tkwEap?.segments?.UP?.id === "14" && tkwEap?.segments?.DOWN?.id === "15"
  && homEap?.segments?.UP?.id === "15" && homEap?.segments?.DOWN?.id === "16"
  && searchResultMode(tkwEap) === "single" && searchResultMode(homEap) === "single",
"上下行落在相鄰站段嘅 EAP 安全回落單軌，唔會切換後漏掉目標")
const nrAustin = index.items.find((item) => item.id === "nr:NAC-NR-02-107.795")
check(nrAustin?.segment?.id === "19" && nrAustin.track === "UP", "Niche Room 解析到 AUS—NAC UP 站段")

const neutralPairs = pairNeutralZones(technical.neutralZones)
check(neutralPairs.length === 7 && neutralPairs.every((pair) => pair.up && pair.down),
"14 個 Neutral Zone 配對成 7 組 UP／DOWN")
const cioPair = index.items.find((item) => item.id === "nz:CIO")
check(cioPair?.segment?.id === "07" && cioPair.dual === true && cioPair.defaultDir === "UP",
"Neutral Zone CIO 配對解析到站段 07 並啟用雙軌")

check(findSegmentForChainage(segments, "UP", 81.237)?.id === "02", "WKS 止衝擋 chainage 回落到 WKS—MOS 站段")
check(findSegmentForChainage(segments, "DOWN", [98.854, 98.852])?.id === "13", "number[] chainage 可用於站段解析")

const epSearch = searchTechnicalIndex(index, "1-2", "EP")
check(epSearch[0]?.id === "ep:1-2", "搜尋 EP 1-2 將完全匹配排在首位")
check(!searchTechnicalIndex(index, "1-2", "EP").some((item) => item.id === "ep:1612"),
"EP 搜尋不會把 1-2 誤配成 1612")
check(searchTechnicalIndex(index, "美孚", "ALL").length > 0
  && searchTechnicalIndex(index, "美孚", "ALL").every((item) => item.searchText.includes("美孚")),
"車站中文名可以搜尋技術設施")
check(searchTechnicalIndex(index, "NAC43", "CPD")[0]?.id === "cpd:NAC43", "CPD 編號可以搜尋")
check(searchTechnicalIndex(index, "WKS EAP 13", "EAP")[0]?.id === "eap:WKS EAP 13", "EAP 名稱可以搜尋")
check(searchTechnicalIndex(index, "HP 601", "NZ")[0]?.id === "nz:HP", "Neutral Zone 編號可以搜尋")
check(searchTechnicalIndex(index, "6-7", "VCC").some((item) => item.id === "vcc-boundary:6:7"),
"VCC 交界可以搜尋")

if (failed) {
  console.error(`✗ 技術搜尋驗證失敗：${failed} 個檢查未通過，${passed} 個通過`)
  process.exit(1)
}
console.log(`✓ 技術搜尋驗證全部通過（${passed} 個檢查）`)
