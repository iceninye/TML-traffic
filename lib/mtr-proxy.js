// Optional edge cache for the MTR feed (worker/README.md). Wraps fetch so the
// feed code is unchanged: a getSchedule request for one station is answered
// from ONE aggregated /board request shared by all 27 stations, and falls back
// to the direct request whenever the proxy fails or lacks the station.

export function createProxyFetch({ proxyUrl, direct = (...args) => fetch(...args), ttlMs = 3000, now = () => Date.now(), timeoutMs = 8000, backoffMs = 30_000 }) {
  let cached = null
  let inflight = null
  let failedAt = -Infinity
  const board = (lang) => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.data)
    // After a failure go straight to data.gov.hk for a while instead of asking a broken proxy 27 times.
    if (now() - failedAt < backoffMs) return Promise.reject(new Error("proxy backing off"))
    if (!inflight) {
      const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined
      inflight = direct(`${proxyUrl}${proxyUrl.includes("?") ? "&" : "?"}lang=${lang}`, { headers: { Accept: "application/json" }, signal })
        .then((response) => {
          if (response.status !== 200) throw new Error(`proxy ${response.status}`)
          return response.json()
        })
        .then((data) => {
          if (!data || typeof data.stations !== "object") throw new Error("proxy data")
          cached = { at: now(), data }
          return data
        })
        .catch((error) => {
          failedAt = now()
          throw error
        })
        .finally(() => {
          inflight = null
        })
    }
    return inflight
  }
  return async function proxyFetch(url, options) {
    try {
      const target = new URL(url)
      const station = target.searchParams.get("sta")
      const data = await board(target.searchParams.get("lang") === "en" ? "en" : "tc")
      const payload = data.stations[station]
      if (payload) return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
    } catch {
      // fall through to the direct request
    }
    return direct(url, options)
  }
}
