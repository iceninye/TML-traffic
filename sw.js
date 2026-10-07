// Offline shell for the diagram view. Only same-origin GETs are cached; the
// MTR feed and any map tiles are left alone so nothing stale is ever replayed
// while the network is up.

const CACHE = "tml-traffic-shell-v27"
const SHELL = [
  "./",
  "index.html",
  "assets/app.css",
  "assets/app.js",
  "assets/icon.svg",
  "lib/mtr-estimate.js",
  "lib/mtr-feed.js",
  "lib/mtr-network.js",
  "lib/mtr-run.js",
  "lib/mtr-schedule.js",
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
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
  event.respondWith(
    fetch(request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      })
      .catch(() => caches.match(request).then((hit) => hit ?? Response.error())),
  )
})
