// 抓股價寫進 Firebase 的 jizhangState/{uid}.quotes，只更新每個帳號「持股」裡的代號。
// MODE=close（排程）：用證交所／櫃買中心最新公布的收盤價；當天收盤價還沒公布時，那份資料就是前一個交易日的。
// MODE=realtime（手動啟動）：用證交所即時行情（盤中是最新成交價），抓不到的代號改用收盤價。
// 手動填的價格，日期不比新資料舊就保留。
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";

const TWSE = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const TPEX = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";
const SYM = /^[0-9A-Z.]{1,10}$/;

const pick = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== "") return o[k]; return ""; };
const num = v => { const n = Number(String(v).replace(/,/g, "").replace(/^\+/, "")); return Number.isFinite(n) ? n : NaN; };

export function toDate(v) {
  const s = String(v || "").replace(/[^0-9]/g, "");
  if (s.length === 8) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6);
  if (s.length === 7 || s.length === 6) {
    const y = Number(s.slice(0, s.length - 4)) + 1911;
    return y + "-" + s.slice(-4, -2) + "-" + s.slice(-2);
  }
  return "";
}

export function parse(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const code = String(pick(r, ["Code", "SecuritiesCompanyCode", "code", "證券代號"])).trim().toUpperCase();
    const p = num(pick(r, ["ClosingPrice", "Close", "close", "收盤價"]));
    if (!SYM.test(code) || !(p > 0)) continue;
    const chg = num(pick(r, ["Change", "change", "漲跌價差"]));
    out[code] = {
      p,
      n: String(pick(r, ["Name", "CompanyName", "name", "證券名稱"])).trim().slice(0, 20),
      chg: Number.isFinite(chg) ? Math.round(chg * 100) / 100 : 0,
      d: toDate(pick(r, ["Date", "date", "資料日期"])),
    };
  }
  return out;
}

const MIS = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";

// 即時行情：同一個代號同時問上市（tse）和上櫃（otc），哪個有資料就用哪個
// z＝最新成交價（這段時間沒成交是 "-"，改用最佳買價）、y＝昨收、d＝日期 YYYYMMDD、t＝時間
export function parseMis(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const code = String(r.c || "").trim().toUpperCase();
    if (!SYM.test(code)) continue;
    let p = num(r.z);
    if (!(p > 0)) p = num(String(r.b || "").split("_")[0]);
    if (!(p > 0)) continue;
    const y = num(r.y);
    out[code] = {
      p,
      n: String(r.n || "").trim().slice(0, 20),
      chg: y > 0 ? Math.round((p - y) * 100) / 100 : 0,
      d: toDate(r.d),
      t: String(r.t || "").slice(0, 5),
    };
  }
  return out;
}

async function getRealtime(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 20) {
    const part = syms.slice(i, i + 20);
    const ex = part.flatMap(s => [`tse_${s}.tw`, `otc_${s}.tw`]).join("|");
    const res = await fetch(`${MIS}?ex_ch=${encodeURIComponent(ex)}&json=1&delay=0&_=${Date.now()}`, {
      headers: { "user-agent": "Mozilla/5.0 kyms-quotes", referer: "https://mis.twse.com.tw/stock/index.jsp" },
    });
    if (!res.ok) throw new Error("即時行情 " + res.status);
    const d = await res.json();
    Object.assign(out, parseMis(d.msgArray));
  }
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 kyms-quotes" } });
  if (!res.ok) throw new Error(url + " " + res.status);
  return res.json();
}

// 用持股（股數 × 價格）算浮動盈虧，存成那個月的快照（同月後面的執行會覆蓋＝月底值）
export function plSnapshot(hold, px) {
  let mv = 0, cost = 0, d = "";
  for (const h of hold || []) {
    const s = String((h && h.sym) || "").toUpperCase(), q = px[s], sh = Number(h && h.sh), c = Number(h && h.cost);
    if (!q || !(q.p > 0) || !(sh > 0)) continue;
    mv += sh * q.p; cost += sh * (c > 0 ? c : 0);
    if (String(q.d || "") > d) d = String(q.d);
  }
  if (!d) return null;
  return { mk: d.slice(0, 7), v: { pl: Math.round(mv - cost), mv: Math.round(mv), cost: Math.round(cost), d } };
}

// 把收盤資料合併進某個帳號原本的 quotes；沒變就回傳 null
export function merge(oldQuotes, syms, map) {
  const q = { px: { ...((oldQuotes && oldQuotes.px) || {}) }, at: String((oldQuotes && oldQuotes.at) || "") };
  let changed = false, latest = "";
  for (const s of syms) {
    const n = map[s], old = q.px[s];
    if (!n || !n.d) continue;
    const stamp = n.d + (n.t ? " " + n.t : "");
    if (stamp > latest) latest = stamp;
    if (old && old.src === "manual" && String(old.d || "") >= n.d) continue;
    if (old && old.src === "auto" && old.p === n.p && old.d === n.d && (old.t || "") === (n.t || "")) continue;
    q.px[s] = { p: n.p, d: n.d, src: "auto", n: n.n, chg: n.chg };
    if (n.t) q.px[s].t = n.t;
    changed = true;
  }
  const at = latest ? latest + (latest.length > 10 ? " 即時" : " 收盤") : "";
  if (at && q.at !== at) { q.at = at; changed = true; }
  return changed ? q : null;
}

async function main() {
  const [a, b] = await Promise.allSettled([getJson(TWSE), getJson(TPEX)]);
  console.log("證交所：", a.status === "fulfilled" ? "成功" : "失敗 " + a.reason);
  console.log("櫃買中心：", b.status === "fulfilled" ? "成功" : "失敗 " + b.reason);
  if (a.status === "rejected" && b.status === "rejected") throw new Error("兩個資料來源都抓不到");
  const map = Object.assign({}, b.status === "fulfilled" ? parse(b.value) : {}, a.status === "fulfilled" ? parse(a.value) : {});
  console.log("收盤資料筆數：", Object.keys(map).length);
  const realtime = process.env.MODE === "realtime";
  console.log("模式：", realtime ? "即時價（手動啟動）" : "收盤價（排程）");

  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();
  const snap = await db.collection("jizhangState").get();
  let rt = {};
  if (realtime) {
    const all = new Set();
    snap.docs.forEach(doc => {
      const h = ((doc.data() || {}).settings || {}).hold;
      (Array.isArray(h) ? h : []).forEach(x => { const s = String((x && x.sym) || "").toUpperCase(); if (SYM.test(s)) all.add(s); });
    });
    try { rt = await getRealtime([...all]); console.log("即時行情筆數：", Object.keys(rt).length, "/", all.size); }
    catch (e) { console.log("即時行情抓不到，改用收盤價：", e.message); }
  }
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const hold = (data.settings && Array.isArray(data.settings.hold)) ? data.settings.hold : [];
    const syms = [...new Set(hold.map(h => String((h && h.sym) || "").toUpperCase()).filter(s => SYM.test(s)))];
    if (!syms.length) continue;
    const src = realtime ? Object.assign({}, map, rt) : map;
    const q = merge(data.quotes, syms, src);
    const miss = syms.filter(s => !src[s]);
    const snapQ = plSnapshot(hold, (q || data.quotes || {}).px || {});
    const oldSnap = snapQ && data.plh && data.plh[snapQ.mk];
    const snapChanged = snapQ && !(oldSnap && oldSnap.pl === snapQ.v.pl && oldSnap.mv === snapQ.v.mv && oldSnap.d === snapQ.v.d);
    if (q && snapChanged) await doc.ref.update("quotes", q, new FieldPath("plh", snapQ.mk), snapQ.v);
    else if (q) await doc.ref.update({ quotes: q });
    else if (snapChanged) await doc.ref.update(new FieldPath("plh", snapQ.mk), snapQ.v);
    if (snapQ) console.log(`  ${snapQ.mk} 浮動盈虧快照：${snapQ.v.pl}`);
    console.log(`帳號 ${doc.id.slice(0, 6)}…：持股 ${syms.length} 檔，${q ? "已更新" : "沒有變動"}${miss.length ? "，找不到：" + miss.join(",") : ""}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
