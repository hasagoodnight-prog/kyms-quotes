# 台股即時報價中繼站（Cloudflare Workers）

證交所的即時行情不允許其他網站直接讀取，所以用 Cloudflare Workers（免費）幫記帳台代抓。

## 設定（約 5 分鐘，一次就好）
1. 到 https://dash.cloudflare.com/sign-up 註冊（免費，不用信用卡）。
2. 左邊選 **Workers & Pages** → **Create** → **Create Worker**（Hello World 範本），名稱填 `kyms-live` → **Deploy**。
3. 部署完按 **Edit code**，把編輯器裡的內容全部刪掉，貼上 `realtime.js` 的全部內容 → **Deploy**。
4. 複製網址（像 `https://kyms-live.你的帳號.workers.dev`），交給 Claude 接到記帳台。

## 測試
瀏覽器打開 `https://kyms-live.你的帳號.workers.dev/?s=00919,T00`，看到 `"px":{"00919":{"p":…}` 就成功了。

## 用量
免費方案每天 10 萬次。記帳台開著時每 20 秒查一次，10 秒內的重複查詢直接用快取。
