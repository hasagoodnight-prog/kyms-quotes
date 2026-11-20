// 每天收盤後抓證交所／櫃買中心收盤價，寫進 Firebase 的 jizhangState/{uid}.quotes
// 只更新每個帳號「持股」裡的代號；手動填的價格，日期不比收盤資料舊就保留。
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 kyms-quotes" } });
  if (!res.ok) throw new Error(url + " " + res.status);
  return res.json();
}

// 把收盤資料合併進某個帳號原本的 quotes；沒變就回傳 null
export function merge(oldQuotes, syms, map) {
  const q = { px: { ...((oldQuotes && oldQuotes.px) || {}) }, at: String((oldQuotes && oldQuotes.at) || "") };
  let changed = false, latest = "";
  for (const s of syms) {
    const n = map[s], old = q.px[s];
    if (!n || !n.d) continue;
    if (n.d > latest) latest = n.d;
    if (old && old.src === "manual" && String(old.d || "") >= n.d) continue;
    if (old && old.src === "auto" && old.p === n.p && old.d === n.d) continue;
    q.px[s] = { p: n.p, d: n.d, src: "auto", n: n.n, chg: n.chg };
    changed = true;
  }
  if (latest && q.at !== latest + " 收盤") { q.at = latest + " 收盤"; changed = true; }
  return changed ? q : null;
}

async function main() {
  const [a, b] = await Promise.allSettled([getJson(TWSE), getJson(TPEX)]);
  console.log("證交所：", a.status === "fulfilled" ? "成功" : "失敗 " + a.reason);
  console.log("櫃買中心：", b.status === "fulfilled" ? "成功" : "失敗 " + b.reason);
  if (a.status === "rejected" && b.status === "rejected") throw new Error("兩個資料來源都抓不到");
  const map = Object.assign({}, b.status === "fulfilled" ? parse(b.value) : {}, a.status === "fulfilled" ? parse(a.value) : {});
  console.log("收盤資料筆數：", Object.keys(map).length);

  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();
  const snap = await db.collection("jizhangState").get();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const hold = (data.settings && Array.isArray(data.settings.hold)) ? data.settings.hold : [];
    const syms = [...new Set(hold.map(h => String((h && h.sym) || "").toUpperCase()).filter(s => SYM.test(s)))];
    if (!syms.length) continue;
    const q = merge(data.quotes, syms, map);
    const miss = syms.filter(s => !map[s]);
    if (q) await doc.ref.update({ quotes: q });
    console.log(`帳號 ${doc.id.slice(0, 6)}…：持股 ${syms.length} 檔，${q ? "已更新" : "沒有變動"}${miss.length ? "，找不到：" + miss.join(",") : ""}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
