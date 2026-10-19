# 設定、部署同發佈

本專案係純靜態網站：**冇 `package.json`、冇 build step、冇 bundler**，瀏覽器直接跑 ES module。
所以「設定」只係三件事：本機預覽、部署到 Cloudflare Workers（GitHub Pages 備用）、同發佈新版時改三處。

## 1. 本機預覽

需要 Python 3（只用佢嘅內置 HTTP server）：

```bash
python3 -m http.server 8790 --bind 127.0.0.1
# 開 http://127.0.0.1:8790/
```

注意：

- 要用 HTTP server，直接開 `index.html`（`file://`）會因 ES module 同 `fetch` 載入資料失敗。
- 實時班次直接由瀏覽器向 `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php` 攞（該端點允許跨域），本機同線上一樣；網絡連唔到就會顯示原因（逾時、HTTP 狀態、網絡錯誤）。
- 註冊咗 service worker（`sw.js`），改完檔案後如果見到舊畫面，開發者工具 → Application → Service Workers 撳 Unregister，或者硬重新整理。
- 逐檔語法檢查：`node --check assets/app.js`（其他 `lib/*.js` 同理）。

可選工具嘅環境：

| 用途 | 需要 |
|---|---|
| `tools/*.mjs` 驗證腳本 | Node.js（內置 ES module，唔使 `npm install`） |
| 解析 Duty Sheet PDF／Excel、時間表 PDF | Python 3 + `pip install pdfplumber openpyxl` |
| 檢查 Workers 設定 | `npx wrangler`（第一次會自動下載） |

## 2. 部署到 Cloudflare Workers（主要網站）

網站以 Workers **靜態資源**（static assets）形式發佈，根目錄就係網站。設定喺 [`wrangler.jsonc`](../wrangler.jsonc)：

| 欄位 | 值 | 作用 |
|---|---|---|
| `name` | `tml-traffic` | Worker 名，決定網址 `https://tml-traffic.<帳戶子網域>.workers.dev` |
| `compatibility_date` | `2026-10-01` | Workers runtime 兼容日期 |
| `assets.directory` | `.` | 將 repo 根目錄當作網站 |
| `previews` | `{}` | 預覽部署用（`wrangler preview` 需要有呢個區塊） |

根目錄入面唔應該公開嘅檔案寫喺 [`.assetsignore`](../.assetsignore)（`.git`、`tools`、`docs`、`*.md`、`wrangler.jsonc` 等），部署時會略過。

### 用 Cloudflare Workers Builds 自動部署

1. 登入 Cloudflare dashboard → **Workers & Pages** → **Create** → 揀 **Import a repository**，授權 GitHub 並揀 `iceninye/TML-traffic`。
2. Worker 名要同 `wrangler.jsonc` 嘅 `name` 一致（`tml-traffic`）。
3. **Build command** 留空（冇 build step）。**Deploy command** 要用得 `wrangler.jsonc`：現時用 `npx wrangler preview`（所以設定檔要有 `previews` 區塊）；改用 `npx wrangler deploy` 亦可。
4. 之後 `main` 有更新就會自動部署；PR 會有 `Workers Builds: tml-traffic` 檢查。建置錯誤只喺 Cloudflare dashboard 睇得到，唔喺 GitHub。

### 手動部署／本機檢查

```bash
npx wrangler deploy --dry-run   # 只驗證設定同打包，唔會上載
npx wrangler deploy             # 真正部署（要先 npx wrangler login）
```

`--dry-run` 成功會印出 `--dry-run: exiting now.`。

## 3. GitHub Pages（備用）

備用網址：`https://iceninye.github.io/TML-traffic/`。

- 發佈來源係 `gh-pages` 分支（repo → **Settings → Pages** → Source 揀 *Deploy from a branch*，分支 `gh-pages`，資料夾 `/ (root)`）。
- 因為網站係純靜態，`gh-pages` 放嘅就係 `main` 根目錄檔案，冇需要 build（分支內容由持有人手動同步，唔會自動跟 `main`）。
- GitHub Pages 同 Workers 係兩個獨立部署，改版後兩邊都要更新先會一致。
- 如果 repo 轉做私人，免費帳戶嘅 GitHub Pages 會停，到時要移除 README 嘅備用連結。

## 4. 發佈新版：版本號要改三處

1. `assets/app.js` 嘅 `BUILD`：`{ version, commit }`
2. `CHANGELOG.md` 最上面嘅新一項（標題 `## vX.Y.Z — 日期 (`commit`)`）
3. `sw.js` 嘅 `CACHE`（`tml-traffic-shell-vNN`，加一）：令已安裝嘅用戶換走舊殼層

頁腳顯示 `vX.Y.Z · commit …`，來自 `BUILD`。`commit` 係該版 release commit 嘅短 hash，所以流程係：先 commit 改動，再用新 commit hash 補返 `BUILD` 同 `CHANGELOG`（release PR 慣例係再推一個「stamp the commit in the footer」commit）。

只改文件（例如本目錄）**唔需要**改版本號。同一時間只應該有一個 release PR 改呢三處，否則會撞版本。

## 5. 驗證腳本

全部喺 repo 根目錄跑：

| 指令 | 檢查咩 | 需要網絡 |
|---|---|---|
| `node --check assets/app.js` | 語法 | 否 |
| `node tools/validate_matching.mjs` | 延誤情境下嘅班次對應（合成讀數） | 否 |
| `node tools/validate_position.mjs` | 被扣列車嘅列車點位置（合成讀數） | 否 |
| `node tools/validate_duties.mjs` | 更份卡片資料同當值判斷（用 `data/duties/` 真資料） | 否 |
| `node tools/validate_feed_errors.mjs` | 連唔到班次 API 時錯誤原因分類 | 否 |
| `node tools/probe-tml.mjs` | 對實時 API 做一次完整讀取（`--json` 機讀） | **是** |
| `node tools/probe-runs.mjs` | 動畫層平滑度 | 否 |
| `python3 tools/validate_timetable.py data/timetables/TML1100B.json` | 單份時間表（站序、時間唔倒退、首尾班、Run 接續…）；通過 exit 0 | 否 |
| `python3 tools/validate_dutysheet.py data/timetables/DS8022.json` | 單份 Duty Sheet 時間表 | 否 |

`validate_matching`、`validate_duties` 等失敗時會喺輸出標 `✗` 並以非 0 結束。`probe-tml.mjs` 喺連唔到 `rt.data.gov.hk` 嘅環境（例如受限沙盒）會印 `FEED FAILED`，唔代表程式有錯。
`tools/validate_timetable.py`、`validate_dutysheet.py` 通常唔使手動跑：`parse_timetables.py`／`parse_dutysheet.py` 寫檔前會自動跑。

## 6. 已知限制

- **用 VPN／代理（例如 Shadowrocket）時要將 `data.gov.hk` 設為直連。** 班次 API `rt.data.gov.hk` 係香港政府伺服器，經海外節點或被攔截會逾時或「網絡錯誤」。App 無法改變裝置點樣解析或轉發請求，真正解法喺代理設定入面：將 `data.gov.hk`（至少 `rt.data.gov.hk`）設為 DIRECT。連唔到時畫面會講原因，並（v0.8.10 起）提示「如用緊 VPN／代理，請將 data.gov.hk 設為直連」。
- 港鐵**冇公開列車位置**，位置係由各站到站倒數反推，只供參考；詳見 [`ALGORITHM.md`](ALGORITHM.md) 同 [`MODEL.md`](MODEL.md)。
- 特別車務安排期間 API 唔提供班次，只回傳通告；畫面會顯示「港鐵暫停提供實時班次」同港鐵原文。
- 中途各站時間喺 Duty Sheet 重建嘅班次係推算（見 [`DUTYSHEET.md`](DUTYSHEET.md)「限制」）。
- Duty Sheet 係每份指定日期／日類型手動加入；冇對應 Duty Sheet 嗰日（例如未登記嘅公眾假期）header 顯示「Duty Sheet 不適用」，Run 編號同更份功能自動隱藏。
- 需要 Service Worker 同 ES module，舊瀏覽器（唔支援 `import`）用唔到。
