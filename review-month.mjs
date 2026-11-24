// 每月 1 日：把上個月的記帳整理成摘要，請 Claude 寫月報分析，存進 Firebase 的 jizhangState/{uid}.reviews.m[YYYY-MM]
// 網頁「月報」會優先顯示這份分析；已經寫過的月份不會重寫（FORCE=1 可強制重寫）。
// 環境變數：FIREBASE_SERVICE_ACCOUNT、ANTHROPIC_API_KEY；可選 MONTH=2026-11、FORCE=1
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const SAVE_GOAL = 10000; // 和網頁的「每月先存」目標一致
const MRE = /^\d{4}-\d{2}$/;

const ReviewSchema = z.object({
  sum: z.string().describe("一段總結，150 字以內"),
  good: z.array(z.string()).describe("做得好的地方，1–4 點"),
  warn: z.array(z.string()).describe("要注意的地方，1–4 點"),
  act: z.array(z.string()).describe("下個月具體可做的改善，2–4 點"),
  goal: z.string().describe("下個月一個可量化的目標，一句話"),
});

const SYSTEM = `你是使用者的記帳助理，幫他寫每月的消費回顧。使用者在台灣，用繁體中文（台灣用語）回覆，金額用 NT$ 和千分位。
語氣像朋友：直接、具體、不說教。每一點都要引用摘要裡的實際數字或項目，不要寫空泛的理財建議。
重點看：每月先存 ${SAVE_GOAL} 有沒有達標、哪些分類超出預算、伙食每天平均多少、大額或不必要的花費、和上個月比的變化。
固定支出（房租、訂閱、醫療這類）使用者已經說過不能改，不要建議砍它們。
各欄位字數：sum 150 字內；good / warn / act 每點 60 字內；goal 一句話。`;

function taipeiNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function prevMonth(mk) {
  const [y, m] = mk.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
const daysIn = mk => new Date(+mk.slice(0, 4), +mk.slice(5, 7), 0).getDate();

// 把某個月的資料整理成給 Claude 看的摘要（只含這次分析需要的欄位）
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

async function writeReview(client, summary) {
  const res = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "high", format: zodOutputFormat(ReviewSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: "這是我這個月的記帳摘要，請寫月報分析：\n" + JSON.stringify(summary, null, 1) }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude 拒絕回應：" + JSON.stringify(res.stop_details));
  if (!res.parsed_output) throw new Error("回應無法解析，stop_reason=" + res.stop_reason);
  const r = res.parsed_output, cut = (s, n) => String(s || "").slice(0, n), arr = a => (a || []).slice(0, 8).map(t => cut(t, 300));
  return { sum: cut(r.sum, 600), good: arr(r.good), warn: arr(r.warn), act: arr(r.act), goal: cut(r.goal, 300) };
}

async function main() {
  const now = taipeiNow();
  const thisMk = now.toISOString().slice(0, 7);
  const mk = MRE.test(process.env.MONTH || "") ? process.env.MONTH : prevMonth(thisMk);
  const force = process.env.FORCE === "1";
  console.log("分析月份：", mk, force ? "（強制重寫）" : "");

  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();
  const client = new Anthropic();
  const snap = await db.collection("jizhangState").get();
  let failed = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {}, who = doc.id.slice(0, 6) + "…";
    const has = data.reviews && data.reviews.m && data.reviews.m[mk];
    if (has && !force) { console.log(`帳號 ${who}：${mk} 已經有分析，略過`); continue; }
    const summary = summarize(data, mk);
    if (!summary.記帳筆數) { console.log(`帳號 ${who}：${mk} 沒有紀錄，略過`); continue; }
    try {
      const review = await writeReview(client, summary);
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
