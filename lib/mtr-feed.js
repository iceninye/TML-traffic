// Extracted + narrowed to the Tuen Ma Line from
// https://github.com/keithligh/hk-traffic-intelligence
// src/lib/mtr-feed.ts, src/lib/pool.ts, src/lib/refresh-slice.ts
// MIT (c) 2026 Keith Li. See NOTICE.md.
//
// Upstream reads all 10 lines and is careful to be fair between them, because a
// refresh only had room for 16 station calls. On the TML-only line there is a
// single line, so fairness collapses to plain oldest-first and the whole 27
// station set can be read inside one refresh.
//
// Upstream also runs behind a Cloudflare worker cache and writes shared memory;
// none of that is needed client-side. What is kept is the part that makes the
// data usable: remember the last board per station, treat it stale after 20 s,
// keep serving it for up to 180 s, and retry once when the feed returns empty.

export const REMEMBER_MS = 180_000
export const STALE_MS = 20_000
export const REFRESH_SLICE = 27
export const FETCH_LIMIT = 4
export const UPSTREAM = "https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php"

export function pool(items, limit, task) {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index]
      index += 1
      if (current === undefined) return
      await task(current)
    }
  })
  return Promise.all(workers)
}

// Upstream fairLineReads(), kept for reference. TML-only callers should use
// oldestDue(): one line means the inter-line fairness loop is a no-op.
export function fairLineReads(items, fetchedAt, now, staleMs, limit) {
  if (limit <= 0) return []
  const dueByLine = new Map()
  const lineOrder = []
  for (const item of items) {
    const at = fetchedAt(item)
    if (at != null && now - at < staleMs) continue
    const list = dueByLine.get(item.line)
    if (list) list.push(item)
    else {
      lineOrder.push(item.line)
      dueByLine.set(item.line, [item])
    }
  }
  for (const list of dueByLine.values()) {
    list.sort((left, right) => (fetchedAt(left) ?? -1) - (fetchedAt(right) ?? -1))
  }
  const lines = [...lineOrder].sort((left, right) => {
    const waiting = (dueByLine.get(right)?.length ?? 0) - (dueByLine.get(left)?.length ?? 0)
    return waiting || lineOrder.indexOf(left) - lineOrder.indexOf(right)
  })
  const chosen = []
  while (chosen.length < limit) {
    let took = false
    for (const line of lines) {
      if (chosen.length >= limit) break
      const next = dueByLine.get(line)?.shift()
      if (!next) continue
      chosen.push(next)
      took = true
    }
    if (!took) break
  }
  return chosen
}

export function oldestDue(items, fetchedAt, now, staleMs, limit) {
  const due = []
  for (const item of items) {
    const at = fetchedAt(item)
    if (at == null || now - at >= staleMs) due.push(item)
  }
  due.sort((left, right) => (fetchedAt(left) ?? 0) - (fetchedAt(right) ?? 0))
  return due.slice(0, Math.max(0, limit))
}

// Upstream guards against a hot feed: after 8 failures / a 429 it stops calling
// for 45 s instead of hammering data.gov.hk.
export function createFeed(network, options = {}) {
  const {
    fetchImpl = fetch,
    readSchedule,
    readNotice = () => null,
    carryArrivalClock,
    estimateTrains,
    now = () => Date.now(),
    blockedMs = 45_000,
    failureLimit = 8,
    lang = "tc",
    requestTimeoutMs = 10_000,
  } = options

  const remembered = new Map()
  let blockedUntil = 0
  let failures = 0
  // TML-traffic: why reads fail, for the status line. `notice` is MTR's own
  // alert (special arrangements: the feed answers but withholds the data);
  // `problem` is the last failed read otherwise. Both clear on a good read.
  let notice = null
  let problem = null

  // Count a failure; at the limit stop calling for blockedMs (the documented
  // guard; `failures` was previously reset on every pass, so it never engaged).
  function fail() {
    failures += 1
    if (failures >= failureLimit) blockedUntil = now() + blockedMs
  }

  async function fetchPair(line, station) {
    if (now() < blockedUntil) return null
    const url = `${UPSTREAM}?line=${encodeURIComponent(line)}&sta=${encodeURIComponent(station)}&lang=${lang}`
    try {
      // A stalled socket would otherwise hold a pool worker forever and wedge
      // every refresh behind it; the signal also covers reading the body.
      const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(requestTimeoutMs) : undefined
      const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal })
      if (response.status === 429) {
        blockedUntil = now() + blockedMs
        failures += 1
        problem = "HTTP 429"
        return null
      }
      if (response.status >= 500) {
        fail()
        problem = `HTTP ${response.status}`
        return null
      }
      if (response.status !== 200) {
        problem = `HTTP ${response.status}`
        return null
      }
      failures = 0
      const payload = await response.json()
      const parsed = readSchedule(payload, line, station)
      if (parsed) {
        notice = null
        problem = null
        return parsed
      }
      const posted = readNotice(payload)
      if (posted) notice = { ...posted, at: now() }
      else problem = "data"
      return null
    } catch (error) {
      fail()
      problem = error?.name === "TimeoutError" ? "timeout" : error?.name === "SyntaxError" ? "data" : "network"
      return null
    }
  }

  // One refresh pass. Returns the number of stations actually read.
  async function refresh(at = now(), slice = REFRESH_SLICE) {
    if (at >= blockedUntil) failures = 0
    if (at < blockedUntil) return 0
    const due = oldestDue(
      network.queries(),
      (pair) => remembered.get(`${pair.line}-${pair.station}`)?.at ?? null,
      at,
      STALE_MS,
      slice,
    )
    await pool(due, FETCH_LIMIT, async (pair) => {
      const key = `${pair.line}-${pair.station}`
      const previous = remembered.get(key)
      let parsed = await fetchPair(pair.line, pair.station)
      // Some stations legitimately answer with no rows and then answer properly
      // a moment later; one retry is upstream's fix for that.
      if (parsed && parsed.observations.length === 0) {
        const again = await fetchPair(pair.line, pair.station)
        if (again && again.observations.length > 0) parsed = again
      }
      if (!parsed) return
      if (parsed.observations.length === 0 && previous && previous.observations.length > 0 && at - previous.at < REMEMBER_MS) return
      remembered.set(key, {
        at,
        board: parsed.board,
        observations: carryArrivalClock(previous?.observations ?? [], parsed.observations),
      })
    })
    return due.length
  }

  function snapshot(at = now()) {
    const boards = []
    const observations = []
    for (const [key, item] of remembered) {
      if (at - item.at > REMEMBER_MS) {
        remembered.delete(key)
        continue
      }
      boards.push(item.board)
      observations.push(...item.observations)
    }
    if (boards.length === 0) {
      return { ok: false, error: "Next train feed failed", observedAt: null, trains: [], boards: [] }
    }
    const trains = estimateTrains(network.routes_(), observations, network.point.bind(network)).map((train) => ({
      id: train.id,
      line: train.line,
      dest: train.dest,
      plat: train.plat,
      ttnt: train.ttnt,
      observedAt: new Date(train.observedAt).toISOString(),
      observedAtMs: train.observedAt,
      dueAtMs: train.dueAt,
      delay: train.delay,
      timeType: train.timeType,
      anchor: train.anchor,
      obs: train.obs ?? [],
      path: train.path,
      hold: train.hold,
    }))
    // TML-traffic: the raw readings too, for timetable matching.
    return { ok: true, observedAt: new Date(at).toISOString(), trains, boards, observations }
  }

  return {
    refresh,
    snapshot,
    async load(at = now()) {
      await refresh(at)
      return snapshot(at)
    },
    get stationCount() {
      return remembered.size
    },
    // TML-traffic: when the freshest board was read, so the app can tell
    // "showing old data" apart from "live".
    get newestAt() {
      let newest = 0
      for (const item of remembered.values()) newest = Math.max(newest, item.at)
      return newest
    },
    get blocked() {
      return now() < blockedUntil
    },
    // TML-traffic: MTR's alert while it lasts (dropped after REMEMBER_MS
    // without a new one), and the last read failure: "timeout", "network",
    // "data" (unreadable answer) or "HTTP <code>".
    get notice() {
      return notice && now() - notice.at <= REMEMBER_MS ? notice : null
    },
    get problem() {
      return problem
    },
  }
}
