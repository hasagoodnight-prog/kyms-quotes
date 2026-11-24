// 股價排程的計算邏輯（不連網路、不碰 Firebase）：node --test tests/unit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, parseMis, merge, toDate, parseDayRows, mergeSeries, holdingsAt, backfillPlh, plSnapshot,
  parseDividends, sharesBefore, divAmount, planDividends } from "../update-quotes.mjs";

test("民國／西元日期轉換", () => {
  assert.equal(toDate("1151119"), "2026-11-19");
  assert.equal(toDate("115/09/30"), "2026-09-30");
  assert.equal(toDate("20261119"), "2026-11-19");
});

test("收盤價解析（上市、上櫃欄位名稱不同）", () => {
  const m = parse([{ Date: "1151121", Code: "2330", Name: "台積電", ClosingPrice: "1,045.00", Change: "+5" },
    { Date: "1151121", SecuritiesCompanyCode: "6488", CompanyName: "環球晶", Close: "420", Change: "-3.5" }, { Code: "X", ClosingPrice: "--" }]);
  assert.deepEqual(Object.keys(m).sort(), ["2330", "6488"]);
  assert.equal(m["2330"].p, 1045);
  assert.equal(m["6488"].chg, -3.5);
});

test("即時價：沒成交時用最佳買價", () => {
  const m = parseMis([{ c: "00919", z: "-", b: "22.41_22.40_", y: "22.31", d: "20261124", t: "11:32:00" }]);
  assert.equal(m["00919"].p, 22.41);
  assert.equal(m["00919"].t, "11:32");
});

test("手動價比較新時不覆蓋", () => {
  const q = merge({ px: { A: { p: 1, d: "2026-11-24", src: "manual" } }, at: "" }, ["A", "B"],
    { A: { p: 2, d: "2026-11-21" }, B: { p: 3, d: "2026-11-21" } });
  assert.equal(q.px.A.p, 1);
  assert.equal(q.px.B.p, 3);
});

test("歷史股價合併去重排序", () => {
  const s = mergeSeries(parseDayRows([["115/09/30", 0, 0, 0, 0, 0, "21.80"]]), [["2026-09-29", 22.05], ["2026-09-30", 21.9]]);
  assert.deepEqual(s, [["2026-09-29", 22.05], ["2026-09-30", 21.9]]);
});

const DATA = {
  settings: { hold: [{ sym: "00919", sh: 30000, cost: 19 }], cats: { i: [{ id: "salary", n: "薪資" }, { id: "yield", n: "投資收益" }] } },
  months: { "2026-09": { a: { t: "e", c: "food", a: 1, d: "2026-09-02" } },
    "2026-10": { b: { t: "s", c: "stock", a: 190000, d: "2026-10-05", sym: "00919", sh: 10000 } },
    "2026-11": { c: { t: "e", c: "food", a: 1, d: "2026-11-01" } } },
  plh: { "2026-11": { pl: 1 } },
};

test("用買進紀錄還原每月持股、補月底浮動盈虧", () => {
  assert.deepEqual(holdingsAt(DATA, "2026-09"), [{ sym: "00919", sh: 20000, cost: 380000 }]);
  const b = backfillPlh(DATA, { "00919": [["2026-09-30", 21.8], ["2026-10-31", 20.9]] }, "2026-11");
  assert.equal(b["2026-09"].pl, 56000);
  assert.equal(b["2026-10"].pl, 57000);
  assert.equal(b["2026-11"], undefined);
});

test("本月浮動盈虧快照", () => {
  assert.equal(plSnapshot([{ sym: "00919", sh: 30000, cost: 19 }], { "00919": { p: 22.41, d: "2026-11-24" } }).v.pl, 102300);
});

test("股息：股數以除息日前為準、2 萬以上扣二代健保、不重複", () => {
  assert.equal(sharesBefore(DATA, "00919", "2026-09-16"), 20000);
  assert.deepEqual(divAmount(30000, 0.72), { gross: 21600, nhi: 456, net: 21144 });
  const divs = parseDividends([{ CashEarningsDistribution: 0.72, CashStatutorySurplus: 0, CashExDividendTradingDate: "2026-09-16", CashDividendPaymentDate: "2026-10-14" },
    { CashEarningsDistribution: 0.7, CashExDividendTradingDate: "2026-12-16", CashDividendPaymentDate: "2027-01-13" }]);
  const r = planDividends(DATA, { "00919": divs }, "2026-11-24");
  assert.equal(r.add.length, 1);
  assert.equal(r.add[0].e.a, 14400);
  assert.equal(r.add[0].e.c, "yield");
  assert.equal(r.upcoming[0].net, 20557);
  const again = planDividends({ ...DATA, divDone: { [r.add[0].id]: 1 } }, { "00919": divs }, "2026-11-24");
  assert.equal(again.add.length, 0);
});
