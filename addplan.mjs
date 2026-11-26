// 暫時用：在消費計畫新增「咖啡套組」（已存在就不重複加）
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const item = { id: "coffee" + Date.now().toString(36), n: "咖啡套組", a: 11500, d: "2027-02-25" };
const snap = await getFirestore().collection("jizhangState").get();
let n = 0;
for (const doc of snap.docs) {
  const s = (doc.data() || {}).settings;
  if (!s) continue;
  if ((s.plan || []).some(p => p && p.n === item.n)) { console.log("已經有「咖啡套組」，不重複新增"); continue; }
  await doc.ref.update({ "settings.plan": FieldValue.arrayUnion(item) });
  n++;
}
console.log("新增消費計畫：", n, "個帳號");
