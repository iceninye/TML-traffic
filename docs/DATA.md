# 資料檔案結構

全部資料都係 `data/` 入面嘅靜態 JSON，App 啟動時用 `fetch` 讀取。大部分由 `tools/` 腳本生成，**唔好手改**（唯一例外：`data/timetables/index.json` 嘅 `alsoOn`，見下文）。

```
data/
  tml-network.json        27 站、2 條方向 route（抽取自上游，MIT）
  tml-segments.json       站間距離／行車時間（tools/build-segments.mjs 生成）
  tml-timetable.json      站距、行車、停站、時段模型（tools/build_data.py 生成）
  tml-track.json          OSM 真實走綫座標（tools/build_data.py 生成，ODbL）
  timetables/
    index.json            時間表清單（App 讀呢個）
    TML*.json             港鐵官方工作時間表（tools/parse_timetables.py）
    DS<代號>.json         由 Duty Sheet 解析出嘅時間表（tools/parse_dutysheet.py）
  duties/
    index.json            更份卡片清單
    DS<代號>.json         每張 Duty Sheet 嘅更份卡片（tools/dutycards.py）
```

## `data/timetables/index.json`

```json
{ "note": "…", "timetables": [ { "code": "DS7091", "file": "DS7091.json", "day": "sunday",
  "kind": "normal", "effective": "2025-08-31", "source": "dutysheet", "base": "TML7090",
  "revision": 1, "sha256": "…", "primary": true, "alsoOn": ["2026-10-19"] } ] }
```

| 欄位 | 意思 |
|---|---|
| `code` / `file` | 代號同檔名 |
| `day` | `weekday` / `saturday` / `sunday` / `special` |
| `kind` | `normal`（平日、星期六、星期日正常班）或 `special`（活動、颱風等特別班） |
| `effective` | 生效日（`YYYY-MM-DD`） |
| `source: "dutysheet"` | 由 Duty Sheet 解析（官方時間表冇呢個欄位） |
| `base` | Duty Sheet 時間表用邊份官方時間表做底 |
| `primary` | `true` 先會被優先載入（見 [`DUTYSHEET.md`](DUTYSHEET.md)「選用規則」） |
| `dates` | 只喺呢啲行車日載入（Excel Duty Sheet 由表內日期讀出，例如 `["2026-10-24"]`）；冇呢個欄位即所有日子 |
| `alsoOn` | 額外指定日子用呢份 Duty Sheet（例如假日跟星期日 7091）。**手動維護**，解析器重新登記時會保留 |
| `revision` / `sha256` | 同一代號重新解析嘅版本同內容雜湊 |

行車日喺**凌晨 4 點**換日；`dates`、`alsoOn` 都按行車日計。

## `data/timetables/<代號>.json`

主要欄位：`timetable`（代號）、`day`、`kind`、`effective`、`sectionA`（四個時段每方向行車同停站秒數）、`headways`、`firstLast`（首尾班）、`trips`（逐班車）。
每班車有 Run、方向、逐站時間（秒，由行車日零時起計，過咗午夜會超過 86400）；Duty Sheet 時間表另有 `duties`（`[更份, 起點站]`）、`dutysheet`、`base`、`coverage`。
詳見 `tools/parse_timetables.py` 開頭說明同 [`ALGORITHM.md`](ALGORITHM.md) §3e。

## `data/duties/`

`index.json` 的 `sheets[]`：`code`、`file`、`class`（`weekday`／`saturday`／`sunday`／`special`）、`dates`、`issued`（發出日）、`duties`（更份數目）、`sha256`。

`DS<代號>.json`：`schema`、`dutysheet`、`class`、`dates`、`issued`、`parser`、`src`、`sha256`、`duties[]`。每個更份：

```json
{ "id": "8022101", "group": "KSR", "tab": "KSR",
  "on": [17100, "TUM"], "off": [47700, "KSR"], "work": 480,
  "meal": [32045, 38395, "KSR2", "KSR2"],
  "legs": [["drive", 25, "TUM", 20700, "WKS", 25251]] }
```

- `on`／`off`：`[秒, 地點]`（上班／下班）；`work` 工時（分鐘）。
- `meal`：`[由, 至, 落車地點, 接車地點]`。
- `legs`：`[類別, Run, 接班地點, 接班時間, 離班地點, 離班時間]`；類別 `drive` 載客、`empty` 空車、`park` 泊車、`prep` 出車準備、`ride` 乘搭、`wait` 待命／休息、`other`。
- **公開欄位只有整理過嘅資料**；司機姓名同備註原文不寫入。原始 Duty Sheet（PDF／Excel）亦不入 repo。

## 其他

- `lib/maplibre/`：vendored MapLibre GL JS（BSD-3-Clause），見 [`NOTICE.md`](../NOTICE.md)。
- 重建模型檔：`python3 tools/build_data.py`（會向 Overpass 攞 OSM 走綫，要網絡）；`--no-track` 只重建 `tml-timetable.json`；`node tools/build-segments.mjs` 重建 `tml-segments.json`。
- 授權：`data/timetables/` 同 `data/duties/` 源自港鐵公佈資料，MIT 不適用（見 [`NOTICE.md`](../NOTICE.md) §7）。
