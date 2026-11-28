// TD_TML 技術資料搜尋：建立前端 index、chainage→站段／VCC 解析，
// 以及 Neutral Zone 上下行配對。純函數，瀏覽器及 Node 驗證共用。
import { formatEp } from "./td-infrastructure.js"

const KIND_ORDER = ["VCC_AREA", "VCC_BOUNDARY", "EP", "NR", "EAP", "CPD", "NZ"]
const MAINLINE_VCC = new Set([1, 2, 4, 5, 6, 7, 8, 9])

function finiteValues(value) {
  if (Array.isArray(value)) return value.flatMap(finiteValues)
  return Number.isFinite(value) ? [value] : []
}

function firstChainage(value) {
  return finiteValues(value)[0] ?? null
}

function resultSegment(item, direction) {
  return item?.segments?.[direction] ?? item?.segment ?? null
}

function resultChainage(item, direction) {
  if (item?.kind === "VCC_AREA" && item.data?.range) {
    return direction === "UP" ? Number(item.data.range.from) : Number(item.data.range.to)
  }
  const values = searchResultChainageValues(item, direction)
  return values.length ? Math.min(...values) : null
}

function resultTrackRank(item, direction) {
  if (item?.track === direction) return 0
  if (item?.track === "BOTH") return 1
  if (item?.track === "UP" || item?.track === "DOWN") return 2
  return 3
}

function normalizeTrack(value) {
  const track = String(value ?? "").trim().toUpperCase()
  if (["UP", "U"].includes(track)) return "UP"
  if (["DOWN", "DN", "D"].includes(track)) return "DOWN"
  return "BOTH"
}

export function searchResultDirection(item, selectedDirection = "UP") {
  const selected = selectedDirection === "DOWN" ? "DOWN" : "UP"
  if (item?.track === "UP" || item?.track === "DOWN") return item.track
  if (item?.track === "BOTH") return selected
  return item?.defaultDir === "DOWN" ? "DOWN" : item?.defaultDir === "UP" ? "UP" : selected
}

export function searchResultSegment(item, direction = "UP") {
  const dir = direction === "DOWN" ? "DOWN" : "UP"
  return item?.segments?.[dir] ?? item?.segment ?? null
}

export function segmentEndpoints(segment, direction = "UP") {
  if (!segment) return null
  return direction === "DOWN"
    ? { from: segment.to, to: segment.from }
    : { from: segment.from, to: segment.to }
}

export function searchResultEndpoints(item, direction = "UP") {
  const dir = searchResultDirection(item, direction)
  return segmentEndpoints(searchResultSegment(item, dir), dir)
}

export function searchResultChainageValues(item, direction = "UP") {
  const dir = searchResultDirection(item, direction)
  if (item?.kind === "VCC_AREA") return finiteValues(item.chainageKm)
  if (item?.kind === "VCC_BOUNDARY") {
    return finiteValues(dir === "DOWN" ? item.data?.downChainageKm : item.data?.upChainageKm)
  }
  if (item?.kind === "NZ") {
    return finiteValues(dir === "DOWN" ? item.data?.down?.chainageKm : item.data?.up?.chainageKm)
  }
  if (item?.kind === "EAP") {
    return finiteValues(dir === "DOWN" ? item.data?.downChainageKm : item.data?.upChainageKm)
  }
  return finiteValues(item?.chainageKm)
}

export function searchResultChainageText(item, direction = "UP") {
  const values = searchResultChainageValues(item, direction)
  if (!values.length) return ""
  const low = Math.min(...values)
  const high = Math.max(...values)
  return low === high ? `${low.toFixed(3)} km` : `${low.toFixed(3)}–${high.toFixed(3)} km`
}

export function searchResultStations(item, direction = "UP") {
  const stations = [...(item?.data?.stations ?? item?.stations ?? [])]
  return direction === "DOWN" ? stations.reverse() : stations
}

function normalizedSeparators(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase()
    .replace(/[\/／↔\-–—]+/gu, "-")
}

// Compact key keeps legacy identifier searches such as NAC43 and HP601 working.
function searchKey(value) {
  return normalizedSeparators(value).replace(/[^\p{L}\p{N}]+/gu, "")
}

// Separator-aware key is the primary match. Numeric whitespace is treated as a
// separator too, so EP 1 2 and VCC 6 7 behave like their punctuated forms.
function separatorSearchKey(value) {
  return normalizedSeparators(value)
    .replace(/(?<=\d)\s+(?=\d)/gu, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
}

function isCompactEpQuery(value) {
  const compact = searchKey(value)
  return /^(?:ep)?\d+$/u.test(compact)
}

function containsChainage(km, range) {
  if (!Number.isFinite(km) || !range) return false
  const from = Number(range.from)
  const to = Number(range.to)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false
  return km >= Math.min(from, to) - 1e-9 && km <= Math.max(from, to) + 1e-9
}

function segmentDistance(km, range) {
  const from = Number(range?.from)
  const to = Number(range?.to)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Infinity
  const low = Math.min(from, to)
  const high = Math.max(from, to)
  return km < low ? low - km : km > high ? km - high : 0
}

export function findSegmentForChainage(segments, track, value) {
  const km = firstChainage(value)
  if (!Number.isFinite(km)) return null
  const dir = normalizeTrack(track) === "DOWN" ? "DOWN" : "UP"
  const key = dir === "UP" ? "up" : "down"
  const list = Array.isArray(segments) ? segments : segments?.segments ?? []
  const usable = list.filter((segment) => segment.from !== segment.to && segment[key])
  const exact = usable.find((segment) => containsChainage(km, segment[key]))
  if (exact) return { ...exact, dir }
  const nearest = [...usable].sort((a, b) => segmentDistance(km, a[key]) - segmentDistance(km, b[key]))[0]
  return nearest ? { ...nearest, dir } : null
}

function resolveSegmentPair(segments, track, value) {
  const normalized = normalizeTrack(track)
  if (normalized === "BOTH") {
    return {
      UP: findSegmentForChainage(segments, "UP", value),
      DOWN: findSegmentForChainage(segments, "DOWN", value),
    }
  }
  return { [normalized]: findSegmentForChainage(segments, normalized, value) }
}

function lineBounds(segments) {
  const list = Array.isArray(segments) ? segments : segments?.segments ?? []
  const values = []
  for (const segment of list) {
    for (const key of ["up", "down"]) {
      const range = segment[key]
      if (!range) continue
      for (const value of [range.from, range.to, segment.extendedTo, segment.extendedFrom]) {
        if (Number.isFinite(value)) values.push(value)
      }
    }
  }
  return values.length ? { low: Math.min(...values), high: Math.max(...values) } : { low: 0, high: 0 }
}

function buildVccAreas(technical, segments, stationOrder) {
  const areas = technical?.vcc?.areas ?? []
  const order = Array.isArray(stationOrder) ? stationOrder : []
  const stationIndex = new Map(order.map((code, index) => [code, index]))
  const wksFirst = order[0] === "WKS" || order.at(-1) === "TUM"
  const orderDirection = wksFirst ? 1 : -1
  const mainline = areas.filter((area) => area.mainLine)
    .map((area) => ({
      ...area,
      firstStationIndex: Math.min(...(area.stations ?? []).map((code) => stationIndex.get(code) ?? Infinity)),
    }))
    .sort((a, b) => (a.firstStationIndex - b.firstStationIndex) * orderDirection || a.vcc - b.vcc)

  const boundaries = (technical?.vcc?.boundaries ?? []).map((boundary) => ({
    ...boundary,
    km: Math.min(...finiteValues([boundary.upChainageKm, boundary.downChainageKm])),
  })).filter((boundary) => Number.isFinite(boundary.km)).sort((a, b) => a.km - b.km)

  const bounds = lineBounds(segments)
  const ranges = new Map()
  if (boundaries.length === Math.max(0, mainline.length - 1)) {
    for (let index = 0; index < mainline.length; index++) {
      ranges.set(mainline[index].vcc, {
        from: index === 0 ? bounds.low : boundaries[index - 1].km,
        to: index === boundaries.length ? bounds.high : boundaries[index].km,
      })
    }
  }

  return areas.map((area) => ({
    ...area,
    mainline: area.mainLine === true,
    range: ranges.get(area.vcc) ?? null,
  }))
}

export function vccAreaForChainage(areas, value) {
  const km = firstChainage(value)
  if (!Number.isFinite(km)) return null
  const list = (areas ?? []).filter((area) => area.mainline && area.range)
  const exact = list.find((area) => km >= area.range.from - 1e-9 && km <= area.range.to + 1e-9)
  if (!exact) return null
  const atBoundary = list.filter((area) => Math.abs(km - area.range.to) <= 1e-9)
  if (atBoundary.length === 1) {
    const towardWks = list.find((area) => Math.abs(area.range.from - km) <= 1e-9)
    if (towardWks) return towardWks.vcc
  }
  return exact.vcc
}

function vccAreaForEp(ep, areas) {
  const match = String(ep.id ?? "").match(/^(\d+)-/)
  if (match && MAINLINE_VCC.has(Number(match[1]))) return Number(match[1])
  return vccAreaForChainage(areas, ep.chainageKm)
}

export function pairNeutralZones(zones) {
  const groups = new Map()
  for (const zone of zones ?? []) {
    const name = String(zone.isolator ?? "").trim()
    const base = name.replace(/\s*(?:601|602)$/u, "").trim() || name
    const group = groups.get(base) ?? { base, up: null, down: null }
    const track = normalizeTrack(zone.track)
    if (track === "UP" && !group.up) group.up = zone
    else if (track === "DOWN" && !group.down) group.down = zone
    else if (!group.up) group.up = zone
    else if (!group.down) group.down = zone
    groups.set(base, group)
  }
  return [...groups.values()].sort((a, b) => {
    const aKm = firstChainage(a.up?.chainageKm ?? a.down?.chainageKm) ?? Infinity
    const bKm = firstChainage(b.up?.chainageKm ?? b.down?.chainageKm) ?? Infinity
    return aKm - bKm || a.base.localeCompare(b.base, "en", { numeric: true })
  })
}

function sourceText(...values) {
  return values.flatMap((value) => Array.isArray(value) ? value : [value])
    .filter(Boolean).map(String).join(", ")
}

export function buildTechnicalSearchIndex(technical, segments, options = {}) {
  const stationOrder = options.stationOrder ?? []
  const stationName = options.stationName ?? ((code) => code)
  const vccAreas = buildVccAreas(technical, segments, stationOrder)
  const items = []

  const segmentLabel = (segment) => segment
    ? `${stationName(segment.from)} → ${stationName(segment.to)}`
    : ""
  const segmentSearch = (segment) => segment
    ? `${segment.from} ${segment.to} ${segmentLabel(segment)}`
    : ""
  const add = (item) => {
    const searchText = [item.label, item.sublabel, item.id, item.sourcePage,
      ...(item.searchTerms ?? []), segmentSearch(item.segment),
      ...(item.segments ? Object.values(item.segments).map(segmentSearch) : [])]
      .filter(Boolean).join(" ")
    items.push({
      ...item,
      searchText,
      searchKey: searchKey(searchText),
      separatorKey: separatorSearchKey(searchText),
    })
  }

  for (const area of vccAreas) {
    const stations = (area.stations ?? []).map((code) => `${code} ${stationName(code)}`).join("、")
    const range = area.range
    add({
      kind: "VCC_AREA",
      id: `vcc-area:${area.vcc}`,
      label: `VCC ${area.vcc}`,
      sublabel: `${area.mainline ? "主線" : area.rangeType === "depot_area" ? "車廠" : "側綫"}${stations ? ` · ${stations}` : ""}`,
      chainageKm: range ? [range.from, range.to] : null,
      track: "BOTH",
      direction: null,
      vccArea: area.vcc,
      segment: null,
      segments: null,
      dual: false,
      defaultDir: null,
      sourcePage: "",
      mainline: area.mainline,
      data: area,
    })
  }

  for (const boundary of technical?.vcc?.boundaries ?? []) {
    const upKm = firstChainage(boundary.upChainageKm)
    const downKm = firstChainage(boundary.downChainageKm)
    const segmentsByDir = {
      UP: findSegmentForChainage(segments, "UP", boundary.upChainageKm),
      DOWN: findSegmentForChainage(segments, "DOWN", boundary.downChainageKm),
    }
    const segment = segmentsByDir.UP ?? segmentsByDir.DOWN
    add({
      kind: "VCC_BOUNDARY",
      id: `vcc-boundary:${boundary.between.join(":")}`,
      label: `VCC ${boundary.between[0]} ↔ ${boundary.between[1]}`,
      sublabel: `UP ${upKm == null ? "n/a" : upKm.toFixed(3)} · DOWN ${downKm == null ? "n/a" : downKm.toFixed(3)} km`,
      chainageKm: finiteValues([boundary.upChainageKm, boundary.downChainageKm]),
      track: "BOTH",
      direction: null,
      vccArea: null,
      segment,
      segments: segmentsByDir,
      dual: true,
      defaultDir: "UP",
      sourcePage: boundary.source,
      searchTerms: [boundary.between.join("-"), `VCC ${boundary.between[0]} ${boundary.between[1]}`],
      mainline: true,
      data: boundary,
    })
  }

  for (const ep of technical?.entryPoints ?? []) {
    const track = normalizeTrack(ep.track)
    const segment = findSegmentForChainage(segments, track, ep.chainageKm)
    add({
      kind: "EP",
      id: `ep:${ep.id}`,
      label: `EP ${formatEp(ep.id)}`,
      sublabel: `${track} · ${ep.direction === "tum" ? "往屯門" : "往烏溪沙"}`,
      chainageKm: ep.chainageKm,
      track,
      direction: ep.direction === "tum" ? "TUM" : "WKS",
      vccArea: vccAreaForEp(ep, vccAreas),
      segment,
      segments: segment ? { [track]: segment } : null,
      dual: false,
      defaultDir: track,
      sourcePage: ep.sourcePage,
      mainline: true,
      data: ep,
    })
  }

  for (const room of technical?.nicheRooms ?? []) {
    const track = normalizeTrack(room.track)
    const segment = findSegmentForChainage(segments, track, room.chainageKm)
    add({
      kind: "NR",
      id: `nr:${room.uid}`,
      label: room.name,
      sublabel: `${track} · ${room.uid}`,
      chainageKm: room.chainageKm,
      track,
      direction: null,
      vccArea: vccAreaForChainage(vccAreas, room.chainageKm),
      segment,
      segments: segment ? { [track]: segment } : null,
      dual: false,
      defaultDir: track,
      sourcePage: room.sourcePage,
      mainline: true,
      data: room,
    })
  }

  for (const point of technical?.emergencyAccessPoints ?? []) {
    const up = point.upAccess === true && Number.isFinite(point.upChainageKm)
    const down = point.downAccess === true && Number.isFinite(point.downChainageKm)
    const segmentsByDir = {}
    if (up) segmentsByDir.UP = findSegmentForChainage(segments, "UP", point.upChainageKm)
    if (down) segmentsByDir.DOWN = findSegmentForChainage(segments, "DOWN", point.downChainageKm)
    const segment = segmentsByDir.UP ?? segmentsByDir.DOWN ?? null
    const dual = Boolean(up && down)
    add({
      kind: "EAP",
      id: `eap:${point.id}`,
      label: point.id,
      sublabel: [point.type, point.station ? `${point.station} ${stationName(point.station)}` : "", dual ? "雙向" : up ? "UP" : "DOWN"].filter(Boolean).join(" · "),
      chainageKm: [point.upChainageKm, point.downChainageKm].filter(Number.isFinite),
      track: dual ? "BOTH" : up ? "UP" : "DOWN",
      direction: null,
      vccArea: vccAreaForChainage(vccAreas, up ? point.upChainageKm : point.downChainageKm),
      segment,
      segments: Object.keys(segmentsByDir).length ? segmentsByDir : null,
      dual,
      defaultDir: up ? "UP" : "DOWN",
      sourcePage: point.sourcePage,
      mainline: true,
      data: point,
    })
  }

  for (const cpd of technical?.crossPassageDoors ?? []) {
    if (cpd.type !== "crossPassageDoor") continue
    const track = normalizeTrack(cpd.track)
    const segmentsByDir = resolveSegmentPair(segments, track, cpd.chainageKm)
    const segment = segmentsByDir.UP ?? segmentsByDir.DOWN ?? null
    const dual = track === "BOTH"
    add({
      kind: "CPD",
      id: `cpd:${cpd.id}`,
      label: cpd.id,
      sublabel: `${track} · ${cpd.sourcePage ?? ""}`.trim(),
      chainageKm: cpd.chainageKm,
      track,
      direction: null,
      vccArea: vccAreaForChainage(vccAreas, cpd.chainageKm),
      segment,
      segments: segment ? segmentsByDir : null,
      dual,
      defaultDir: track === "DOWN" ? "DOWN" : "UP",
      sourcePage: cpd.sourcePage,
      mainline: true,
      data: cpd,
    })
  }

  for (const pair of pairNeutralZones(technical?.neutralZones)) {
    const reference = pair.up ?? pair.down
    const track = pair.up && pair.down ? "BOTH" : normalizeTrack(reference.track)
    const segmentsByDir = {}
    if (pair.up) segmentsByDir.UP = findSegmentForChainage(segments, "UP", pair.up.chainageKm)
    if (pair.down) segmentsByDir.DOWN = findSegmentForChainage(segments, "DOWN", pair.down.chainageKm)
    const segment = segmentsByDir.UP ?? segmentsByDir.DOWN ?? null
    const dual = Boolean(pair.up && pair.down)
    const upKm = firstChainage(pair.up?.chainageKm)
    const downKm = firstChainage(pair.down?.chainageKm)
    add({
      kind: "NZ",
      id: `nz:${pair.base}`,
      label: pair.base,
      sublabel: `UP ${upKm == null ? "n/a" : upKm.toFixed(3)} · DOWN ${downKm == null ? "n/a" : downKm.toFixed(3)} km`,
      chainageKm: [upKm, downKm].filter(Number.isFinite),
      track,
      direction: null,
      vccArea: vccAreaForChainage(vccAreas, reference.chainageKm),
      segment,
      segments: Object.keys(segmentsByDir).length ? segmentsByDir : null,
      dual,
      defaultDir: pair.up ? "UP" : "DOWN",
      sourcePage: sourceText(pair.up?.sourcePage, pair.down?.sourcePage),
      searchTerms: [pair.up?.isolator, pair.down?.isolator, pair.up?.type, pair.down?.type],
      mainline: true,
      data: pair,
    })
  }

  items.sort((a, b) => {
    const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    if (kind) return kind
    const aKm = firstChainage(a.chainageKm) ?? Infinity
    const bKm = firstChainage(b.chainageKm) ?? Infinity
    return aKm - bKm || a.label.localeCompare(b.label, "en", { numeric: true })
  })

  return { items, vccAreas }
}

export function searchResultMode(item) {
  if (!item?.dual) return "single"
  const ids = Object.values(item.segments ?? {}).map((segment) => segment?.id).filter(Boolean)
  return ids.length >= 2 && new Set(ids).size === 1 ? "dual" : "single"
}

// Presentation metadata keeps UI decisions out of the segment resolver. The
// original mode helper remains string-valued for existing callers and tests.
export function searchResultPresentation(item, direction = null) {
  const mode = searchResultMode(item)
  if (mode === "dual" || item?.kind !== "EAP") {
    return { mode, fallbackReason: null, oppositeTrack: null, oppositeSegment: null }
  }
  const up = item.segments?.UP ?? null
  const down = item.segments?.DOWN ?? null
  if (!up || !down || up.id === down.id) {
    return { mode, fallbackReason: null, oppositeTrack: null, oppositeSegment: null }
  }
  const defaultDir = direction == null
    ? (item.defaultDir === "DOWN" || (!item.defaultDir && item.track === "DOWN") ? "DOWN" : "UP")
    : searchResultDirection(item, direction)
  const oppositeTrack = defaultDir === "UP" ? "DOWN" : "UP"
  return {
    mode,
    fallbackReason: "cross-segment-eap",
    oppositeTrack,
    oppositeSegment: oppositeTrack === "UP" ? up : down,
  }
}

function matchesCategory(item, category) {
  if (!category || category === "ALL") return true
  if (category === "VCC") return item.kind === "VCC_AREA" || item.kind === "VCC_BOUNDARY"
  return item.kind === category
}

export function searchResultMatchTier(item, query) {
  const key = separatorSearchKey(query)
  if (!key) return 1
  const label = separatorSearchKey(item?.label)
  return label === key || label.replace(/^ep/u, "") === key ? 0 : 1
}

export function searchTechnicalIndex(index, query, category = "ALL", direction = "UP") {
  const dir = direction === "DOWN" ? "DOWN" : "UP"
  const key = separatorSearchKey(query)
  const compact = searchKey(query)
  const compactEp = isCompactEpQuery(query)
  const rows = (index?.items ?? []).filter((item) => {
    if (!matchesCategory(item, category)) return false
    if (!key) return true
    if (item.separatorKey?.includes(key)) return true
    // Never split an unpunctuated EP number into an arbitrary facility code.
    // EP 1-12 and EP 11-2 are distinct identifiers even if a future compact
    // representation collides. This guard applies in ALL as well as EP.
    if (compactEp && item.kind === "EP") return false
    return Boolean(item.searchKey?.includes(compact))
  })
  const relevance = (item) => searchResultMatchTier(item, query)
  const segmentOrder = (item) => {
    const id = Number(resultSegment(item, dir)?.id)
    return Number.isFinite(id) ? id : Infinity
  }
  return rows.sort((a, b) => {
    // CPDs are rendered as segment accordions, so keep every segment contiguous.
    if (category !== "CPD") {
      const byRelevance = relevance(a) - relevance(b)
      if (byRelevance) return byRelevance
      const byTrack = resultTrackRank(a, dir) - resultTrackRank(b, dir)
      if (byTrack) return byTrack
    }
    const aSegment = segmentOrder(a)
    const bSegment = segmentOrder(b)
    if (aSegment !== bSegment) return dir === "UP" ? aSegment - bSegment : bSegment - aSegment
    if (category === "CPD") {
      const byRelevance = relevance(a) - relevance(b)
      if (byRelevance) return byRelevance
      const aKm = resultChainage(a, dir) ?? Infinity
      const bKm = resultChainage(b, dir) ?? Infinity
      if (aKm !== bKm) return dir === "UP" ? aKm - bKm : bKm - aKm
      const byTrack = resultTrackRank(a, dir) - resultTrackRank(b, dir)
      if (byTrack) return byTrack
    }
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    if (byKind) return byKind
    const aKm = resultChainage(a, dir) ?? Infinity
    const bKm = resultChainage(b, dir) ?? Infinity
    return dir === "UP" ? aKm - bKm : bKm - aKm
  })
}

export function groupEntryPointsByPrefix(rows) {
  const groups = new Map()
  const units = []
  for (const item of rows ?? []) {
    const prefix = item?.kind === "EP"
      ? item.label.match(/^EP\s+(\d+)-/u)?.[1]
      : null
    if (!prefix) {
      units.push({ kind: "item", item })
      continue
    }
    let group = groups.get(prefix)
    if (!group) {
      group = { kind: "epGroup", id: prefix, prefix, items: [] }
      groups.set(prefix, group)
      units.push(group)
    }
    group.items.push(item)
  }
  return units
}

export function groupCpdsBySegment(rows, direction = "UP") {
  const dir = direction === "DOWN" ? "DOWN" : "UP"
  const groups = new Map()
  for (const item of rows ?? []) {
    if (item?.kind !== "CPD") continue
    const segment = resultSegment(item, dir) ?? resultSegment(item, "UP") ?? resultSegment(item, "DOWN")
    const id = segment?.id ?? `track:${item.track}`
    const group = groups.get(id) ?? { id, segment, direction: dir, items: [] }
    group.items.push(item)
    groups.set(id, group)
  }
  return [...groups.values()]
}

export function entryPointsByVccArea(index) {
  const groups = new Map()
  for (const item of index?.items ?? []) {
    if (item.kind !== "EP" || !MAINLINE_VCC.has(item.vccArea)) continue
    const group = groups.get(item.vccArea) ?? { UP: [], DOWN: [] }
    if (item.track === "UP" || item.track === "DOWN") group[item.track].push(item)
    groups.set(item.vccArea, group)
  }
  for (const group of groups.values()) {
    group.UP.sort((a, b) => (firstChainage(a.chainageKm) ?? Infinity) - (firstChainage(b.chainageKm) ?? Infinity))
    group.DOWN.sort((a, b) => (firstChainage(a.chainageKm) ?? Infinity) - (firstChainage(b.chainageKm) ?? Infinity))
  }
  return groups
}

export function mainlineVccAreas(index) {
  return (index?.vccAreas ?? []).filter((area) => area.mainline).sort((a, b) => a.vcc - b.vcc)
}
