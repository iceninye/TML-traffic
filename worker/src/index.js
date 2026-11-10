// tml-feed: an optional edge cache for the MTR Next Train API (see worker/README.md).
//
// GET /board?lang=tc answers { at, stations: { TUM: <raw getSchedule payload>, ... } }
// for all 27 Tuen Ma Line stations in ONE request, cached at the edge for a few
// seconds. The page then makes one request per refresh instead of 27, and
// data.gov.hk sees one set of 27 calls per cache window however many people watch.
//
// Deployed on its own (worker/wrangler.jsonc), not part of the site's static
// assets deploy. The page falls back to calling data.gov.hk directly whenever
// this answers badly, so a failure here never takes the site down.

export const UPSTREAM = "https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php"
// Keep in step with data/tml-network.json (tools/validate_proxy.mjs checks it).
export const STATIONS = ["TUM", "SIH", "TIS", "LOP", "YUL", "KSR", "TWW", "MEF", "NAC", "AUS", "ETS", "HUH", "HOM", "TKW", "SUW", "KAT", "DIH", "HIK", "TAW", "CKT", "STW", "CIO", "SHM", "TSH", "HEO", "MOS", "WKS"]
export const CACHE_SECONDS = 5
const CONCURRENCY = 6

const headers = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": `public, max-age=${CACHE_SECONDS}`,
}

async function readStation(code, lang, fetchImpl) {
  const url = `${UPSTREAM}?line=TML&sta=${code}&lang=${lang}`
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) })
    if (response.status !== 200) return null
    return await response.json()
  } catch {
    return null
  }
}

export async function buildBoard(lang, fetchImpl = fetch, now = Date.now()) {
  const stations = {}
  let next = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (next < STATIONS.length) {
      const code = STATIONS[next++]
      const payload = await readStation(code, lang, fetchImpl)
      if (payload) stations[code] = payload
    }
  })
  await Promise.all(workers)
  return { at: now, stations }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "access-control-allow-methods": "GET" } })
    const url = new URL(request.url)
    if (url.pathname !== "/board" || request.method !== "GET") return new Response("not found", { status: 404, headers })
    const lang = url.searchParams.get("lang") === "en" ? "en" : "tc"
    const key = new Request(`${url.origin}/board?lang=${lang}`)
    const cache = typeof caches !== "undefined" ? caches.default : null
    const hit = cache ? await cache.match(key) : null
    if (hit) return hit
    const board = await buildBoard(lang)
    // Nothing readable (the API is down): do not cache the failure.
    if (Object.keys(board.stations).length === 0) return new Response(JSON.stringify(board), { status: 502, headers: { ...headers, "cache-control": "no-store" } })
    const response = new Response(JSON.stringify(board), { status: 200, headers })
    if (cache) ctx.waitUntil(cache.put(key, response.clone()))
    return response
  },
}
