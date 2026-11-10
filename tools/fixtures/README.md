# 真實站牌讀數 fixtures

`validate_replay.mjs` 會重播呢度每個 `boards-*.json`，確認曾經配錯嘅列車而家配啱。

## 點樣新增一份

1. 喺手機開 App，撞頁腳版本號 5 次打開隱藏面板，撳「複製站牌數據」。
2. 將複製出嚟嘅文字貼入新檔 `tools/fixtures/boards-<日期>-<時間>.json`。
3. 加 `expect`（邊個 Run 喺邊個時間應該係邊個方向／班次），格式參考 `boards-2026-11-04-1023.json`。
4. `node tools/validate_replay.mjs` 要通過。

建議收集：繁忙時段、非繁忙、公眾假期、事故／特別車務各一份，之後每次改配對邏輯，重播呢幾份加 `validate_matching.mjs` 嘅重點情境就夠，唔使跑全部 Duty Sheet × 時段。
