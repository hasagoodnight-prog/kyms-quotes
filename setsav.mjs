// 暫時用：每月計畫的先存目標改成 6,000（沿用原本的項目名稱）
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const snap = await getFirestore().collection("jizhangState").get();
for (const doc of snap.docs) {
  const s = (doc.data() || {}).settings;
  if (!s) continue;
  const mp = s.mp || {};
  const first = (Array.isArray(mp.sav) && mp.sav[0] && mp.sav[0].n) || "定期定額";
  await doc.ref.update(new FieldPath("settings", "mp", "sav"), [{ n: first, a: 6000 }]);
  console.log("先存目標已改成 6,000");
}
