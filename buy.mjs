// 暫時用：記下 11/26 下單的咖啡設備（娛樂 10,462），並移除消費計畫裡的咖啡設備；已記過就不重複
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const d = "2026-11-26", mk = "2026-11", A = 10462, N = "咖啡設備（咖啡機＋磨豆機＋秤）";
const snap = await getFirestore().collection("jizhangState").get();
for (const doc of snap.docs) {
  const x = doc.data() || {}, s = x.settings;
  if (!s) continue;
  const cats = (s.cats && s.cats.e) || [];
  const fun = cats.find(c => c.id === "fun") || cats.find(c => c.n === "娛樂");
  if (!fun) { console.log("找不到娛樂分類，沒有記帳"); continue; }
  const m = (x.months && x.months[mk]) || {};
  const dup = Object.values(m).some(e => e && e.t === "e" && e.a === A && /咖啡設備/.test(e.n || ""));
  const upd = [];
  if (!dup) upd.push(new FieldPath("months", mk, "cf" + Date.now().toString(36)), { t: "e", c: fun.id, a: A, d, n: N, ts: Date.now(), f: 0 });
  const plan = (s.plan || []).filter(p => !(p && /咖啡/.test(p.n || "")));
  if (plan.length !== (s.plan || []).length) upd.push(new FieldPath("settings", "plan"), plan);
  if (upd.length) await doc.ref.update(...upd);
  console.log(dup ? "已經記過，沒有重複" : "已記帳 1 筆", "；消費計畫", plan.length !== (s.plan || []).length ? "已移除" : "沒有需要移除的");
}
