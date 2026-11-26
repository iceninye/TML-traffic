// 技術資料層檢查：
//   node tools/validate_td.mjs
import { readFileSync } from "node:fs"
import { chainageValues, formatEp, recordsForRange, travelRange } from "../lib/td-infrastructure.js"

let failed = 0
let passed = 0
const check = (ok, message) => {
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? "✓" : "✗"} ${message}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
  } catch (error) {
    check(false, `${path} JSON 解析失敗：${error.message}`)
    return null
  }
}
const attempt = (fn) => {
  try {
    return fn()
  } catch (error) {
    check(false, `函數執行失敗：${error.message}`)
    return null
  }
}

const technical = readJson("../data/td-tml-v2_3_4.json")
const segmentData = readJson("../data/td-segments.json")
if (!technical || !segmentData) {
  console.error(`✗ 技術資料驗證失敗：${failed} 個檢查未通過`)
  process.exit(1)
}

check(technical.schemaVersion === "2.3.4", "技術 JSON schemaVersion 為 2.3.4")
const expectedCounts = [
  ["entryPointLines", 120],
  ["entryPoints", 240],
  ["crossPassageDoors", 261],
  ["neutralZones", 14],
]
for (const [key, expected] of expectedCounts) {
  check(Array.isArray(technical[key]) && technical[key].length === expected, `${key} 數量為 ${expected}`)
}
const pureCpds = (technical.crossPassageDoors ?? []).filter((row) => row.type === "crossPassageDoor")
const platformRefs = (technical.crossPassageDoors ?? []).filter((row) => row.type === "platformEdgeReference")
check(pureCpds.length === 260, "純 CPD 數量為 260")
check(platformRefs.length === 1, "platformEdgeReference 數量為 1")
check(technical.vcc?.boundaries?.length === 7, "VCC boundaries 數量為 7")

const idCollections = [
  ["entryPoints", technical.entryPoints, (row) => row.id],
  ["emergencyAccessPoints", technical.emergencyAccessPoints, (row) => row.id],
  ["crossPassageDoors", technical.crossPassageDoors, (row) => row.id],
  ["neutralZones", technical.neutralZones, (row) => row.isolator],
  ["crossovers", technical.crossovers, (row) => row.id],
  ["physicalInterfaces", technical.physicalInterfaces, (row) => row.id],
  ["turnouts", technical.turnouts, (row) => row.id],
]
const allIds = []
for (const [name, rows, idOf] of idCollections) {
  if (!Array.isArray(rows)) {
    check(false, `${name} 可供 ID 唯一性檢查`)
    continue
  }
  const ids = rows.map(idOf)
  check(ids.every((id) => typeof id === "string" && id.length > 0)
    && new Set(ids).size === ids.length, `${name} ID 完整且唯一`)
  allIds.push(...ids)
}
check(new Set(allIds).size === allIds.length, "技術設施 ID 在各資料表之間唯一")

const epById = new Map((technical.entryPoints ?? []).map((row) => [row.id, row]))
const epErrors = []
const mappedIds = []
for (const line of technical.entryPointLines ?? []) {
  for (const [color, direction, pairedColor] of [["yellowEP", "tum", "greenEP"], ["greenEP", "wks", "yellowEP"]]) {
    const ep = epById.get(line[color])
    mappedIds.push(line[color])
    if (!ep || ep.direction !== direction || ep.track !== line.track || !same(ep.chainageKm, line.chainageKm)
      || ep.pairedEpId !== line[pairedColor]) epErrors.push(`${line[color]}（${color}）`)
  }
}
check(epErrors.length === 0, `yellowEP→tum、greenEP→wks 的 ID、軌道及里程對應${epErrors.length ? `：${epErrors.slice(0, 5).join("、")}` : ""}`)
check(mappedIds.length === 240 && new Set(mappedIds).size === 240, "120 條 EP 線完整映射至 240 個 EP ID")

for (const [raw, expected] of [["1603", "16-3"], ["1605", "16-5"], ["1410", "14-10"], ["7-11", "7-11"]]) {
  check(formatEp(raw) === expected, `formatEp(${raw}) → ${expected}`)
}
check(same(chainageValues(127.964), [127.964])
  && same(chainageValues([98.842, 98.84]), [98.842, 98.84]), "chainageValues 支援 number 及 number[]")

check(segmentData.schemaVersion === 1, "站段 JSON schemaVersion 為 1")
check(segmentData.source === "TML_full_line_technical_reference_v2_3_4.md §3", "站段 JSON 標示參考文件 §3")
const segments = segmentData.segments ?? []
check(segments.length === 27, "站段數量為 27")
check(same(segments.map((segment) => segment.id), Array.from({ length: 27 }, (_, index) => String(index + 1).padStart(2, "0"))), "站段 ID 由 01 連續至 27")
const stationSegments = segments.slice(1)
const stations = stationSegments.length ? [stationSegments[0].from, ...stationSegments.map((segment) => segment.to)] : []
const expectedStations = ["WKS", "MOS", "HEO", "TSH", "SHM", "CIO", "STW", "CKT", "TAW", "HIK", "DIH", "KAT", "SUW", "TKW", "HOM", "HUH", "ETS", "AUS", "NAC", "MEF", "TWW", "KSR", "YUL", "LOP", "TIS", "SIH", "TUM"]
check(same(stations, expectedStations), "站段車站順序為 WKS→TUM 且連續")
const allTravelRanges = []
for (let index = 0; index < stations.length - 1; index++) {
  for (const dir of ["up", "down"]) {
    const from = dir === "up" ? stations[index] : stations[index + 1]
    const to = dir === "up" ? stations[index + 1] : stations[index]
    const range = attempt(() => travelRange(segments, from, to, dir))
    if (range) allTravelRanges.push(range)
  }
}
check(allTravelRanges.length === 52 && allTravelRanges.every((range) => range.track === range.dir
  && Number.isFinite(range.chainageFrom) && Number.isFinite(range.chainageTo) && range.sourcePages.length > 0),
"27 站全部相鄰站段嘅上下行查詢均可用")
const allRecords = allTravelRanges.map((range) => attempt(() => recordsForRange(technical, range, range.dir)))
check(allRecords.length === 52 && allRecords.every((records) => records
  && ["entryPoints", "emergencyAccessPoints", "cpds", "neutralZones", "vccBoundaries"].every((key) => Array.isArray(records[key]))),
"27 站全部相鄰站段嘅技術資料查詢均可用")
const badRanges = segments.filter((segment) => {
  const up = segment.up
  const down = segment.down
  return ![up?.from, up?.to, down?.from, down?.to].every(Number.isFinite)
    || up.to <= up.from || down.to >= down.from || typeof segment.sourcePage !== "string" || !segment.sourcePage
})
check(badRanges.length === 0, `上下行里程有限、單調且具圖紙出處${badRanges.length ? `：${badRanges.map((row) => row.id).join("、")}` : ""}`)
const discontinuities = segments.slice(1).filter((segment, index) => segment.up.from !== segments[index].up.to
  || segment.down.to !== segments[index].down.from)
check(discontinuities.length === 0, "相鄰站段上下行鏈接點連續")
const terminal = segments.find((segment) => segment.id === "27")
check(terminal?.up.from === 135.596 && terminal?.up.to === 137.549 && terminal.extendedTo === 137.800
  && terminal?.down.from === 137.552 && terminal.down.to === 135.597 && terminal.extendedFrom === 137.800,
"站段 27 保留 SIH—TUM 中心里程及 137.800 止衝擋延展")

const smokeCases = [
  { from: "WKS", to: "MOS", dir: "up", chainageFrom: 81.224, chainageTo: 82.755, sourcePages: ["1A2-17"], segmentIds: ["01", "02"], vccFrom: 9, vccTo: 9 },
  { from: "YUL", to: "LOP", dir: "up", chainageFrom: 127.258, chainageTo: 128.313, sourcePages: ["1A2-3"], segmentIds: ["24"], vccFrom: 4, vccTo: 4 },
  { from: "TUM", to: "SIH", dir: "down", chainageFrom: 137.800, chainageTo: 135.597, sourcePages: ["1A2-1"], segmentIds: ["27"], vccFrom: 4, vccTo: 4 },
]
const ranges = new Map()
for (const expected of smokeCases) {
  const key = `${expected.from}>${expected.to}`
  const range = attempt(() => travelRange(segments, expected.from, expected.to, expected.dir))
  ranges.set(key, range)
  check(range && ["from", "to", "dir", "chainageFrom", "chainageTo"].every((field) => range[field] === expected[field])
    && range.track === expected.dir && same(range.sourcePages, expected.sourcePages) && same(range.segmentIds, expected.segmentIds),
  `travelRange ${key} ${expected.dir.toUpperCase()} 里程、站段及圖紙正確`)
  if (!range) continue
  const records = attempt(() => recordsForRange(technical, range, expected.dir))
  check(records && records.vccFrom === expected.vccFrom && records.vccTo === expected.vccTo,
    `recordsForRange ${key} 端點 VCC 正確`)
  check(records && ["entryPoints", "emergencyAccessPoints", "cpds", "neutralZones", "vccBoundaries"].every((name) => {
    const values = records[name].map((row) => Math.min(...chainageValues(name === "vccBoundaries" ? row.values : row.chainageKm)))
    return values.every((km, index) => index === 0 || values[index - 1] <= km)
  }), `recordsForRange ${key} 各結果按 chainage 排序`)
}

const wksRecords = attempt(() => recordsForRange(technical, ranges.get("WKS>MOS"), "up"))
const wksEp = wksRecords?.entryPoints.find((row) => row.chainageKm === 81.928)
check(wksEp?.yellowEP === "16-28" && wksEp.greenEP === "16-30"
  && wksEp.yellowEPId === "1628" && wksEp.greenEPId === "1630"
  && wksRecords.entryPoints.every((row) => row.track === "up"), "WKS→MOS UP 保留所選軌道的黃／綠 EP，不互換或按方向刪除")
check(wksRecords?.emergencyAccessPoints.some((row) => row.id === "WKS EAP 13" && row.chainageKm === 81.237),
  "WKS→MOS UP 包含方向可用嘅 WKS EAP 13")

const wksDownRange = attempt(() => travelRange(segments, "MOS", "WKS", "down"))
check(wksDownRange?.chainageFrom === 82.736 && wksDownRange?.chainageTo === 81.224
  && same(wksDownRange.segmentIds, ["02", "01"]), "MOS→WKS DOWN 對稱延至 WKS 81.224 止衝擋")

const tshUpRange = attempt(() => travelRange(segments, "TSH", "SHM", "up"))
const tshDownRange = attempt(() => travelRange(segments, "SHM", "TSH", "down"))
const tshUpRecords = attempt(() => recordsForRange(technical, tshUpRange, "up"))
const tshDownRecords = attempt(() => recordsForRange(technical, tshDownRange, "down"))
check(!tshUpRecords?.emergencyAccessPoints.some((row) => row.id === "TSH Nullah")
  && tshDownRecords?.emergencyAccessPoints.some((row) => row.id === "TSH Nullah" && row.chainageKm === 85.319),
  "EAP 按方向 access 同 chainage 過濾：TSH Nullah 只出現喺下行")

const yulRecords = attempt(() => recordsForRange(technical, ranges.get("YUL>LOP"), "up"))
check(yulRecords?.entryPoints.some((row) => row.chainageKm === 127.964)
  && !yulRecords.entryPoints.some((row) => row.chainageKm === 127.965), "YUL→LOP UP 包含 EP 127.964")
const yulDownRange = attempt(() => travelRange(segments, "LOP", "YUL", "down"))
const yulDownRecords = attempt(() => recordsForRange(technical, yulDownRange, "down"))
check(yulDownRecords?.entryPoints.some((row) => row.chainageKm === 127.965)
  && !yulDownRecords.entryPoints.some((row) => row.chainageKm === 127.964), "LOP→YUL DOWN 包含 EP 127.965")

const tumRecords = attempt(() => recordsForRange(technical, ranges.get("TUM>SIH"), "down"))
check(tumRecords?.entryPoints.some((row) => row.chainageKm === 136.427)
  && !tumRecords.entryPoints.some((row) => row.chainageKm === 136.428), "TUM→SIH DOWN 包含 EP 136.427")
const tumUpRange = attempt(() => travelRange(segments, "SIH", "TUM", "up"))
const tumUpRecords = attempt(() => recordsForRange(technical, tumUpRange, "up"))
check(tumUpRange?.chainageTo === 137.800 && tumUpRecords?.entryPoints.some((row) => row.chainageKm === 136.428),
  "SIH→TUM UP 延至 137.800 並包含 EP 136.428")

const arrayRange = attempt(() => travelRange(segments, "DIH", "KAT", "up"))
const arrayRecords = attempt(() => recordsForRange(technical, arrayRange, "up"))
check(arrayRecords?.entryPoints.some((row) => same(row.chainageKm, [97.345, 97.343])
  && row.yellowEPId === "7-25" && row.greenEPId === "7-22"), "recordsForRange 保留 EP 的 number[] 里程及原始 ID")
const boundaryRange = attempt(() => travelRange(segments, "KAT", "SUW", "up"))
const boundaryRecords = attempt(() => recordsForRange(technical, boundaryRange, "up"))
const arrayBoundary = boundaryRecords?.vccBoundaries.find((row) => same(row.between, [6, 7]))
check(same(arrayBoundary?.values, [98.842, 98.84]) && arrayBoundary.transitionGapM === 2
  && arrayBoundary.reviewStatus === "cross-checked-from-enlarged-images", "VCC 雙值界線保留 number[]、誤差及審核資料")

const descendingRecords = attempt(() => recordsForRange({
  entryPointLines: [{ track: "down", chainageKm: [5, 4], yellowEP: "1603", greenEP: "1605" }],
  emergencyAccessPoints: [
    { id: "EAP A", downChainageKm: 4.5, downAccess: true },
    { id: "EAP B", downChainageKm: 4.6, downAccess: false },
    { id: "EAP C", downChainageKm: 4.7, upAccess: true },
  ],
  crossPassageDoors: [
    { type: "crossPassageDoor", track: "down", chainageKm: [4.5, 4.4] },
    { type: "platformEdgeReference", track: "-", chainageKm: 4.5 },
    { type: "crossPassageDoor", track: "up", chainageKm: 4.5 },
  ],
  neutralZones: [
    { track: "down", chainageKm: 9, downLimitKm: 4.8, upLimitKm: 5.2 },
    { track: "up", chainageKm: 4.5 },
  ],
  vcc: { areas: [], boundaries: [{ between: [1, 2], downChainageKm: [5.1, 4.9], source: "test" }] },
}, { from: "A", to: "B", track: "down", chainageFrom: 5, chainageTo: 4 }, "down"))
check(descendingRecords?.entryPoints.length === 1 && descendingRecords.emergencyAccessPoints.length === 1
  && descendingRecords.cpds.length === 1 && descendingRecords.neutralZones.length === 1
  && same(descendingRecords.vccBoundaries[0]?.values, [5.1, 4.9]),
"遞減里程及 number[] 可用；EAP 方向、CPD 類型、軌道、中性區相交及 VCC 過濾正確")

if (failed) {
  console.error(`✗ 技術資料驗證失敗：${failed} 個檢查未通過，${passed} 個通過`)
  process.exit(1)
}
console.log(`✓ 技術資料驗證全部通過（${passed} 個檢查）`)
