// 每月 1 日：把上個月的記帳整理成摘要，請 AI（Google Gemini 免費方案）寫月報分析，
// 存進 Firebase 的 jizhangState/{uid}.reviews.m[YYYY-MM]。網頁「月報」會優先顯示這份分析。
// 已經寫過的月份不會重寫（FORCE=1 可強制重寫）。
// 環境變數：FIREBASE_SERVICE_ACCOUNT、GEMINI_API_KEY；可選 MODEL、MONTH=2026-11、FORCE=1、LIST_MODELS=1
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";

const API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = ""; // 空白＝自動用清單裡最新的 gemini-x.y-flash
const KEY_HEADERS = () => ({ "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" });

const SAVE_GOAL = 10000; // 和網頁的「每月先存」目標一致
const MRE = /^\d{4}-\d{2}$/;

const SYSTEM = `你是使用者的記帳助理，幫他寫每月的消費回顧。使用者在台灣，用繁體中文（台灣用語）回覆，金額用 NT$ 和千分位。
語氣像朋友：直接、具體、不說教。每一點都要引用摘要裡的實際數字或項目，不要寫空泛的理財建議。
重點看：每月先存 ${SAVE_GOAL} 有沒有達標、哪些分類超出預算、伙食每天平均多少、大額或不必要的花費、和上個月比的變化。
固定支出（房租、訂閱、醫療這類）使用者已經說過不能改，不要建議砍它們。
只回傳一個 JSON 物件，不要其他文字，格式：
{"sum": "總結，150 字內", "good": ["做得好，1–4 點"], "warn": ["要注意，1–4 點"], "act": ["下個月具體改善，2–4 點"], "goal": "下個月一個可量化的目標，一句話"}
good / warn / act 每點 60 字內。`;

function taipeiNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function prevMonth(mk) {
  const [y, m] = mk.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
const daysIn = mk => new Date(+mk.slice(0, 4), +mk.slice(5, 7), 0).getDate();

// 把某個月的資料整理成給 AI 看的摘要（只含這次分析需要的欄位）
export function summarize(data, mk) {
  const cats = (data.settings && data.settings.cats) || {};
  const name = (t, id) => ((cats[t] || []).find(c => c.id === id) || {}).n || id;
  const list = Object.values((data.months && data.months[mk]) || {}).filter(e => e && e.a > 0);
  const sumBy = (arr, t) => {
    const by = {};
    arr.filter(e => e.t === t).forEach(e => { by[e.c] = (by[e.c] || 0) + e.a; });
    return by;
  };
  const total = (arr, t) => arr.filter(e => e.t === t).reduce((s, e) => s + e.a, 0);
  const exBy = sumBy(list, "e");
  const expense = (cats.e || []).filter(c => !c.h && (c.b > 0 || exBy[c.id]))
    .map(c => ({ 分類: c.n, 預算: c.b || null, 實際: exBy[c.id] || 0 }));
  Object.keys(exBy).filter(id => !(cats.e || []).some(c => c.id === id))
    .forEach(id => expense.push({ 分類: name("e", id), 預算: null, 實際: exBy[id] }));
  const food = (cats.e || []).find(c => c.id === "food" || c.n === "伙食");
  const prevList = Object.values((data.months && data.months[prevMonth(mk)]) || {}).filter(e => e && e.a > 0);
  const big = list.filter(e => e.t === "e" && !e.f && e.a >= 500).sort((a, b) => b.a - a.a).slice(0, 15)
    .map(e => ({ 日期: e.d, 分類: name("e", e.c), 備註: e.n || "", 金額: e.a }));
  return {
    月份: mk,
    記帳筆數: list.length,
    收入: { 合計: total(list, "i"), 分類: Object.entries(sumBy(list, "i")).map(([id, v]) => ({ 分類: name("i", id), 金額: v })) },
    支出: { 合計: total(list, "e"), 其中固定支出: list.filter(e => e.t === "e" && e.f).reduce((s, e) => s + e.a, 0), 各分類: expense },
    存錢投資: { 合計: total(list, "s"), 每月目標: SAVE_GOAL, 分類: Object.entries(sumBy(list, "s")).map(([id, v]) => ({ 分類: name("s", id), 金額: v })) },
    伙食: food ? { 合計: exBy[food.id] || 0, 天數: daysIn(mk), 每日平均: Math.round((exBy[food.id] || 0) / daysIn(mk)), 月預算: food.b || null } : null,
    單筆500以上的非固定支出: big,
    沒寫備註的筆數: list.filter(e => !e.n).length,
    上個月: prevList.length ? { 收入: total(prevList, "i"), 支出: total(prevList, "e"), 存錢投資: total(prevList, "s") } : null,
  };
}

// 檢查並整理 AI 回傳的 JSON，欄位長度和網頁 cleanReviews 的限制一致
export function cleanReview(txt) {
  const m = String(txt || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("回應裡沒有 JSON：" + String(txt).slice(0, 200));
  const r = JSON.parse(m[0]);
  const cut = (v, n) => String(v == null ? "" : v).slice(0, n);
  const arr = v => Array.isArray(v) ? v.slice(0, 8).map(t => cut(t, 300)).filter(Boolean) : [];
  const out = { sum: cut(r.sum, 600), good: arr(r.good), warn: arr(r.warn), act: arr(r.act), goal: cut(r.goal, 300) };
  if (!out.sum && !out.act.length) throw new Error("回應缺少內容：" + m[0].slice(0, 200));
  return out;
}

// 列出這把金鑰能用、而且能產生文字的模型
async function availableModels() {
  const out = [];
  let page = "";
  do {
    const res = await fetch(`${API}/models?pageSize=200${page ? "&pageToken=" + page : ""}`, { headers: KEY_HEADERS() });
    if (!res.ok) throw new Error(`讀不到模型清單：${res.status} ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    for (const m of d.models || []) {
      if ((m.supportedGenerationMethods || []).includes("generateContent")) out.push({ id: m.name.replace(/^models\//, ""), name: m.displayName || "" });
    }
    page = d.nextPageToken || "";
  } while (page);
  return out;
}

export async function callGeminiOnce(model, summary, thinking) {
  const generationConfig = { responseMimeType: "application/json", maxOutputTokens: 8192 };
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking };
  const res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: KEY_HEADERS(),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: "這是我這個月的記帳摘要，請寫月報分析：\n" + JSON.stringify(summary) }] }],
      generationConfig,
    }),
  });
  const body = await res.text();
  if (!res.ok) { const e = new Error(`Gemini 回應 ${res.status}：${body.slice(0, 300)}`); e.status = res.status; throw e; }
  const d = JSON.parse(body), c = d.candidates && d.candidates[0];
  const txt = c && c.content && (c.content.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
  if (!txt) throw new Error("Gemini 沒有回傳內容：" + body.slice(0, 300));
  return cleanReview(txt);
}

// 思考等級設低（月報只是整理摘要，不需要想很久，也避免超過 5 分鐘逾時）；
// 模型不支援這個設定（400）就拿掉再試；逾時或暫時錯誤（5xx/429）再試一次
export async function callGemini(model, summary) {
  let thinking = "low";
  for (let i = 0; i < 3; i++) {
    try { return await callGeminiOnce(model, summary, thinking); }
    catch (e) {
      if (e.status === 400 && thinking && /thinking/i.test(e.message)) { console.log("這個模型不支援 thinkingLevel，改用預設"); thinking = null; continue; }
      const retry = !e.status || e.status === 429 || e.status >= 500;
      if (!retry || i === 2) throw e;
      console.log("暫時失敗，30 秒後重試：", e.message.slice(0, 120));
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

// 指定的模型不存在（例如舊版被下架）時，自動改用清單裡最新的 flash 模型
export async function pickModel(wanted) {
  const list = await availableModels();
  if (wanted && list.some(m => m.id === wanted)) return wanted;
  const ver = id => id.match(/^gemini-([\d.]+)-flash$/)[1].split(".").map(Number);
  const flash = list.map(m => m.id).filter(id => /^gemini-[\d.]+-flash$/.test(id))
    .sort((a, b) => { const x = ver(a), y = ver(b); return (y[0] - x[0]) || ((y[1] || 0) - (x[1] || 0)); });
  const alt = flash[0] || (list.find(m => /flash/.test(m.id)) || {}).id;
  if (!alt) throw new Error(`找不到模型 ${wanted}，也沒有可替代的 flash 模型`);
  console.log(wanted ? `找不到模型 ${wanted}，改用 ${alt}` : `自動選用最新的 flash 模型：${alt}`);
  return alt;
}

async function listModels(model) {
  const list = await availableModels();
  console.log("可以用的模型（填在 model 欄位的是 id）：");
  for (const m of list) console.log(`- ${m.id}　${m.name}`);
  const use = await pickModel(model);
  try { const r = await callGemini(use, { 測試: "只是測試，請隨便寫一句總結", 記帳筆數: 0 }); console.log(`試打 ${use} 成功：`, r.sum); }
  catch (e) { console.log(`試打 ${use} 失敗：`, e.message); }
}

async function main() {
  const now = taipeiNow();
  const thisMk = now.toISOString().slice(0, 7);
  const mk = MRE.test(process.env.MONTH || "") ? process.env.MONTH : prevMonth(thisMk);
  const force = process.env.FORCE === "1";
  if (!process.env.GEMINI_API_KEY) { console.log("還沒設定 GEMINI_API_KEY，這次不產生分析。"); return; }
  let model = (process.env.MODEL || "").trim() || DEFAULT_MODEL;
  if (process.env.LIST_MODELS === "1") { await listModels(model); return; }
  model = await pickModel(model);
  console.log("分析月份：", mk, force ? "（強制重寫）" : "", "模型：", model);

  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();
  const snap = await db.collection("jizhangState").get();
  let failed = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {}, who = doc.id.slice(0, 6) + "…";
    const has = data.reviews && data.reviews.m && data.reviews.m[mk];
    if (has && !force) { console.log(`帳號 ${who}：${mk} 已經有分析，略過`); continue; }
    const summary = summarize(data, mk);
    if (!summary.記帳筆數) { console.log(`帳號 ${who}：${mk} 沒有紀錄，略過`); continue; }
    try {
      const review = await callGemini(model, summary);
      review.by = model;
      review.at = now.toISOString().slice(0, 10);
      await doc.ref.update(new FieldPath("reviews", "m", mk), review);
      console.log(`帳號 ${who}：已寫入 ${mk} 月報分析`);
    } catch (e) {
      failed++;
      console.error(`帳號 ${who}：失敗`, e);
    }
  }
  if (failed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
