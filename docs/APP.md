# App 層 (APP)

**日期**：2026-10-04
**視覺形式決定**：**B4 混合** —— 預設自製 SVG 路綫圖，可選真地圖，地圖失敗自動回落。

---

## 1. 點解係 B4（唔係淨跟上游）

上游 `city-map.tsx` 用 MapLibre GL + React 19 / Next 16 打真地圖。查證之後，風險唔喺 MapLibre，而喺**底圖供應商**：

| 元件 | 實測結果 | 風險 |
|---|---|---|
| **MapLibre GL JS** | Linux Foundation 旗下、有 elected Governing Board、資金來自 Amazon / Meta / Microsoft / StadiaMaps / Elastic、1.0(2021)→6.12.0(現行) 穩定發版 | 低 |
| **OpenFreeMap** | 已上 Cloudflare（`cf-ray: ...-HKG` 香港 edge）、HK z12 tile 304 KB / 0.124 s、資源集中單一 host、每週更新 tile、**但一人維護靠捐款、冇 SLA** | 中 |
| **Esri 衛星底圖** | 技術正常，但 Esri 條款講明唔可以 commercial use、禁止 systematic harvest | 中（法務） |
| **MapLibre v6** | **只出 ESM，冇 UMD** —— `dist/maplibre-gl.js` 喺 unpkg 同 jsdelivr 都 404 | 低（可自 host） |

加上上游自己都寫咗 `isGpuFailure()` / `GPUInitializationError` / `gpuFailed`，即係作者本身都當「地圖有機會開唔到」。

**所以：路綫圖做預設（永遠開得到），地圖做選項（開唔到就回落，唔會白畫面）。**

---

## 2. 架構：零 build step

冇 bundler、冇 npm install、冇 build script。瀏覽器直接跑 ES module。

```
index.html                 markup
assets/app.css            手寫 CSS（無 Tailwind build）
assets/app.js             UI 層（state / 動畫 / 兩個 renderer / 彈窗）
assets/icon.svg           favicon
sw.js                     offline app shell（只 cache 同源 GET）
lib/mtr-*.js              抽取返嚟嘅引擎（唔改）
lib/maplibre/*.mjs        vendored MapLibre GL 6.12.0
data/tml-*.json           靜態資料
```

`app.js` 直接 `import` 引擎檔：

```js
import { advanceRuns, cumulative, mergeRuns, placeRun, runsFromTrains } from "../lib/mtr-run.js"
```

### 兩個 renderer，同一份 state

`state.runs` 係唯一真相。`loop()` 每 frame 用 `advanceRuns(runs, dt, locate)` 推進位置：

- `view === "diagram"` → `syncTrains()`，每 frame 更新 SVG 上嘅 transform
- `view === "map"` → 每 **1.2 s** 才 `paintMap()` 一次（每 frame 寫 GeoJSON 只係燒 CPU）

列車身份靠 `run.id`，所以兩個 view 之間切換唔會令圓點跳位。

---

## 3. 路綫圖 (diagram)

> **v0.2 更新（2026-10-04）**：改為雙軌。左軌 = 上行往屯門（橙 `--up`），右軌 = 下行往烏溪沙（藍 `--down`），
> 每個站係橫跨兩軌嘅月台膠囊。站距 = `max(62 px, 24 px × 軌道 km)`，全圖約 1.9k px；
> 每段中間標「距離 · 行車時間」，大欖隧道加虛框。列車只喺自己方向嗰條軌上移動，疊埋時沿軌錯開 21 px。
> 短程車用虛線圈；延誤用黃框；候發（未開出）半透明。點列車開「列車卡」（唔遮擋路綫圖），
> 列出前方各站推算到站時間，可「跟隨」自動捲動。位置模型見 [`MODEL.md`](MODEL.md)。
> 以下係 v0.1 原文，保留作記錄。

屯馬綫係一條直綫、冇分叉，所以示意圖最清楚。27 站由上（屯門）到下（烏溪沙），每行：

```
● 站名             ← 往屯門倒數   ← 往烏溪沙倒數
```

- **座標軸**：用 `axisPosition(run)` 將引擎嘅「距離（米）」映射成「站單位」（0 = 屯門，26 = 烏溪沙）。因為站距差別極大（701 m ↔ 8,807 m 大欖隧道），一定要沿 segment 做 fraction 插值，唔可以直接按米數平分。
- **方向標題**：放喺 sticky header（`.col-legend`），因為捲到中間時 SVG 內嘅標題會走失。
- **列車標記**：白邊深紅圓點，內裡 ↑（往屯門）/ ↓（往烏溪沙）。**永遠貼住路軌**；如果兩個標記會疊（同一隧道／站外排隊），就**沿軌道**上下錯開 15 px，唔會橫向飄出去。
- **延誤**：有 `board.message` 或任何 `train.delay` 就出 banner。

### 互動

| 動作 | 結果 |
|---|---|
| 點站名／站點 | bottom sheet：兩個方向各 4 班，含月台、預定/實時、延誤 |
| 點列車圓點 | 列車卡：目的地、現時位置（A → B）、最近一站倒數、車速、月台 |
| 標題左邊橙點 | 開／關 Run 編號（記入 localStorage）；開咗先會喺列車卡左上角顯示 Run 編號同「全日更份 ›」 |
| 暫停 | 停止輪詢同動畫推進，保留畫面 |
| 路綫圖 / 地圖 | 切換 view，記入 localStorage |

`prefers-reduced-motion` 會停用 sheet 過場。

---

## 4. 地圖 (map)

> **v0.2 更新**：走綫改用 OSM relation 6102298 真實路軌（`data/tml-track.json`）。同一條 LineString 畫兩次，
> 用 `line-offset` 分開：下行（藍）喺行車方向左邊、上行（橙）喺右邊（港鐵靠左行車）。
> 列車點用同樣嘅像素偏移計返經緯度（隨 zoom 重算），所以永遠貼住自己方向嗰條綫。站點吸附到路軌上。
> 點列車開列車卡；「跟隨」會 `easeTo` 跟住列車，拖動地圖即取消。

MapLibre GL 由 **本地 `lib/maplibre/`** 載入（唔靠 CDN），底圖用 OpenFreeMap：

- 深色主題 → `styles/dark`；淺色主題 → `styles/bright`
- `setWorkerUrl()` 指向本地 worker（因為 v6 用獨立 worker chunk）
- CSS lazy 注入：只有真正開地圖先加 `<link>`，唔會拖慢預設路綫圖
- `fitBounds()` 用 27 站經緯度自動框住條綫，唔寫死 center/zoom
- 圖層完全照上游 6 層象徵：casing → track（`#9A3B26`）→ stations → station labels → trains → train labels
- 點站點開同一個 bottom sheet（兩個 view 行為一致）

### Vendored 檔案（維護時要知）

| 檔案 | 大小 | sha256（前 16） |
|---|---|---|
| `maplibre-gl.mjs` | 597,295 B | `8e0545d1042293cb` |
| `maplibre-gl-shared.mjs` | 516,951 B | `df3d0b4ba965ebaf` |
| `maplibre-gl-worker.mjs` | 19,130 B | `1ecca7178f0a496b` |
| `maplibre-gl.css` | 83,305 B | `8456072adc2cbf04` |

來源：`https://cdn.jsdelivr.net/npm/maplibre-gl@6.12.0/dist/`，BSD-3-Clause。import 關係：`maplibre-gl.mjs` 同 `maplibre-gl-worker.mjs` 都 `from "./maplibre-gl-shared.mjs"`，所以**三個檔一定要同一個目錄**。

### Fallback 鏈

```
user 切去地圖
  └─ import lib/maplibre/maplibre-gl.mjs
       ├─ 失敗（檔案缺失 / 瀏覽器唔支援 module）→ 回落路綫圖
       └─ 成功 → new Map()
            ├─ 25 s 內冇 "load" → 回落路綫圖
            ├─ error 含 webgl/context/gpu/initialize → 回落路綫圖
            └─ load 成功 → 裝圖層，之後 tile 404 只會局部爛，唔會收工
```

回落時：顯示 `.map-fallback` 提示、自動切回路綫圖、`localStorage` 改回 `diagram`，**唔會白畫面**（呢個係上游冇嘅保險）。

---

## 5. 實測記錄（2026-10-04）

### CORS — 瀏覽器可唔可以直接打港鐵 API

```
GET https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=TML&sta=TUM&lang=tc
  Origin: https://iceninye.github.io
→ access-control-allow-origin: *
```

→ **`*`，所以 GitHub Pages 可以直接 fetch，唔需要 proxy。**
`Accept: application/json` 屬 CORS safelisted header，唔會觸發 preflight。

### 底圖供應商

```
styles/bright    200  48,713 b  0.110 s
styles/liberty   200  43,079 b  0.100 s
styles/positron  200  25,153 b  0.134 s
styles/dark      200  20,959 b  0.109 s      ← 深色主題用
styles/fiord     200  22,234 b  0.100 s
tiles.openfreemap.org  →  server: cloudflare, cf-cache-status: HIT, cf-ray: ...-HKG
```

### 瀏覽器實測（Chromium 390×844, deviceScaleFactor 2, DPR, dark）

| 檢查 | 結果 |
|---|---|
| 首次載入（27 站） | 站牌 27/27、`41 班車 · 27 站`、狀態燈綠 |
| 路綫圖行數 | 27 行，唔多唔少 |
| 列車標記 | 全部 x = 32（貼住路軌），零橫向偏移 |
| 倒數欄 | 兩欄正常，`即將` 用綠色，終點站顯示「總站」 |
| 點站彈窗 | 何文田 → 往屯門 5/11/17/23 分 月台 3、往烏溪沙 即將/5/11/17 分 月台 4 |
| 列車卡 | 烏溪沙方向 · 屯門 → 兆康 · 最近一站 1.6 分 · 65 km/h · 月台 2 |
| 英文模式 | 標題／方向／單位全切；最長站名 `East Tsim Sha Tsui` = 122 px < 可用 164 px |
| 地圖 pane | canvas 出現、fitBounds 框住全綫、6 層圖層、站名標籤 zoom ≥ 11 出現 |
| 地圖點站 | 點荃灣西站點 → 同一個 bottom sheet |
| **view 還原** | 記住 `map` → reload 後仍然係地圖；切回路綫圖 → 27 行 + 33 列車點 |
| Console | 只有一個無害警告：`Image "wood-pattern" could not be loaded`（OpenFreeMap dark style 自帶，唔影響） |

---

## 6. 已知取捨

1. **`lib/maplibre/` 有 1.2 MB vendored 程式** —— 換嚟「冇 CDN 喺 critical path」。路綫圖唔會載入佢（lazy import），所以首次見到路綫圖嘅成本唔受影響。
2. **路綫圖要捲** —— 27 行 × 44 px ≈ 1.19 k px，手機一屏睇唔完。呢個係換取字級可讀性；強行塞入一屏會令字細到睇唔清。
3. **絕對位置誤差** —— 模型全程 57.3 min，實際 73–75 min（缺停站時間），所以倒推位置可能偏 anchor 一側 1–2 個站。`mtr-run.js` 只做 frame 之間嘅平滑，**唔會修正絕對偏差**。
4. **底圖靠外部 tile server** —— 呢個係 B4 唯一保留嘅外部依賴，而且只影響可選嘅地圖 view。
5. **唔改 commit message** —— 改咗會令 gh-pages parity 嘅 tree 對唔上。

---

## 7. 手動檢查清單（冇 build script，所以靠手動）

```bash
# 1. 起本地 server
python3 -m http.server 8790 --bind 127.0.0.1

# 2. 開 http://127.0.0.1:8790/  → 應該 3 秒內出 27 行 + 列車點
# 3. 點站名 → 彈窗；點列車點 → 列車卡；撳橙點 → 列車點同列車卡顯示 Run 編號
# 4. 切地圖 → 應該出真地圖；再切回路綫圖 → 列車點仍然貼住路軌

# 5. 語法檢查（無 bundler，所以逐檔 parse）
node --check assets/app.js
node --check lib/mtr-estimate.js
node --check lib/mtr-run.js

# 6. 引擎仍然正常
node tools/probe-tml.mjs
node tools/probe-runs.mjs

# 7. HTML / CSS 冇漏 id（app.js 靠 getElementById）
grep -oE 'getElementById\("[a-z-]+"\)' assets/app.js | sort -u
```

**踩過嘅坑（避免重犯）：**

- `els.title.textContent = ...` 會**清空 `<h1>` 內嘅 `<small id="sub">`** → 副標題消失。標題同副標題必須係 sibling，唔可以巢狀。
- `localStorage` 還原咗 `state.view` 但冇同步 pane → 顯示路綫圖、程式以為喺 map mode，`syncTrains()` 永遠唔跑（**畫面完全冇列車點，但冇任何 error**）。任何「還原狀態」都要即刻套用到 DOM。
- `buildDiagram()` 喺 pane 隱藏時量到寬度 0 → 唔可以拿 fallback 寬度去重建（會把錯寬度焊死）。
