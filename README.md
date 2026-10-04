# TML-traffic

**屯馬綫列車動態圖** — Tuen Ma Line live train diagram.

🔗 https://iceninye.github.io/TML-traffic/

港鐵**冇公開列車位置 API**，只公佈「下一班幾分鐘後到」。本專案由各站到站倒數
**反推列車位置**，引擎抽取自 [keithligh/hk-traffic-intelligence](https://github.com/keithligh/hk-traffic-intelligence)（MIT），
並收窄到**只做屯馬綫 27 站**。

## 兩個視圖

| | 說明 |
|---|---|
| **路綫圖**（預設） | 自製 SVG，**上行（往屯門，橙）／下行（往烏溪沙，藍）兩條軌**；站距按實際軌道里程拉開（大欖隧道 8.93 km 最長），每段標距離同行車時間 |
| **地圖**（可選） | MapLibre GL 6.12.0（自 host）+ OpenFreeMap 底圖；**OpenStreetMap 真實走綫**，上下行兩色並排，列車貼住自己方向嗰條綫 |

功能：每站雙向倒數 · 點站睇詳情 · 點列車睇列車卡（前方各站推算到站時間）· **跟隨列車** · 時段／班距標示 · 轉綫站標示 · 延誤提示 · 繁／英切換 · 暫停。

## 位置模型（v0.2）

按[車務數據分析報告](docs/MODEL.md)校正：時間表站間行車時間（繁忙／非繁忙）、停站時間、S 曲線加減速、秒級到站時間、
新舊快照之間軟性糾偏（唔會跳位、唔會倒行）。全程由 57 分鐘（v0.1）改正為 73.9 分鐘，同實際 73–75 分鐘吻合。

## 架構

**冇 build step。** 冇 bundler、冇 `npm install`、冇 build script。瀏覽器直接跑 ES module。

```
index.html
assets/app.css        手寫 CSS
assets/app.js         UI 層（雙軌路綫圖、雙色地圖、列車卡）
assets/icon.svg
sw.js                 offline app shell
lib/mtr-*.js          抽取返嚟嘅估算引擎（串連各站倒數 → 列車）
lib/tml-model.js      時間表位置模型（行車 + 停站 + S 曲線 + 時段）
lib/tml-motion.js     動畫層（身份追蹤 + 軟性糾偏）
lib/maplibre/*.mjs    vendored MapLibre GL 6.12.0（1.2 MB，lazy load）
data/tml-network.json 27 站
data/tml-timetable.json 站距 / 行車 / 停站 / 時段（tools/build_data.py 生成）
data/tml-track.json   OSM 真實走綫（tools/build_data.py 生成，ODbL）
```

## 本地跑

```bash
python3 -m http.server 8790 --bind 127.0.0.1
# 開 http://127.0.0.1:8790/
```

## 重建資料

```bash
python3 tools/build_data.py              # 時間表 + 由 Overpass 攞 OSM 走綫
python3 tools/build_data.py --no-track   # 只重建時間表
```

## 驗證

```bash
node tools/probe-tml.mjs     # 列車位置（v0.1 引擎）
node tools/probe-runs.mjs    # 動畫層平滑度
node --check assets/app.js   # 無 bundler，逐檔 parse
```

實測輸出（2026-10-04）：

```
probe-tml : 27 station reads · 2848 ms
            boards 27/27 · trains 38 · off-line projection: no

probe-runs: snapshot 1/2 -> 37 runs each, tracked 37, dropped 0
            dot jump on new snapshot:
              no animation layer : median 20 m · max 216 m
              mergeRuns          : median 0 m · max 0 m
            advanceRuns travel over 12 s: 216 m (model says ~216 m at 18 m/s)
```

瀏覽器實測（Chromium 390×844, dark）：站牌 27/27、列車點全部貼住路軌、
點站／點車彈窗正常、地圖 pane 出 canvas、view 記入 localStorage 並正確還原。

## 文件

- [`docs/MODEL.md`](docs/MODEL.md) — v0.2 位置模型：資料來源、算法、實測數字、已知限制
- [`docs/APP.md`](docs/APP.md) — App 層：視覺形式決定 (B4)、架構、實測、已知取捨、手動檢查清單
- [`docs/EXTRACTION.md`](docs/EXTRACTION.md) — 引擎抽取報告：反推機制、常數、驗證數字
- [`NOTICE.md`](NOTICE.md) — 第三方授權

## 授權

`lib/mtr-*.js` 及 `data/tml-network.json` 抽取自 MIT 授權專案；`lib/maplibre/` 為 BSD-3-Clause；`data/tml-track.json` © OpenStreetMap contributors（ODbL）。
見 [`NOTICE.md`](NOTICE.md)。
