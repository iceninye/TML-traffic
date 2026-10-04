// Tuen Ma Line live diagram.
//
// The engine under lib/ answers "where is each train now" from the published
// next-train minutes. This file is only the view: it keeps a running animation
// state, draws the line, and reports what the boards say at each station.
//
// Two views, same data:
//   diagram (default) — a self-contained SVG line diagram. No network, no
//                       WebGL, always available.
//   map     (optional) — MapLibre GL on OpenFreeMap tiles, loaded on demand.
//                       Any failure falls back to the diagram.

import { readSchedule } from "../lib/mtr-schedule.js"
import { carryArrivalClock, estimateTrains } from "../lib/mtr-estimate.js"
import { createNetwork } from "../lib/mtr-network.js"
import { createFeed } from "../lib/mtr-feed.js"
import { advanceRuns, cumulative, mergeRuns, placeRun, runsFromTrains } from "../lib/mtr-run.js"

const LINE = "TML"
const LOCALE_KEY = "tml-traffic-locale"
const VIEW_KEY = "tml-traffic-view"
const PAUSE_KEY = "tml-traffic-paused"
// The feed marks a station stale after 20 s. Refreshing a little sooner than
// that keeps every station inside its window without re-reading them all.
const REFRESH_EVERY_MS = 18_000
const ROW_H = 44
const PAD_TOP = 26
const PAD_BOTTOM = 18
const TRACK_X = 32
// Markers that would overlap are stepped along the track, never sideways.
const TRAIN_R = 7
const TRAIN_NUDGE = [0, -15, 15, -30, 30, -45, 45]
const NAME_X = 60
const COL_W = 64
const COL_GAP = 6
const MAX_TTNT = 3

const STRINGS = {
  tc: {
    title: "屯馬綫列車動態圖",
    sub: "Tuen Ma Line · 實時推算",
    diagram: "路綫圖",
    map: "地圖",
    pause: "暫停",
    resume: "繼續",
    toTum: "往屯門",
    toWks: "往烏溪沙",
    terminus: "總站",
    trains: (n) => `${n} 班車`,
    stations: (n) => `${n} 站`,
    updated: (s) => (s < 60 ? `${s} 秒前更新` : `${Math.floor(s / 60)} 分鐘前更新`),
    loading: "讀取中…",
    feedDown: "攞唔到班次資料",
    paused: "已暫停更新",
    min: "分",
    due: "即將",
    platform: "月台",
    scheduled: "預定",
    delayBadge: "延誤",
    delayNote: "港鐵報告有列車延誤",
    notice: "服務提示",
    position: "現時位置",
    between: (a, b) => `${a} → ${b}`,
    atStation: (a) => `${a} 站內`,
    dest: "目的地",
    nextAt: "最近一站倒數",
    speed: "車速",
    line: "路綫",
    tapHint: "點站名睇詳細",
    dir: "方向",
    close: "閂",
    noTrains: "暫時冇班次資料",
    mapUnavailable: "地圖開唔到（瀏覽器唔支援 WebGL 或網絡問題），已自動轉回路綫圖。",
    mapLoading: "載入地圖…",
    attribution: "地圖資料 © OpenStreetMap 貢獻者 · 底圖 OpenFreeMap",
    source: "資料來源：港鐵 getSchedule.php（data.gov.hk）",
    engine: "位置由到站倒數推算，並非港鐵官方列車位置",
  },
  en: {
    title: "Tuen Ma Line Live",
    sub: "Tuen Ma Line · estimated",
    diagram: "Diagram",
    map: "Map",
    pause: "Pause",
    resume: "Resume",
    toTum: "To Tuen Mun",
    toWks: "To Wu Kai Sha",
    terminus: "Terminus",
    trains: (n) => `${n} trains`,
    stations: (n) => `${n} stations`,
    updated: (s) => (s < 60 ? `updated ${s}s ago` : `updated ${Math.floor(s / 60)}m ago`),
    loading: "Loading…",
    feedDown: "Next-train feed unavailable",
    paused: "Updates paused",
    min: "min",
    due: "now",
    platform: "Platform",
    scheduled: "Scheduled",
    delayBadge: "Delay",
    delayNote: "MTR reports a delayed train",
    notice: "Service notice",
    position: "Position",
    between: (a, b) => `${a} → ${b}`,
    atStation: (a) => `at ${a}`,
    dest: "Destination",
    nextAt: "Next station in",
    speed: "Speed",
    line: "Line",
    tapHint: "Tap a station for detail",
    dir: "Direction",
    close: "Close",
    noTrains: "No board data yet",
    mapUnavailable: "The map could not start (no WebGL, or the tiles would not load). Switched back to the diagram.",
    mapLoading: "Loading map…",
    attribution: "Map data © OpenStreetMap contributors · basemap OpenFreeMap",
    source: "Source: MTR getSchedule.php (data.gov.hk)",
    engine: "Position is walked back from the arrival countdown, not an official MTR train location",
  },
}

const els = {
  title: document.getElementById("title"),
  sub: document.getElementById("sub"),
  clock: document.getElementById("clock"),
  pulse: document.getElementById("pulse"),
  statusText: document.getElementById("status-text"),
  statusCounts: document.getElementById("status-counts"),
  alert: document.getElementById("alert"),
  stage: document.getElementById("stage"),
  paneDiagram: document.getElementById("pane-diagram"),
  paneMap: document.getElementById("pane-map"),
  diagramWrap: document.getElementById("diagram-wrap"),
  svg: document.getElementById("diagram"),
  mapEl: document.getElementById("map"),
  mapNote: document.getElementById("map-note"),
  mapFallback: document.getElementById("map-fallback"),
  viewSeg: document.getElementById("view-seg"),
  langSeg: document.getElementById("lang-seg"),
  pauseBtn: document.getElementById("pause-btn"),
  legendTum: document.getElementById("legend-tum"),
  legendWks: document.getElementById("legend-wks"),
  sheet: document.getElementById("sheet"),
  sheetBody: document.getElementById("sheet-body"),
  sheetBackdrop: document.getElementById("sheet-backdrop"),
  foot: document.getElementById("foot"),
}

const state = {
  lang: localStorage.getItem(LOCALE_KEY) === "en" ? "en" : "tc",
  view: localStorage.getItem(VIEW_KEY) === "map" ? "map" : "diagram",
  paused: localStorage.getItem(PAUSE_KEY) === "1",
  runs: [],
  data: null,
  observedAtMs: 0,
  loadedAtMs: 0,
  stationCount: 0,
  status: "loading",
  geo: null,
}

let network = null
let locate = null
let feed = null
let displayOrder = []
let trainNodes = new Map()
let cumCache = new Map()
let mapApi = null
let mapInstance = null
let mapPromise = null
let lastAdvance = 0
let lastMapPaint = 0
let rafId = 0

const t = () => STRINGS[state.lang]

/* ------------------------------------------------------------------ data */

async function boot() {
  const [netJson, segJson] = await Promise.all([
    fetchJson("data/tml-network.json"),
    fetchJson("data/tml-segments.json").catch(() => null),
  ])
  network = createNetwork(netJson)
  locate = (code) => network.point(code)
  // Display runs Tuen Mun (top) to Wu Kai Sha (bottom), matching the official
  // line presentation. TML-DT is that order.
  displayOrder = network.routes.find((route) => route.id.endsWith("DT")).stations
  state.segments = segJson
  feed = createFeed(network, { readSchedule, carryArrivalClock, estimateTrains, lang: state.lang })

  applyStrings()
  buildDiagram()
  wireControls()
  render()

  await refresh(true)
  loop()
  // localStorage remembers the last view; without this the panes keep their
  // markup defaults and the app renders the wrong one.
  showView(state.view).catch(() => {})
  setInterval(() => {
    if (!state.paused) refresh(false)
  }, REFRESH_EVERY_MS)
  setInterval(paintClock, 200)
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response.json()
}

async function refresh(first) {
  if (state.paused) return
  if (first) setStatus("loading")
  const at = Date.now()
  try {
    await feed.refresh(at)
    const snapshot = feed.snapshot(at)
    if (!snapshot.ok) {
      setStatus("error")
      return
    }
    state.data = snapshot
    state.observedAtMs = Date.parse(snapshot.observedAt) || at
    state.loadedAtMs = Date.now()
    state.stationCount = feed.stationCount
    const incoming = runsFromTrains(snapshot.trains, locate, () => network.meta.color, at)
    state.runs = state.runs.length === 0 ? incoming : mergeRuns(state.runs, incoming, at)
    setStatus("ok")
    render()
  } catch (error) {
    console.warn("refresh failed", error)
    setStatus("error")
  }
}

function setStatus(kind) {
  state.status = kind
  els.pulse.dataset.state = kind === "ok" ? "live" : kind
}

/* ---------------------------------------------------------------- strings */

function applyStrings() {
  const s = t()
  document.documentElement.lang = state.lang === "en" ? "en" : "zh-HK"
  els.title.textContent = s.title
  els.sub.textContent = s.sub
  els.viewSeg.querySelector('[data-view="diagram"]').textContent = s.diagram
  els.viewSeg.querySelector('[data-view="map"]').textContent = s.map
  for (const button of els.langSeg.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.lang === state.lang))
  for (const button of els.viewSeg.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.view === state.view))
  els.pauseBtn.textContent = state.paused ? s.resume : s.pause
  els.pauseBtn.setAttribute("aria-pressed", String(state.paused))
  els.mapNote.textContent = s.mapLoading
  els.mapFallback.querySelector("p").textContent = s.mapUnavailable
  els.foot.innerHTML =
    `<p>${s.source}</p><p>${s.engine}</p>` +
    `<p><a href="https://github.com/iceninye/TML-traffic">github.com/iceninye/TML-traffic</a> · ` +
    `<a href="https://github.com/keithligh/hk-traffic-intelligence">engine: hk-traffic-intelligence</a></p>` +
    `<p id="build">v0.1.0 · commit 56079b9</p>`
  paintClock()
}

function paintClock() {
  const s = t()
  const now = new Date()
  els.clock.querySelector("b").textContent = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Hong_Kong", hour12: false })
  const counts = []
  if (state.data) counts.push(s.trains(state.runs.length), s.stations(state.stationCount))
  els.statusText.textContent = state.paused ? s.paused : state.status === "loading" ? s.loading : state.status === "error" ? s.feedDown : s.updated(Math.max(0, Math.round((Date.now() - state.loadedAtMs) / 1000)))
  els.statusCounts.textContent = counts.join(" · ")
}

/* ---------------------------------------------------------------- diagram */

function buildDiagram() {
  const measured = els.svg.getBoundingClientRect().width
  // A hidden pane measures 0; rebuilding then would bake in the fallback width.
  if (measured === 0) return
  const width = Math.max(300, Math.round(measured))
  const height = PAD_TOP + (displayOrder.length - 1) * ROW_H + PAD_BOTTOM
  els.svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
  els.svg.setAttribute("height", String(height))
  els.svg.replaceChildren()

  const ns = "http://www.w3.org/2000/svg"
  const make = (tag, attrs) => {
    const node = document.createElementNS(ns, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
    return node
  }

  const y = (index) => PAD_TOP + index * ROW_H
  const lastY = y(displayOrder.length - 1)
  const rightEdge = width - 4
  const wksX = rightEdge - COL_W
  const tumX = wksX - COL_GAP - COL_W
  const nameX = NAME_X

  const rows = make("g", {})
  const trainLayer = make("g", { id: "train-layer" })

  // A hairline between the two direction columns. The column headings live in
  // the sticky header so they stay readable once the diagram scrolls.
  rows.append(
    make("line", { x1: tumX + COL_W + COL_GAP / 2, y1: 4, x2: tumX + COL_W + COL_GAP / 2, y2: height - 4, stroke: "var(--edge)", "stroke-width": 1 }),
  )

  // the track, casing first so the coloured line sits on top
  rows.append(
    make("line", { x1: TRACK_X, y1: y(0), x2: TRACK_X, y2: lastY, class: "dg-track-casing" }),
    make("line", { x1: TRACK_X, y1: y(0), x2: TRACK_X, y2: lastY, class: "dg-track" }),
  )

  displayOrder.forEach((code, index) => {
    const rowY = y(index)
    const group = make("g", { class: "dg-row", "data-code": code })
    group.append(make("rect", { x: 0, y: rowY - ROW_H / 2, width, height: ROW_H, class: "dg-row-bg" }))

    const hit = make("circle", { cx: TRACK_X, cy: rowY, r: 15, class: "dg-station-hit", role: "button", tabindex: 0, "aria-label": network.name(code, state.lang) })
    hit.addEventListener("click", () => openStation(code))
    hit.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        openStation(code)
      }
    })
    hit.addEventListener("pointerenter", () => group.setAttribute("data-hover", "1"))
    hit.addEventListener("pointerleave", () => group.removeAttribute("data-hover"))

    group.append(
      hit,
      make("circle", { cx: TRACK_X, cy: rowY, r: 6, class: "dg-station" }),
      make("text", { x: nameX, y: rowY, class: "dg-name" }),
      make("text", { x: tumX + COL_W, y: rowY, "text-anchor": "end", class: "dg-ttnt" }),
      make("text", { x: wksX + COL_W, y: rowY, "text-anchor": "end", class: "dg-ttnt" }),
    )
    group.querySelectorAll(".dg-name")[0].textContent = stationLabel(code)
    rows.append(group)
  })

  els.svg.append(rows, trainLayer)
  trainNodes = new Map()
}

function stationLabel(code) {
  return network.name(code, state.lang)
}

function yFor(index) {
  return PAD_TOP + index * ROW_H
}

function cumFor(path) {
  const key = path.join(">")
  let value = cumCache.get(key)
  if (!value) {
    value = cumulative(path, locate)
    cumCache.set(key, value)
  }
  return value
}

// Where a run sits on the display axis, in station units (0 = Tuen Mun, 26 = Wu Kai Sha).
function axisPosition(run) {
  const cum = cumFor(run.path)
  const end = cum[cum.length - 1] ?? 0
  const distance = Math.max(0, Math.min(end, run.distance))
  let index = 0
  while (index < cum.length - 2 && (cum[index + 1] ?? 0) <= distance) index += 1
  const seg = (cum[index + 1] ?? 0) - (cum[index] ?? 0)
  const frac = seg > 1 ? (distance - (cum[index] ?? 0)) / seg : 0
  const alongPath = index + frac
  return run.path[0] === displayOrder[0] ? alongPath : displayOrder.length - 1 - alongPath
}

function trainsForDirection(dest) {
  return state.runs
    .filter((run) => run.dest === dest)
    .map((run) => ({ run, axis: axisPosition(run) }))
    .sort((a, b) => a.axis - b.axis)
}

function render() {
  if (!network) return
  const s = t()
  const boards = new Map()
  for (const board of state.data?.boards ?? []) boards.set(board.station, board)

  els.legendTum.textContent = `← ${s.toTum}`
  els.legendWks.textContent = `${s.toWks} →`

  let delayed = 0
  const notices = new Set()

  for (const group of els.svg.querySelectorAll(".dg-row")) {
    const code = group.dataset.code
    const rowY = Number(group.querySelector(".dg-station").getAttribute("cy"))
    const nameNode = group.querySelector(".dg-name")
    const [tumNode, wksNode] = group.querySelectorAll(".dg-ttnt")
    nameNode.textContent = stationLabel(code)

    const board = boards.get(code)
    if (board?.message) notices.add(board.message)

    const columns = [
      { node: tumNode, dest: "TUM", terminus: code === "TUM" },
      { node: wksNode, dest: "WKS", terminus: code === "WKS" },
    ]
    for (const column of columns) {
      if (column.terminus) {
        column.node.textContent = s.terminus
        column.node.dataset.tone = "none"
        continue
      }
      const list = (board?.trains ?? []).filter((train) => column.dest === "WKS" ? train.dest === "WKS" : train.dest !== "WKS")
      for (const train of list) if (train.delay) delayed += 1
      const shown = list.slice(0, MAX_TTNT).map((train) => (train.ttnt <= 0 ? s.due : String(train.ttnt)))
      column.node.textContent = shown.length ? shown.join("  ") : "—"
      const first = list[0]
      column.node.dataset.tone = !first ? "none" : first.ttnt <= 0 ? "now" : first.ttnt <= 3 ? "soon" : "far"
    }

    group.dataset.y = String(rowY)
  }

  if (notices.size > 0) {
    els.alert.dataset.show = "1"
    els.alert.innerHTML = `<b>${s.notice}</b> ${[...notices].join(" · ")}`
  } else if (delayed > 0) {
    els.alert.dataset.show = "1"
    els.alert.innerHTML = `<b>${s.delayNote}</b>`
  } else {
    els.alert.dataset.show = "0"
  }

  paintClock()
  if (state.view === "map") paintMap()
}

/* ------------------------------------------------------------- animation */

function syncTrains() {
  const ns = "http://www.w3.org/2000/svg"
  const layer = els.svg.querySelector("#train-layer")
  if (!layer) return
  const seen = new Set()

  // Trains bunch outside busy stations and inside the long tunnel; drawn at
  // their exact spot they merge into one blob. Nudge them along the track
  // instead of off it, so every marker stays on the line it belongs to.
  const items = state.runs
    .map((run) => {
      const axis = axisPosition(run)
      return { run, axis, base: yFor(axis), y: yFor(axis) }
    })
    .sort((a, b) => a.base - b.base)
  const usedY = []
  for (const item of items) {
    for (const offset of TRAIN_NUDGE) {
      item.y = item.base + offset
      if (!usedY.some((used) => Math.abs(used - item.y) < 15)) break
    }
    usedY.push(item.y)
  }

  for (const item of items) {
    const { run, axis, y } = item
    const x = TRACK_X
    seen.add(run.id)
    let node = trainNodes.get(run.id)
    if (!node) {
      node = document.createElementNS(ns, "g")
      node.setAttribute("class", "dg-train")
      node.dataset.id = run.id
      node.setAttribute("role", "button")
      node.setAttribute("tabindex", "0")
      node.append(
        document.createElementNS(ns, "circle"),
        document.createElementNS(ns, "text"),
        document.createElementNS(ns, "circle"),
      )
      node.children[0].setAttribute("r", String(TRAIN_R))
      node.children[2].setAttribute("r", "14")
      node.children[2].setAttribute("fill", "transparent")
      node.children[1].textContent = run.dest === "TUM" ? "↑" : "↓"
      node.addEventListener("click", () => openTrain(run.id))
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          openTrain(run.id)
        }
      })
      layer.append(node)
      trainNodes.set(run.id, node)
    }
    node.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
    node.dataset.delay = run.delay ? "1" : "0"
    node.dataset.dest = run.dest
    node.children[0].setAttribute("fill", run.color)
    node.children[0].setAttribute("stroke", run.delay ? "var(--warn)" : "#f7fbff")
    node.children[0].setAttribute("stroke-width", run.delay ? "2.5" : "1.5")
    node.setAttribute("aria-label", `${run.dest} ${Math.round(run.distance)}m`)
    node.dataset.axis = axis.toFixed(3)
  }

  for (const [id, node] of trainNodes) {
    if (!seen.has(id)) {
      node.remove()
      trainNodes.delete(id)
    }
  }
}

function loop(now) {
  rafId = requestAnimationFrame(loop)
  const stamp = now ?? performance.now()
  const dt = lastAdvance ? (stamp - lastAdvance) / 1000 : 0
  lastAdvance = stamp
  if (dt > 0 && dt < 5 && state.runs.length > 0) {
    state.runs = advanceRuns(state.runs, dt, locate)
  }
  if (state.view === "diagram") {
    syncTrains()
  } else if (stamp - lastMapPaint > 1200) {
    // The map only needs a refresh a second to look live; per-frame GeoJSON
    // writes would just burn CPU.
    lastMapPaint = stamp
    paintMap()
  }
}

/* ------------------------------------------------------------------- map */

const MAP_STYLES = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/bright",
}
const MAP_ENTRY = "../lib/maplibre/maplibre-gl.mjs"
const MAP_CSS = "../lib/maplibre/maplibre-gl.css"

function preferredStyle() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? MAP_STYLES.dark : MAP_STYLES.light
}

let mapCssInjected = false

function ensureMapCss() {
  if (mapCssInjected) return
  mapCssInjected = true
  const link = document.createElement("link")
  link.rel = "stylesheet"
  link.href = new URL(MAP_CSS, import.meta.url).href
  document.head.append(link)
}

async function loadMapLibre() {
  if (mapApi) return mapApi
  if (mapPromise) return mapPromise
  mapPromise = (async () => {
    // Self-hosted: no CDN in the critical path, and the app keeps working with
    // the network down (the diagram just never gets replaced by tiles).
    const module = await import(MAP_ENTRY)
    const api = module.default?.Map ? module.default : module
    if (typeof api.setWorkerUrl === "function") {
      api.setWorkerUrl(new URL("../lib/maplibre/maplibre-gl-worker.mjs", import.meta.url).href)
    }
    mapApi = api
    return api
  })()
  return mapPromise
}

async function ensureMap() {
  if (mapInstance) return mapInstance
  ensureMapCss()
  const maplibre = await loadMapLibre()
  mapInstance = new maplibre.Map({
    container: els.mapEl,
    style: preferredStyle(),
    center: [114.13, 22.37],
    zoom: 10.4,
    attributionControl: { compact: true },
  })
  mapInstance.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right")
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("map did not finish loading")), 25_000)
    mapInstance.once("load", () => {
      clearTimeout(timer)
      resolve()
    })
    // Tile 404s are survivable; a context we never got is not.
    mapInstance.on("error", (event) => {
      const message = String(event?.error?.message ?? event?.error ?? "")
      if (/webgl|context|gpu|initialize/i.test(message)) {
        clearTimeout(timer)
        reject(new Error(message))
      }
    })
  })
  // Frame the line rather than trusting a fixed centre/zoom on every screen.
  const lngs = []
  const lats = []
  for (const station of Object.values(network.stations)) {
    lngs.push(station.lng)
    lats.push(station.lat)
  }
  mapInstance.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: { top: 12, bottom: 12, left: 12, right: 12 }, duration: 0 },
  )
  installMapLayers()
  return mapInstance
}

function installMapLayers() {
  const map = mapInstance
  map.addSource("tml-track", { type: "geojson", data: network.trackCollection() })
  map.addSource("tml-stations", { type: "geojson", data: network.stationCollection() })
  map.addSource("tml-trains", { type: "geojson", data: { type: "FeatureCollection", features: [] } })

  map.addLayer({
    id: "tml-track-casing",
    type: "line",
    source: "tml-track",
    paint: { "line-color": "#041018", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3.2, 14, 5], "line-opacity": 0.55 },
    layout: { "line-cap": "round", "line-join": "round" },
  })
  map.addLayer({
    id: "tml-track",
    type: "line",
    source: "tml-track",
    paint: { "line-color": network.meta.color, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.6, 14, 2.6], "line-opacity": 0.92 },
    layout: { "line-cap": "round", "line-join": "round" },
  })
  map.addLayer({
    id: "tml-stations",
    type: "circle",
    source: "tml-stations",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 5.5],
      "circle-color": "#f7fbff",
      "circle-stroke-color": "#041018",
      "circle-stroke-width": 1.5,
    },
  })
  map.addLayer({
    id: "tml-station-labels",
    type: "symbol",
    source: "tml-stations",
    minzoom: 11,
    layout: {
      "text-field": ["coalesce", ["get", state.lang === "en" ? "name" : "nameTc"], ["get", "code"]],
      "text-size": 11,
      "text-offset": [0, 1.2],
      "text-anchor": "top",
      "text-font": ["Noto Sans Regular"],
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#f7fbff", "text-halo-color": "#041018", "text-halo-width": 1.6 },
  })
  map.addLayer({
    id: "tml-trains",
    type: "circle",
    source: "tml-trains",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4.5, 14, 7],
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#f7fbff",
      "circle-stroke-width": 1.5,
    },
  })

  // Same detail sheet as the diagram, so a tap means the same thing in both views.
  map.on("click", "tml-stations", (event) => {
    const code = event.features?.[0]?.properties?.code
    if (code) openStation(code)
  })
  map.on("mouseenter", "tml-stations", () => {
    map.getCanvas().style.cursor = "pointer"
  })
  map.on("mouseleave", "tml-stations", () => {
    map.getCanvas().style.cursor = ""
  })
}

function paintMap() {
  if (!mapInstance) return
  const features = state.runs.map((run) => {
    const place = placeRun(run, locate)
    if (!place) return null
    return {
      type: "Feature",
      properties: { id: run.id, color: run.color, dest: run.dest, delay: run.delay ? 1 : 0 },
      geometry: { type: "Point", coordinates: [place.lng, place.lat] },
    }
  }).filter(Boolean)
  mapInstance.getSource("tml-trains")?.setData({ type: "FeatureCollection", features })
  mapInstance.getLayer("tml-station-labels")?.setLayoutProperty("text-field", ["coalesce", ["get", state.lang === "en" ? "name" : "nameTc"], ["get", "code"]])
}

async function showView(view) {
  state.view = view
  localStorage.setItem(VIEW_KEY, view)
  for (const button of els.viewSeg.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.view === view))
  els.paneDiagram.dataset.active = view === "diagram" ? "1" : "0"
  els.paneMap.dataset.active = view === "map" ? "1" : "0"
  els.mapFallback.dataset.show = "0"
  if (view !== "map") return

  els.mapNote.textContent = t().mapLoading
  try {
    await ensureMap()
    els.mapNote.textContent = t().attribution
    mapInstance.resize()
    paintMap()
  } catch (error) {
    console.warn("map unavailable", error)
    els.mapNote.textContent = t().mapUnavailable
    els.mapFallback.dataset.show = "1"
    for (const button of els.viewSeg.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.view === "diagram"))
    els.paneDiagram.dataset.active = "1"
    els.paneMap.dataset.active = "0"
    state.view = "diagram"
    localStorage.setItem(VIEW_KEY, "diagram")
  }
}

/* ----------------------------------------------------------------- sheet */

function openSheet(html) {
  els.sheetBody.innerHTML = html
  els.sheet.dataset.open = "1"
  els.sheetBackdrop.dataset.open = "1"
}

function closeSheet() {
  els.sheet.dataset.open = "0"
  els.sheetBackdrop.dataset.open = "0"
}

function minutesLabel(value) {
  const s = t()
  if (value <= 0) return `<span class="mins">${s.due}</span>`
  return `<span class="mins">${value}<small>${s.min}</small></span>`
}

function trainRow(train) {
  const s = t()
  const badge = train.delay ? ` <span class="badge">${s.delayBadge}</span>` : ""
  const platform = train.plat ? `${s.platform} ${train.plat}` : ""
  const kind = train.timeType === "D" ? s.scheduled : ""
  const meta = [platform, kind].filter(Boolean).join(" · ")
  return `<div class="train-item" data-delay="${train.delay ? 1 : 0}">${minutesLabel(train.ttnt)}` +
    `<span>${network.name(train.dest, state.lang)}${badge}</span>` +
    `<span class="meta">${meta}</span></div>`
}

function openStation(code) {
  const s = t()
  const board = (state.data?.boards ?? []).find((item) => item.station === code)
  const name = network.name(code, state.lang)
  const blocks = []
  for (const dest of ["TUM", "WKS"]) {
    if (code === dest) {
      blocks.push(
        `<div class="dir-block"><div class="dir-head"><span class="arrow">→</span>${network.name(dest, state.lang)}</div>` +
        `<div class="empty">${s.terminus}</div></div>`,
      )
      continue
    }
    const list = (board?.trains ?? []).filter((train) => dest === "WKS" ? train.dest === "WKS" : train.dest !== "WKS").slice(0, 4)
    blocks.push(
      `<div class="dir-block"><div class="dir-head"><span class="arrow">→</span>${network.name(dest, state.lang)}</div>` +
      (list.length ? `<div class="train-list">${list.map(trainRow).join("")}</div>` : `<div class="empty">${s.noTrains}</div>`) +
      `</div>`,
    )
  }
  const notice = board?.message ? `<p class="sub"><b>${s.notice}</b> ${board.message}</p>` : ""
  openSheet(
    `<button class="sheet-close" aria-label="${s.close}">✕</button>` +
    `<h2>${name}</h2><div class="sub">${code} · ${network.line}${board ? "" : ` · ${s.noTrains}`}</div>` +
    notice + blocks.join(""),
  )
}

function openTrain(runId) {
  const s = t()
  const run = state.runs.find((item) => item.id === runId)
  if (!run) return
  const place = placeRun(run, locate)
  const position = place
    ? place.from === place.to
      ? s.atStation(network.name(place.from, state.lang))
      : s.between(network.name(place.from, state.lang), network.name(place.to, state.lang))
    : "—"
  const speed = run.speed > 0 ? `${Math.round(run.speed * 3.6)} km/h` : "0 km/h"
  openSheet(
    `<button class="sheet-close" aria-label="${s.close}">✕</button>` +
    `<h2>${network.name(run.dest, state.lang)}</h2>` +
    `<div class="sub">${s.line} ${run.line}${run.delay ? ` · <span class="badge">${s.delayBadge}</span>` : ""}</div>` +
    `<dl class="kv">` +
    `<dt>${s.dest}</dt><dd>${network.name(run.dest, state.lang)}</dd>` +
    `<dt>${s.position}</dt><dd>${position}</dd>` +
    `<dt>${s.nextAt}</dt><dd>${place ? `${Math.max(0, place.minutes).toFixed(1)} ${s.min}` : "—"}</dd>` +
    `<dt>${s.speed}</dt><dd>${speed}</dd>` +
    `<dt>${s.platform}</dt><dd>${run.plat || "—"}</dd>` +
    `</dl>` +
    (run.timeType === "D" ? `<p class="sub">${s.scheduled}</p>` : ""),
  )
}

/* -------------------------------------------------------------- controls */

function wireControls() {
  els.viewSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button")
    if (button) showView(button.dataset.view)
  })
  els.langSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button")
    if (!button) return
    state.lang = button.dataset.lang
    localStorage.setItem(LOCALE_KEY, state.lang)
    feed = createFeed(network, { readSchedule, carryArrivalClock, estimateTrains, lang: state.lang })
    state.runs = []
    state.data = null
    cumCache = new Map()
    applyStrings()
    buildDiagram()
    state.lang = button.dataset.lang
    render()
    refresh(true)
  })
  els.pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused
    localStorage.setItem(PAUSE_KEY, state.paused ? "1" : "0")
    els.pauseBtn.textContent = state.paused ? t().resume : t().pause
    els.pauseBtn.setAttribute("aria-pressed", String(state.paused))
    setStatus(state.paused ? "paused" : "ok")
    if (!state.paused) refresh(false)
  })
  els.sheetBackdrop.addEventListener("click", closeSheet)
  els.sheet.addEventListener("click", (event) => {
    if (event.target.closest(".sheet-close")) closeSheet()
  })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSheet()
  })
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh(false)
  })
  let resizeTimer = 0
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => buildDiagram(), 180)
  })
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {})
  }
}

boot().catch((error) => {
  console.error(error)
  setStatus("error")
  els.statusText.textContent = String(error?.message ?? error)
})
