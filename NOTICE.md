# NOTICE — 第三方授權

本專案 `lib/` 之下嘅列車位置推算引擎，以及 `data/tml-network.json` 嘅站序／座標／路綫資料，抽取自：

- **Repository**：https://github.com/keithligh/hk-traffic-intelligence
- **作者**：Keith Li
- **授權**：MIT License, Copyright (c) 2026 Keith Li

原文檔與對應抽取檔案：

| 上游檔案 | 本專案檔案 |
|---|---|
| `src/lib/mtr-estimate.ts` | `lib/mtr-estimate.js` |
| `src/lib/mtr-schedule.ts` | `lib/mtr-schedule.js` |
| `src/lib/mtr-network.ts` + `data/mtr-network.json` | `lib/mtr-network.js` + `data/tml-network.json` |
| `src/lib/mtr-feed.ts` / `pool.ts` / `refresh-slice.ts` | `lib/mtr-feed.js` |

改動性質：TypeScript → 零依賴 ES module 移植；網絡資料由全部 10 條綫（98 站）收窄為**只保留屯馬綫**（27 站、2 條方向 route）。邏輯本身保持忠實移植。

MIT 授權全文見上游 repo 的 `LICENSE`。使用或再分發時請保留本 NOTICE。
