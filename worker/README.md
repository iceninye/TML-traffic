# tml-feed（可選：港鐵班次邊緣快取）

預設**唔使用**。網站每個用戶每 20 秒直接向 data.gov.hk 發 27 個請求；用戶多嘅時候可以開呢個 Worker，將 27 個請求合成 1 個，並喺 Cloudflare 邊緣快取 5 秒，data.gov.hk 嘅負載就同觀看人數無關。

## 額度（先睇呢度）

Workers 免費計劃每日 10 萬次請求。開咗之後每個用戶（開住頁面）每 20 秒 1 次請求，即每日約 4,300 次，所以**免費額度大約夠 20 個人成日開住**；快取命中仍然計請求次數，但唔會多打 data.gov.hk。流量大過呢個數目就要升級計劃，或者唔好開。

## 部署（一次性）

```bash
cd worker
npx wrangler login
npx wrangler deploy        # 得到 https://tml-feed.<帳戶子網域>.workers.dev
```

呢個係獨立專案（`worker/wrangler.jsonc`），唔會影響網站本身嘅部署（根目錄 `.assetsignore` 已排除 `worker`）。

## 開啟／關閉

編輯 `data/config.json`：

```json
{ "feedProxy": "https://tml-feed.<帳戶子網域>.workers.dev/board" }
```

留空字串 `""` 就係關閉（預設）。開咗之後頁面如果收唔到 Worker 嘅回應，會自動改為直接向 data.gov.hk 讀，網站唔會因 Worker 出事而壞。

## 資料格式

`GET /board?lang=tc` → `{ "at": <毫秒>, "stations": { "TUM": <data.gov.hk 原本回應>, ... } }`。27 個站碼要同 `data/tml-network.json` 一致，`node tools/validate_proxy.mjs` 會檢查。
