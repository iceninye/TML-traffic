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
import { calendarDay, createTimetables, headwayAt, hopTimesAround, matchReadings, measuredHeadways, pickFirstEntry, serviceDate, serviceSeconds } from "../lib/tml-timetable.js"

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
const BUILD = { version: "0.6.2", commit: "dev" }

const COLORS = { UP: "var(--up)", DOWN: "var(--down)" }
// Raw values for MapLibre, which cannot read CSS variables.
const MAP_COLORS = { gap: "#e3b341", UP_LINE: "#ffb17d", DOWN_LINE: "#79c3ff", alarm: "#ff1238", UP: "#ff8f45", DOWN: "#3fa9ff", UP_HOT: "#ffe2c7", DOWN_HOT: "#d6edff", casing: "#020611", warn: "#d29922", late: "#e5484d" }

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
    waitingIn: (a, m) => `${a} 候發，約 ${m} 分鐘後開出`,
    duty: "更份",
    relief: (place, duty) => `（${place}換 ${duty}）`,
    schedDep: "原定開出",
    expectedDep: (clock) => `（預計 ${clock}）`,
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
    engine: "列車位置由到站時間推算模擬，非港鐵官方列車位置",
    lateTag: (sec) => `+ ${sec}s`,
    lateLabel: "慢於時間表",
    lateSec: (sec) => `${sec} 秒`,
    lateSource: { timetable: "比時間表班次遲", spacing: "與前車距離比實測班距長" },
    gapTag: (sec) => `班距 +${sec}s`,
    spacing: "班距",
    spacingOk: "正常",
    na: "N/A",
    onTime: "準時（相差少於 60 秒）",
    readings: (n) => `綜合 ${n} 個車站倒數`,
    dayType: { weekday: "平日", saturday: "星期六", sunday: "星期日／假期", special: "特別時間表" },
    peak: "繁忙",
    offTimetable: (u, d, mu, md) => `特別車務：按到站倒數推算 · 上行 ${u} 班 / 下行 ${d} 班 · 實測班距 上行 ${mu} 分 / 下行 ${md} 分`,
    offTimetableNote: "時間表同實際車務唔吻合，列車位置只按港鐵到站倒數推算；車次、Run 編號及時間表延誤不適用",
    offPeak: "非繁忙",
    matchNote: (m, f) => `${m} 班對應時間表班次，${f} 班按行車模型推算`,
    dutySource: (code, date) => `班次來源：Duty Sheet ${code}（${date} 起）；開出時間準確，中途各站按時間表模型推算`,
    dutyTag: "Duty Sheet",
    tripId: (run, trip) => `車次 ${trip}（Run ${run}）`,
    basis: { sched: (n) => `按時間表班次 + ${n} 個車站倒數校正`, model: (n) => `時間表無對應班次，按 ${n} 個車站倒數推算` },
    band: { early: "清晨", shoulder: "繁忙過渡", amPeak: "早上繁忙", day: "日間", pmPeak: "黃昏繁忙", evening: "晚間" },
    headway: (m) => `班距約 ${m} 分`,
    offService: "非服務時間",
    lastTrains: "尾班車時段",
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
    waitingIn: (a, m) => `Standing at ${a}, leaves in about ${m} min`,
    duty: "Duty",
    relief: (place, duty) => `(relief at ${place}: ${duty})`,
    schedDep: "Scheduled departure",
    expectedDep: (clock) => ` (expected ${clock})`,
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
    engine: "Train positions are simulated from arrival times, not official MTR train locations",
    lateTag: (sec) => `+ ${sec}s`,
    lateLabel: "Behind timetable",
    lateSec: (sec) => `${sec} s`,
    lateSource: { timetable: "behind its timetabled trip", spacing: "gap to the train ahead is longer than the measured headway" },
    gapTag: (sec) => `Gap +${sec}s`,
    spacing: "Spacing",
    spacingOk: "Normal",
    na: "N/A",
    onTime: "On time (within 60 s)",
    readings: (n) => `fused from ${n} station countdowns`,
    dayType: { weekday: "Weekday", saturday: "Saturday", sunday: "Sunday/PH", special: "Special timetable" },
    peak: "peak",
    offTimetable: (u, d, mu, md) => `Special service: placed from countdowns · up ${u} / down ${d} trains · measured headway up ${mu} / down ${md} min`,
    offTimetableNote: "The service does not match any timetable; trains are placed from MTR countdowns only. Trip, run and timetable delay do not apply",
    offPeak: "off-peak",
    matchNote: (m, f) => `${m} trains matched to timetabled trips, ${f} estimated by the running model`,
    dutySource: (code, date) => `Trips from Duty Sheet ${code} (effective ${date}): departures are exact, stops in between are modelled from the timetable`,
    dutyTag: "Duty Sheet",
    tripId: (run, trip) => `Trip ${trip} (run ${run})`,
    basis: { sched: (n) => `Timetabled trip, corrected by ${n} station countdowns`, model: (n) => `No timetabled trip matched; estimated from ${n} station countdowns` },
    band: { early: "Early", shoulder: "Shoulder", amPeak: "AM peak", day: "Daytime", pmPeak: "PM peak", evening: "Evening" },
    headway: (m) => `every ~${m} min`,
    offService: "Out of service hours",
    lastTrains: "Last trains",
    peakRun: "peak run times",
    offRun: "off-peak run times",
    hopLabel: (km, down, up) => `${km.toFixed(2)} km · ▼${clockSpan(down)} ▲${clockSpan(up)}`,
    shortLegend: "dashed ring = short trip",
    colUp: "Tuen Mun",
    colDown: "Wu Kai Sha",
  },
}

const els = {
  brandDot: document.querySelector(".brand-dot"),
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
  runsUntil: 0,
  follow: false,
  sheetKind: null,
  station: null,
}

let network = null
let model = null
let timetables = null
// Readings per scheduled trip from recent snapshots (they keep narrowing
// that trip's delay while they are fresh).
let tripHistory = new Map()
let hopTimesKey = ""
let offTimetableStreak = 0
let onTimetableStreak = 0
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

// Special timetables (events, typhoon) are fetched once, the first time the
// normal ones fit the boards badly; pickDay then considers them too.
let specialEntries = []
let specialsRequested = false
function requestSpecials() {
  if (specialsRequested) return
  specialsRequested = true
  for (const e of specialEntries) {
    fetchJson(`data/timetables/${e.file}`).then((data) => timetables.add(data)).catch(() => {})
  }
}

async function boot() {
  const [netJson, timetable, track, manifest] = await Promise.all([
    fetchJson("data/tml-network.json"),
    fetchJson("data/tml-timetable.json"),
    fetchJson("data/tml-track.json").catch(() => null),
    // Working timetables are listed in data/timetables/index.json; new ones
    // are added there by tools/parse_timetables.py, no code change needed.
    fetchJson("data/timetables/index.json").catch(() => ({ timetables: [] })),
  ])
  network = createNetwork(netJson)
  model = createModel(timetable, track)
  timetables = createTimetables({}, model)
  // The calendar's timetable first, so the first trains appear quickly; the
  // rest load in the background and become candidates when they arrive.
  const entries = (manifest.timetables ?? []).filter((e) => e.source !== "dutysheet" || e.primary)
  const today = calendarDay(Date.now())
  const first = pickFirstEntry(entries, today, serviceDate(Date.now()))
  if (first) {
    timetables.add(await fetchJson(`data/timetables/${first.file}`).catch(() => null))
    state.book = first.code
  }
  // The other normal timetables load now; special ones (events, typhoon) only
  // when the normal ones stop fitting the boards (see requestSpecials).
  specialEntries = entries.filter((e) => e.kind === "special")
  for (const e of entries) {
    if (e === first || e.kind === "special") continue
    fetchJson(`data/timetables/${e.file}`).then((data) => timetables.add(data)).catch(() => {})
  }
  // Section labels and the fallback model use this period's timetable times.
  if (timetables.books[state.book]) {
    const tau = serviceSeconds(Date.now())
    hopTimesKey = `${state.book}|${Math.floor(tau / 600)}`
    model.setScheduleTimes(hopTimesAround(timetables.books[state.book], tau))
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
  // Countdowns age between feed reads: a "now" reading clears once its train leaves.
  setInterval(render, 1000)
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
    const active = feed
    await active.refresh(at)
    // Language switch swapped the feed mid-flight: this result belongs to the
    // old one (the switch handler queues a fresh refresh).
    if (active !== feed) return
    const snapshot = active.snapshot(at)
    if (!snapshot.ok) {
      // Nothing usable at all. Keep whatever was on screen.
      setStatus(state.data ? "stale" : "error")
      return
    }
    state.data = snapshot
    state.loadedAtMs = active.newestAt || Date.now()
    state.stationCount = active.stationCount
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
  const mine = pick.scores[state.book]
  if (!mine || (mine.n >= 6 && mine.close < 0.7)) requestSpecials()
  const theirs = pick.day && pick.scores[pick.day]
  if (theirs && pick.day !== state.book && theirs.n >= 10 && theirs.close - (mine?.close ?? 0) > 0.25) {
    state.book = pick.day
    tripHistory = new Map()
  }
  state.dayScores = pick.scores
  const book = timetables.books[state.book]
  const measured = measuredHeadways(readings)
  state.measured = measured

  let matched = new Map()
  let leftover = readings
  let result = null
  if (book) {
    const tau = serviceSeconds(now)
    result = matchReadings(book, readings, now, tripHistory)
    // Does the running service match this timetable at all? A special
    // timetable this app does not have, overnight service, or an incident
    // timetable shows up as some of: readings that fit no trip, many trips
    // far off their times, a measured headway unlike the timetable's, or
    // the boards announcing special arrangements.
    const fit = readings.length ? 1 - result.leftover.length / readings.length : 1
    const delays = [...result.trips.values()].map((e) => Math.abs(e.delay))
    const scattered = delays.length ? delays.filter((d) => d > 120).length / delays.length : 0
    const headwayOff = ["UP", "DOWN"].some((dir) => {
      const planned = headwayAt(book, dir, tau)
      return planned && measured[dir] && Math.abs(measured[dir] - planned) / planned > 0.3
    })
    const notice = (snapshot.boards ?? []).some((b) => /special|特別|arrangement|安排/i.test(b.message ?? ""))
    const signals = [scattered > 0.2, headwayOff, notice].filter(Boolean).length
    const offNow = readings.length >= 20 && (fit < 0.5 || signals >= 2)
    state.timetableSignals = { fit, scattered, headwayOff, notice }
    if (offNow) {
      offTimetableStreak += 1
      onTimetableStreak = 0
    } else {
      onTimetableStreak += 1
      offTimetableStreak = 0
    }
    // Two snapshots to leave the timetable, three to come back.
    if (!state.offTimetable && offTimetableStreak >= 2) {
      state.offTimetable = true
      tracker.dropScheduled()
    }
    else if (state.offTimetable && onTimetableStreak >= 3) state.offTimetable = false
  } else {
    state.offTimetable = true
  }

  if (book && !state.offTimetable) {
    const tau = serviceSeconds(now)
    const key = `${state.book}|${Math.floor(tau / 600)}`
    if (key !== hopTimesKey) {
      hopTimesKey = key
      model.setScheduleTimes(hopTimesAround(book, tau))
    }
    matched = result.trips
    leftover = result.leftover
    state.lineDelay = result.lineDelay
    tripHistory = new Map([...matched].map(([id, entry]) => [id, { readings: entry.history, delay: entry.delay }]))
  } else {
    // Countdown-only: no timetable times either; running times come from
    // the base model plus what it has learned from the boards.
    if (hopTimesKey !== "off") {
      hopTimesKey = "off"
      model.setScheduleTimes(null)
    }
    tripHistory = new Map()
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
  // Fallback trains report spacing against the headway measured from the
  // boards, never against a timetable.
  tracker.update({ matched, fallback, headwayOf: (dir) => measured[dir] }, now)
}

function setStatus(kind) {
  // A refresh already in flight when Pause was pressed must not repaint "live".
  if (state.paused && kind !== "paused") return
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
  const book = timetables?.books[state.book]
  if (state.offTimetable) {
    let up = 0
    let down = 0
    for (const run of state.runs) run.dir === "UP" ? (up += 1) : (down += 1)
    const m = state.measured ?? {}
    const mins = (sec) => (sec ? Math.round((sec / 60) * 10) / 10 : "—")
    els.period.textContent = s.offTimetable(up, down, mins(m.UP), mins(m.DOWN))
    els.period.dataset.peak = "0"
    els.period.title = s.offTimetableNote
  } else if (book) {
    const tau = serviceSeconds(now)
    const headway = headwayAt(book, "DOWN", tau) ?? headwayAt(book, "UP", tau)
    if (!headway) {
      // Past the last headway band, the last trains may still be running.
      els.period.textContent = state.runs.length ? s.lastTrains : s.offService
      els.period.dataset.peak = "0"
    } else {
      const peak = headway <= 210
      const mins = Math.round((headway / 60) * 10) / 10
      const source = book.source === "dutysheet" ? ` · ${s.dutyTag}` : ""
      els.period.textContent = `${book.kind === "special" ? s.dayType.special : (s.dayType[book.day] ?? s.dayType.special)} · ${peak ? s.peak : s.offPeak} · ${s.headway(mins)}${source}`
      els.period.dataset.peak = peak ? "1" : "0"
      els.period.title = (book.source === "dutysheet" ? `${s.dutySource(book.dutysheet, book.effective)}\n` : "") + s.matchNote(state.matchedCount ?? 0, state.fallbackCount ?? 0)
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

// A 0-minute reading ("now") only says the train is due; the board is read every
// ~20 s and kept up to 3 min when a read fails, so it can outlive the train.
// Drop it once the train has left, by the same clock the map uses: an arrival
// reading leaves after the stop (ARRIVAL_STOP_MS, as lib/mtr-estimate.js), a
// published departure leaves at its time.
const ARRIVAL_STOP_MS = 30_000
function hasLeft(train, now) {
  if (train.ttnt > 0 || !Number.isFinite(train.dueAt)) return false
  return now > train.dueAt + (train.timeType === "D" ? 0 : ARRIVAL_STOP_MS)
}

function boardTrains(board, dir, now = Date.now()) {
  return (board?.trains ?? []).filter(
    (train) => !hasLeft(train, now) && (dir === "DOWN" ? model.km(train.dest) > model.km(board.station) : model.km(train.dest) < model.km(board.station)),
  )
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
  paintStationSheet()
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
          make("text", { class: "dg-train-run" }),
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
      // Hidden feature: tapping the brand dot shows each train's Run number
      // in place of its arrow for a few seconds (N/A trains show a dash).
      const reveal = Date.now() < state.runsUntil
      node.dataset.reveal = reveal ? "1" : "0"
      if (reveal) {
        const label = run.kind === "sched" ? String(run.trip.run) : "–"
        const text = node.querySelector(".dg-train-run")
        if (text.textContent !== label) text.textContent = label
      }
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

// 0 on time, 1 late (red), 2 very late (red, flashing glow), 3 a fallback
// train whose gap to the one in front is long (yellow; no timetable to be
// late against).
function lateLevel(run) {
  const sec = run.late?.sec ?? 0
  if (run.kind === "model") return sec >= LATE_SHOW_SEC ? 3 : 0
  return sec >= LATE_ALARM_SEC ? 2 : sec >= LATE_SHOW_SEC ? 1 : 0
}

function lateText(run) {
  if (!isLate(run)) return ""
  return run.kind === "model" ? t().gapTag(run.late.sec) : t().lateTag(run.late.sec)
}

// A small red tag above a train running 60 s or more behind the timetable.
function paintLateTag(node, run) {
  const tag = node.querySelector(".dg-late")
  const text = lateText(run)
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

let mapReady = null

// One shared promise: concurrent callers wait for the same load instead of
// receiving a half-built instance, and a failed load is torn down so the next
// attempt starts clean rather than reusing a map with no layers.
function ensureMap() {
  if (!mapReady) {
    mapReady = buildMap().catch((error) => {
      mapInstance?.remove()
      mapInstance = null
      mapReady = null
      throw error
    })
  }
  return mapReady
}

async function buildMap() {
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
      // 30% lighter and 30% thinner than the base line, so trains stand out.
      paint: { "line-color": MAP_COLORS[`${dir}_LINE`], "line-width": z(9, 1.4, 12, 2.1, 15, 3.5, 17, 4.9), "line-offset": offset },
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
  // Cars are grey-white (30% darker) with a grey edge, like real stock; lateness shows in
  // the edge: red when 60 s+ late, flashing red when 180 s+.
  map.addLayer({
    id: "tml-cars",
    type: "fill",
    source: "tml-cars",
    paint: { "fill-color": "#a1a2a5", "fill-opacity": 1 },
  })
  // White outline around every car so the train stands out on the map.
  map.addLayer({
    id: "tml-cars-outline",
    type: "line",
    source: "tml-cars",
    paint: { "line-color": "#ffffff", "line-width": 2.6, "line-opacity": 0.95 },
  }, "tml-cars")
  map.addLayer({
    id: "tml-cars-edge",
    type: "line",
    source: "tml-cars",
    paint: {
      "line-color": ["match", ["get", "level"], 2, MAP_COLORS.alarm, 1, MAP_COLORS.late, 3, MAP_COLORS.gap, ["case", ["==", ["get", "delay"], 1], MAP_COLORS.warn, "#8a9099"]],
      "line-width": ["match", ["get", "level"], 0, 0.8, 1.6],
    },
  })
  // Two small white lamps at the front, two small red ones at the back.
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
    paint: {
      "text-color": ["match", ["get", "level"], 3, "#1d1600", "#ffffff"],
      "text-halo-color": ["match", ["get", "level"], 3, MAP_COLORS.gap, MAP_COLORS.late],
      "text-halo-width": 2.2,
    },
  })

  for (const layer of ["tml-cars"]) {
    map.on("click", layer, (event) => {
      const id = event.features?.[0]?.properties?.id
      if (id) openTrain(id)
    })
  }
  map.on("click", "tml-stations", (event) => {
    if (map.queryRenderedFeatures(event.point, { layers: ["tml-cars"] }).length) return
    const code = event.features?.[0]?.properties?.code
    if (code) openStation(code)
  })
  for (const layer of ["tml-stations", "tml-cars"]) {
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
    // Two small lamps at each end, set in from the car sides.
    heads: [trackPoint(run, head, 0.4 * scale, -half * 0.55, zoom), trackPoint(run, head, 0.4 * scale, half * 0.55, zoom)],
    tails: [trackPoint(run, head, length - 0.4 * scale, -half * 0.55, zoom), trackPoint(run, head, length - 0.4 * scale, half * 0.55, zoom)],
    middle: trackPoint(run, head, length / 2, 0, zoom),
    lightR: Math.max(1.4, Math.min(3, (half * 0.35) / mpp)),
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
      lateText: lateText(run),
      glow: shape.glow,
    }
    points.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: shape.middle } })
    for (const ring of shape.cars) cars.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } })
    for (const at of shape.heads) if (at) lights.push({ type: "Feature", properties: { kind: "head", r: shape.lightR }, geometry: { type: "Point", coordinates: at } })
    for (const at of shape.tails) if (at) lights.push({ type: "Feature", properties: { kind: "tail", r: shape.lightR }, geometry: { type: "Point", coordinates: at } })
  }
  mapInstance.getSource("tml-trains").setData({ type: "FeatureCollection", features: points })
  mapInstance.getSource("tml-cars").setData({ type: "FeatureCollection", features: cars })
  mapInstance.getSource("tml-lights").setData({ type: "FeatureCollection", features: lights })
  mapInstance.getLayer("tml-station-labels") && mapInstance.setLayoutProperty("tml-station-labels", "text-field", labelField())
  if (state.follow && followed && !mapInstance.isMoving()) {
    mapInstance.easeTo({ center: followed, zoom: Math.max(zoom, 13), duration: 600 })
  }
}

let flashOn = null

// Flash the edge of very late trains (steady when reduced motion is asked for).
function flashMap(stamp) {
  if (!mapInstance?.getLayer("tml-cars-edge")) return
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  const on = still || Math.sin((stamp / 1000) * Math.PI * 2) > 0
  if (on === flashOn) return
  flashOn = on
  mapInstance.setPaintProperty("tml-cars-edge", "line-color", [
    "match", ["get", "level"],
    2, on ? MAP_COLORS.alarm : "#8a9099",
    1, MAP_COLORS.late,
    3, MAP_COLORS.gap,
    ["case", ["==", ["get", "delay"], 1], MAP_COLORS.warn, "#8a9099"],
  ])
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
  state.station = null
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

// The station card is rebuilt from the live boards, so it follows the feed and
// the per-second "now" ageing like the diagram does; the DOM is only touched
// when the card's content changes.
let stationHtmlShown = ""

function stationSheetHtml(code) {
  const s = t()
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
  return (
    `<button class="sheet-close" aria-label="${s.close}">✕</button>` +
    `<h2>${name} ${lines}</h2><div class="sub">${code} · TML · ${model.km(code).toFixed(2)} km${board ? "" : ` · ${s.noTrains}`}</div>` +
    notice + blocks.join("")
  )
}

function openStation(code) {
  state.selected = null
  state.station = code
  setFollow(false)
  stationHtmlShown = stationSheetHtml(code)
  openSheet(stationHtmlShown, "station")
}

function paintStationSheet() {
  if (state.sheetKind !== "station" || !state.station) return
  const html = stationSheetHtml(state.station)
  if (html === stationHtmlShown) return
  stationHtmlShown = html
  els.sheetBody.innerHTML = html
}

function positionText(run) {
  const s = t()
  const pos = run.pos
  const n = (code) => network.name(code, state.lang)
  if (pos.phase === "run") return s.running(n(pos.from), n(pos.to))
  if (pos.phase === "dwell") return s.dwelling(n(pos.from))
  if (pos.phase === "wait") {
    // Terminus layover: the train is shown up to 5 min before it leaves.
    const mins = Math.round(pos.secsToNext / 60)
    return mins >= 2 ? s.waitingIn(n(pos.from), mins) : s.waiting(n(pos.from))
  }
  return s.arrived(n(pos.from))
}

function secClock(sec) {
  const t = ((Math.round(sec) % 86400) + 86400) % 86400
  const two = (n) => String(n).padStart(2, "0")
  return `${two(Math.floor(t / 3600))}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}`
}

// Timetabled departure of a train that starts at a terminus, to the second
// (Duty Sheet times are exact too). Shows the expected time when the train is
// running a minute or more off it.
function scheduledDeparture(run) {
  const s = t()
  if (run.kind !== "sched" || (run.trip.origin !== "TUM" && run.trip.origin !== "WKS")) return ""
  const dep = run.trip.stops[0]?.dep
  if (!Number.isFinite(dep)) return ""
  const off = Math.abs(run.delayDisp) >= 60 ? s.expectedDep(secClock(dep + run.delayDisp)) : ""
  return `<dt>${s.schedDep}</dt><dd>${network.name(run.trip.origin, state.lang)} ${secClock(dep)}${off}</dd>`
}

// Duty number (更份) driving the train now, when the loaded timetable came
// from a Duty Sheet: duties are [duty, from station] pairs along the trip.
// A relief still ahead is named after it.
function dutyRow(run) {
  const duties = run.kind === "sched" ? run.trip.duties : null
  if (!duties?.length) return ""
  const codes = run.trip.stops.map((st) => st.code)
  const reached = codes.indexOf(run.pos?.from)
  let current = 0
  duties.forEach(([, code], i) => {
    if (reached >= 0 && codes.indexOf(code) <= reached) current = i
  })
  const next = duties[current + 1]
  const s = t()
  const later = next ? ` <span class="meta">${s.relief(network.name(next[1], state.lang), escapeHtml(next[0]))}</span>` : ""
  return `<dt>${s.duty}</dt><dd>${escapeHtml(duties[current][0])}${later}</dd>`
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
    (run.kind === "sched"
      ? `<dt>${s.lateLabel}</dt><dd>${isLate(run)
        ? `<span class="badge late">${s.lateTag(run.late.sec)}</span> ${s.lateSource[run.late.source]}`
        : s.onTime}</dd>`
      : `<dt>${s.lateLabel}</dt><dd>${s.na}</dd>` +
        `<dt>${s.spacing}</dt><dd>${isLate(run)
          ? `<span class="badge gap">${s.gapTag(run.late.sec)}</span> ${s.lateSource.spacing}`
          : s.spacingOk}</dd>`) +
    `<dt>${s.platform}</dt><dd>${escapeHtml(run.plat || "—")}</dd>` +
    scheduledDeparture(run) +
    dutyRow(run) +
    `</dl>` +
    `<p class="fine">${run.kind === "sched"
      ? `${s.tripId(run.trip.run, run.trip.trip)} · ${s.basis.sched(run.readings)}`
      : `${s.tripId(s.na, s.na)} · ${s.basis.model(run.readings)}`}</p>` +
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

// How long the brand-dot reveal shows Run numbers.
const RUN_REVEAL_MS = 15_000
let revealTimer = 0

function wireControls() {
  els.brandDot.addEventListener("click", () => {
    state.runsUntil = Date.now() + RUN_REVEAL_MS
    els.brandDot.dataset.on = "1"
    clearTimeout(revealTimer)
    revealTimer = setTimeout(() => {
      els.brandDot.dataset.on = "0"
    }, RUN_REVEAL_MS)
    if (state.view === "diagram") syncTrains()
  })
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
    // refresh() would just return the in-flight pass on the old feed.
    ;(inFlight ?? Promise.resolve()).then(() => refresh(true))
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
