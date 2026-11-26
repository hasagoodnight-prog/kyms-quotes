// 暫時用：咖啡組還沒買 → 刪掉 11/26 那筆 11,500，改排進 12 月消費計畫
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath, FieldValue } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const snap = await getFirestore().collection("jizhangState").get();
for (const doc of snap.docs) {
  const x = doc.data() || {}, s = x.settings;
  if (!s) continue;
  const upd = [];
  const m = (x.months && x.months["2026-11"]) || {};
  const ids = Object.keys(m).filter(id => m[id] && m[id].t === "e" && m[id].a === 11500 && m[id].n === "咖啡套組");
  for (const id of ids) upd.push(new FieldPath("months", "2026-11", id), FieldValue.delete());
  const plan = (s.plan || []).filter(p => !(p && /咖啡/.test(p.n || "")));
  plan.push({ id: "coffee" + Date.now().toString(36), n: "咖啡設備（咖啡機＋磨豆機＋秤）", a: 10412, d: "2026-12-10" });
  upd.push(new FieldPath("settings", "plan"), plan);
  await doc.ref.update(...upd);
  console.log("刪除支出", ids.length, "筆；消費計畫已排入 12 月");
}
