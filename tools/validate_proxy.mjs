// Checks the optional feed proxy (lib/mtr-proxy.js) and its Worker (worker/src/index.js) without a network.
//   node tools/validate_proxy.mjs
import { readFileSync } from "node:fs"
import { createProxyFetch } from "../lib/mtr-proxy.js"
import worker, { STATIONS, buildBoard, UPSTREAM } from "../worker/src/index.js"

const root = new URL("..", import.meta.url).pathname
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`)
  if (!ok) failed += 1
}

const network = JSON.parse(readFileSync(`${root}/data/tml-network.json`, "utf8"))
check(JSON.stringify(STATIONS) === JSON.stringify(Object.keys(network.stations)), "Worker 站碼清單同 data/tml-network.json 一致")
check(JSON.parse(readFileSync(`${root}/data/config.json`, "utf8")).feedProxy === "", "預設關閉 feedProxy")

// A fake data.gov.hk: every station answers { data: { "TML-<sta>": ... } }.
let upstreamCalls = 0
const upstream = async (url) => {
  upstreamCalls += 1
  const sta = new URL(url).searchParams.get("sta")
  return new Response(JSON.stringify({ status: 1, data: { [`TML-${sta}`]: { curr_time: "2026-11-10 12:00:00", UP: [], DOWN: [] } } }), { status: 200 })
}

const board = await buildBoard("tc", upstream, 1000)
check(upstreamCalls === 27 && Object.keys(board.stations).length === 27 && board.at === 1000, "Worker：一次合成 27 站")
const partial = await buildBoard("tc", async (url) => (new URL(url).searchParams.get("sta") === "TUM" ? new Response("x", { status: 500 }) : upstream(url)), 1)
check(Object.keys(partial.stations).length === 26 && !partial.stations.TUM, "Worker：個別站失敗只漏嗰一站")
check(String(UPSTREAM).startsWith("https://rt.data.gov.hk/"), "Worker 上游係 data.gov.hk")

// The Worker's fetch handler answers 502 and does not cache when nothing is readable.
const realFetch = globalThis.fetch
globalThis.fetch = async () => new Response("down", { status: 503 })
const down = await worker.fetch(new Request("https://x.test/board?lang=tc"), {}, { waitUntil() {} })
check(down.status === 502 && down.headers.get("cache-control") === "no-store", "Worker：上游全失敗 → 502 同唔快取")
globalThis.fetch = realFetch
check((await worker.fetch(new Request("https://x.test/other"), {}, {})).status === 404, "Worker：其他路徑 404")

// The page side: 27 station requests, one proxy request.
let proxyCalls = 0
let directCalls = 0
let proxyOk = true
let clock = 0
const direct = async (url) => {
  if (url.startsWith("https://feed.test/board")) {
    proxyCalls += 1
    return proxyOk ? new Response(JSON.stringify(board), { status: 200 }) : new Response("no", { status: 500 })
  }
  directCalls += 1
  return upstream(url)
}
const proxyFetch = createProxyFetch({ proxyUrl: "https://feed.test/board", direct, ttlMs: 3000, now: () => clock })
const urls = STATIONS.map((s) => `${UPSTREAM}?line=TML&sta=${s}&lang=tc`)
const answers = await Promise.all(urls.map((u) => proxyFetch(u)))
const payloads = await Promise.all(answers.map((r) => r.json()))
check(proxyCalls === 1 && directCalls === 0, "頁面：27 個站請求只發 1 個 proxy 請求，冇直接請求")
check(payloads.every((p, i) => p.data[`TML-${STATIONS[i]}`]), "頁面：每個站拎到自己嗰份原始資料")
clock = 1000
await proxyFetch(urls[0])
check(proxyCalls === 1, "頁面：3 秒內用快取")
clock = 5000
await proxyFetch(urls[0])
check(proxyCalls === 2, "頁面：過期後再問一次")
proxyOk = false
clock = 20000
const fallback = await proxyFetch(urls[3])
check(proxyCalls === 3 && directCalls === 1 && (await fallback.json()).data[`TML-${STATIONS[3]}`], "頁面：proxy 出事 → 自動直接讀 data.gov.hk")
await Promise.all(urls.slice(4).map((u) => proxyFetch(u)))
check(proxyCalls === 3 && directCalls === 24, "頁面：proxy 出事後 30 秒內唔再問 proxy（其餘 23 站直接讀）")
proxyOk = true
clock = 60000
await proxyFetch(urls[0])
check(proxyCalls === 4, "頁面：30 秒後再試 proxy")
const missing = createProxyFetch({ proxyUrl: "https://feed.test/board", direct: async (u) => (u.startsWith("https://feed.test") ? new Response(JSON.stringify({ at: 1, stations: {} }), { status: 200 }) : upstream(u)) })
check((await (await missing(urls[0])).json()).data["TML-TUM"], "頁面：proxy 冇該站 → 直接讀")

if (failed) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log("validate_proxy OK")
