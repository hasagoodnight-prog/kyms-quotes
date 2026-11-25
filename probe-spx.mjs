// 暫時用：測試 S&P 500 與加權指數的免費資料來源
const tries = [
  ["FRED", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500"],
  ["Yahoo", "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1mo&interval=1d"],
  ["FinMind", "https://api.finmindtrade.com/api/v4/data?dataset=USStockPrice&data_id=%5EGSPC&start_date=2026-11-01"],
  ["Stooq", "https://stooq.com/q/d/l/?s=%5Espx&i=d"],
  ["TWSE-idx", "https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=20261101&response=json"],
  ["MIS-t00", "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0"],
];
for (const [n, u] of tries) {
  try {
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 kyms-quotes", referer: "https://mis.twse.com.tw/stock/index.jsp" } });
    const t = await r.text();
    console.log("==", n, r.status, t.length, "|", t.slice(0, 160).replace(/\s+/g, " "), "| tail:", t.slice(-160).replace(/\s+/g, " "));
  } catch (e) { console.log("==", n, "ERR", e.message); }
}
