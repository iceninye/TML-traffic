# NOTICE — 第三方授權

## 1. 推算引擎 + 網絡資料

本專案 `lib/mtr-*.js` 之下嘅列車位置推算引擎，以及 `data/tml-network.json` 嘅站序／座標／路綫資料，抽取自：

- **Repository**：https://github.com/keithligh/hk-traffic-intelligence
- **作者**：Keith Li
- **授權**：MIT License, Copyright (c) 2026 Keith Li

原文檔與對應抽取檔案：

| 上游檔案 | 本專案檔案 |
|---|---|
| `src/lib/mtr-estimate.ts` | `lib/mtr-estimate.js` |
| `src/lib/mtr-run.ts` | `lib/mtr-run.js` |
| `src/lib/mtr-schedule.ts` | `lib/mtr-schedule.js` |
| `src/lib/mtr-network.ts` + `data/mtr-network.json` | `lib/mtr-network.js` + `data/tml-network.json` |
| `src/lib/mtr-feed.ts` / `pool.ts` / `refresh-slice.ts` | `lib/mtr-feed.js` |

上游嘅地圖圖層象徵（`src/components/city-map.tsx`）亦作為 `assets/app.js` 地圖圖層嘅參考，未直接複製程式碼。

改動性質：TypeScript → 零依賴 ES module 移植；網絡資料由全部 10 條綫（98 站）收窄為**只保留屯馬綫**（27 站、2 條方向 route）。

v0.2.0 起有三處標明 `TML-traffic:` 嘅小改動：`mtr-estimate.js` 加咗 `setHopModel()`（用時間表站間時間串連各站倒數）、`mtr-schedule.js` 用 API 嘅 `time` 欄計秒級 `dueAt`、`mtr-feed.js` 將 `dueAtMs` 傳出。v0.3.0 再加：`mtr-estimate.js` / `mtr-feed.js` 將每班車串連到嘅所有讀數（`obs`）傳出。其餘邏輯維持原樣。

MIT 授權全文見上游 repo 的 `LICENSE`。使用或再分發時請保留本 NOTICE。

## 2. MapLibre GL JS（`lib/maplibre/`）

`lib/maplibre/` 之下四個檔案為 **MapLibre GL JS 6.12.0** 未修改副本，vendored 自 npm 發佈版本：

| 檔案 | 大小 | 來源 |
|---|---|---|
| `maplibre-gl.mjs` | 597,295 B | `https://cdn.jsdelivr.net/npm/maplibre-gl@6.12.0/dist/maplibre-gl.mjs` |
| `maplibre-gl-shared.mjs` | 516,951 B | 同上 |
| `maplibre-gl-worker.mjs` | 19,130 B | 同上 |
| `maplibre-gl.css` | 83,305 B | 同上 |

- **Repository**：https://github.com/maplibre/maplibre-gl-js
- **授權**：BSD 3-Clause License, Copyright (c) MapLibre contributors
- **無修改**：原封不動，只係搬去本地目錄以避免依賴第三方 CDN。

授權全文見上游 repo 的 `LICENSE.txt`。

## 3. 底圖及地圖資料

地圖視圖（可選）會即時向第三方 tile server 取資料，**本 repo 唔包含任何地圖圖磚**：

- **底圖圖磚 / 字型 / sprites**：OpenFreeMap（https://openfreemap.org）· `https://tiles.openfreemap.org/`
- **地圖資料**：© OpenStreetMap 貢獻者（ODbL）· https://www.openstreetmap.org/copyright

使用時必須保留上述標註（`assets/app.js` 會喺地圖角落顯示）。

## 4. 列車班次資料

- **來源**：香港特別行政區政府資料一線通 / 港鐵
  `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php`
- 該端點實測回應 `access-control-allow-origin: *`，可由瀏覽器直接查詢。
- 本專案**唔會**儲存或再分發班次資料，只喺瀏覽器即時顯示。

## 5. 免責

列車位置係**由到站倒數推算**，並非港鐵官方列車位置。港鐵並無發佈列車實時位置。
推算位置可能有 1–2 個站嘅偏差（見 `docs/EXTRACTION.md` §3.3）。請勿用於任何安全關鍵用途。

## 3. 屯馬綫走綫（`data/tml-track.json`）

`data/tml-track.json` 嘅路軌座標由 `tools/build_data.py` 從 **OpenStreetMap** relation
[6102298](https://www.openstreetmap.org/relation/6102298)（港鐵屯馬綫，下行）抽取、串接並簡化（Douglas–Peucker 6 m）。

- **© OpenStreetMap contributors**
- **授權**：Open Database License (ODbL) 1.0 — https://www.openstreetmap.org/copyright
- 地圖上已顯示署名。再分發此檔案須保留署名及 ODbL。
