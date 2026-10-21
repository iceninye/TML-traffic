# Changelog

All notable changes to the Tuen Ma Line live diagram. Commit hashes are the
release commits stamped in the page footer.

## v0.8.15 — 2026-10-21 (`c72ec32`)
- 更份: a failed read of the Duty index or a sheet is no longer kept for the session. The index used to turn into an empty list (「冇符合」) and a sheet stayed 「讀取更份資料失敗」 until a reload; now both are read again when the network comes back or the page is shown again.
- Shell cache renamed `v48`.

## v0.8.14 — 2026-10-21 (`58eb59b`)
- Place names for the depot, siding and turn-back codes on the Duty Sheets, confirmed by Ice: OS 外放車 (where trains stand outside service hours), PHD 八鄉車廠（東）, PMC 八鄉車廠（西）, PKTA／PKTD 八鄉車廠側線 A／D, ENT／EXT 大圍車廠出入口, HHS 紅磡廠, CIOT 第一城側線, KATS 啟德側線, TWWS 荃灣西側線, TIST 天水圍側線, AUP 柯士甸側線, TB1 大圍調頭位置 (about 300 m before 大圍 platform 3／顯徑 platform 1). They live in `data/tml-network.json` under `places`, so tml-roster reads the same names; the 更份 card shows 「外放車」 instead of 「OS」.
- `data/duties/index.json` now carries `alsoOn` like `data/timetables/index.json`: 8022 also runs on 31 Oct and 7091 on 19 Oct. tml-roster reads only the duty index to pick a day's sheet. `tools/dutycards.py` copies `alsoOn` from the timetables index whenever it writes the duty index.
- `tools/validate_duties.mjs`: the days of each sheet agree between the two indexes, and every place a card names has a name.
- Shell cache renamed `v47`.

## v0.8.13 — 2026-10-21 (`5124eae`)
- Audit of what the parser takes from the Duty Sheet workbooks (8022, 8023, 8027, 7091M), sheet by sheet. The workbook's own `timetable` sheet (the official train-by-train times with trip numbers) was not read before; it is now, and its times go on every matched train: 437/437 (8022), 417/417 (8023), 537/537 (8027) and 380/382 (7091M) trips now carry the workbook's exact times. 8022 had 7 trips changed (up to 108 s), 8027 15 (up to 66 s), 7091M 6 (up to 38 s), 8023 none. Rebuilt trips now have their trip number (86 in 8022 and 8027, 7 in 8023, 379 in 7091M).
- Platform numbers: each 更份 on a trip now carries the platform the driver takes over on when the sheet names one (KSR1, KSR2, TAW3, TAW4, HUH2, HUH3, TWW2, HOM3, ...), as a third item `[duty, station, platform]`; terminus pick-ups at TUM and WKS stay `[duty, station]` because the sheets give no platform there. All seven Duty Sheets (1101, 6091, 7091 too) were written again for it. The train card reads 「錦上路 1 換 8027115」 and the 全日更份 page 「接車 錦上路 2」, 「交車 紅磡 3」. A trip the timetable sheet routes to a named platform (「(HUH3 arr)」) keeps it in `platforms`. The `platform sheet` tab was checked against the data: every relief and time on it matches (its platforms are fixed by direction: UP TAW3, HUH3, KSR1; DOWN KSR2, HUH2, TAW4).
- Fixed: 8027 Run 67 19:48 from Tuen Mun had no 更份 (the base timetable ran it later than the workbook, so its driver 8027153 was missed); duties are matched again on the workbook's own times. The workbook overlay no longer drops the "empty stop" mark on the first stop of trains coming out of a depot.
- 8027107 is 6.5 h and 8027131 is 8 h (confirmed by Ice; the Index sheet had 6 h and 7.5 h): added to `data/duty-hours-fixes.json` and `data/duty-basic.json`.
- 1101, 6091 and 7091: four last trips that end service at Tai Wai and go to the depot now carry the L mark (from the v0.8.12 parser), the same as the dated sheets.
- Not taken: empty-train movements between depot and terminus (trip numbers 3xxxx and 4xxxx, flagged N), and the timetable sheet's note symbols ((#), (~), (W), (K), (29)(30)) whose legend is not in the workbook; for passenger trips the base timetable's full notes are kept.
- `tools/parse_dutysheet.py`: `read_timetable` and `apply_timetable`; the data files record the timetable sheet's code in `timetableSheet` (8027 is built on TML110CB, 8022 on TML609CB, 8023 on TML709CB, 7091M on TML709MB).
- Shell cache renamed `v45`.

## v0.8.12 — 2026-10-21 (`0eb3672`)
- The Marathon timetable of Sunday 1 Nov 2026 (the updated 7091 workbook, "Northern Metropolis Marathon Timetable") runs on that day only, as Duty Sheet **7091M**: the header reads "Duty Sheet 7091M" on 1 Nov, and every other Sunday (and 19 Oct) keeps the regular 7091. It has the same 360 trips as the regular Sunday timetable plus four early trains from Wu Kai Sha at 04:38, 04:53, 05:08 and 05:23 that end at Tai Wai (from the workbook's `overnight` sheet), and different duty numbers on 208 trips (Tai Wai duties are 7091401 and up, Hung Hom 7091601 and up).
- `tools/parse_dutysheet.py`: `--code` registers a workbook under another code (7091M), `--force` rewrites an already registered workbook, and the `overnight` sheet is read. A trip handed over at Tai Wai or Kowloon Station to an empty train (to a depot or siding) now ends there; before, it was drawn to the far terminus. Excel relief times are to the second, so the 30-second round-up meant for PDF minutes is no longer added: 8022, 8023 and 8027 were written again, which moves only their rebuilt trips (20, 7 and 40), by at most 39 seconds. The first-departure check accepts 04:00 onwards, and the fifth digit check accepts 4 and 7 (Tai Wai) and 6 (Hung Hom) too.
- Known: `tools/validate-hours.mjs` reports 8027107 (card 6.5 h, official Index 6 h) and 8027131 (card 8 h, Index 7.5 h). The cards follow the sheet's own book on/off times and meal; the official hours need a driver to confirm before going into `data/duty-hours-fixes.json`.
- Shell cache renamed `v44`.

## v0.8.11 — 2026-10-21 (`8837f6d`)
- Duty data now lives in one place: this repo. `data/duty-basic.json` (book-on/off, place and hours of every duty, spare duties included, from the Duty workbook's Index sheet), `data/duty-hours-fixes.json`, `tools/index-to-basic.py` and `tools/validate-hours.mjs` moved here from tml-roster. tml-roster stops keeping copies and reads `data/` from this site at run time, so a new Duty Sheet or Index is imported here only.
- `_headers`: `data/*` answers cross-origin GETs (`Access-Control-Allow-Origin: *`) so tml-roster can read it on Cloudflare Workers.
- `.gitignore` also skips `*.xlsx`, so a raw Duty Sheet or Duty workbook is not committed by accident.
- Duty Sheet 8027 (KTSP event timetable) runs on Friday 30 Oct 2026 (the date is in the workbook). Duty Sheet 8022 also runs on Saturday 31 Oct, besides 24 Oct (`alsoOn` on its entry in `data/timetables/index.json`; `entriesForDate` now keeps a dated sheet on its `alsoOn` days too). The 8022 workbook sent again is byte-identical to the one already ingested, so its data is unchanged. Other days are unchanged.
- Shell cache renamed `v43`.

## v0.8.10 — 2026-10-19 (`ca9e7bc`)
- When the request itself fails, the status line adds a hint: "網絡錯誤，如用緊 VPN／代理，請將 data.gov.hk 設為直連". Reported by Ice: with Shadowrocket on, the MTR feed (`rt.data.gov.hk`) fails with 網絡錯誤 while the page itself loads. The app cannot change how the device resolves or routes that host.
- Shell cache renamed `v41`.

## v0.8.9 — 2026-10-19 (`e7689e1`)
- "網絡錯誤" is now only reported when the request itself fails (offline, blocked, refused by CORS, DNS). Before, any exception while reading a reply that did arrive (a parser bug, an unexpected payload) was also labelled "網絡錯誤", which hid the real cause; it now shows "資料無法讀取". `AbortError` counts as 逾時. `lib/mtr-feed.js`; checked by `tools/validate_feed_errors.mjs`.
- Shell cache renamed `v40`.

## v0.8.8 — 2026-10-15 (`a498664`)
- Monday 19 Oct 2026 runs Duty Sheet 7091 (Sunday's sheet), so the header reads "Duty Sheet 7091" instead of 不適用 and Run numbers, 更份 and the Duty Sheet card work that day. The date is the `alsoOn` list on the DS7091 entry in `data/timetables/index.json`: add a date there to run that sheet on another day (the service day still changes at 04:00). 24 Oct (DS8022) and 25 Oct (DS8023) are unchanged. Other days are unchanged.
- Shell cache renamed `v39`.

## v0.8.7 — 2026-10-14 (`6ea7ef6`)
- Train card: duty numbers (both the current one and the relief ahead) are plain text in the body colour, with no underline, and tapping either opens its Duty Sheet card. The relief-ahead number was plain text before.
- Shell cache renamed `v38`.

## v0.8.6 — 2026-10-14 (`44becd1`)
- Train card: the duty number (更份) is now a button. Tap it and the Duty Sheet card opens on that duty's own card (hours, meal, 飯腳, every leg); 返回 goes to the day's duty list. The duty numbers in the train card's 全日更份 page open their cards the same way. A number the sheet has no card for (a skipped card) says so instead of "讀取失敗".
- Shell cache renamed `v37`.

## v0.8.5 — 2026-10-14 (`3537493`)
- 飯腳 compares meals by station, not platform: 錦上路1 and 錦上路2 (KSR1, KSR2) are both 錦上路, 大圍3 and 大圍4 (TAW3, TAW4) are both 大圍, and 紅磡2 and 紅磡3 (HUH2, HUH3) are both 紅磡 (`placeStation()` in `lib/tml-duties.js`). Only duties of the same Duty Sheet are compared, since one sheet runs per day.
- Shell cache renamed `v36`.

## v0.8.4 — 2026-10-14 (`f49dbec`)
- Duty detail card: under 用膳 a new line 飯腳 lists the other duties of the same Duty Sheet that eat at the same place (the place where the duty gets off) and whose meal overlaps this one's by 45 minutes or more, each with the overlap ("19:44–20:30（46 分）"); tap a number to open that duty. `mealMates()` in `lib/tml-duties.js`; checked by `tools/validate_duties.mjs`.
- Shell cache renamed `v35`.

## v0.8.3 — 2026-10-14 (`4eda119`)
- Duty cards: every HUH3 → ETS1 and ETS2 → HUH2 leg is 泊車 (parking the train), no longer 載客 (Ice: 1101334 Run 20 16:58:24 and Run 62 17:06:47). The new leg kind `park` is written by `tools/dutycards.py` into all five `data/duties/DS*.json` (2088 legs) and shown as "Run 20 泊車 紅磡3 → 尖東1" on the card.
- Shell cache renamed `v34`.

## v0.8.2 — 2026-10-14 (`b6ccd27`)
- Meal break is now the time from getting off a train to picking up the next one (1101165: 19:44 at KSR1 to 20:57 at KSR2, 1 h 13 min), not the printed MB row. The row only tells the parser which gap is the meal. `meal` in `data/duties/DS<code>.json` is `[from, to, placeFrom, placeTo]`; the card shows "KSR1 → KSR2" when the two places differ. Meals are therefore longer than before (median about 90 min).
- 1101586 is no longer published (alongside 6091588 and 7091587), so 1101 has 154 duties. 1101107 and 1101131 show 6 h 30 min and 8 h (the printed 6:00 and 7:30 are source-sheet errors that later versions will correct).
- The header line's Duty Sheet button looks like the rest of the line: same colour, no underline and no arrow (a hidden control; it still opens the card).
- 8023586 and 8023585 (ETS DM): the MB row's own time is unreliable in the workbook (8023586 prints 18:41 between legs at 19:16 and 20:30), so the meal gap is taken from the MB row's position among the legs. 8023586 is 19:19 HUH2 to 20:30 HUH3, 8023585 20:26 HUH2 to 21:48 HUH3.
- Shell cache renamed `v33`.

## v0.8.1 — 2026-10-14 (`0f434b8`)
- Duty cards for the three older PDF sheets. `tools/parse_dutysheet.py` now reads the left block of every PDF card (Book On/Off places and times, Work Hr) and the meal break row ("<from> MB <to>"), and `tools/dutycards.py` turns them into `data/duties/DS<code>.json` like the Excel sheets. 1101 has 155 duty cards, 6091 121 and 7091 102 (the number-only lists of v0.8.0 are replaced), so pages 1 to 3 of the Duty Sheet card now work for weekdays, Saturdays and Sundays too, with book on/off, meal and every leg.
- Times in a PDF card are anchored on the card's own book-on time, so a duty that starts in the evening keeps its after-midnight legs on the right day. Two stray cards whose legs run far past their book-off (6091588, 7091587) are skipped with a warning. A leg may run up to an hour past book off (the sheet's "Continue Duty" legs); a duty's phase now ends at book off.
- The source note on a duty card no longer says "工作表" for a PDF sheet (there is no tab).
- Shell cache renamed `v32`.

## v0.8.0 — 2026-10-14 (`74d4e70`)
- Duty Sheet card. The header's "· Duty Sheet 1101 ›" (any sheet number, or 不適用) is now a button that opens a card with three pages and a detail view:
  1. 當值: the duties on duty now with their state and place ("Run 25 行駛中 屯門 → 烏溪沙", 用膳中, 等待接班, 出車準備, 乘搭接駁, 收車), until when, what comes next, book on/off and the meal break; filter 全部 / KSR / TAD / HHS.
  2. 今日全部: every duty of the sheet in use in book-on order (book on, book off, meal), 現時 marks those on now; the same filter and a number search.
  3. 所有編號: every sheet's duties, filtered first by 平日 / 星期六 / 星期日 / 特別日 (dated sheets such as 8022 and 8023), then KSR / TAD / HHS, with the number search.
  4. Tapping a duty shows its whole card: book on/off with places, work hours, meal break, every leg (kind, Run, from, pick-up time to the second, to, arrival minute), the live leg highlighted, a 睇列車 link to the train when its Run is on the diagram, and where the data comes from.
  The card needs a sheet in use for pages 1 and 2; with 不適用 it opens on page 3. The Run switch (brand dot) does not affect it.
- New data: `data/duties/DS<code>.json` (+ `index.json`), written by the new `tools/dutycards.py` (called by `tools/parse_dutysheet.py` for every `.xlsx`; `python3 tools/dutycards.py --stubs` lists the numbers of the older PDF sheets 1101, 6091 and 7091, which have no book on/off or meal data yet). 8022 has 133 duties and 8023 117, checked against the workbook's own duty list. Published per duty: number, group, tab, book on/off, work minutes, meal, and legs as kind, Run, places and times. Free-text remarks and the one card that is not on the duty list are not written.
- `tools/validate_duties.mjs` checks the cards and the on-duty logic on the real data (including a duty that crosses midnight).
- Shell cache renamed `v31`.

## v0.7.8 — 2026-10-14 (`0d47bcf`)
- Duty Sheets 8022 and 8023 now run on their own days: Saturday 24 Oct 2026 uses DS8022 and Sunday 25 Oct uses DS8023 (the Kai Tak event timetable, built on TML709CB). Every other day is unchanged. A timetable listed with `dates` in `data/timetables/index.json` is used on those service dates only and left out on all other days; the header tooltip says "只用於 <date>".
- `tools/parse_dutysheet.py` reads the new Excel workbooks (sheets KSR, TAW, HHS, ETS DM; pick-up and relief times to the second). The service date comes from the sheet itself. For a dated sheet the base timetable is the same-day one (normal or special) whose terminal departures the sheet reproduces best. Only Run, duty number and times are written, as before.
- The header line shows the Duty Sheet in use again, now as its number: "· Duty Sheet 1101" (also 6091, 7091, 8022, 8023). When no sheet is in use it reads "· Duty Sheet 不適用": the running book is not a Duty Sheet book (for example a public holiday that follows Sunday's plain timetable) or the boards no longer fit it (special arrangements). In that state no Run number or 更份 shows anywhere (route diagram labels, the card's Run chip and 車次 line, 更份, the duty page, 全日更份) and the L dimming goes too, because all of these come from the sheet. The Run switch (brand dot) stays but does nothing then.
- Shell cache renamed `v30`.

## v0.7.7 — 2026-10-09 (`8cfb6d5`)
- A late train's dot no longer reaches a platform before the train. At 17:04 Run 5 (towards Wu Kai Sha) showed +95 s, yet its dot was already at Shek Mun while the Shek Mun board still read 1 min. The dot's clock closes on the delay estimate at no more than 0.3 s per second, so after the delay jumped the dot kept running ahead of the badge. Now, when the dot is ahead of the estimate by more than that clock could still close before the dot reaches the next platform, the dot stands still short of the platform until the estimate has caught up, then runs on at 0.7x. In the synthetic check (`tools/validate_position.mjs`, new "early" column: dot at or past a platform the train has not reached) held trains went from 3-19% of the time early to 0-1.2%, and a train running 4 sections at 1.5x slow from 7.5% to 4.5%; on-time running and the rest of the line are unchanged. The slow case is not fully closed because the delay estimate itself lags a gradual slow-down (docs/ALGORITHM.md §3i).
- Shell cache renamed `v29`.

## v0.7.6 — 2026-10-07 (`942f025`)
- Late trains no longer run ahead of their boards. At 18:40 Run 73 showed +110 s but its dot was already half way from To Kwa Wan to Sung Wong Toi, while the To Kwa Wan board still counted down to it. The badge was right; the dot's clock was still at about +50 s, because it closed on the estimate at no more than 0.3 s per second and kept running at 0.7x. A dot standing at a platform now waits there until its clock catches up (or leaves sooner when the train is ahead of it); between stations it still runs at 0.7-1.3x and never stops or goes backwards. In a synthetic check of held trains (`tools/validate_position.mjs`), dots that had left a platform the train had not reached went from 2-8% of the time to none; on-time running is unchanged. A train held at a platform can still leave on time on screen and wait at the next station, because the boards show the hold only 40-60 s later (docs/ALGORITHM.md §3h).
- Shell cache renamed `v28`.

## v0.7.5 — 2026-10-07 (`e30df5f`)
- Train card and keyboard: the card is rebuilt every second, so focus on any of its buttons (✕, the Run chip, "全日更份 ›", 跟隨) dropped back to the page within a second, and flipping the card with Enter or Space lost it at once. Focus now stays on the same button, or moves to the Run chip when "全日更份 ›" is no longer on the card. Mouse and touch use is unchanged.
- docs/DUTYSHEET.md no longer says the header line ends in "Duty Sheet" (gone since v0.7.4; the tooltip still names it). Shell cache renamed `v27`.

## v0.7.4 — 2026-10-07 (`c35a340`)
- Run-number switch (the orange dot left of the title) now also covers the train card. Switched on: the card's chip shows the train's Run number instead of ▲/▼, and the chip and "全日更份 ›" open the Run's duties for the day. Switched off: the chip is a plain ▲/▼ and the duty list is hidden (an open card on that page goes back to the train details). A train no timetable trip claims shows "–" on the chip, as on the diagram. The choice is still remembered after reloading.
- Header: the timetable line no longer ends in "· Duty Sheet" (e.g. "平日 · 繁忙 · 班距約 3.5 分"); its tooltip still names the Duty Sheet.
- Footer: the second line is now a disclaimer: "⚠免責聲明：本站列車位置為演算法推算之模擬數據，非港鐵官方即時定位。資料僅供參考，本站概不承擔任何責任。"
- The 繁 / EN switch is gone; the app is Chinese only. The diagram still shows each station's English name under the Chinese one. Shell cache renamed `v26`.

## v0.7.3 — 2026-10-07 (`86ae0e5`)
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
