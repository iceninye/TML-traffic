// Extracted from https://github.com/keithligh/hk-traffic-intelligence
// src/lib/mtr-schedule.ts — MIT (c) 2026 Keith Li. See NOTICE.md.
//
// Turns one rt.data.gov.hk getSchedule.php payload into a board plus the flat
// observation list the position estimator consumes.

export function readSchedule(payload, line, station) {
  if (!payload || typeof payload !== "object") return null
  const root = payload
  const data = root.data
  if (!data || typeof data !== "object") return null
  const block = data[`${line}-${station}`]
  if (!block || typeof block !== "object") return null
  const body = block
  const clock = text(body.curr_time) || text(root.curr_time)
  const observedAt = parseHongKongTime(clock)
  if (observedAt === null) return null
  const delay = root.isdelay === "Y" || body.isdelay === "Y"
  const trains = []
  const observations = []
  for (const row of [...asList(body.UP), ...asList(body.DOWN)]) {
    if (!row || typeof row !== "object") continue
    const train = row
    if (train.valid === "N") continue
    const dest = text(train.dest).toUpperCase()
    const ttnt = wholeMinutes(train.ttnt)
    if (!/^[A-Z0-9]{2,5}$/.test(dest) || ttnt === null) continue
    const plat = text(train.plat)
    const timeType = train.timeType === "D" || train.timetype === "D" ? "D" : "A"
    const viaRacecourse = train.route === "RAC"
    // TML-traffic: `time` is the absolute due clock; minus the board clock it
    // gives seconds, where `ttnt` is whole minutes. Fall back to ttnt.
    const exact = parseHongKongTime(text(train.time))
    const dueAt = exact !== null && Math.abs(exact - (observedAt + ttnt * 60_000)) < 90_000 ? exact : observedAt + ttnt * 60_000
    trains.push({ dest, plat, ttnt, delay, timeType, dueAt })
    observations.push({
      line,
      station,
      dest,
      plat,
      ttnt,
      dueAt,
      observedAt,
      delay,
      timeType,
      viaRacecourse,
    })
  }
  return {
    board: { line, station, message: publicMessage(text(root.message)), trains },
    observations,
  }
}

export function parseHongKongTime(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null
  const parsed = Date.parse(`${value.replace(" ", "T")}+08:00`)
  return Number.isFinite(parsed) ? parsed : null
}

function publicMessage(value) {
  const textValue = value.trim()
  if (!textValue || textValue === "-" || /^successful$/i.test(textValue) || /^ok$/i.test(textValue)) return ""
  return textValue
}

function wholeMinutes(value) {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 90) return null
  return parsed
}

function asList(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") return [value]
  return []
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}
