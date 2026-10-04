# 屯馬綫資料抽取報告 (EXTRACTION)

**日期**：2026-10-04
**來源**：https://github.com/keithligh/hk-traffic-intelligence （MIT, (c) 2026 Keith Li）
**範圍**：只取 MTR **屯馬綫 (TML)**，其他交通工具（城巴／九巴／小巴／渡輪／輕鐵／路况）全部唔取。

---

## 1. 最重要嘅發現：港鐵冇公開列車位置

上游 repo 嘅核心價值唔係「拎到位置」，而係**由到站時間反推位置**。原文註釋（`mtr-estimate.ts` 開頭）講得好清楚：

> MTR publishes the minutes until a train reaches a station. It does not publish where that train is. A position is the countdown walked back along the station spacing: a short hop is about 43 km/h, a longer one about 65 km/h.

即係：

1. 逐個站問 `getSchedule.php`，拎到「下一班車幾分鐘後到」
2. 同一個實體車會喺**連續多個站**都出現 → 靠「到達時間差 ≈ 站距行車時間」串成一條 chain
3. Chain 最新嗰個觀察點做 anchor
4. 由 anchor **沿站距倒推** countdown，得到座標

**資料源**：`https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=TML&sta=<站>&lang=tc`
每站回傳 UP / DOWN 各最多 4 班，每 10 秒更新一次。**呢個係唯一實時來源。**

---

## 2. 抽取內容

### 2.1 靜態資料

| 檔案 | 內容 | 大小 |
|---|---|---|
| `data/tml-network.json` | 27 站（code / en / tc / lng / lat）+ 綫資料 (`#9A3B26`) + 2 條方向 route | 27 站 |
| `data/tml-segments.json` | 衍生：26 段站距（米）+ 推算行車分鐘 | 生成物 |

屯馬綫站序（TML-UT，烏溪沙 → 屯門）：

```
TUM SIH TIS LOP YUL KSR TWW MEF NAC AUS ETS HUH HOM TKW
SUW KAT DIH HIK TAW CKT STW CIO SHM TSH HEO MOS WKS
```

屯門 → 烏溪沙（TML-DT）為完全反向。**冇分支、冇環、冇共綫段**（呢點好重要，見 §4）。

### 2.2 推算引擎（`lib/`）

| 檔案 | 抽出嘅函數 | 作用 |
|---|---|---|
| `lib/mtr-estimate.js` | `metresBetween` | Haversine 距離 |
| | `segmentMinutes` | 站距 → 行車分鐘（<1500 m 用 12 m/s，否則 18 m/s，夾在 0.8–8 分鐘） |
| | `pathsToward` | 由 route 表砌出「往某終點站」嘅站序 |
| | `estimateTrains` | **主入口**：觀察值 → 串 chain → 出列車清單 |
| | `projectTrain` | **主入口**：列車 → 此刻座標 |
| | `carryArrivalClock` | ttnt 由 0 變回 0 時，保留原本到達時刻（避免倒數重置） |
| `lib/mtr-schedule.js` | `readSchedule` | API payload → board + observations |
| | `parseHongKongTime` | `YYYY-MM-DD HH:MM:SS` +08:00 → epoch |
| `lib/mtr-network.js` | `createNetwork` | TML 網絡存取（`point` / `name` / `queries` / GeoJSON 輸出） |
| `lib/mtr-feed.js` | `createFeed` | 輪詢：`refresh()` / `snapshot()` / `load()` |
| | `pool` | 併發上限 |
| | `oldestDue` / `fairLineReads` | 揀邊啲站要更新 |

### 2.3 關鍵參數（原封保留）

| 參數 | 值 | 用途 |
|---|---|---|
| `URBAN_SPEED_MPS` / `URBAN_METRES` | 12 m/s (< 1500 m) | 站距速度模型 |
| `OPEN_SPEED_MPS` | 18 m/s (≥ 1500 m) | 同上 |
| `MIN/MAX_SEGMENT_MIN` | 0.8 / 8 分鐘 | 夾住異常站距 |
| `HOP_TOLERANCE_MS` | 75,000 ms | **串 chain 容忍度**（過大 → 黏錯車；過細 → 同一班車拆散） |
| `ARRIVAL_DWELL_MIN` | 0.5 分鐘 | 到達後停留，之後先開始行下一段 |
| `ZERO_CLOCK_MAX_MS` | 4 分鐘 | `carryArrivalClock` 上限 |
| `STALE_MS` / `REMEMBER_MS` | 20 s / 180 s | 幾時重讀 / 幾時丟棄 |
| `REFRESH_SLICE` | 27（TML 全部站） | 每次更新幾多站 |
| `FETCH_LIMIT` | 4 | 併發 |
| 429 冷卻 / 失敗上限 | 45 s / 8 次 | 保護 data.gov.hk |

---

## 3. 實測結果（真實 API，未作假）

```
Tuen Ma Line probe · 1 pass · 27 station reads · 2848 ms
line: 屯馬綫 / Tuen Ma Line  color #9A3B26
boards received: 27 / 27          ← 全部站都答
trains estimated: 38              ← 18 往屯門 + 20 往烏溪沙
furthest projected train from any station: 4071 m
off-line projection detected: no
```

抽樣輸出（節錄）：

| dest | ttnt | anchor | 此刻位置 | 下一站 | 剩餘 |
|---|---|---|---|---|---|
| TUM | 1 | DIH | Hin Keng → Diamond Hill | 鑽石山 | 0.8 min |
| TUM | 5 | KSR | Tsuen Wan West → Kam Sheung Road | 錦上路 | 4.8 min |
| TUM | 1 | TIS | Long Ping → Tin Shui Wai | 天水圍 | 0.8 min |
| WKS | 1 | TUM | at Tuen Mun (origin) | 屯門 | 0.8 min |
| WKS | 3 | AUS | Mei Foo → Nam Cheong | 南昌 | 0.3 min |
| WKS | 8 | HUH | Tsuen Wan West → Mei Foo | 美孚 | 0.2 min |

**合理性檢查**（人手核對過）：
- 由 anchor 倒推行數站數 × 每段行車時間，**對得上** ttnt。例：anchor AUS / ttnt 12 min / 位置 HIK→DIH，中間 DIH→KAT→SUW→TKW→HOM→HUH→ETS→AUS 共 7 段 ≈ 12 min ✓
- 「4071 m」係列車身處**大欖隧道段（TWW↔KSR，8,807 m）**中間，屬正常，非 bug
- 38 班車係整條綫雙向總數；屯馬綫全程約 73–75 分鐘，繁忙時間班距 4–5 分鐘 → 單向 15–18 班，數目合理

### 3.1 已知限制（誠實記錄）

1. **行車時間模型偏快**：`segmentMinutes` 加總 = 57.3 分鐘（單向），但實際全程約 73–75 分鐘。模型**唔含停站時間**。後果：倒推位置會偏向 anchor 一側，位置誤差可能達 1–2 個站。上游靠 `mtr-run.ts`（`advanceRuns` / `mergeRuns`）做時間軸平滑補償，但**今次未抽取**（見 §5）。
2. **座標係站與站之間直線插值**，唔跟真實軌道走線。喺大欖隧道、馬鞍山段等彎多路段誤差較大。
3. **`seq` 唔係全綫列車 ID**，只係該站班次排序；所以同一班車喺唔同站嘅 `seq` 唔同，必須靠時間差串連。
4. **ttnt 只到整數分鐘**，位置解析度有限。
5. **`lang=tc` / `lang=en`** 會影響 `dest` 相關欄位？——實測 `dest` 一律係站碼，不受語言影響，站名要靠 `tml-network.json` 自己譯。

---

## 4. 屯馬綫特別簡單（好消息）

上游嘅 `HOP_TOLERANCE`、`hold`、`clamp`、`preferredPath`、`racecoursePaths` 等機制，全部係為咗應付：
- 東鐵綫**分叉**（羅湖 / 落馬洲 / 馬場）
- 多條綫**共用路段**（觀塘綫／荃灣綫過海後）
- 同一月台開出唔同終點站

**屯馬綫完全冇以上問題** — 一條直綫、兩個總站、冇分叉。所以：
- `chainObservations` 裡面嘅 `shared` 分支永遠唔會觸發
- `hold` / `clamp` 永遠係 `hold = shared = 全部 27 站`
- `intersection` / `dropSuffixPaths` / `scorePath` / `preferredPath` 全部係死代碼

👉 **可以大幅刪減**（待你決定）。保守估計 `mtr-estimate.js` 可以由 16 KB 削到 5–6 KB。

---

## 5. 未抽取 / 已放棄嘅部分

| 上游檔案 | 決定 | 原因 |
|---|---|---|
| `mtr-run.ts` | ⏸ **未抽，建議抽** | 時間軸平滑（`advanceRuns` / `mergeRuns`）+ 防重疊（`SAME_SPOT_M`）。對「動態圖」動畫流暢度有用 |
| `mtr-network.ts` GeoJSON 輸出 | ✅ 已抽（`createNetwork` 內） | `trackCollection` / `stationCollection` |
| `feed-cache.ts` / Cloudflare Worker cache | ❌ 唔抽 | 上游係 server-side；純前端唔需要 |
| `maplibre-gl` / `city-map.tsx` | ❌ 唔抽 | 上游用 MapLibre + React；本 app 未定視覺形式 |
| `opencc-js` | ❌ 唔抽 | 簡繁轉換，TML 站名已同時有 tc / en |
| 城巴／九巴／小巴／渡輪／輕鐵／路况／天氣警告／隧道／攝影機 | ❌ 唔抽 | 超出屯馬綫範圍 |
| `mtrTrackCollection` 嘅 `GeoJSON.FeatureCollection` 型別 | ➖ 改為純物件 | 零依賴，唔想引入 `@types/geojson` |

---

## 6. 檔案清單

```
TML-traffic/
├── NOTICE.md                 第三方授權聲明（必留）
├── docs/EXTRACTION.md        本文
├── data/
│   ├── tml-network.json      27 站 + 2 方向 route + 綫資料
│   └── tml-segments.json     26 段站距 + 行車時間（衍生）
├── lib/
│   ├── mtr-estimate.js       位置推算引擎（忠實移植）
│   ├── mtr-schedule.js       API payload 解析
│   ├── mtr-network.js        TML 網絡存取
│   └── mtr-feed.js           輪詢 + 記憶 + 冷卻
└── tools/
    ├── probe-tml.mjs         實時端對端驗證（node tools/probe-tml.mjs）
    └── build-segments.mjs    重新生成 tml-segments.json
```

## 7. 點驗證

```bash
node tools/probe-tml.mjs           # 人手可讀表格
node tools/probe-tml.mjs --json    # 機械可讀
node tools/probe-tml.mjs --en      # 英文站名
PASSES=2 node tools/probe-tml.mjs  # 第二 pass 應讀 0 站（20 s stale 生效）
node tools/build-segments.mjs      # 重建站距資料
```

## 8. 未做 / 待你決定

- [ ] 視覺形式（真地圖 vs 自製路綫圖）— 你話「你說的都不要」，等新指示
- [ ] 要唔要抽 `mtr-run.ts` 做動畫平滑
- [ ] 要唔要按 §4 削減死代碼
- [ ] App 功能：每站倒數 / 點站彈詳情 / 列車卡 / 延誤提示（你答「全部都要」）
