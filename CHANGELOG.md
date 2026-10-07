# Changelog

All notable changes to the Tuen Ma Line live diagram. Commit hashes are the
release commits stamped in the page footer.

## v0.7.3 — 2026-10-07 (`dev`)
- Station countdowns: "即將" now goes as soon as the dot of the train it belongs to starts to pull out of the platform. MTR's board keeps a departed train at 0 for a while and each board is read every ~20 s, and since v0.7.0 any 0 from a read in the last 30 s was kept, so "即將" could stay up to about a minute after the dot left. Each board reading is now tied to its drawn train (its timetable trip, or the countdown-model train built from it); readings no train claims keep the old clock. Synthetic boards (DS1101 11:50, 52 rows over 10 min, board still at 0 for 20 s after a departure): rows showing "即將" with no train at or within a minute of the platform, 2174 to 38 row-seconds; the same with a 40 s board lag, 3746 to 29. Rows missing "即將" while a train dwells are unchanged (565 vs 565), except a train held at the platform past its timetabled dwell: its dot leaves on time and "即將" goes with it (90 s holds: 560 to 743). Details in docs/ALGORITHM.md §3g. Shell cache renamed `v25`.

## v0.7.2 — 2026-10-07 (`84824aa`)
- Resume after pause: with nothing read yet (the app opened paused, or MTR withholding data under special arrangements), tapping 繼續 showed "資料延遲（29855776 分鐘前）" until the first read finished, 1-10 s. It now shows "讀取中…" until then. Shell cache renamed `v24`.

## v0.7.1 — 2026-10-07 (`ed9f043`)
- Feed status: during special train service arrangements the MTR feed answers every station with `status: 0`, its own message and a link, and no train times. The app treated that like a failed connection and showed "暫時連唔到港鐵班次資料" for as long as it lasted. It now says "港鐵暫停提供實時班次" and shows MTR's message with a 詳情 link in the banner; the banner also appears while older boards are still on screen, and clears once the feed sends times again.
- "Can't reach" now names the reason: HTTP status (e.g. 503, 429), 逾時 (no answer in 10 s), 網絡錯誤 (blocked or offline), 資料無法讀取 (an answer that is not the feed's JSON), or 程式錯誤 when the app itself failed before reading anything.
- The banner is rewritten only when its text changes (it was rewritten every second), so its link can be tapped. Shell cache renamed `v23`.

## v0.7.0 — 2026-10-07 (`0b89ed3`)
- Trip matching (the "–" dots): a dot shows "–" in Run-number mode when no timetable trip claimed its readings and the countdown model drew it. Delayed trains caused this: readings 120-150 s off their trip cost more than skipping them, so they were always dropped and drawn again as a "–" train beside the real one, and the line delay taken from the nearest slot could read a late line as an early one. The matching cost is now continuous, the line delay is scored over all near readings with lateness favoured over earliness, each direction gets its own, and readings attached in the second pass must keep the trains' order. Synthetic boards like the 2026-10-07 08:56 screenshot (a few trains +80-130 s, page opened during the delay): "–" dots 1.5 to 0 per snapshot, readings on the wrong trip 5.5% to 1.0%. With a train held 5-8 minutes and a queue behind it, "–" dots fall (e.g. 3.8 to 1.2) but some of those readings now go to a neighbouring trip in the queue (wrong-trip share up to 8.5% from 4.2% in one case): queued trains are hard to tell apart from the boards alone. `tools/validate_matching.mjs` runs these scenarios.
- Run numbers: the orange dot left of the title is now a switch. Tap once and every train dot shows its Run number until tapped again; the choice is remembered (it used to show for 15 s).
- L trips (last trip of the day for that train, back to depot after it) are drawn at 70% opacity on the diagram and the map, and the card says "L 尾程". The flag comes from the Duty Sheet; the official timetable PDFs have none, so special-timetable days show no L.
- Train card page 2: tap the ▲/▼ chip (or "全日更份 ›") for the train's duties for the day from the Duty Sheet: duty number, pick-up station and time, relief station and time, with the current duty highlighted and "回廠" on the last. Tap the chip again to go back.
- Station countdowns: a "即將" reading from a board read in the last 30 s is never hidden. A train dwelling past its due clock keeps its board at 0; v0.6.1 hid it 30 s after the due clock even when the read was fresh.

## v0.6.3 — 2026-10-06 (`b3d0e2a`)
- Station countdowns: a reading's minutes now count down from its due time between feed reads (never upwards). Before, a board kept after a failed read (up to 3 min) showed the same "3" for its whole life; now it falls to "即將" and then leaves like any other.
- Duty Sheet tooltip: states that stop times are the official timetable's with duty numbers added, and only trips the timetable lacks are modelled (it still said every mid-station time was modelled).

## v0.6.2 — 2026-10-06 (`9d70e3e`)
Fixes from a second audit of v0.5.4 to v0.6.1; no change to train matching or positions.
- Station card: it was a snapshot taken when opened, so its minutes and "即將" never moved until it was closed and reopened. It now follows the feed and the per-second ageing like the diagram rows.
- Service worker: files are revalidated with the server on every load (`cache: "no-cache"`). GitHub Pages lets browsers reuse a file for 10 minutes, so right after a release a returning visitor could get the new `app.js` with an old `lib/tml-timetable.js` and fail to start on a missing export. Shell cache renamed `v21`.

## v0.6.1 — 2026-10-06 (`fb98092`)
- Station countdowns: a "即將"/"now" reading is dropped once its train has left (30 s after an arrival time, at the departure time for a published departure) and the board repaints every second, so it no longer lingers after the dot has left the platform until the next feed read.
- Train card: a train standing at its first platform shows "候發，約 N 分鐘後開出" instead of "即將開出" when it is two or more minutes from leaving.
- Train card: trains starting at TUM/WKS show their timetabled (or Duty Sheet) departure to the second, with the expected time when running 60 s or more off it.

- Duty Sheet parser 0.2.0 records who drives each trip: [duty, from station] pairs (更份, 7 digits), taken from the legs of the same Run (a relief hands over at KSR/TAW or the terminus; "Riding" legs and DM shuttles are skipped). The train card shows the duty driving now, and the next relief if one is ahead as "（<station>換 <duty>）".
- Duty Sheet books now start from the base timetable: every trip the sheet confirms keeps the official stop times, trip number and notes, including depot pull-outs and short workings that start mid-line (Run 64 from Kam Sheung Road at 16:26:12, duty 1101160, was missing before). Only terminal departures the base lacks are rebuilt. A sheet is primary when not older than its base, so the duty numbers load. DS1101, DS6091, DS7091 registered: all base trips present with identical times, duty numbers on every trip; 1960 of 1963 duty hand-overs match a pick-up leg at that station within 60 s, the other 3 start from a depot or siding (W1C, AUP).

## v0.6.0 — 2026-10-06 (`4427014`)
Duty Sheet as a schedule source, for when the official working timetable is late.
- `tools/parse_dutysheet.py` reads a Duty Sheet PDF (run, terminal departure, KSR/TAW relief, arrival), rebuilds the stops between from the nearest trip of a base timetable and writes `data/timetables/DS<code>.json` only after `tools/validate_dutysheet.py` passes. Output holds run, direction and times only: no duty numbers or crew details.
- On the three sample sheets (6091, 7091, 1101) the parser reproduces every terminal departure of the matching timetable (401, 360, 460 trips, 0 new, 0 missing). Rebuilt stop times against the real ones: median 3-10 s, P90 15-47 s.
- `index.json` entries can carry `source: "dutysheet"` and `primary`; the app loads only primary ones (newer than their base and different from it), labels them "Duty Sheet" in the header, and otherwise behaves as before.
- Timetable `pickFirstEntry` / `serviceDate` moved into `lib/tml-timetable.js`.

## v0.5.4 — 2026-10-06 (`5118645`)
Reliability fixes from a code audit; no change to train matching or positions.
- Feed: each station request now times out after 10 s (a stalled connection used to hold the refresh open indefinitely, freezing updates until reload). After 8 consecutive failures the feed pauses requests for 45 s, as documented; before, the counter was reset on every pass so the pause never happened.
- Language switch: a refresh already in flight on the old feed no longer overwrites the new feed's result with an empty snapshot; a fresh refresh runs right after it.
- Pause: a refresh that finishes after Pause was pressed no longer turns the status back to "live".
- Map: a failed load (timeout, no WebGL) is torn down so the next attempt starts clean instead of reusing a map with no layers; concurrent calls share one load.
- Saved running-time calibration: entries with a negative count are ignored, and an oversized count now scales its sum with it instead of inflating the correction.

## v0.5.3 — 2026-10-06 (`760d64a`)
- Special timetables converted and registered: TML110SB (2026 Mid-Autumn, weekday), TML709CA/CB/GA/GC/UF (Sunday events), TML906V/906Y (typhoon, non-peak/peak). Manifest `kind` is now read from the PDF ("Special" on page 1); the validator no longer demands a full-day window for special timetables (typhoon peak pattern runs 09:00-21:00).
- The app loads normal timetables first and fetches special ones only when the normal ones fit the boards badly (< 70% of near readings within 40 s); `pickDay` then switches to a special timetable that fits clearly better, otherwise countdown-only mode as before. Header shows "特別時間表" for a special one.
- Checked on live Sunday boards: the normal timetable still wins (0.74–0.96 vs best special 0.56); synthetic readings built from each special timetable select that timetable.

## v0.5.2 — 2026-10-06 (`fe3fd25`)
- Timetable parser: footnotes resolved per page (they were attached to the wrong trips); empty (non-passenger) running flagged per stop and excluded from matching; depot-to-platform times kept; arrivals derived from section A run times; section A period names, ranges and summary rows (turnaround, round trip, trains used); section F first/last trains parsed.
- Validator checks section F (1,404/1,404 match in all three timetables) and trains in use.
- Header shows "尾班車時段" while the last trains are still running.

## v0.5.1 — 2026-10-05 (`de51834`)
- Hidden feature: tap the orange-red dot at the top left; it glows and every train on the route diagram shows its Run number in place of its arrow for 15 seconds (trains without a timetabled trip show "–").

## v0.5.0 — 2026-10-05 (`fb3568d`)
- Timetables live in `data/timetables/` with an `index.json` manifest; the app loads the calendar's one first and the rest in the background. `tools/parse_timetables.py` validates (`tools/validate_timetable.py`) before registering a new timetable — no code change needed to add one.
- Detects when the running service does not match the timetable (fit < 50%, or two of: >20% of trips >120 s off, measured headway >30% off, special-arrangement notice) and switches to countdown-only mode; switches back when it fits again.
- Countdown-only mode: positions from MTR countdowns only; header shows up/down train counts and measured headway; trip, Run and timetable delay show N/A; long gaps to the train ahead shown as yellow "班距 +Xs".
- Delay tag format `+ 60s`.

## v0.4.8 — 2026-10-05 (`d09eb2a`)
- Terminus turnaround: an arriving train stays at the Tuen Mun / Wu Kai Sha platform and hands over to the same Run's departing trip (linked by Run number; departure timed by the terminus board). No more trains vanishing on arrival; up to two trains wait per terminus.
- "0 min" readings count from the first time 0 was seen, fixing delays that inflated on the approach to a terminus.

## v0.4.7 — 2026-10-05 (`5d3a214`)
- Footer: "列車位置由到站時間推算模擬，非港鐵官方列車位置"; engine reference line removed (the engine has been largely rewritten).

## v0.4.6 — 2026-10-05 (`d46a9d9`)
- Physics speed profile between stations (1.0 m/s² accel/brake, cruise solved from distance and timetabled run time) replaces the fixed 22% ramps; up to 525 m difference on the long KSR–TWW hop.
- Evidence-based de-duplication: a fallback train or coasting trip is a duplicate only if a placed train's predicted arrivals explain all its readings (±75 s); distance alone only below 0.25 km.
- Countdown-only mode when under 50% of readings fit any timetabled trip for two snapshots (overnight/special service), shown in the header badge.
- Smoother catch-up (critically damped), capped at 0.7×–1.3× pace (no on-screen speed above ~130 km/h).

## v0.4.5 — 2026-10-05 (`3e7cdcf`)
- Matching survives disruptions: per-trip tracking and ordered (non-crossing) alignment per station board; a held, extra or withdrawn train no longer shifts other trains (tests in `docs/ALGORITHM.md` §3b).
- Peak bunching: near-miss readings join the train they fit instead of spawning a duplicate; fallback needs two agreeing readings; trains closer than 0.85 km on one track are merged. Weekday AM peak: 56 shown (6 duplicates) → 48–50 (timetable 50–51).

## v0.4.4 — 2026-10-05 (`6b6a900`)
- Map trains: two small red tail lamps; white outline on every car.

## v0.4.3 — 2026-10-05 (`71b2f13`)
- Map trains: two small white lamps at each end; car body 30% darker grey-white.
- Up/down map lines 30% lighter and 30% thinner.

## v0.4.2 — 2026-10-05 (`b7160b1`)
- Map trains grey-white with a grey edge; centre glow removed.
- Lateness on the map shown by the car outline (red at 60 s, flashing at 180 s).

## v0.4.1 — 2026-10-05 (`23fb85d`)
- Delay tag reads `- 75s`. Trains 60 s+ late turn red; 180 s+ deeper red with a flashing glow (steady under reduced motion).
- Lines no longer glow on the diagram or map; trains still do.
- Timetable codes (TML1100B / TML6090A / TML7090) hidden; trip and run numbers kept.
- Map trains drawn as 8-car sets to scale (25,280 / 24,136 mm cars, 3,100 mm wide, 195.376 m).

## v0.4.0 — 2026-10-04 (`ef4187b`)
- Trains placed on the official working timetables (every trip, every station), matched to the Next Train API.
- API countdowns read correctly as rounded up ("2 min" = within 1–2 min); median error 39 s → 16 s.
- Running timetable detected from live readings (public holidays use Sunday's).
- Clock-based smoothing: no freezing between stations, no jumps, never backwards. See `docs/ALGORITHM.md`.

## v0.3.1 — 2026-10-04 (`d45ac3d`)
- Recover from feed outages: quick retries with back-off, stale-data status, offline message.
- Refresh every 20.5 s so every pass reads all 27 stations.
- Diagram builds when it first gets a width (fixes blank diagram in a hidden tab).

## v0.3.0 — 2026-10-04 (`96f74c4`)
- Positions fused from all chained board readings; per-direction hop times learned from the feed.
- Delay tags (run drift, feed forecast, headway). Glow styling after railisland.tw. New footer.

## v0.2.0 — 2026-10-04 (`c017797`)
- Two-track diagram with distance-proportional spacing; two-colour map on the real OSM alignment.
- Timetable running-time model, train card with upcoming stops, follow mode.

## v0.1.0 — 2026-10-04 (`3e9f376`)
- First release: SVG line diagram and optional MapLibre map, engine extracted from hk-traffic-intelligence.
