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

// ===== 歷史收盤價（持股走勢圖、補齊過去月份的浮動盈虧） =====
const HIST_KEEP = 400;          // 每檔最多保留幾個交易日
const HIST_MONTHS = 12;         // 第一次補資料往回抓幾個月
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 證交所／櫃買中心的「個股日成交資訊」表格：找出 [日期, …, 收盤價(第 7 欄)] 的列
export function parseDayRows(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(r) || r.length < 7) continue;
    const d = toDate(r[0]), c = num(r[6]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && c > 0) out.push([d, c]);
  }
  return out;
}

// 抓某檔某個月每天的收盤價；先試上市（證交所），沒有再試上櫃（櫃買中心）
async function fetchMonth(sym, mk) {
  const ymd = mk.replace("-", "") + "01";
  const tries = [
    async () => { const d = await getJson(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ymd}&stockNo=${sym}&response=json`); return parseDayRows(d.data || (d.tables && d.tables[0] && d.tables[0].data)); },
    async () => { const d = await getJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${sym}&date=${mk.replace("-", "/")}/01&response=json`); return parseDayRows((d.tables && d.tables[0] && d.tables[0].data) || d.aaData || d.data); },
  ];
  for (const t of tries) {
    try { const rows = await t(); if (rows.length) return rows; } catch (e) {}
    await sleep(800);
  }
  return [];
}

const addMonth = (mk, n) => { const d = new Date(Date.UTC(+mk.slice(0, 4), +mk.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };

// 合併、去重、排序、只留最近 HIST_KEEP 天
export function mergeSeries(a, b) {
  const m = new Map();
  for (const [d, c] of [...(a || []), ...(b || [])]) if (d && c > 0) m.set(d, c);
  return [...m.entries()].sort((x, y) => x[0] < y[0] ? -1 : 1).slice(-HIST_KEEP);
}

// Firestore 不能存巢狀陣列，存成 { d: [...日期], c: [...收盤] }
const packSeries = s => ({ d: s.map(x => x[0]), c: s.map(x => x[1]) });
const unpackSeries = o => o && Array.isArray(o.d) && Array.isArray(o.c) ? o.d.map((d, i) => [d, Number(o.c[i])]) : [];

// 某個月底當時的持股：存入紀錄有代號和股數的，照紀錄累加；目前持股比紀錄多出來的部分，當作一開始就有
export function holdingsAt(data, mk) {
  const hold = (data.settings && Array.isArray(data.settings.hold)) ? data.settings.hold : [];
  const buys = {};
  for (const [m, tx] of Object.entries(data.months || {})) {
    for (const e of Object.values(tx || {})) {
      if (!e || e.t !== "s" || !e.sym || !(Number(e.sh) > 0)) continue;
      const s = String(e.sym).toUpperCase();
      (buys[s] = buys[s] || []).push({ mk: m, sh: Number(e.sh), a: Number(e.a) || 0 });
    }
  }
  const out = [];
  for (const h of hold) {
    const s = String((h && h.sym) || "").toUpperCase(), list = buys[s] || [];
    const allSh = list.reduce((t, b) => t + b.sh, 0), allA = list.reduce((t, b) => t + b.a, 0);
    const preSh = Math.max(0, (Number(h.sh) || 0) - allSh), preCost = Math.max(0, (Number(h.sh) || 0) * (Number(h.cost) || 0) - allA);
    const upto = list.filter(b => b.mk <= mk);
    const sh = preSh + upto.reduce((t, b) => t + b.sh, 0), cost = preCost + upto.reduce((t, b) => t + b.a, 0);
    if (sh > 0) out.push({ sym: s, sh, cost });
  }
  return out;
}

// 用歷史收盤價補過去月份的月底浮動盈虧（只補沒有快照的月份）
export function backfillPlh(data, series, curMk) {
  const months = Object.keys(data.months || {}).filter(m => Object.keys(data.months[m] || {}).length).sort();
  if (!months.length) return {};
  const out = {}, have = data.plh || {};
  for (let mk = months[0] < addMonth(curMk, -HIST_MONTHS) ? addMonth(curMk, -HIST_MONTHS) : months[0]; mk < curMk; mk = addMonth(mk, 1)) {
    if (have[mk]) continue;
    const end = mk + "-31";
    let mv = 0, cost = 0, d = "", ok = true;
    const hs = holdingsAt(data, mk);
    if (!hs.length) continue;
    for (const h of hs) {
      const pts = (series[h.sym] || []).filter(p => p[0] <= end && p[0] >= mk + "-01");
      if (!pts.length) { ok = false; break; }
      const last = pts[pts.length - 1];
      mv += h.sh * last[1]; cost += h.cost;
      if (last[0] > d) d = last[0];
    }
    if (ok) out[mk] = { pl: Math.round(mv - cost), mv: Math.round(mv), cost: Math.round(cost), d, est: 1 };
  }
  return out;
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
  const thisMk = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
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
    // 走勢圖用的歷史收盤價：資料太少就往回補 HIST_MONTHS 個月，之後每天加上最新的收盤
    const series = {}, phUpd = {};
    for (const s of syms) {
      let cur = unpackSeries(data.ph && data.ph[s]);
      if (cur.length < 20) {
        let got = [];
        for (let k = HIST_MONTHS; k >= 0; k--) got = got.concat(await fetchMonth(s, addMonth(thisMk, -k)));
        console.log(`  補歷史收盤價：${got.length} 天`);
        cur = mergeSeries(cur, got);
      }
      const today = map[s];
      if (today && today.d) cur = mergeSeries(cur, [[today.d, today.p]]);
      series[s] = cur;
      const before = data.ph && data.ph[s];
      if (!before || before.d.length !== cur.length || before.d[before.d.length - 1] !== (cur[cur.length - 1] || [])[0]) phUpd[s] = packSeries(cur);
    }
    const back = backfillPlh(data, series, thisMk);
    const upd = [];
    for (const s in phUpd) upd.push(new FieldPath("ph", s), phUpd[s]);
    for (const mk in back) upd.push(new FieldPath("plh", mk), back[mk]);
    if (upd.length) await doc.ref.update(...upd);
    if (Object.keys(back).length) console.log(`  補上 ${Object.keys(back).length} 個月的月底浮動盈虧（估算）`);
    console.log(`帳號 ${doc.id.slice(0, 6)}…：持股 ${syms.length} 檔，${q ? "已更新" : "沒有變動"}${miss.length ? "，" + miss.length + " 檔找不到價格" : ""}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
