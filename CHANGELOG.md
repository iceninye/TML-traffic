# Changelog

All notable changes to the Tuen Ma Line live diagram. Commit hashes are the
release commits stamped in the page footer.

## v0.4.5 — 2026-10-05
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
