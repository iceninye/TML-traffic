# Changelog

All notable changes to the Tuen Ma Line live diagram. Commit hashes are the
release commits stamped in the page footer.

## v0.5.4 — 2026-10-06 (`COMMIT`)
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
