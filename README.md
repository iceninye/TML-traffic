# TML-traffic

**屯馬綫列車動態圖** — Tuen Ma Line live train diagram.

🔗 **https://tml-traffic.iceninye.workers.dev**（Cloudflare Workers；GitHub Pages 備用：https://iceninye.github.io/TML-traffic/）

目前版本 v0.7.6，每版改動見 [`CHANGELOG.md`](CHANGELOG.md)。

港鐵**冇公開列車位置 API**，只公佈「下一班幾分鐘後到」。本專案由各站到站倒數
**反推列車位置**，引擎抽取自 [keithligh/hk-traffic-intelligence](https://github.com/keithligh/hk-traffic-intelligence)（MIT），
並收窄到**只做屯馬綫 27 站**。

## 兩個視圖

| | 說明 |
|---|---|
| **路綫圖**（預設） | 自製 SVG，**上行（往屯門，橙）／下行（往烏溪沙，藍）兩條軌**；站距按實際軌道里程拉開（大欖隧道 8.93 km 最長），每段標距離同行車時間 |
| **地圖**（可選） | MapLibre GL 6.12.0（自 host）+ OpenFreeMap 底圖；**OpenStreetMap 真實走綫**，上下行兩色並排，列車貼住自己方向嗰條綫 |

功能：雙軌路綫圖（上行橙、下行藍，站距按實際里程）· 地圖按真實比例畫 8 卡列車（灰白車身、白邊、車頭兩盞白燈、車尾兩盞紅燈）沿 OSM 路軌行駛 · 列車慢 60 秒以上變紅並標示「- 75s」，180 秒以上紅色閃爍 · 每站雙向倒數 · 點站睇詳情 · 點列車睇列車卡（車次、前方各站推算到站時間）· 撳標題左邊橙點開／關 Run 編號（會記住；開咗先見列車卡左上角 Run 編號同「全日更份 ›」，撳任何一個睇嗰架車全日更份）· L 尾程（之後回廠）列車淡色 70% · 跟隨列車 · 時段／班距標示 · 轉綫站標示 · 港鐵延誤提示 · 港鐵特別車務通告（API 暫停提供班次時顯示港鐵原文同連結；連唔到時講原因）· 暫停 · 離線殼層。版本紀錄見 [`CHANGELOG.md`](CHANGELOG.md)。

## 位置演算法

完整流程同實測見 [`docs/ALGORITHM.md`](docs/ALGORITHM.md)。每個 API 讀數對應官方工作時間表
（TML1100B / TML6090A / TML7090）上嘅一班車，由該班車所有讀數求出延誤，位置 = 該班車時間表 + 延誤。
實測發現 API 嘅「N 分鐘」係向上取整（即 N−1 至 N 分鐘內到站），修正後預測中位誤差由 39 秒降到 16 秒，
同 API 一致性由 57% 升到 90%；由車廠開出、短程車、總站折返亦按時間表處理。
今日行邊份時間表由 API 讀數自動判斷（公眾假期會自動用星期日時間表）。

## 位置模型

按[車務數據分析報告](docs/MODEL.md)校正：時間表站間行車時間（繁忙／非繁忙）、停站時間、S 曲線加減速、秒級到站時間、
新舊快照之間軟性糾偏（唔會跳位、唔會倒行）。全程由 57 分鐘（v0.1）改正為 73.9 分鐘，同實際 73–75 分鐘吻合。

## 架構

**冇 build step。** 冇 bundler、冇 `npm install`、冇 build script。瀏覽器直接跑 ES module。

```
index.html
assets/app.css        手寫 CSS
assets/app.js         UI 層（雙軌路綫圖、雙色地圖、列車卡）
assets/icon.svg
sw.js                 offline app shell（改版要改 cache 名）
wrangler.jsonc        Cloudflare Workers 靜態資源設定（根目錄即網站）
.assetsignore         部署時略過嘅檔案
lib/mtr-*.js          抽取返嚟嘅估算引擎（串連各站倒數 → 列車）
lib/tml-model.js      時間表位置模型（行車 + 停站 + S 曲線 + 時段）
lib/tml-timetable.js  時間表對應：讀數 → 班次 → 延誤 → 位置
lib/tml-motion.js     追蹤 + 列車時鐘平滑
lib/maplibre/*.mjs    vendored MapLibre GL 6.12.0（1.2 MB，lazy load）
data/tml-network.json 27 站
data/tml-timetable.json 站距 / 行車 / 停站 / 時段（tools/build_data.py 生成）
data/tml-track.json   OSM 真實走綫（tools/build_data.py 生成，ODbL）
data/timetables/       工作時間表（index.json 清單 + 每份一個 <代號>.json）
tools/                資料解析、驗證同 probe 腳本
docs/                 演算法、模型、App 設計文件
```

## 本地跑

```bash
python3 -m http.server 8790 --bind 127.0.0.1
# 開 http://127.0.0.1:8790/
```

## 新增／更新時間表

港鐵出新版或特別時間表（PDF）時：

```bash
pip install pdfplumber
python3 tools/parse_timetables.py 新時間表.pdf
```

工具會解析 PDF → 執行 `tools/validate_timetable.py`（站序、時間唔倒退、首尾班車、總站 Run 接續、A 部 26 段、班距表）→
**通過先**寫入 `data/timetables/<代號>.json` 同登記喺 `data/timetables/index.json`；唔通過唔會加入。
App 會自動讀清單，唔使改程式。
清單分 `normal`（平日／星期六／星期日正常班）同 `special`（活動、颱風等特別班，由 PDF 第一頁「Special」判斷）：
正常班先載入；只有當正常班同月台讀數唔夾（夾度 < 70%）先會載入特別班逐份試，夾得明顯好過（高 25% 以上）就轉用，
全部都唔夾就轉去「只用倒數」模式。檔案格式見 `tools/parse_timetables.py` 開頭說明同 `docs/ALGORITHM.md` §3e。

### 用 Duty Sheet 更新（時間表 PDF 未出時）

營運端拎到最新 Duty Sheet（司機更表）但官方時間表 PDF 未出時：

```bash
python3 tools/parse_dutysheet.py DutySheet.pdf            # 自動揀同日類型、日期最近嘅時間表做底
python3 tools/parse_dutysheet.py DutySheet.pdf --dry-run  # 只檢查，唔寫檔
```

Duty Sheet 係司機更表，只有每班車嘅 Run、更份編號、總站開出時間、錦上路／大圍接班時間同到站分鐘，**冇逐站時間、冇車次號**。
底表已有嘅班次沿用官方逐站時間同車次號，再加上更份編號；底表冇嘅班次由最近嘅班次重建中間各站（誤差中位數約 3–10 秒、P90 約 15–47 秒），開出時間準確。
通過 `tools/validate_dutysheet.py` 先寫 `data/timetables/DS<代號>.json` 同登記；輸出只有 Run、更份編號、方向同時間，
冇司機姓名、備註、上下班等人手資料；Duty Sheet PDF 本身唔入 repo（`.gitignore` 已排除 `*.pdf`）。如果同底表一模一樣（底表時間更準），就唔寫檔。
App 只會優先用「生效日已到、比底表新而且有差異」嘅 Duty Sheet（`index.json` 入面 `primary: true`），時段列嘅提示（滑鼠停喺「平日 · 繁忙 · 班距」嗰行）會註明來源 Duty Sheet。
詳見 `docs/DUTYSHEET.md`。

## 重建資料

```bash
python3 tools/build_data.py              # 時間表 + 由 Overpass 攞 OSM 走綫
python3 tools/build_data.py --no-track   # 只重建時間表
```

## 部署同發佈

- 網站：Cloudflare Workers 靜態資源（`wrangler.jsonc`），`main` 更新後由 Cloudflare 自動建置；`gh-pages` 分支嘅 GitHub Pages 為備用。
- 發佈新版要同時改三處：`assets/app.js` 嘅 `BUILD`（version、commit）、`CHANGELOG.md` 最新一項、`sw.js` 嘅 `tml-traffic-shell-vNN` cache 名（令已安裝嘅用戶換走舊殼層）。
- 本地檢查 Workers 設定：`npx wrangler deploy --dry-run`。

## 驗證

```bash
node tools/probe-tml.mjs     # 列車位置（v0.1 引擎）
node tools/probe-runs.mjs    # 動畫層平滑度
node tools/validate_matching.mjs   # 延誤情境下嘅班次對應（合成讀數）
node tools/validate_position.mjs   # 被扣列車嘅列車點位置（合成讀數）
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

- [`CHANGELOG.md`](CHANGELOG.md) — 版本紀錄
- [`docs/ALGORITHM.md`](docs/ALGORITHM.md) — 位置演算法完整流程、延誤計法、準確度實測
- [`docs/DUTYSHEET.md`](docs/DUTYSHEET.md) — Duty Sheet 格式同解析器
- [`docs/MODEL.md`](docs/MODEL.md) — 位置模型：資料來源、算法、實測數字、已知限制
- [`docs/APP.md`](docs/APP.md) — App 層：視覺形式決定 (B4)、架構、實測、已知取捨、手動檢查清單
- [`docs/EXTRACTION.md`](docs/EXTRACTION.md) — 引擎抽取報告：反推機制、常數、驗證數字
- [`NOTICE.md`](NOTICE.md) — 第三方授權

## 資料同私隱

公開資料只有 Run 編號、時間同更份編號；唔包含司機姓名或其他人手資料。列車位置係由港鐵公開嘅下一班倒數反推，非官方資料，只供參考。

## 授權

原創程式碼為 MIT（見 [`LICENSE`](LICENSE)）；`lib/mtr-*.js` 及 `data/tml-network.json` 抽取自 MIT 授權專案；`data/timetables/` 源自港鐵，不在 MIT 範圍內；`lib/maplibre/` 為 BSD-3-Clause；`data/tml-track.json` © OpenStreetMap contributors（ODbL）。
見 [`NOTICE.md`](NOTICE.md)。
