// 暫時用：伙食預算 12,400（每天 400 × 31）、娛樂預算 3,000（每月計畫裡同名的項目一起改）
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const NEW = { 伙食: 12400, 娛樂: 3000 };
const snap = await getFirestore().collection("jizhangState").get();
for (const doc of snap.docs) {
  const s = (doc.data() || {}).settings;
  if (!s || !s.cats || !Array.isArray(s.cats.e)) continue;
  let n = 0;
  const e = s.cats.e.map(c => (c && !c.h && NEW[c.n] != null) ? (n++, { ...c, b: NEW[c.n] }) : c);
  const upd = [new FieldPath("settings", "cats", "e"), e];
  if (s.mp && Array.isArray(s.mp.fix)) upd.push(new FieldPath("settings", "mp", "fix"), s.mp.fix.map(q => (q && NEW[q.n] != null) ? { ...q, a: NEW[q.n] } : q));
  await doc.ref.update(...upd);
  const total = e.filter(c => c && !c.h).reduce((t, c) => t + (Number(c.b) || 0), 0);
  console.log("已改", n, "個分類預算；預算合計", total);
}
