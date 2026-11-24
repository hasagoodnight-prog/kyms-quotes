// 每月 1 日：把上個月的記帳整理成摘要，請 AI 寫月報分析，存進 Firebase 的 jizhangState/{uid}.reviews.m[YYYY-MM]
// 用 GitHub Models（GitHub 免費額度，GitHub Actions 內用 GITHUB_TOKEN，不需要另外的金鑰）。
// 網頁「月報」會優先顯示這份分析；已經寫過的月份不會重寫（FORCE=1 可強制重寫）。
// 環境變數：FIREBASE_SERVICE_ACCOUNT、GITHUB_TOKEN；可選 MODEL、MONTH=2026-11、FORCE=1、LIST_MODELS=1
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";

const INFER = "https://models.github.ai/inference/chat/completions";
const CATALOG = "https://models.github.ai/catalog/models";
const DEFAULT_MODEL = "openai/gpt-4.1";
const GH_HEADERS = () => ({
  authorization: "Bearer " + process.env.GITHUB_TOKEN,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "content-type": "application/json",
});

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

async function writeReview(model, summary) {
  const res = await fetch(INFER, {
    method: "POST",
    headers: GH_HEADERS(),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: "這是我這個月的記帳摘要，請寫月報分析：\n" + JSON.stringify(summary) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2000,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`GitHub Models 回應 ${res.status}：${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  return cleanReview(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
}

async function listModels() {
  const res = await fetch(CATALOG, { headers: GH_HEADERS() });
  if (!res.ok) throw new Error("讀不到模型清單：" + res.status);
  const list = await res.json();
  console.log("可以用的模型（填在 model 欄位的是 id）：");
  for (const m of list) console.log(`- ${m.id}　${m.name || ""}　額度等級：${m.rate_limit_tier || "?"}`);
}

async function main() {
  const now = taipeiNow();
  const thisMk = now.toISOString().slice(0, 7);
  const mk = MRE.test(process.env.MONTH || "") ? process.env.MONTH : prevMonth(thisMk);
  const force = process.env.FORCE === "1";
  const model = (process.env.MODEL || "").trim() || DEFAULT_MODEL;
  if (process.env.LIST_MODELS === "1") { await listModels(); return; }
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
      const review = await writeReview(model, summary);
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
