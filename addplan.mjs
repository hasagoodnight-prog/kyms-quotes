// 暫時用：消費計畫新增「高鐵回老家」2,500（12/5），已有就不重複
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const item = { id: "hsr" + Date.now().toString(36), n: "高鐵回老家（高雄↔新竹 12/5–12/6）", a: 2500, d: "2026-12-05" };
const snap = await getFirestore().collection("jizhangState").get();
for (const doc of snap.docs) {
  const s = (doc.data() || {}).settings;
  if (!s) continue;
  if ((s.plan || []).some(p => p && /高鐵回老家/.test(p.n || ""))) { console.log("已經有，不重複新增"); continue; }
  await doc.ref.update({ "settings.plan": FieldValue.arrayUnion(item) });
  console.log("已新增消費計畫 1 項");
}
