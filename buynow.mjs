// 暫時用：記下今天買的咖啡套組（娛樂 11,500），並移除對應的消費計畫；已記過就不重複
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const d = "2026-11-26", mk = d.slice(0, 7);
const snap = await getFirestore().collection("jizhangState").get();
for (const doc of snap.docs) {
  const x = doc.data() || {}, s = x.settings;
  if (!s) continue;
  const fun = ((s.cats && s.cats.e) || []).find(c => c.id === "fun") || ((s.cats && s.cats.e) || []).find(c => c.n === "娛樂");
  if (!fun) { console.log("找不到娛樂分類，沒有記帳"); continue; }
  const dup = Object.values((x.months && x.months[mk]) || {}).some(e => e && e.t === "e" && e.a === 11500 && /咖啡套組/.test(e.n || ""));
  const upd = [];
  if (!dup) {
    const id = "cf" + Date.now().toString(36);
    upd.push(new FieldPath("months", mk, id), { t: "e", c: fun.id, a: 11500, d, n: "咖啡套組", ts: Date.now(), f: 0 });
  }
  const plan = (s.plan || []).filter(p => !(p && p.n === "咖啡套組"));
  if (plan.length !== (s.plan || []).length) upd.push(new FieldPath("settings", "plan"), plan);
  if (upd.length) await doc.ref.update(...upd);
  console.log(dup ? "這筆已經記過，沒有重複" : "已記帳 1 筆", "；消費計畫", plan.length !== (s.plan || []).length ? "已移除" : "沒有需要移除的");
}
