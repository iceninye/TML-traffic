// Duty cards: who is on duty now, and what each duty is doing.
// Pure functions over the cards in data/duties/DS<code>.json (written by
// tools/dutycards.py). Times are seconds since midnight of the service date
// (04:00 cut-over, so after midnight they run past 86400), the same clock the
// timetables use: pass serviceSeconds(Date.now()).
//
// A card: { id, group: KSR|TAD|HHS, tab, on: [t, place], off: [t, place],
//           work: minutes, meal: [from, to, placeFrom, placeTo] | null,
//           legs: [[kind, run, from, at, to, until], ...] }
// kind: drive (revenue), empty (no passengers), park (HUH3 to ETS1, ETS2 to HUH2),
// prep, ride, wait, other.

export const GROUPS = ["KSR", "TAD", "HHS"]
export const CLASSES = ["weekday", "saturday", "sunday", "special"]

// What the duty is doing at tau, or null when off duty (before book on, from
// book off) or when the sheet has no card for it.
//   phase: prep (before the first leg), drive/empty/park/ride/wait/other (inside a
//          leg), meal, wait (between legs), end (after the last leg)
//   until: when this phase ends; next: what comes after it
export function dutyState(duty, tau) {
  if (!duty.on || !duty.off || tau < duty.on[0] || tau >= duty.off[0]) return null
  const legs = duty.legs ?? []
  const meal = duty.meal && duty.meal[1] != null ? duty.meal : null
  let state = null
  if (meal && tau >= meal[0] && tau < meal[1]) {
    state = { phase: "meal", place: meal[2], until: meal[1] }
  } else {
    for (let i = 0; i < legs.length && !state; i += 1) {
      const [kind, run, from, at, to, until] = legs[i]
      const end = until ?? legs[i + 1]?.[3] ?? duty.off[0]
      if (tau >= at && tau < end) state = { phase: kind, run, from, to, at, until: end, leg: i }
    }
  }
  if (!state) {
    const nextIdx = legs.findIndex((leg) => leg[3] > tau)
    const nextLeg = nextIdx === -1 ? null : legs[nextIdx]
    const prev = nextIdx === 0 ? null : legs[(nextIdx === -1 ? legs.length : nextIdx) - 1]
    const mealAt = meal && meal[0] > tau ? meal[0] : Infinity
    if (!prev) state = { phase: "prep", place: duty.on[1], until: Math.min(nextLeg?.[3] ?? duty.off[0], mealAt) }
    else if (!nextLeg) state = { phase: "end", place: prev[4] ?? prev[2], until: Math.min(duty.off[0], mealAt) }
    else state = { phase: "wait", place: prev[4] ?? prev[2], until: Math.min(nextLeg[3], mealAt) }
  }
  state.until = Math.min(state.until, duty.off[0])
  state.next = nextAction(duty, tau, state)
  return state
}

// The next thing after the current phase: a leg (pick-up), the meal, or book off.
function nextAction(duty, tau, state) {
  const legs = duty.legs ?? []
  const options = []
  legs.forEach((leg, i) => {
    if (leg[3] > tau && i !== state.leg) options.push({ type: "leg", at: leg[3], run: leg[1], place: leg[2], kind: leg[0] })
  })
  if (duty.meal && duty.meal[0] > tau && state.phase !== "meal") {
    options.push({ type: "meal", at: duty.meal[0], place: duty.meal[2] })
  }
  options.sort((a, b) => a.at - b.at)
  return options[0] ?? { type: "off", at: duty.off[0], place: duty.off[1] }
}

// Duties on duty at tau, soonest-changing first. Cards without times are left out.
export function onDuty(duties, tau) {
  const rows = []
  for (const duty of duties) {
    const state = dutyState(duty, tau)
    if (state) rows.push({ duty, state })
  }
  return rows.sort((a, b) => a.state.until - b.state.until || a.duty.id.localeCompare(b.duty.id))
}

export function inGroup(duty, group) {
  return group === "all" || duty.group === group
}

// Digits typed into the search box match anywhere in the number.
export function matchesQuery(duty, query) {
  const q = query.trim()
  return !q || duty.id.includes(q)
}

// The sheet's class for the filter on the "all sheets" page: dated sheets are
// "special"; the others keep the day type of the timetable they came from.
export function sheetsOfClass(sheets, cls) {
  return sheets.filter((sheet) => sheet.class === cls)
}

// The station of a place code: platforms of one station count as one place
// (KSR1 and KSR2 are 錦上路, TAW3 and TAW4 are 大圍, HUH2 and HUH3 are 紅磡).
export function placeStation(place) {
  return place?.replace(/^([A-Z]{3})\d$/, "$1") ?? place
}

// 飯腳: the other duties of the same sheet that eat at the same station (the one
// where this duty gets off) and whose meal overlaps this one's by at least
// minOverlap seconds (45 min by default). Returns [{ duty, from, to }], the
// overlap, earliest first.
export function mealMates(duty, duties, minOverlap = 45 * 60) {
  const meal = duty.meal
  if (!meal || meal[1] == null) return []
  const rows = []
  for (const other of duties) {
    const m = other.meal
    if (other.id === duty.id || !m || m[1] == null || placeStation(m[2]) !== placeStation(meal[2])) continue
    const from = Math.max(meal[0], m[0])
    const to = Math.min(meal[1], m[1])
    if (to - from >= minOverlap) rows.push({ duty: other, from, to })
  }
  return rows.sort((a, b) => a.from - b.from || a.duty.id.localeCompare(b.duty.id))
}

// 接車／交車：同一張 duty sheet 入面，邊個更份將呢段（legs[i]）嘅車交俾你，
// 你落車之後又交俾邊個。比對方法：同一個 run、同一個站，對方嗰段喺你開始前
// 20 分鐘內完結（接車），或者喺你完結後 20 分鐘內開始（交車）。
// 自己下一段仍然係同一個 run（例如出車準備之後直接開），就唔算交車。
// 回傳 { from: { id, at, place } | null, to: { id, at, place } | null }。
const RELIEF_WINDOW = 20 * 60
const TRAIN_KINDS = new Set(["drive", "empty", "park", "prep"])

export function reliefOf(duty, duties, i) {
  const legs = duty.legs ?? []
  const leg = legs[i]
  if (!leg || !TRAIN_KINDS.has(leg[0])) return { from: null, to: null }
  const [, run, from, at, to] = leg
  const until = leg[5] ?? legs[i + 1]?.[3] ?? duty.off?.[0]
  const prev = legs[i - 1]
  const next = legs[i + 1]
  const continuesIn = prev && prev[1] === run && TRAIN_KINDS.has(prev[0])
  const continuesOut = next && next[1] === run && TRAIN_KINDS.has(next[0])
  let take = null
  let hand = null
  for (const other of duties) {
    if (other.id === duty.id) continue
    for (const l of other.legs ?? []) {
      if (l[1] !== run || !TRAIN_KINDS.has(l[0])) continue
      const end = l[5]
      if (!continuesIn && end != null && placeStation(l[4]) === placeStation(from) && end <= at + 60 && at - end <= RELIEF_WINDOW) {
        if (!take || end > take.at) take = { id: other.id, at: end, place: l[4] }
      }
      if (!continuesOut && until != null && l[0] !== "prep" && placeStation(l[2]) === placeStation(to) && l[3] >= until - 60 && l[3] - until <= RELIEF_WINDOW) {
        if (!hand || l[3] < hand.at) hand = { id: other.id, at: l[3], place: l[2] }
      }
    }
  }
  return { from: take, to: hand }
}
