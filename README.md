# TML-traffic

**屯馬綫列車動態圖** — Tuen Ma Line live train diagram.

🔗 https://iceninye.github.io/TML-traffic/

港鐵**冇公開列車位置 API**，只公佈「下一班幾分鐘後到」。本專案由各站到站倒數
**反推列車位置**，引擎抽取自 [keithligh/hk-traffic-intelligence](https://github.com/keithligh/hk-traffic-intelligence)（MIT），
並收窄到**只做屯馬綫 27 站**。

## 兩個視圖

| | 說明 |
|---|---|
| **路綫圖**（預設） | 自製 SVG，27 站一屏直列，列車圓點沿軌道移動。零依賴、零 CDN、零 build step |
| **地圖**（可選） | MapLibre GL 6.12.0（自 host）+ OpenFreeMap 底圖，屯馬綫真實走綫。載入失敗會自動回落路綫圖 |

功能：每站雙向倒數 · 點站睇詳情 · 點列車睇列車卡 · 延誤提示 · 繁／英切換 · 暫停。

## 架構

**冇 build step。** 冇 bundler、冇 `npm install`、冇 build script。瀏覽器直接跑 ES module。

```
index.html
assets/app.css        手寫 CSS
assets/app.js         UI 層
assets/icon.svg
sw.js                 offline app shell
lib/mtr-*.js          抽取返嚟嘅推算引擎
lib/maplibre/*.mjs    vendored MapLibre GL 6.12.0（1.2 MB，lazy load）
data/tml-*.json       27 站 + 26 段站距
```

## 本地跑

```bash
python3 -m http.server 8790 --bind 127.0.0.1
# 開 http://127.0.0.1:8790/
```

## 驗證

```bash
node tools/probe-tml.mjs     # 列車位置
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

- [`docs/APP.md`](docs/APP.md) — App 層：視覺形式決定 (B4)、架構、實測、已知取捨、手動檢查清單
- [`docs/EXTRACTION.md`](docs/EXTRACTION.md) — 引擎抽取報告：反推機制、常數、驗證數字
- [`NOTICE.md`](NOTICE.md) — 第三方授權

## 授權

`lib/mtr-*.js` 及 `data/tml-network.json` 抽取自 MIT 授權專案；`lib/maplibre/` 為 BSD-3-Clause。
見 [`NOTICE.md`](NOTICE.md)。
