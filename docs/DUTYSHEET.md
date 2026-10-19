# Duty Sheet 數據源

## 操作指南：準備同加入新 Duty Sheet

### 1. 檔案格式

| 格式 | 支援 | 備註 |
|---|---|---|
| `.xlsx`（Excel） | ✅ | 新式 Duty Sheet。需要工作表 `KSR`、`TAW`、`HHS`、`ETS DM`（至少其一），第一張工作表頂部要有 `TML Duty Sheet <4 位代號> (<日類型>)` 標題；表內嘅行車日期、Issue Date 會自動讀出。讀嘅係 Excel 儲存咗嘅計算結果（唔會重新計算），所以請喺 Excel 開過、儲存過先交 |
| `.pdf` | ✅ | 舊式 PDF Duty Sheet（1101、6091、7091 係呢種）。冇指定日期，按 `effective`（發出日）同日類型用 |
| `.csv` | ❌ 不支援 | `parse_dutysheet.py` 唔識讀 CSV：非 `.xlsx` 嘅檔案一律當 PDF，傳 CSV 會以 `Is this really a PDF?` 報錯。CSV 冇工作表同儲存格結構，唔夠解析更表；請用原本嘅 `.xlsx` 或 PDF。（個人更表 CSV 屬另一個專案，唔喺呢個 repo） |

### 2. 準備

```bash
pip install pdfplumber openpyxl     # PDF 同 xlsx 都要（parse_dutysheet.py 一開始就載入 pdfplumber）
```

- 檔名隨意，代號、日期都喺檔案內容入面讀（4 位代號；首位 1／5 平日、6 星期六、7 星期日，其他當特別日，例如 8022、8023）。
- **原始 Duty Sheet 唔好 commit**（`.gitignore` 只排除 `*.pdf`，Excel 要自己小心，因為 repo 係公開嘅）。將檔案放喺 repo 外面，例如 `~/Downloads/`。
- 官方底表（`data/timetables/` 入面同日類型、生效日唔新過 Duty Sheet 嘅正常時間表）需要已經存在，解析器用佢做模板。

### 3. 解析、驗證、寫檔

```bash
# 先試跑：解析 + 驗證，唔寫任何檔
python3 tools/parse_dutysheet.py ~/Downloads/TML_duty_sheet_8022.xlsx --dry-run

# 確認冇問題後正式寫入（可一次傳多個檔）
python3 tools/parse_dutysheet.py ~/Downloads/TML_duty_sheet_8022.xlsx ~/Downloads/TML_duty_sheet_8023.xlsx

# 指定底表（預設：同日類型、最新而唔新過 Duty Sheet 嘅正常時間表）
python3 tools/parse_dutysheet.py sheet.pdf --base TML1100B

# 同底表一模一樣都照寫
python3 tools/parse_dutysheet.py sheet.pdf --keep-redundant
```

做咗乜：

1. 解析 → 經 `tools/validate_dutysheet.py` 驗證，**通過先寫** `data/timetables/DS<代號>.json` 並登記到 `data/timetables/index.json`；唔通過會列出原因，唔會寫檔。工作表名對唔上等問題會直接報錯（例如 `none of the sheets (…) in the workbook`）。
2. 同時由 `tools/dutycards.py` 寫 `data/duties/DS<代號>.json` 同 `data/duties/index.json`（更份卡片）。
3. 如果結果同底表完全一樣（底表時間更準），預設唔寫（`--keep-redundant` 可覆蓋）。

只想補更份卡片、或某張 Duty Sheet 冇卡片時列出編號：

```bash
python3 tools/dutycards.py file.xlsx [file.pdf ...] [--dry-run]
python3 tools/dutycards.py --stubs      # 有時間表但冇卡片嘅 Duty Sheet，印編號清單
```

### 4. 驗證輸出

```bash
python3 tools/validate_dutysheet.py data/timetables/DS8022.json   # 單份時間表，exit 0 = 通過
node tools/validate_duties.mjs                                    # 更份卡片同當值判斷
node tools/validate_matching.mjs                                  # 班次對應（合成讀數）
```

### 5. 指定「呢個日期用邊份 Duty Sheet」

| 情況 | 做法 |
|---|---|
| Excel Duty Sheet（有指定行車日） | 全自動：`index.json` 項目帶 `dates: ["YYYY-MM-DD"]`，只喺該行車日載入，其他日子唔受影響 |
| 平日／假日要借用另一份（例如 2026-10-19 用星期日 7091） | 手動喺 `data/timetables/index.json` 嗰份 Duty Sheet 項目加／改 `alsoOn: ["2026-10-19"]`；解析器重新登記時會保留。例子見 `DS7091` |
| 日常平日／星期六／星期日 | 唔使設定：最新、已生效、`primary: true` 嘅 Duty Sheet 自動優先 |
| 冇 Duty Sheet 嘅日子 | 唔使設定：header 顯示「Duty Sheet 不適用」，Run 編號同更份功能隱藏 |

行車日喺凌晨 4 點換日。`alsoOn` 目前只喺 `index.json` 手動維護；更份卡片 (`data/duties/index.json`) 嘅 `dates` 只記錄 Excel 內嘅行車日。

### 6. 開 PR

1. 改動只應該有 `data/timetables/`、`data/duties/`（同需要時 `docs/`）。
2. 加入新資料即係改變 App 行為，要按 [`SETUP.md`](SETUP.md)「發佈新版」同時改版本號三處（`assets/app.js` 嘅 `BUILD`、`CHANGELOG.md`、`sw.js` 嘅 cache 名）。
3. 跑上面驗證指令同 `node --check assets/app.js`，再開 PR。

資料結構見 [`DATA.md`](DATA.md)。

---

## 內容（三份樣本 6091 星期六、7091 星期日、1101 平日）

Duty Sheet 係司機更表。每張更表（7 位編號：4 位代號 + 3 位序號）有一串「腿」：

`Run | 接班地點 | 接班時間(H:MM:SS) | 備註 | 離班時間(H:MM) | 離班地點 | 旗標`

- 接班時間到秒，離班時間只到分鐘（係到站秒數捨去，解析時加 30 秒做估算）。
- 地點：TUM、WKS 總站；KSR1/2、TAW3/4 係接班點；HUH2/3、ETS1/2 係紅磡短途班同接駁；車廠同停車點（W1C、W1F、YUL、PKTD、TT …）。
- 旗標：`N` 不載客列車（空車到目的地）、`L` 最後一程（到終點站後回廠）；其餘（A/B/C/D）意思未確認。
- 備註：`Train preparation`、`Start service`、`MB`（用膳）、`Spare`、`Ride …` 等；`DM` 係紅磡 ⇄ 尖東接駁，唔載客。
- 凌晨時間寫成 `0:10:10`，跨午夜要靠單調性補 +24 小時；星期字樣可能用罕見字（`星期㇐`，U+31D0）。
- **冇逐站時間，冇車次號。** 每腿屬於一個更份（7 位編號）。解析器 0.2.0 起按同一 Run 嘅腿，逐站定出由邊個更份駕駛（`duties`: [更份, 起點站]，跳過 `Riding` 同 DM），列車卡片顯示當時駕駛嘅更份同下一次換班；撳卡片左上角 ▲▼ 轉第二頁，列出同一 Run 全日每個更份嘅接車站／時間（開出時間，準到秒）同交車站／時間（到站時間），現時更份會標示。L（最後一程，之後回廠）由行程備註 `LAST TRIP, TRAIN TO DEPOT AT TERMINUS` 讀出，列車畫成 70% 透明。

## 對照現有時間表

三份樣本同 repo 內對應時間表（TML6090A、TML7090、TML1100B）逐班對：由 TUM／WKS 開出嘅班次（401／360／460 班，包括紅磡短途班）
Run 同秒數全部一樣，KSR／TAW 接班時間等於時間表嘅開出時間。所以同步時 Duty Sheet 同時間表冇可見分別；
價值係官方時間表未出或者改版期間有更新嘅班次。

## 重建

`tools/parse_dutysheet.py`：
1. 用 pdfplumber 逐字座標讀每頁（欄位位置每頁由表頭 `Run Place Time Remark Time Place` 定出）。
2. 由總站開出、未標 `N` 嘅腿造班次；沿接班鏈（KSR／TAW）跟到終點，紅磡短途班重建到紅磡。
3. 用底表同方向、開出時間最近嘅班次做模板，喺 Duty Sheet 錨點（接班時間、到站分鐘 + 30 秒）之間分段拉伸。
4. 驗證後寫 `data/timetables/DS<代號>.json`；Section A、班距、首尾班資料由底表繼承。

重建誤差（3 份樣本，用另一日時間表做模板）：全部站點中位數 8–10 秒、P90 22–47 秒、最大約 130 秒；
用同日時間表做模板：中位數 3 秒、P90 15 秒。

## 指定日期嘅 Duty Sheet（Excel）

新式 Duty Sheet 係 `.xlsx`（工作表 KSR、TAW、HHS、ETS DM，接班同離班時間都到秒），表內有指定行車日期。`python3 tools/parse_dutysheet.py file.xlsx` 讀出後，`index.json` 項目帶 `dates: ["2026-10-24"]`：只喺該行車日（凌晨 4 點換日）載入同優先使用，其他日子完全唔受影響。底表由同日類型（普通或特別）入面揀 Duty Sheet 總站開出班次最吻合嗰份（例如 8023 活動日用 TML709CB）。現有：DS8022（2026-10-24，星期六）、DS8023（2026-10-25，星期日，啟德體育園活動）。

## 選用規則

- 指定某日用某份 Duty Sheet（例如平日用星期日嗰份）：喺 `index.json` 該 Duty Sheet 項目加 `alsoOn: ["2026-10-19"]`（DS7091 已有 2026-10-19）；解析器重新登記時會保留。

- `index.json` 入面 `source: "dutysheet"` 嘅項目，`primary: true` 先會被載入：生效日 ≥ 底表生效日。Duty Sheet 時間表以底表為基礎：Duty Sheet 證實嘅班次（包括錦上路等中途開出嘅出廠車）沿用底表逐站時間、車次號；只有底表冇嘅總站班次先重建。
- 啟動時：生效日已到嘅最新 primary Duty Sheet 優先，否則日曆對應嘅正常時間表。之後仍按看板讀數（`pickDay`）校正。
- 時段列（「平日 · 繁忙 · 班距」嗰行）尾加「· Duty Sheet 編號」（1101、6091、7091、8022、8023）；冇 Duty Sheet 用緊（例如公眾假期跟星期日普通時間表、或特別車務時間表唔吻合）就顯示「不適用」，同時所有 Run 編號、更份、L 半透明都唔顯示（v0.7.8 起）。滑鼠移上去，提示會註明來源 Duty Sheet 同生效日。

## 更份卡片（v0.8.0；PDF 版 v0.8.1 補齊）

畫面右上「· Duty Sheet 1101」（或「不適用」；冇底線同箭嘴，似隱藏功能）撳落去開卡片：第 1 頁當值、第 2 頁今日全部、第 3 頁所有編號（先平日／星期六／星期日／特別日，再 KSR／TAD／HHS），撳更份編號睇整張卡（第 4 頁）。

- 資料 `data/duties/DS<代號>.json` 由 `tools/dutycards.py` 寫（`parse_dutysheet.py` 讀 `.xlsx` 時一齊寫）。每個更份：編號、組別（KSR／TAD／HHS）、工作表、上班／下班（時間＋地點）、工時（分鐘）、用膳（由—至—、地點）、每腿 `[類別, Run, 接班地點, 接班時間, 離班地點, 離班時間]`。時間係行車日當日零時起計嘅秒數，過咗午夜超過 86400（同時間表一樣，行車日 04:00 換日）。
- 列車卡片嘅更份編號（同「全日更份」頁嘅編號）撳落去，開 Duty Sheet 卡片嘅該更份詳情（`openDutyCard`）。
- 飯腳：更份詳情「用膳」下面，列同一張表內同車站（落車地點；錦上路1同錦上路2、大圍3同大圍4、紅磡2同紅磡3 當同一站）用膳、時間重疊 45 分鐘或以上嘅更份（`mealMates()`）。
- 類別：drive 載客、empty 空車（旗標 N）、park 泊車（紅磡3 → 尖東1、尖東2 → 紅磡2 嘅 DM 班）、prep 出車準備、ride 乘搭接駁／的士／EMU、wait 待命／休息、other。備註原文唔寫入（2026-10-14 決定：只公開整理過嘅欄位）。
- 只收 workbook 自己「duty list」工作表列出嘅更份：8022 有 133 個、8023 有 117 個；`ETS DM` 工作表入面唔喺 duty list 嘅卡（8022588、8023587）唔收。工時同「上下班差 − 用膳」對唔上嘅（8022 有 12 個、8023 有 10 個）係 duty 表冇列出嘅 30 分鐘休息，唔當錯誤。
- PDF 版（1101、6091、7091）：`parse_pdf` 逐頁讀每張卡左邊一欄（Book On／Book Off 地點同時間、Work Hr）同用膳行（`<由> MB <至>`），時間按該卡上班時間定日子（晚上上班嘅更份午夜後嘅腿唔會跌錯日）。1101 有 155 張卡、6091 有 121 張、7091 有 102 張；6091588、7091587（腿遠過下班時間嘅雜卡）同 1101586 略過；1101 因此有 154 張。用膳時間 = 落車至接下一架列車（`[由, 至, 落車地點, 接車地點]`），MB 行只用嚟認邊一段係用膳；1101107、1101131 嘅 Work Hr 以 6.5、8 小時計（原表錯誤）。`python3 tools/dutycards.py --stubs` 只喺有時間表但冇卡嘅 Duty Sheet 先出編號清單。
- 當值判斷（`lib/tml-duties.js`）：上班 ≤ 現時 < 下班；現時喺某一腿之內就係該腿類別，喺用膳時段就係用膳，腿之間「等待接班」，首腿之前「出車準備」，尾腿之後「收車」。`node tools/validate_duties.mjs` 喺真資料上驗證。
- 地點代碼 KSR1、HUH3 等顯示為「錦上路 1」「紅磡 3」；車廠、側線代碼（W1C、TT、LT2 …）按 duty list 嘅地點名加上代碼（例如「八鄉廠 W1C」），其他代碼照印。

## 驗證（`tools/validate_dutysheet.py`）

站序、時間單調、站碼；Run＋方向＋開出時間唔重複；同一 Run 唔會兩班重疊，並於總站接續；
首尾班時段、同總站班距下限；PDF 冇未解析行；對底表嘅班次覆蓋（<70% 拒絕、<95% 警告）、新增／缺少班次、班次總數差異；生效日期。

## 限制

- 中途各站係推算，唔係官方時間。
- 只認 TUM／WKS 開出嘅班次；其他位置開出嘅載客班（如有）唔會出現。
- 欄位意思有新旗標或新備註時，解析器會保守處理，驗證會列出未解析行。
