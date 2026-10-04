# TML-traffic

屯馬綫列車動態圖 — MTR Tuen Ma Line live train map.

## 現況

**已完成：資料抽取階段。** App 本身未開始寫。

港鐵**冇公開列車位置 API**。本專案由「各站下一班車到站時間」反推列車位置，引擎抽取自
[keithligh/hk-traffic-intelligence](https://github.com/keithligh/hk-traffic-intelligence)（MIT），
並收窄到**只做屯馬綫**。詳情見 [`docs/EXTRACTION.md`](docs/EXTRACTION.md)。

## 驗證

```bash
node tools/probe-tml.mjs
```

實測輸出（2026-10-04）：

```
Tuen Ma Line probe · 1 pass · 27 station reads · 2848 ms
boards received: 27 / 27
trains estimated: 38
off-line projection detected: no
```

## 結構

- `data/tml-network.json` — 27 站座標 + 雙向站序
- `data/tml-segments.json` — 26 段站距 + 行車時間（衍生）
- `lib/mtr-estimate.js` — 位置推算引擎
- `lib/mtr-schedule.js` — API 解析
- `lib/mtr-network.js` — TML 網絡存取
- `lib/mtr-feed.js` — 輪詢 / 記憶 / 冷卻
- `tools/probe-tml.mjs` — 實時端對端驗證

## 授權

`lib/` 及 `data/tml-network.json` 抽取自 MIT 授權專案，見 [`NOTICE.md`](NOTICE.md)。
