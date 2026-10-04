// Extracted + narrowed to the Tuen Ma Line from
// https://github.com/keithligh/hk-traffic-intelligence
// src/lib/mtr-network.ts + data/mtr-network.json — MIT (c) 2026 Keith Li.
//
// The upstream file carries all 10 MTR lines (98 stations). This module is
// TML-only: 27 stations, 2 directional routes (TML-DT toward TUM, TML-UT toward
// WKS). Every accessor has the same shape as upstream so the estimator runs
// unchanged.
//
// `createNetwork(json)` takes an already-parsed `data/tml-network.json` so the
// same module works in the browser (fetch) and in Node (readFile).

export const TML_STATION_COUNT = 27

export function createNetwork(network) {
  const linesThroughStation = new Map()
  for (const route of network.routes) {
    for (const code of route.stations) {
      const lines = linesThroughStation.get(code) ?? []
      if (!lines.includes(route.line)) lines.push(route.line)
      linesThroughStation.set(code, lines)
    }
  }

  return {
    line: network.line,
    meta: network.meta,
    routes: network.routes,
    stations: network.stations,

    routes_() {
      return network.routes
    },

    // Same shape as upstream mtrQueries(): one {line, station} pair per station
    // per line-through-that-station. For TML-only this is 27 pairs.
    queries() {
      const pairs = new Map()
      for (const route of network.routes) {
        for (const station of route.stations) {
          pairs.set(`${route.line}-${station}`, { line: route.line, station })
        }
      }
      return [...pairs.values()]
    },

    stationRecord(code) {
      return network.stations[code] ?? null
    },

    lineRecord(code) {
      return code === network.line ? network.meta : null
    },

    linesThrough(station) {
      return linesThroughStation.get(station) ?? []
    },

    point(code) {
      const station = network.stations[code]
      if (!station) return null
      return { lng: station.lng, lat: station.lat }
    },

    // Display helper: locale-aware station name.
    name(code, locale = "tc") {
      const station = network.stations[code]
      if (!station) return code
      return locale === "en" ? station.en : station.tc
    },

    // GeoJSON: one MultiLineString of every adjacent station pair on the line.
    trackCollection() {
      const edges = new Map()
      const addEdge = (fromCode, toCode) => {
        const from = this.point(fromCode)
        const to = this.point(toCode)
        if (!from || !to) return
        const key = [fromCode, toCode].sort().join(">")
        if (!edges.has(key)) edges.set(key, [[from.lng, from.lat], [to.lng, to.lat]])
      }
      for (const route of network.routes) {
        for (let index = 1; index < route.stations.length; index += 1) {
          addEdge(route.stations[index - 1], route.stations[index])
        }
      }
      if (edges.size === 0) return { type: "FeatureCollection", features: [] }
      return {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { line: network.line, color: network.meta.color },
            geometry: { type: "MultiLineString", coordinates: [...edges.values()] },
          },
        ],
      }
    },

    // GeoJSON: one Point per station, carrying both names.
    stationCollection() {
      return {
        type: "FeatureCollection",
        features: Object.entries(network.stations).map(([code, station]) => ({
          type: "Feature",
          properties: { code, name: station.en, nameTc: station.tc },
          geometry: { type: "Point", coordinates: [station.lng, station.lat] },
        })),
      }
    },
  }
}
