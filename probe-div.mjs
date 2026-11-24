// 暫時用：看 FinMind 股利資料的欄位格式（用公開大型股，不涉及個人持股）
for (const [ds, id] of [["TaiwanStockDividend", "0056"], ["TaiwanStockDividend", "2330"], ["TaiwanStockDividendResult", "0056"]]) {
  const u = `https://api.finmindtrade.com/api/v4/data?dataset=${ds}&data_id=${id}&start_date=2025-06-01`;
  const r = await fetch(u); const t = await r.text();
  console.log("==", ds, id, r.status, t.length);
  try { const d = JSON.parse(t); console.log("keys:", Object.keys(d).join(","), "msg:", d.msg, "rows:", (d.data || []).length);
    for (const row of (d.data || []).slice(-2)) console.log(JSON.stringify(row)); } catch (e) { console.log(t.slice(0, 300)); }
}
