// 屯馬綫技術資料查詢：站段里程、Entry Point、CPD、中性區及 VCC 界線。
// 純函數模組，瀏覽器及 Node 驗證工具共用。

export function formatEp(value) {
  const text = String(value)
  return /^\d{4}$/.test(text) ? `${text.slice(0, 2)}-${Number(text.slice(2))}` : text
}

export function chainageValues(value) {
  return Array.isArray(value) ? value : [value]
}

function finiteChainages(value) {
  return chainageValues(value).filter(Number.isFinite)
}

function sortChainage(items, valueOf = (item) => item.chainageKm) {
  return items.sort((a, b) => Math.min(...finiteChainages(valueOf(a))) - Math.min(...finiteChainages(valueOf(b))))
}

function matchesCpdTrack(value, track) {
  const normalized = String(value ?? "").trim().toUpperCase()
  const normalizedTrack = String(track ?? "").trim().toUpperCase()
  const directionCode = normalizedTrack === "UP" || normalizedTrack === "U"
    ? "U"
    : normalizedTrack === "DOWN" || normalizedTrack === "D" ? "D" : null
  return normalized === "-" || normalized === "U/D" || normalized === normalizedTrack || normalized === directionCode
}

function rangeBounds(range) {
  const from = Number(range?.chainageFrom)
  const to = Number(range?.chainageTo)
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new RangeError("技術查詢需要有效的 chainageFrom 及 chainageTo")
  return { low: Math.min(from, to), high: Math.max(from, to) }
}

function inRange(value, { low, high }) {
  return finiteChainages(value).some((km) => km >= low && km <= high)
}

function directionOf(dir) {
  const direction = String(dir ?? "").toLowerCase()
  if (direction !== "up" && direction !== "down") throw new RangeError("行車方向必須是 up 或 down")
  return direction
}

export function travelRange(segments, from, to, dir) {
  const direction = directionOf(dir)
  const origin = String(from ?? "").toUpperCase()
  const destination = String(to ?? "").toUpperCase()
  const list = Array.isArray(segments) ? segments : segments?.segments ?? []
  const matches = (segment) => direction === "up"
    ? segment.from === origin && segment.to === destination
    : segment.from === destination && segment.to === origin
  const segment = list.find(matches) ?? (origin === "WKS" && destination === "WKS"
    ? list.find((item) => item.id === "01")
    : null)
  if (!segment) throw new RangeError(`搵唔到 ${origin}→${destination} 的${direction === "up" ? "上行" : "下行"}技術站段`)

  const selected = [segment]
  // WKS 上行由止衝擋出發、下行入 WKS 亦要去到止衝擋，不能只取中心至 MOS 的站段。
  if ((direction === "up" && origin === "WKS" && destination === "MOS")
    || (direction === "down" && origin === "MOS" && destination === "WKS")) {
    const stopblock = list.find((item) => item.id === "01")
    if (!stopblock) throw new RangeError("缺少 WKS 止衝擋站段 01")
    if (direction === "up") selected.unshift(stopblock)
    else selected.push(stopblock)
  }

  const first = selected[0]
  const last = selected.at(-1)
  const chainageFrom = direction === "down" && Number.isFinite(first.extendedFrom)
    ? first.extendedFrom
    : first[direction].from
  const chainageTo = direction === "up" && Number.isFinite(last.extendedTo)
    ? last.extendedTo
    : last[direction].to
  return {
    from: origin,
    to: destination,
    dir: direction,
    track: direction,
    chainageFrom,
    chainageTo,
    sourcePages: [...new Set(selected.map((item) => item.sourcePage))],
    segmentIds: selected.map((item) => item.id),
  }
}

function stationVcc(technical, station) {
  return technical?.vcc?.areas?.find((area) => area.stations?.includes(station))?.vcc ?? null
}

export function recordsForRange(technical, range, dir) {
  const direction = directionOf(dir)
  const track = range?.track ?? direction
  const bounds = rangeBounds(range)
  const chainageKey = direction === "up" ? "upChainageKm" : "downChainageKm"
  const accessKey = direction === "up" ? "upAccess" : "downAccess"
  const entryPoints = (technical?.entryPointLines ?? [])
    .filter((line) => line.track === track && inRange(line.chainageKm, bounds))
    .map((line) => ({
      yellowEP: formatEp(line.yellowEP),
      greenEP: formatEp(line.greenEP),
      yellowEPId: line.yellowEP,
      greenEPId: line.greenEP,
      chainageKm: line.chainageKm,
      track: line.track,
      sourcePage: line.sourcePage,
      sourcePdfPage: line.sourcePdfPage,
      reviewStatus: line.reviewStatus,
    }))
  sortChainage(entryPoints)

  const emergencyAccessPoints = (technical?.emergencyAccessPoints ?? [])
    .filter((point) => point[accessKey] === true && inRange(point[chainageKey], bounds))
    .map((point) => ({ ...point, chainageKm: point[chainageKey] }))
  sortChainage(emergencyAccessPoints)

  const cpds = (technical?.crossPassageDoors ?? [])
    .filter((door) => door.type === "crossPassageDoor"
      && matchesCpdTrack(door.track, track)
      && inRange(door.chainageKm, bounds))
    .map((door) => ({ ...door }))
  sortChainage(cpds)

  const neutralZones = (technical?.neutralZones ?? [])
    .filter((zone) => {
      if (zone.track !== track) return false
      if (inRange(zone.chainageKm, bounds)) return true
      const limits = finiteChainages([zone.downLimitKm, zone.upLimitKm])
      return limits.length === 2 && Math.max(bounds.low, Math.min(...limits)) <= Math.min(bounds.high, Math.max(...limits))
    })
    .map((zone) => ({ ...zone }))
  sortChainage(neutralZones)

  const vccBoundaries = (technical?.vcc?.boundaries ?? [])
    .filter((boundary) => inRange(boundary[chainageKey], bounds))
    .map((boundary) => ({
      between: boundary.between,
      values: chainageValues(boundary[chainageKey]),
      source: boundary.source,
      reviewStatus: boundary.reviewStatus,
      transitionGapM: boundary.transitionGapM,
      note: boundary.note,
    }))
  sortChainage(vccBoundaries, (boundary) => boundary.values)

  return {
    entryPoints,
    emergencyAccessPoints,
    cpds,
    neutralZones,
    vccBoundaries,
    vccFrom: stationVcc(technical, range?.from),
    vccTo: stationVcc(technical, range?.to),
  }
}
