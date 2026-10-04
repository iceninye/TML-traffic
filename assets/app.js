// Tuen Ma Line live diagram.
//
// The engine under lib/ chains the published next-train boards into trains
// (mtr-estimate.js). lib/tml-model.js places each train with the timetable —
// per-hop run times, station dwell, track kilometres, an S-shaped speed
// profile — and lib/tml-motion.js keeps identities across snapshots and
// smooths corrections. This file is only the view.
//
// Two views, same runs:
//   diagram (default) — SVG, two tracks (up = to Tuen Mun, down = to Wu Kai
//                       Sha), station spacing follows track distance.
//   map     (optional) — MapLibre GL on OpenFreeMap tiles, real OSM alignment,
//                       the two directions drawn side by side in two colours.

import { readSchedule } from "../lib/mtr-schedule.js"
import { carryArrivalClock, estimateTrains, setHopModel } from "../lib/mtr-estimate.js"
import { createNetwork } from "../lib/mtr-network.js"
import { createFeed } from "../lib/mtr-feed.js"
import { createModel } from "../lib/tml-model.js"
import { createTracker } from "../lib/tml-motion.js"
import { DAY_TYPES, calendarDay, createTimetables, headwayAt, hopTimesAround, matchReadings, serviceSeconds } from "../lib/tml-timetable.js"

const LOCALE_KEY = "tml-traffic-locale"
const VIEW_KEY = "tml-traffic-view"
const PAUSE_KEY = "tml-traffic-paused"
// Hop-time calibration learned from the feed, kept so a reload starts warm.
// v2: corrections are now relative to the working timetable's own hop
// times; v1 values were relative to the old single-table model.
const LEARN_KEY = "tml-traffic-learned-v2"
// The feed only re-reads a station once it is 20 s old, so refresh just after
// that: every pass then reads all 27 (at 18 s each station was read every 36 s).
const REFRESH_EVERY_MS = 20_500

// Diagram geometry. Spacing between stations follows track distance, with a
// floor so the shortest hops (0.75 km) still leave room for two-line labels.
const PAD_TOP = 34
const PAD_BOTTOM = 34
const MIN_GAP = 62
const PX_PER_KM = 24
const TRACK_UP_X = 26
const TRACK_DN_X = 56
const NAME_X = 84
const COL_W = 70
const COL_GAP = 4
const TRAIN_R = 9
const TRAIN_SPACING = 21
const MAX_TTNT = 3
// Only trains at least this far behind the timetable get a delay tag.
const LATE_SHOW_SEC = 60
const LATE_ALARM_SEC = 180
const BUILD = { version: "0.4.1", commit: "23fb85d" }

const COLORS = { UP: "var(--up)", DOWN: "var(--down)" }
// Raw values for MapLibre, which cannot read CSS variables.
const MAP_COLORS = { alarm: "#ff1238", UP: "#ff8f45", DOWN: "#3fa9ff", UP_HOT: "#ffe2c7", DOWN_HOT: "#d6edff", casing: "#020611", warn: "#d29922", late: "#e5484d" }

// Interchanges, coloured as on the MTR system map.
const INTERCHANGE = {
  MEF: [["TWL", "#E2231A"]],
  NAC: [["TCL", "#F7943E"]],
  ETS: [["TWL", "#E2231A"]],
  HUH: [["EAL", "#5EB6E4"]],
  HOM: [["KTL", "#00AB4E"]],
  DIH: [["KTL", "#00AB4E"]],
  TAW: [["EAL", "#5EB6E4"]],
}
const TUNNEL = { from: "KSR", to: "TWW", tc: "大欖隧道", en: "Tai Lam Tunnel" }

const STRINGS = {
  tc: {
    title: "屯馬綫列車動態圖",
    sub: "Tuen Ma Line · 實時推算",
    diagram: "路綫圖",
    map: "地圖",
    pause: "暫停",
    resume: "繼續",
    up: "上行",
    down: "下行",
    toTum: "往屯門",
    toWks: "往烏溪沙",
    terminus: "總站",
    live: "LIVE",
    trainsDir: (u, d) => `▲ ${u} · ▼ ${d} 班`,
    stations: (n) => `${n}/27 站`,
    updated: (s) => (s < 60 ? `${s} 秒前更新` : `${Math.floor(s / 60)} 分鐘前更新`),
    loading: "讀取中…",
    feedDown: (r) => `暫時連唔到港鐵班次資料，${r} 秒後自動重試`,
    stale: (a, r) => `資料延遲（${a < 60 ? `${a} 秒` : `${Math.floor(a / 60)} 分鐘`}前），列車按時間表推算・${r} 秒後重試`,
    offline: "網絡離線，恢復後自動更新",
    paused: "已暫停更新",
    min: "分",
    due: "即將",
    platform: "月台",
    scheduled: "預定",
    delayBadge: "延誤",
    delayNote: "港鐵報告有列車延誤，列車位置以黃色外框標示",
    notice: "服務提示",
    position: "現時位置",
    running: (a, b) => `行駛中 ${a} → ${b}`,
    dwelling: (a) => `${a} 停站中`,
    waiting: (a) => `${a} 即將開出`,
    arrived: (a) => `已抵達 ${a}`,
    dest: "目的地",
    nextStops: "前方各站（推算）",
    speed: "車速",
    shortTrip: "短程車",
    follow: "跟隨",
    following: "跟隨中",
    close: "閂",
    noTrains: "暫時冇班次資料",
    mapUnavailable: "地圖開唔到（瀏覽器唔支援 WebGL 或網絡問題），已自動轉回路綫圖。",
    mapLoading: "載入地圖…",
    attribution: "路軌 © OpenStreetMap 貢獻者 (ODbL) · 底圖 OpenFreeMap",
    source: "資料來源：港鐵 Next Train API（data.gov.hk）",
    engine: "列車位置由到站倒數配合時間表行車及停站時間推算，並非港鐵官方列車位置",
    engineRef: "Engine參考",
    lateTag: (sec) => `- ${sec}s`,
    lateLabel: "慢於時間表",
    lateSec: (sec) => `${sec} 秒`,
    lateSource: { timetable: "比時間表班次遲", run: "行車／停站比時間表慢", feed: "港鐵前方各站預報偏慢", headway: "與前車間距超出班距" },
    onTime: "準時（相差少於 60 秒）",
    readings: (n) => `綜合 ${n} 個車站倒數`,
    dayType: { weekday: "平日", saturday: "星期六", sunday: "星期日／假期" },
    peak: "繁忙",
    offPeak: "非繁忙",
    matchNote: (m, f) => `${m} 班對應時間表班次，${f} 班按行車模型推算`,
    tripId: (run, trip) => `車次 ${trip}（Run ${run}）`,
    basis: { sched: (n) => `按時間表班次 + ${n} 個車站倒數校正`, model: (n) => `時間表無對應班次，按 ${n} 個車站倒數推算` },
    band: { early: "清晨", shoulder: "繁忙過渡", amPeak: "早上繁忙", day: "日間", pmPeak: "黃昏繁忙", evening: "晚間" },
    headway: (m) => `班距約 ${m} 分`,
    offService: "非服務時間",
    peakRun: "繁忙時段行車時間",
    offRun: "非繁忙行車時間",
    hopLabel: (km, down, up) => `${km.toFixed(2)} km · ▼${clockSpan(down)} ▲${clockSpan(up)}`,
    shortLegend: "虛線圈＝短程車",
    colUp: "往屯門",
    colDown: "往烏溪沙",
  },
  en: {
    title: "Tuen Ma Line Live",
    sub: "Tuen Ma Line · estimated",
    diagram: "Diagram",
    map: "Map",
    pause: "Pause",
    resume: "Resume",
    up: "Up",
    down: "Down",
    toTum: "To Tuen Mun",
    toWks: "To Wu Kai Sha",
    terminus: "Terminus",
    live: "LIVE",
    trainsDir: (u, d) => `▲ ${u} · ▼ ${d} trains`,
    stations: (n) => `${n}/27 stations`,
    updated: (s) => (s < 60 ? `updated ${s}s ago` : `updated ${Math.floor(s / 60)}m ago`),
    loading: "Loading…",
    feedDown: (r) => `Can't reach the MTR feed, retrying in ${r}s`,
    stale: (a, r) => `Data ${a < 60 ? `${a}s` : `${Math.floor(a / 60)}m`} old, trains estimated from timetable · retry in ${r}s`,
    offline: "Offline, will update when back online",
    paused: "Updates paused",
    min: "min",
    due: "now",
    platform: "Platform",
    scheduled: "Scheduled",
    delayBadge: "Delay",
    delayNote: "MTR reports a delay; affected trains are outlined in amber",
    notice: "Service notice",
    position: "Position",
    running: (a, b) => `Running ${a} → ${b}`,
    dwelling: (a) => `Stopped at ${a}`,
    waiting: (a) => `About to leave ${a}`,
    arrived: (a) => `Arrived at ${a}`,
    dest: "Destination",
    nextStops: "Next stops (estimated)",
    speed: "Speed",
    shortTrip: "Short trip",
    follow: "Follow",
    following: "Following",
    close: "Close",
    noTrains: "No board data yet",
    mapUnavailable: "The map could not start (no WebGL, or the tiles would not load). Switched back to the diagram.",
    mapLoading: "Loading map…",
    attribution: "Track © OpenStreetMap contributors (ODbL) · basemap OpenFreeMap",
    source: "Source: MTR Next Train API (data.gov.hk)",
    engine: "Positions are estimated from arrival countdowns plus timetable run and dwell times, not official MTR train locations",
    engineRef: "Engine reference",
    lateTag: (sec) => `- ${sec}s`,
    lateLabel: "Behind timetable",
    lateSec: (sec) => `${sec} s`,
    lateSource: { timetable: "behind its timetabled trip", run: "running slower than timetable", feed: "MTR boards ahead predict it slower", headway: "gap to the train ahead exceeds headway" },
    onTime: "On time (within 60 s)",
    readings: (n) => `fused from ${n} station countdowns`,
    dayType: { weekday: "Weekday", saturday: "Saturday", sunday: "Sunday/PH" },
    peak: "peak",
    offPeak: "off-peak",
    matchNote: (m, f) => `${m} trains matched to timetabled trips, ${f} estimated by the running model`,
    tripId: (run, trip) => `Trip ${trip} (run ${run})`,
    basis: { sched: (n) => `Timetabled trip, corrected by ${n} station countdowns`, model: (n) => `No timetabled trip matched; estimated from ${n} station countdowns` },
    band: { early: "Early", shoulder: "Shoulder", amPeak: "AM peak", day: "Daytime", pmPeak: "PM peak", evening: "Evening" },
    headway: (m) => `every ~${m} min`,
    offService: "Out of service hours",
    peakRun: "peak run times",
    offRun: "off-peak run times",
    hopLabel: (km, down, up) => `${km.toFixed(2)} km · ▼${clockSpan(down)} ▲${clockSpan(up)}`,
    shortLegend: "dashed ring = short trip",
    colUp: "Tuen Mun",
    colDown: "Wu Kai Sha",
  },
}

const els = {
  title: document.getElementById("title"),
  sub: document.getElementById("sub"),
  clock: document.getElementById("clock"),
  pulse: document.getElementById("pulse"),
  statusText: document.getElementById("status-text"),
  statusCounts: document.getElementById("status-counts"),
  period: document.getElementById("period"),
  alert: document.getElementById("alert"),
  paneDiagram: document.getElementById("pane-diagram"),
  paneMap: document.getElementById("pane-map"),
  svg: document.getElementById("diagram"),
  mapEl: document.getElementById("map"),
  mapNote: document.getElementById("map-note"),
  mapLegend: document.getElementById("map-legend"),
  mapFallback: document.getElementById("map-fallback"),
  viewSeg: document.getElementById("view-seg"),
  langSeg: document.getElementById("lang-seg"),
  pauseBtn: document.getElementById("pause-btn"),
  colLegend: document.getElementById("col-legend"),
  sheet: document.getElementById("sheet"),
  sheetBody: document.getElementById("sheet-body"),
  sheetBackdrop: document.getElementById("sheet-backdrop"),
  foot: document.getElementById("foot"),
}

const state = {
  lang: readPref(LOCALE_KEY) === "en" ? "en" : "tc",
  view: readPref(VIEW_KEY) === "map" ? "map" : "diagram",
  paused: readPref(PAUSE_KEY) === "1",
  runs: [],
  data: null,
  loadedAtMs: 0,
  stationCount: 0,
  status: "loading",
  selected: null,
  follow: false,
  sheetKind: null,
}

let network = null
let model = null
let timetables = null
// Readings per scheduled trip from recent snapshots (they keep narrowing
// that trip's delay while they are fresh).
let tripHistory = new Map()
let hopTimesKey = ""
let tracker = null
let feed = null
let order = []
let stationY = new Map()
let trainNodes = new Map()
let mapApi = null
let mapInstance = null
let mapPromise = null
let lastMapPaint = 0
let lastSheetPaint = 0
let lastFollow = 0

const t = () => STRINGS[state.lang]

/* ------------------------------------------------------------------ data */

async function boot() {
  const [netJson, timetable, track, ...books] = await Promise.all([
    fetchJson("data/tml-network.json"),
    fetchJson("data/tml-timetable.json"),
    fetchJson("data/tml-track.json").catch(() => null),
    // The three working timetables. Without them the app falls back to the
    // running-time model alone.
    ...DAY_TYPES.map((day) => fetchJson(`data/tml-schedule-${day}.json`).catch(() => null)),
  ])
  network = createNetwork(netJson)
  model = createModel(timetable, track)
  timetables = createTimetables(Object.fromEntries(DAY_TYPES.map((day, i) => [day, books[i]])), model)
  state.day = calendarDay(Date.now())
  // Section labels and the fallback model use this period's timetable times.
  if (timetables.books[state.day]) {
    const tau = serviceSeconds(Date.now())
    hopTimesKey = `${state.day}|${Math.floor(tau / 600)}`
    model.setScheduleTimes(hopTimesAround(timetables.books[state.day], tau))
  }
  try {
    model.importLearned(JSON.parse(readPref(LEARN_KEY) ?? "null"))
  } catch {
    // A corrupt saved calibration is simply ignored; it relearns in minutes.
  }
  tracker = createTracker(model)
  order = model.order
  // Chain board readings with the timetable gap (dwell + run) per hop.
  setHopModel((from, to) => model.arrivalGapMinutes(from, to, Date.now()))
  feed = makeFeed()

  applyStrings()
  buildDiagram()
  wireControls()
  render()

  await refresh(true)
  requestAnimationFrame(loop)
  showView(state.view).catch(() => {})
  setInterval(paintClock, 250)
}

function makeFeed() {
  return createFeed(network, { readSchedule, carryArrivalClock, estimateTrains, lang: state.lang })
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response.json()
}

// One refresh chain, never overlapping. After a failure it retries sooner
// and backs off (5, 10, 20, 30 s) instead of waiting out the normal 18 s.
const RETRY_MS = [5_000, 10_000, 20_000, 30_000]
// Boards older than this mean the latest reads failed; the trains keep
// moving on the timetable model, but the status says the data is behind.
const STALE_AFTER_MS = 45_000
let refreshTimer = 0
let inFlight = null
let failStreak = 0

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer)
  state.nextRefreshAt = Date.now() + delay
  refreshTimer = setTimeout(() => refresh(false), delay)
}

function refresh(first) {
  if (state.paused) return Promise.resolve()
  if (inFlight) return inFlight
  inFlight = runRefresh(first).finally(() => {
    inFlight = null
    if (state.paused) return
    if (state.status === "ok") {
      failStreak = 0
      scheduleRefresh(REFRESH_EVERY_MS)
    } else {
      scheduleRefresh(RETRY_MS[Math.min(failStreak, RETRY_MS.length - 1)])
      failStreak += 1
    }
  })
  return inFlight
}

async function runRefresh(first) {
  if (first) setStatus("loading")
  const at = Date.now()
  try {
    await feed.refresh(at)
    const snapshot = feed.snapshot(at)
    if (!snapshot.ok) {
      // Nothing usable at all. Keep whatever was on screen.
      setStatus(state.data ? "stale" : "error")
      return
    }
    state.data = snapshot
    state.loadedAtMs = feed.newestAt || Date.now()
    state.stationCount = feed.stationCount
    placeTrains(snapshot, Date.now())
    state.runs = tracker.frame(Date.now())
    setStatus(Date.now() - state.loadedAtMs > STALE_AFTER_MS ? "stale" : "ok")
    render()
    // Draw now as well: animation frames do not run in a background tab.
    if (state.view === "diagram") syncTrains()
  } catch (error) {
    console.warn("refresh failed", error)
    setStatus(state.data ? "stale" : "error")
  }
}

// Match the boards to the working timetable and hand the result to the
// tracker; anything no scheduled trip claims goes through the model.
function placeTrains(snapshot, now) {
  const readings = []
  for (const o of snapshot.observations ?? []) {
    const ks = model.km(o.station)
    const kd = model.km(o.dest)
    if (ks == null || kd == null || ks === kd) continue
    readings.push({
      station: o.station,
      dest: o.dest,
      dir: kd > ks ? "DOWN" : "UP",
      ttnt: o.ttnt,
      dueAt: o.dueAt,
      plat: o.plat,
      delay: o.delay,
      timeType: o.timeType,
      seenAt: now,
      obs: o,
    })
  }

  // Which timetable is actually running: the calendar's guess, unless the
  // boards clearly fit another one better (public holidays run Sunday's).
  const pick = timetables.pickDay(readings, now)
  const mine = pick.scores[state.day]
  const theirs = pick.day && pick.scores[pick.day]
  if (theirs && pick.day !== state.day && theirs.n >= 10 && theirs.close - (mine?.close ?? 0) > 0.25) {
    state.day = pick.day
    tripHistory = new Map()
  }
  state.dayScores = pick.scores
  const book = timetables.books[state.day]

  let matched = new Map()
  let leftover = readings
  if (book) {
    const tau = serviceSeconds(now)
    const key = `${state.day}|${Math.floor(tau / 600)}`
    if (key !== hopTimesKey) {
      hopTimesKey = key
      model.setScheduleTimes(hopTimesAround(book, tau))
    }
    const result = matchReadings(book, readings, now, tripHistory)
    matched = result.trips
    leftover = result.leftover
    state.lineDelay = result.lineDelay
    tripHistory = new Map([...matched].map(([id, entry]) => [id, entry.history]))
  }

  const fallback = leftover.length
    ? estimateTrains(network.routes_(), leftover.map((r) => r.obs), network.point.bind(network)).map((train) => ({
      ...train,
      observedAtMs: train.observedAt,
      dueAtMs: train.dueAt,
    }))
    : []
  // The model learns per-direction corrections from the unmatched chains.
  if (fallback.length) {
    model.learn(fallback, now)
    writePref(LEARN_KEY, JSON.stringify(model.exportLearned()))
  }
  state.matchedCount = matched.size
  state.fallbackCount = fallback.length
  tracker.update({ matched, fallback, headwayOf: (dir, t0) => (book ? headwayAt(book, dir, serviceSeconds(t0)) : null) }, now)
}

function setStatus(kind) {
  state.status = kind
  els.pulse.dataset.state = kind === "ok" ? "live" : kind === "stale" ? "loading" : kind
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
  els.colLegend.innerHTML =
    `<span class="lg-tracks"><i class="tri up" aria-hidden="true"></i><i class="tri down" aria-hidden="true"></i>` +
    `<em>${s.shortLegend}</em></span>` +
    `<span class="lg-col up" title="${s.toTum}">${s.colUp}</span><span class="lg-col down" title="${s.toWks}">${s.colDown}</span>`
  els.mapLegend.innerHTML =
    `<span><i class="sw up"></i>${s.up} · ${s.toTum}</span><span><i class="sw down"></i>${s.down} · ${s.toWks}</span>`
  const commitLink = BUILD.commit === "dev"
    ? "dev"
    : `<a href="https://github.com/iceninye/TML-traffic/commit/${BUILD.commit}">${BUILD.commit}</a>`
  els.foot.innerHTML =
    `<p>${s.source}</p><p>${s.engine}</p>` +
    `<p>${s.engineRef}: <a href="https://github.com/keithligh/hk-traffic-intelligence">hk-traffic-intelligence</a></p>` +
    `<p id="build">v${BUILD.version} · commit ${commitLink}</p>`
  paintClock()
}

function paintClock() {
  const s = t()
  const now = Date.now()
  els.clock.querySelector("b").textContent = new Date(now).toLocaleTimeString("en-GB", { timeZone: "Asia/Hong_Kong", hour12: false })
  let up = 0
  let down = 0
  for (const run of state.runs) run.dir === "UP" ? (up += 1) : (down += 1)
  const counts = state.data ? [s.trainsDir(up, down), s.stations(state.stationCount)] : []
  const age = Math.max(0, Math.round((now - state.loadedAtMs) / 1000))
  const retryIn = Math.max(0, Math.ceil(((state.nextRefreshAt ?? now) - now) / 1000))
  const offline = typeof navigator !== "undefined" && navigator.onLine === false
  // Turn "updated Ns ago" into the stale warning as soon as it is, not at the next refresh.
  if (state.status === "ok" && age * 1000 > STALE_AFTER_MS) setStatus("stale")
  els.statusText.textContent = state.paused
    ? s.paused
    : state.status === "loading"
      ? s.loading
      : state.status === "error"
        ? (offline ? s.offline : s.feedDown(retryIn))
        : state.status === "stale"
          ? (offline ? s.offline : s.stale(age, retryIn))
          : s.updated(age)
  els.statusCounts.textContent = counts.join(" · ")
  const book = timetables?.books[state.day]
  if (book) {
    const tau = serviceSeconds(now)
    const headway = headwayAt(book, "DOWN", tau) ?? headwayAt(book, "UP", tau)
    if (!headway) {
      els.period.textContent = s.offService
      els.period.dataset.peak = "0"
    } else {
      const peak = headway <= 210
      const mins = Math.round((headway / 60) * 10) / 10
      els.period.textContent = `${s.dayType[state.day]} · ${peak ? s.peak : s.offPeak} · ${s.headway(mins)}`
      els.period.dataset.peak = peak ? "1" : "0"
      els.period.title = s.matchNote(state.matchedCount ?? 0, state.fallbackCount ?? 0)
    }
  }
}

/* ---------------------------------------------------------------- diagram */

const SVG_NS = "http://www.w3.org/2000/svg"

function make(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  if (text != null) node.textContent = text
  return node
}

function layoutStations() {
  stationY = new Map()
  let y = PAD_TOP
  order.forEach((code, index) => {
    if (index > 0) {
      const gapKm = model.km(code) - model.km(order[index - 1])
      y += Math.max(MIN_GAP, gapKm * PX_PER_KM)
    }
    stationY.set(code, y)
  })
  return y
}

// Display y for a kilometre on the line: linear inside each hop.
function yForKm(km) {
  let i = 0
  while (i < order.length - 2 && model.km(order[i + 1]) < km) i += 1
  const a = order[i]
  const b = order[i + 1]
  const ka = model.km(a)
  const kb = model.km(b)
  const f = kb === ka ? 0 : Math.min(1, Math.max(0, (km - ka) / (kb - ka)))
  return stationY.get(a) + (stationY.get(b) - stationY.get(a)) * f
}

function buildDiagram() {
  const measured = els.svg.getBoundingClientRect().width
  // A hidden pane measures 0; rebuilding then would bake in the fallback width.
  if (measured === 0) return
  const s = t()
  const width = Math.max(300, Math.round(measured))
  const lastY = layoutStations()
  const height = lastY + PAD_BOTTOM
  els.svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
  els.svg.setAttribute("height", String(height))
  els.svg.replaceChildren()

  const firstY = stationY.get(order[0])
  const dnColX = width - 4 - COL_W
  const upColX = dnColX - COL_GAP - COL_W

  const defs = make("defs")
  // User-space region: a vertical line has a zero-width bounding box, so the
  // default percentage region would clip its glow to nothing.
  const filter = make("filter", { id: "dg-glow", filterUnits: "userSpaceOnUse", x: -60, y: -60, width: width + 120, height: height + 120 })
  filter.append(make("feGaussianBlur", { stdDeviation: 4 }))
  defs.append(filter)
  els.svg.append(defs)

  const base = make("g")
  // Column panels behind the countdowns.
  base.append(
    make("rect", { x: upColX, y: 6, width: COL_W, height: height - 12, rx: 8, class: "dg-col up" }),
    make("rect", { x: dnColX, y: 6, width: COL_W, height: height - 12, rx: 8, class: "dg-col down" }),
  )

  // Hop annotations: distance and run time, tunnel name on the long one.
  for (let i = 0; i < order.length - 1; i += 1) {
    const a = order[i]
    const b = order[i + 1]
    const hop = model.hop(a, b)
    const ya = stationY.get(a)
    const yb = stationY.get(b)
    const mid = (ya + yb) / 2
    // Run times per direction from the working timetable for this period.
    const down = model.timetableRunSec(a, b, Date.now())
    const up = model.timetableRunSec(b, a, Date.now())
    const label = make("text", { x: NAME_X, y: mid, class: "dg-hop" }, s.hopLabel(hop.km, down, up))
    base.append(label)
    if (a === TUNNEL.from && b === TUNNEL.to) {
      base.append(
        make("rect", { x: TRACK_UP_X - 12, y: ya + 22, width: TRACK_DN_X - TRACK_UP_X + 24, height: yb - ya - 44, rx: 10, class: "dg-tunnel" }),
        make("text", { x: NAME_X, y: mid + 16, class: "dg-tunnel-label" }, state.lang === "en" ? TUNNEL.en : TUNNEL.tc),
      )
    }
  }

  // Two tracks, casing under colour.
  // Plain coloured tracks; only the trains glow.
  for (const [x, dir] of [[TRACK_UP_X, "up"], [TRACK_DN_X, "down"]]) {
    base.append(
      make("line", { x1: x, y1: firstY, x2: x, y2: lastY, class: "dg-track-casing" }),
      make("line", { x1: x, y1: firstY, x2: x, y2: lastY, class: `dg-track ${dir}` }),
    )
  }
  // Direction chevrons along each track, a few per screen.
  for (let y = firstY + 40; y < lastY - 20; y += 180) {
    base.append(
      make("path", { d: `M${TRACK_UP_X - 4} ${y + 3} L${TRACK_UP_X} ${y - 2} L${TRACK_UP_X + 4} ${y + 3}`, class: "dg-chev" }),
      make("path", { d: `M${TRACK_DN_X - 4} ${y - 3} L${TRACK_DN_X} ${y + 2} L${TRACK_DN_X + 4} ${y - 3}`, class: "dg-chev" }),
    )
  }

  const rows = make("g")
  for (const code of order) {
    const y = stationY.get(code)
    const group = make("g", { class: "dg-row", "data-code": code })
    group.append(make("rect", { x: 0, y: y - 22, width, height: 44, class: "dg-row-bg" }))
    // Station: one capsule across both tracks, like a platform.
    group.append(make("rect", { x: TRACK_UP_X - 9, y: y - 7, width: TRACK_DN_X - TRACK_UP_X + 18, height: 14, rx: 7, class: "dg-station" }))
    const primary = network.name(code, state.lang)
    const secondary = state.lang === "en" ? network.name(code, "tc") : network.name(code, "en")
    group.append(
      make("text", { x: NAME_X, y: y - 5, class: "dg-name" }, primary),
      make("text", { x: NAME_X, y: y + 11, class: "dg-name-2" }, secondary),
    )
    // Interchange tags sit beside whichever line carries the Chinese name,
    // which is always short.
    const cjkOnFirst = state.lang !== "en"
    const tagX = NAME_X + approxWidth(cjkOnFirst ? primary : secondary, cjkOnFirst ? 15.5 : 11) + 6
    const tagY = cjkOnFirst ? y - 5 : y + 11
    ;(INTERCHANGE[code] ?? []).forEach(([line, color], k) => {
      const x = tagX + k * 34
      group.append(
        make("rect", { x, y: tagY - 7.5, width: 30, height: 15, rx: 4, fill: color, class: "dg-xfer" }),
        make("text", { x: x + 15, y: tagY + 0.5, class: "dg-xfer-text" }, line),
      )
    })
    group.append(
      make("text", { x: upColX + COL_W / 2, y: y + 1, class: "dg-ttnt" }),
      make("text", { x: dnColX + COL_W / 2, y: y + 1, class: "dg-ttnt" }),
    )
    const hit = make("rect", { x: 0, y: y - 22, width: upColX - 4, height: 44, class: "dg-hit", role: "button", tabindex: 0, "aria-label": primary })
    hit.addEventListener("click", () => openStation(code))
    hit.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        openStation(code)
      }
    })
    hit.addEventListener("pointerenter", () => group.setAttribute("data-hover", "1"))
    hit.addEventListener("pointerleave", () => group.removeAttribute("data-hover"))
    group.append(hit)
    rows.append(group)
  }

  els.svg.append(base, rows, make("g", { id: "train-layer" }))
  // Long English names would run into the countdown columns: shrink to fit.
  const room = upColX - 8 - NAME_X
  for (const node of els.svg.querySelectorAll(".dg-name, .dg-name-2, .dg-hop, .dg-tunnel-label")) {
    const width = node.getComputedTextLength()
    if (width > room) {
      const size = parseFloat(getComputedStyle(node).fontSize)
      node.style.fontSize = `${Math.max(9, Math.floor(size * (room / width) * 10) / 10)}px`
      if (node.getComputedTextLength() > room) node.setAttribute("textLength", String(room))
      if (node.getComputedTextLength() > room) node.setAttribute("lengthAdjust", "spacingAndGlyphs")
    }
  }
  trainNodes = new Map()
  render()
}

function approxWidth(text, perChar) {
  return [...text].length * perChar
}

function boardTrains(board, dir) {
  return (board?.trains ?? []).filter((train) => (dir === "DOWN" ? model.km(train.dest) > model.km(board.station) : model.km(train.dest) < model.km(board.station)))
}

function render() {
  if (!network || !model) return
  const s = t()
  const boards = new Map()
  for (const board of state.data?.boards ?? []) boards.set(board.station, board)

  let delayed = 0
  const notices = new Set()
  for (const group of els.svg.querySelectorAll(".dg-row")) {
    const code = group.dataset.code
    const [upNode, dnNode] = group.querySelectorAll(".dg-ttnt")
    const board = boards.get(code)
    if (board?.message) notices.add(board.message)
    for (const [node, dir, terminus] of [[upNode, "UP", code === "TUM"], [dnNode, "DOWN", code === "WKS"]]) {
      if (terminus) {
        node.textContent = s.terminus
        node.dataset.tone = "none"
        continue
      }
      const list = boardTrains(board, dir)
      for (const train of list) if (train.delay) delayed += 1
      const shown = list.slice(0, MAX_TTNT).map((train) => (train.ttnt <= 0 ? s.due : String(train.ttnt)))
      node.textContent = shown.length ? shown.join("\u2002") : "—"
      const first = list[0]
      node.dataset.tone = !first ? "none" : first.ttnt <= 0 ? "now" : first.ttnt <= 3 ? "soon" : "far"
    }
  }

  if (notices.size > 0) {
    els.alert.dataset.show = "1"
    els.alert.innerHTML = `<b>${s.notice}</b> ${[...notices].map(escapeHtml).join(" · ")}`
  } else if (delayed > 0) {
    els.alert.dataset.show = "1"
    els.alert.innerHTML = `<b>${s.delayNote}</b>`
  } else {
    els.alert.dataset.show = "0"
  }
  paintClock()
}

/* ------------------------------------------------------------- animation */

function isShortTrip(run) {
  return run.dest !== "TUM" && run.dest !== "WKS"
}

function syncTrains() {
  const layer = els.svg.querySelector("#train-layer")
  if (!layer || stationY.size === 0) return
  const seen = new Set()

  // Trains bunch outside busy stations; nudge them along their own track so
  // every chip stays readable and on the line it belongs to.
  for (const dir of ["UP", "DOWN"]) {
    const items = state.runs
      .filter((run) => run.dir === dir)
      .map((run) => ({ run, y: yForKm(run.km) }))
      .sort((a, b) => a.y - b.y)
    for (let i = 1; i < items.length; i += 1) {
      if (items[i].y - items[i - 1].y < TRAIN_SPACING) items[i].y = items[i - 1].y + TRAIN_SPACING
    }
    for (const { run, y } of items) {
      const x = dir === "UP" ? TRACK_UP_X : TRACK_DN_X
      seen.add(run.id)
      let node = trainNodes.get(run.id)
      if (!node) {
        node = make("g", { class: "dg-train", role: "button", tabindex: 0, "data-dir": dir })
        node.append(
          make("circle", { r: TRAIN_R + 7, class: "dg-train-glow", filter: "url(#dg-glow)" }),
          make("circle", { r: TRAIN_R + 6, class: "dg-train-halo" }),
          make("circle", { r: TRAIN_R, class: "dg-train-body", fill: COLORS[dir] }),
          make("path", { d: dir === "UP" ? "M-4 2.5 L0 -3.5 L4 2.5 Z" : "M-4 -2.5 L0 3.5 L4 -2.5 Z", class: "dg-train-arrow" }),
          make("circle", { r: 15, fill: "transparent" }),
          make("g", { class: "dg-late" }),
        )
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
      node.setAttribute("transform", `translate(${x} ${y.toFixed(1)})`)
      node.dataset.delay = run.delay ? "1" : "0"
      node.dataset.short = isShortTrip(run) ? "1" : "0"
      node.dataset.selected = state.selected === run.id ? "1" : "0"
      node.dataset.phase = run.pos.phase
      node.dataset.level = String(lateLevel(run))
      paintLateTag(node, run)
      node.setAttribute("aria-label", `${network.name(run.dest, state.lang)} · ${positionText(run)}`)
    }
  }

  for (const [id, node] of trainNodes) {
    if (!seen.has(id)) {
      node.remove()
      trainNodes.delete(id)
    }
  }
}

function isLate(run) {
  return (run.late?.sec ?? 0) >= LATE_SHOW_SEC
}

// 0 on time, 1 late (red), 2 very late (red, flashing glow).
function lateLevel(run) {
  const sec = run.late?.sec ?? 0
  return sec >= LATE_ALARM_SEC ? 2 : sec >= LATE_SHOW_SEC ? 1 : 0
}

// A small red tag above a train running 60 s or more behind the timetable.
function paintLateTag(node, run) {
  const tag = node.querySelector(".dg-late")
  const text = isLate(run) ? t().lateTag(run.late.sec) : ""
  if (tag.dataset.text === text) return
  tag.dataset.text = text
  tag.replaceChildren()
  if (!text) return
  const w = text.length * 5.4 + 10
  const y = -TRAIN_R - 10
  tag.append(
    make("rect", { x: -w / 2, y: y - 7, width: w, height: 14, rx: 7, class: "dg-late-bg" }),
    make("text", { x: 0, y: y + 0.5, class: "dg-late-text" }, text),
  )
}

function loop(stamp) {
  requestAnimationFrame(loop)
  const now = Date.now()
  if (!state.paused) state.runs = tracker.frame(now)
  if (state.view === "diagram") {
    syncTrains()
    if (state.follow && state.selected && stamp - lastFollow > 900) {
      lastFollow = stamp
      followInDiagram()
    }
  } else {
    flashMap(stamp)
  }
  if (state.view === "map" && stamp - lastMapPaint > 250) {
    lastMapPaint = stamp
    paintMap()
  }
  if (state.sheetKind === "train" && stamp - lastSheetPaint > 1000) {
    lastSheetPaint = stamp
    paintTrainSheet()
  }
}

function followInDiagram() {
  const run = state.runs.find((item) => item.id === state.selected)
  if (!run) return
  const rect = els.svg.getBoundingClientRect()
  const y = rect.top + window.scrollY + yForKm(run.km)
  // Centre it in the strip between the sticky header and the docked card.
  const top = document.querySelector(".top").getBoundingClientRect().bottom
  const bottom = els.sheet.dataset.open === "1" ? els.sheet.getBoundingClientRect().top : window.innerHeight
  const target = y - (top + bottom) / 2
  if (Math.abs(window.scrollY - target) > 24) window.scrollTo({ top: target, behavior: "smooth" })
}

/* ------------------------------------------------------------------- map */

const MAP_STYLES = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  light: "https://tiles.openfreemap.org/styles/bright",
}
const MAP_ENTRY = "../lib/maplibre/maplibre-gl.mjs"
const MAP_CSS = "../lib/maplibre/maplibre-gl.css"
// Pixel gap between the up and down lines, by zoom. Trains use the same gap.
const OFFSET_STOPS = [[9, 2.2], [12, 3.6], [15, 6], [17, 9]]

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

function trackCoords() {
  return model.trackCoords ?? order.map((code) => {
    const p = network.point(code)
    return [p.lng, p.lat]
  })
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
    mapInstance.on("error", (event) => {
      const message = String(event?.error?.message ?? event?.error ?? "")
      if (/webgl|context|gpu|initialize/i.test(message)) {
        clearTimeout(timer)
        reject(new Error(message))
      }
    })
  })
  const coords = trackCoords()
  const lngs = coords.map((c) => c[0])
  const lats = coords.map((c) => c[1])
  mapInstance.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: { top: 30, bottom: 40, left: 20, right: 20 }, duration: 0 },
  )
  installMapLayers()
  // Train offsets are in pixels, so a zoom changes where they sit.
  mapInstance.on("zoom", () => paintMap())
  mapInstance.on("dragstart", () => {
    if (state.follow) setFollow(false)
  })
  return mapInstance
}

function offsetExpr(sign) {
  return ["interpolate", ["linear"], ["zoom"], ...OFFSET_STOPS.flatMap(([z, px]) => [z, sign * px])]
}

function installMapLayers() {
  const map = mapInstance
  const coords = trackCoords()
  map.addSource("tml-track", {
    type: "geojson",
    data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } },
  })
  map.addSource("tml-stations", { type: "geojson", data: stationCollection() })
  map.addSource("tml-trains", { type: "geojson", data: { type: "FeatureCollection", features: [] } })

  // Neon look, after railisland.tw: each direction is a wide soft glow, a
  // narrower bright glow, the coloured line, then a pale hot core.
  const z = (...stops) => ["interpolate", ["linear"], ["zoom"], ...stops]
  // Dim the basemap so the lines read as light, as railisland.tw does.
  const dark = !window.matchMedia?.("(prefers-color-scheme: light)").matches
  map.addSource("tml-veil", {
    type: "geojson",
    data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } },
  })
  map.addLayer({
    id: "tml-veil",
    type: "fill",
    source: "tml-veil",
    paint: { "fill-color": dark ? "#030712" : "#0b1220", "fill-opacity": dark ? 0.55 : 0.12 },
  })
  map.addLayer({
    id: "tml-track-casing",
    type: "line",
    source: "tml-track",
    paint: { "line-color": MAP_COLORS.casing, "line-width": z(9, 8, 12, 12, 15, 18, 17, 26), "line-opacity": 0.55, "line-blur": 2 },
    layout: { "line-cap": "round", "line-join": "round" },
  })
  // The OSM line runs Tuen Mun -> Wu Kai Sha. Trains keep left, so down
  // (to Wu Kai Sha) sits left of the line direction and up sits right.
  for (const [dir, sign] of [["DOWN", -1], ["UP", 1]]) {
    const id = dir.toLowerCase()
    const offset = offsetExpr(sign)
    const layout = { "line-cap": "round", "line-join": "round" }
    map.addLayer({
      id: `tml-track-${id}`,
      type: "line",
      source: "tml-track",
      paint: { "line-color": MAP_COLORS[dir], "line-width": z(9, 2, 12, 3, 15, 5, 17, 7), "line-offset": offset },
      layout,
    })
  }
  map.addLayer({
    id: "tml-stations",
    type: "circle",
    source: "tml-stations",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3.5, 12, 5.5, 15, 9, 17, 13],
      "circle-color": "#f7fbff",
      "circle-stroke-color": MAP_COLORS.casing,
      "circle-stroke-width": 1.5,
    },
  })
  map.addLayer({
    id: "tml-station-labels",
    type: "symbol",
    source: "tml-stations",
    minzoom: 10.5,
    layout: {
      "text-field": labelField(),
      "text-size": ["interpolate", ["linear"], ["zoom"], 10.5, 10, 14, 13],
      "text-offset": [0, 1.3],
      "text-anchor": "top",
      "text-font": ["Noto Sans Regular"],
      "text-allow-overlap": false,
    },
    paint: { "text-color": "#f7fbff", "text-halo-color": MAP_COLORS.casing, "text-halo-width": 1.6 },
  })
  map.addSource("tml-cars", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
  map.addSource("tml-lights", { type: "geojson", data: { type: "FeatureCollection", features: [] } })
  const trainColor = ["match", ["get", "level"], 2, MAP_COLORS.alarm, 1, MAP_COLORS.late, ["get", "color"]]
  // Glow around the whole train; very late trains get a second, flashing one.
  map.addLayer({
    id: "tml-trains-glow",
    type: "circle",
    source: "tml-trains",
    paint: {
      "circle-radius": ["*", ["get", "glow"], ["case", ["==", ["get", "selected"], 1], 1.4, 1]],
      "circle-color": trainColor,
      "circle-blur": 1,
      "circle-opacity": 0.7,
    },
  })
  map.addLayer({
    id: "tml-trains-flash",
    type: "circle",
    source: "tml-trains",
    filter: ["==", ["get", "level"], 2],
    paint: { "circle-radius": ["*", ["get", "glow"], 1.6], "circle-color": MAP_COLORS.alarm, "circle-blur": 1, "circle-opacity": 0.9 },
  })
  map.addLayer({
    id: "tml-cars",
    type: "fill",
    source: "tml-cars",
    paint: { "fill-color": trainColor, "fill-opacity": 1 },
  })
  map.addLayer({
    id: "tml-cars-edge",
    type: "line",
    source: "tml-cars",
    paint: {
      "line-color": ["case", ["==", ["get", "level"], 2], "#ffffff", ["==", ["get", "delay"], 1], MAP_COLORS.warn, "rgba(255,255,255,0.75)"],
      "line-width": ["case", ["==", ["get", "level"], 2], 1.4, 0.7],
    },
  })
  // Headlights white at the front, tail lights red at the back.
  map.addLayer({
    id: "tml-lights-glow",
    type: "circle",
    source: "tml-lights",
    paint: {
      "circle-radius": ["*", ["get", "r"], 3],
      "circle-color": ["match", ["get", "kind"], "head", "#ffffff", "#ff2a2a"],
      "circle-blur": 1,
      "circle-opacity": 0.8,
    },
  })
  map.addLayer({
    id: "tml-lights",
    type: "circle",
    source: "tml-lights",
    paint: { "circle-radius": ["get", "r"], "circle-color": ["match", ["get", "kind"], "head", "#ffffff", "#ff3b3b"] },
  })
  map.addLayer({
    id: "tml-train-late",
    type: "symbol",
    source: "tml-trains",
    filter: [">=", ["get", "level"], 1],
    minzoom: 10.5,
    layout: {
      "text-field": ["get", "lateText"],
      "text-size": 10.5,
      "text-font": ["Noto Sans Bold"],
      "text-offset": [0, -1.6],
      "text-anchor": "bottom",
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: { "text-color": "#ffffff", "text-halo-color": MAP_COLORS.late, "text-halo-width": 2.2 },
  })

  for (const layer of ["tml-cars", "tml-trains-glow"]) {
    map.on("click", layer, (event) => {
      const id = event.features?.[0]?.properties?.id
      if (id) openTrain(id)
    })
  }
  map.on("click", "tml-stations", (event) => {
    if (map.queryRenderedFeatures(event.point, { layers: ["tml-cars", "tml-trains-glow"] }).length) return
    const code = event.features?.[0]?.properties?.code
    if (code) openStation(code)
  })
  for (const layer of ["tml-stations", "tml-cars", "tml-trains-glow"]) {
    map.on("mouseenter", layer, () => {
      map.getCanvas().style.cursor = "pointer"
    })
    map.on("mouseleave", layer, () => {
      map.getCanvas().style.cursor = ""
    })
  }
}

function labelField() {
  return ["coalesce", ["get", state.lang === "en" ? "name" : "nameTc"], ["get", "code"]]
}

function stationCollection() {
  return {
    type: "FeatureCollection",
    features: order.map((code) => {
      const p = model.stationPoint(code) ?? network.point(code)
      const s = network.stations[code]
      return {
        type: "Feature",
        properties: { code, name: s.en, nameTc: s.tc },
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      }
    }),
  }
}

function offsetPx(zoom) {
  if (zoom <= OFFSET_STOPS[0][0]) return OFFSET_STOPS[0][1]
  for (let i = 1; i < OFFSET_STOPS.length; i += 1) {
    const [z1, p1] = OFFSET_STOPS[i]
    const [z0, p0] = OFFSET_STOPS[i - 1]
    if (zoom <= z1) return p0 + ((p1 - p0) * (zoom - z0)) / (z1 - z0)
  }
  return OFFSET_STOPS.at(-1)[1]
}

// Tuen Ma Line 8-car set: end cars 25,280 mm, six middle cars 24,136 mm,
// 3,100 mm wide; 195.376 m over all eight.
const CAR_M = [25.28, 24.136, 24.136, 24.136, 24.136, 24.136, 24.136, 25.28]
const TRAIN_M = CAR_M.reduce((a, b) => a + b, 0)
const CAR_WIDTH_M = 3.1
const CAR_GAP_M = 0.8
// True scale vanishes when zoomed out (a train is under 1 px across the
// whole line), so below about zoom 13 the set is stretched to stay visible.
const MIN_TRAIN_PX = 26
const MIN_WIDTH_PX = 3.5

function metresPerPx(lat, zoom) {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)
}

// A point `along` metres behind the head (toward the tail), pushed sideways
// onto this direction's track and then `side` metres off its centreline.
function trackPoint(run, headKm, along, sideM, zoom) {
  const travel = run.dir === "DOWN" ? 1 : -1
  const p = model.pointAtKm(headKm - (travel * along) / 1000)
  if (!p) return null
  const mpp = metresPerPx(p.lat, zoom)
  // Down keeps left of the TUM -> WKS line direction, up keeps right.
  const [nx, ny] = run.dir === "DOWN" ? [-p.uy, p.ux] : [p.uy, -p.ux]
  const m = offsetPx(zoom) * mpp + sideM
  const k = Math.cos((p.lat * Math.PI) / 180)
  return [p.lng + (m * nx) / (111_320 * k), p.lat + (m * ny) / 110_540]
}

function trainShape(run, zoom) {
  const centre = model.pointAtKm(run.km)
  if (!centre) return null
  const mpp = metresPerPx(centre.lat, zoom)
  const scale = Math.max(1, (MIN_TRAIN_PX * mpp) / TRAIN_M)
  const length = TRAIN_M * scale
  const half = Math.max(CAR_WIDTH_M * scale, MIN_WIDTH_PX * mpp) / 2
  // Keep the whole set on the line at a terminus.
  const travel = run.dir === "DOWN" ? 1 : -1
  let head = run.km
  if (travel > 0) head = Math.max(head, length / 1000)
  else head = Math.min(head, model.totalKm - length / 1000)
  const cars = []
  let from = 0
  for (const carM of CAR_M) {
    const a = from + (CAR_GAP_M * scale) / 2
    const b = from + carM * scale - (CAR_GAP_M * scale) / 2
    from += carM * scale
    const steps = [a, (a + b) / 2, b]
    const left = steps.map((d) => trackPoint(run, head, d, -half, zoom))
    const right = steps.map((d) => trackPoint(run, head, d, half, zoom))
    if ([...left, ...right].some((x) => !x)) continue
    cars.push([...left, ...right.reverse(), left[0]])
  }
  return {
    cars,
    head: trackPoint(run, head, 0, 0, zoom),
    tail: trackPoint(run, head, length, 0, zoom),
    middle: trackPoint(run, head, length / 2, 0, zoom),
    lightR: Math.max(1.6, Math.min(5, (half * 0.9) / mpp)),
    glow: Math.max(7, Math.min(40, (length / mpp) * 0.42)),
  }
}

function paintMap() {
  if (!mapInstance || !mapInstance.getSource("tml-trains")) return
  const zoom = mapInstance.getZoom()
  const points = []
  const cars = []
  const lights = []
  let followed = null
  for (const run of state.runs) {
    const shape = trainShape(run, zoom)
    if (!shape || !shape.middle) continue
    if (run.id === state.selected) followed = shape.middle
    const props = {
      id: run.id,
      color: MAP_COLORS[run.dir],
      level: lateLevel(run),
      delay: run.delay ? 1 : 0,
      selected: run.id === state.selected ? 1 : 0,
      lateText: isLate(run) ? t().lateTag(run.late.sec) : "",
      glow: shape.glow,
    }
    points.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: shape.middle } })
    for (const ring of shape.cars) cars.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } })
    if (shape.head) lights.push({ type: "Feature", properties: { kind: "head", r: shape.lightR }, geometry: { type: "Point", coordinates: shape.head } })
    if (shape.tail) lights.push({ type: "Feature", properties: { kind: "tail", r: shape.lightR * 0.8 }, geometry: { type: "Point", coordinates: shape.tail } })
  }
  mapInstance.getSource("tml-trains").setData({ type: "FeatureCollection", features: points })
  mapInstance.getSource("tml-cars").setData({ type: "FeatureCollection", features: cars })
  mapInstance.getSource("tml-lights").setData({ type: "FeatureCollection", features: lights })
  mapInstance.getLayer("tml-station-labels") && mapInstance.setLayoutProperty("tml-station-labels", "text-field", labelField())
  if (state.follow && followed && !mapInstance.isMoving()) {
    mapInstance.easeTo({ center: followed, zoom: Math.max(zoom, 13), duration: 600 })
  }
}

// Flash the glow of very late trains (steady when reduced motion is asked for).
function flashMap(stamp) {
  if (!mapInstance?.getLayer("tml-trains-flash")) return
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  const opacity = still ? 0.6 : 0.15 + 0.85 * Math.abs(Math.sin((stamp / 1000) * Math.PI))
  mapInstance.setPaintProperty("tml-trains-flash", "circle-opacity", opacity)
}

async function showView(view) {
  state.view = view
  writePref(VIEW_KEY, view)
  for (const button of els.viewSeg.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.view === view))
  els.paneDiagram.dataset.active = view === "diagram" ? "1" : "0"
  els.paneMap.dataset.active = view === "map" ? "1" : "0"
  els.colLegend.dataset.show = view === "diagram" ? "1" : "0"
  els.mapFallback.dataset.show = "0"
  if (view === "diagram") {
    if (!els.svg.querySelector(".dg-row")) buildDiagram()
    return
  }

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
    els.colLegend.dataset.show = "1"
    state.view = "diagram"
    writePref(VIEW_KEY, "diagram")
    if (!els.svg.querySelector(".dg-row")) buildDiagram()
  }
}

/* ----------------------------------------------------------------- sheet */

function openSheet(html, kind) {
  state.sheetKind = kind
  els.sheetBody.innerHTML = html
  els.sheet.dataset.open = "1"
  els.sheet.dataset.kind = kind
  // A train card stays docked and lets the line show behind it.
  els.sheetBackdrop.dataset.open = kind === "train" ? "0" : "1"
}

function closeSheet() {
  els.sheet.dataset.open = "0"
  els.sheetBackdrop.dataset.open = "0"
  state.sheetKind = null
  state.selected = null
  setFollow(false)
}

function minutesLabel(value) {
  const s = t()
  if (value <= 0) return `<span class="mins">${s.due}</span>`
  return `<span class="mins">${value}<small>${s.min}</small></span>`
}

function trainRow(train) {
  const s = t()
  const badge = train.delay ? ` <span class="badge">${s.delayBadge}</span>` : ""
  const platform = train.plat ? `${s.platform} ${escapeHtml(train.plat)}` : ""
  const kind = train.timeType === "D" ? s.scheduled : ""
  const meta = [platform, kind].filter(Boolean).join(" · ")
  return `<div class="train-item" data-delay="${train.delay ? 1 : 0}">${minutesLabel(train.ttnt)}` +
    `<span>${network.name(train.dest, state.lang)}${badge}</span>` +
    `<span class="meta">${meta}</span></div>`
}

function openStation(code) {
  const s = t()
  state.selected = null
  setFollow(false)
  const board = (state.data?.boards ?? []).find((item) => item.station === code)
  const name = network.name(code, state.lang)
  const blocks = []
  for (const [dir, dest, label] of [["UP", "TUM", s.toTum], ["DOWN", "WKS", s.toWks]]) {
    const head = `<div class="dir-head" data-dir="${dir}"><i class="sw ${dir === "UP" ? "up" : "down"}"></i>${dir === "UP" ? s.up : s.down} · ${label}</div>`
    if (code === dest) {
      blocks.push(`<div class="dir-block">${head}<div class="empty">${s.terminus}</div></div>`)
      continue
    }
    const list = boardTrains(board ?? { station: code, trains: [] }, dir).slice(0, 4)
    blocks.push(
      `<div class="dir-block">${head}` +
      (list.length ? `<div class="train-list">${list.map(trainRow).join("")}</div>` : `<div class="empty">${s.noTrains}</div>`) +
      `</div>`,
    )
  }
  const notice = board?.message ? `<p class="sub"><b>${s.notice}</b> ${escapeHtml(board.message)}</p>` : ""
  const lines = (INTERCHANGE[code] ?? []).map(([line, color]) => `<span class="xfer" style="background:${color}">${line}</span>`).join("")
  openSheet(
    `<button class="sheet-close" aria-label="${s.close}">✕</button>` +
    `<h2>${name} ${lines}</h2><div class="sub">${code} · TML · ${model.km(code).toFixed(2)} km${board ? "" : ` · ${s.noTrains}`}</div>` +
    notice + blocks.join(""),
    "station",
  )
}

function positionText(run) {
  const s = t()
  const pos = run.pos
  const n = (code) => network.name(code, state.lang)
  if (pos.phase === "run") return s.running(n(pos.from), n(pos.to))
  if (pos.phase === "dwell") return s.dwelling(n(pos.from))
  if (pos.phase === "wait") return s.waiting(n(pos.from))
  return s.arrived(n(pos.from))
}

function openTrain(runId) {
  state.selected = runId
  state.sheetKind = "train"
  paintTrainSheet(true)
}

function paintTrainSheet(first = false) {
  const s = t()
  const run = state.runs.find((item) => item.id === state.selected)
  if (!run) {
    if (!first) closeSheet()
    return
  }
  const now = Date.now()
  const stops = tracker.upcoming(run, now).slice(0, 8)
  const dirClass = run.dir === "UP" ? "up" : "down"
  const destName = network.name(run.dest, state.lang)
  const stopRows = stops
    .map((stop) => {
      const mins = Math.max(0, Math.round((stop.at - now) / 60_000))
      const clock = new Date(stop.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", hour12: false })
      return `<li><span class="stop-dot ${dirClass}"></span><span class="stop-name">${network.name(stop.code, state.lang)}</span>` +
        `<span class="stop-eta">${mins <= 0 ? s.due : `${mins} ${s.min}`}</span><span class="stop-clock">${clock}</span></li>`
    })
    .join("")
  const html =
    `<button class="sheet-close" aria-label="${s.close}">✕</button>` +
    `<div class="train-head"><span class="train-chip ${dirClass}">${run.dir === "UP" ? "▲" : "▼"}</span>` +
    `<div><h2>${destName}</h2><div class="sub">${run.dir === "UP" ? s.up : s.down} · TML` +
    `${isShortTrip(run) ? ` · <span class="badge plain">${s.shortTrip}</span>` : ""}` +
    `${run.delay ? ` · <span class="badge">${s.delayBadge}</span>` : ""}</div></div>` +
    `<button class="btn follow" aria-pressed="${state.follow}">${state.follow ? s.following : s.follow}</button></div>` +
    `<dl class="kv">` +
    `<dt>${s.position}</dt><dd>${positionText(run)}</dd>` +
    `<dt>${s.speed}</dt><dd>${Math.round(run.pos.speedKmh)} km/h</dd>` +
    `<dt>${s.lateLabel}</dt><dd>${isLate(run)
      ? `<span class="badge late">${s.lateTag(run.late.sec)}</span> ${s.lateSource[run.late.source]}`
      : s.onTime}</dd>` +
    `<dt>${s.platform}</dt><dd>${escapeHtml(run.plat || "—")}</dd>` +
    `</dl>` +
    `<p class="fine">${run.kind === "sched"
      ? `${s.tripId(run.trip.run, run.trip.trip)} · ${s.basis.sched(run.readings)}`
      : s.basis.model(run.readings)}</p>` +
    (stopRows ? `<div class="stops-head">${s.nextStops}</div><ol class="stops">${stopRows}</ol>` : "")
  if (first || els.sheet.dataset.open !== "1") openSheet(html, "train")
  else els.sheetBody.innerHTML = html
}

function setFollow(on) {
  state.follow = on
  const button = els.sheetBody.querySelector(".follow")
  if (button) {
    button.setAttribute("aria-pressed", String(on))
    button.textContent = on ? t().following : t().follow
  }
}

/* -------------------------------------------------------------- controls */

function wireControls() {
  els.viewSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button")
    if (button) showView(button.dataset.view)
  })
  els.langSeg.addEventListener("click", (event) => {
    const button = event.target.closest("button")
    if (!button || button.dataset.lang === state.lang) return
    state.lang = button.dataset.lang
    writePref(LOCALE_KEY, state.lang)
    feed = makeFeed()
    state.data = null
    applyStrings()
    buildDiagram()
    if (state.sheetKind === "train") paintTrainSheet()
    else if (state.sheetKind) closeSheet()
    refresh(true)
  })
  els.pauseBtn.addEventListener("click", () => {
    state.paused = !state.paused
    writePref(PAUSE_KEY, state.paused ? "1" : "0")
    els.pauseBtn.textContent = state.paused ? t().resume : t().pause
    els.pauseBtn.setAttribute("aria-pressed", String(state.paused))
    setStatus(state.paused ? "paused" : "ok")
    if (!state.paused) refresh(false)
  })
  els.sheetBackdrop.addEventListener("click", closeSheet)
  els.sheet.addEventListener("click", (event) => {
    if (event.target.closest(".sheet-close")) closeSheet()
    else if (event.target.closest(".follow")) {
      setFollow(!state.follow)
      lastFollow = 0
    }
  })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSheet()
  })
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh(false)
  })
  window.addEventListener("online", () => refresh(false))
  // A manual scroll in the diagram ends following.
  for (const type of ["wheel", "touchmove"]) {
    window.addEventListener(type, () => {
      if (state.follow && state.view === "diagram") setFollow(false)
    }, { passive: true })
  }
  // Rebuild when the diagram's width changes, including the first time it
  // gets one: a pane that was hidden at load measures 0 and builds nothing.
  let resizeTimer = 0
  let builtWidth = 0
  const onWidth = (width) => {
    if (width === 0 || Math.abs(width - builtWidth) < 1) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      builtWidth = width
      buildDiagram()
    }, builtWidth === 0 ? 0 : 180)
  }
  if ("ResizeObserver" in window) {
    new ResizeObserver((entries) => onWidth(Math.round(entries[0].contentRect.width))).observe(els.svg)
  } else {
    window.addEventListener("resize", () => onWidth(Math.round(els.svg.getBoundingClientRect().width)))
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {})
  }
}

/* --------------------------------------------------------------- helpers */

function clockSpan(sec) {
  const m = Math.floor(sec / 60)
  const r = Math.round(sec % 60)
  return `${m}:${String(r).padStart(2, "0")}`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function readPref(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode or blocked storage: the preference just is not remembered.
  }
}

boot().catch((error) => {
  console.error(error)
  setStatus("error")
  els.statusText.textContent = String(error?.message ?? error)
})
