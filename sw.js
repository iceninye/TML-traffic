// Offline shell for the diagram view. Only same-origin GETs are cached; the
// MTR feed and any map tiles are left alone so nothing stale is ever replayed
// while the network is up.

const CACHE = "tml-traffic-shell-v50"
const SHELL = [
  "./",
  "index.html",
  "site.webmanifest",
  "assets/app.css",
  "assets/app.js",
  "assets/icon.svg",
  "apple-touch-icon.png",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "android-chrome-maskable-512x512.png",
  "lib/mtr-estimate.js",
  "lib/mtr-feed.js",
  "lib/mtr-network.js",
  "lib/mtr-run.js",
  "lib/mtr-schedule.js",
  "lib/tml-duties.js",
  "lib/tml-model.js",
  "lib/tml-motion.js",
  "lib/tml-timetable.js",
  "data/tml-network.json",
  "data/tml-timetable.json",
  "data/tml-track.json",
  "data/timetables/index.json",
  "data/timetables/TML1100B.json",
  "data/timetables/TML6090A.json",
  "data/timetables/TML7090.json",
]

// Best effort: the Duty cards and the official duty hours for offline use. Every sheet
// in index.json is cached, so a new sheet needs no change here.
async function cacheDuties(cache) {
  try {
    const get = async (path) => {
      const response = await fetch(path, { cache: "no-cache" })
      if (!response.ok) throw new Error(`${path}: ${response.status}`)
      await cache.put(path, response.clone())
      return response
    }
    const index = await (await get("data/duties/index.json")).json()
    await Promise.all([get("data/duty-basic.json"), ...index.sheets.map((sheet) => get(`data/duties/${sheet.file}`))])
  } catch {
    // the page fetches them itself when online
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL).then(() => cacheDuties(cache)))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Revalidate against the server every time (a cheap conditional GET): GitHub
  // Pages lets browsers reuse a file for 10 minutes, and after a release that
  // could pair a new app.js with an old lib/*.js whose exports it imports.
  event.respondWith(answer(event, request))
})

// 先問網絡（唔係先用快取），但訊號差時唔好等到失敗：3 秒未答就先出快取，網絡背後繼續跑並更新快取。
const SLOW_MS = 3000

async function answer(event, request) {
  const network = fetch(request, { cache: "no-cache" }).then((response) => {
    if (response.ok) {
      const copy = response.clone()
      caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
    }
    return response
  })
  const cached = await caches.match(request)
  if (!cached) return network.catch(() => Response.error())
  event.waitUntil(network.catch(() => {}))
  let timer
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(cached), SLOW_MS) })
  return Promise.race([network.catch(() => cached), slow]).finally(() => clearTimeout(timer))
}
