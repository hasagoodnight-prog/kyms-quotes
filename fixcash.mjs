// 暫時用：把記帳台算出的現金校正成銀行實際存款（調整起始資產，不新增收支紀錄）
// 銀行 56,000 還沒扣這個月的皮膚科：記帳台已記 → 校正成 52,800；還沒記 → 56,000
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const BANK = 56000, DERM = 3200;
const mkNow = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
const snap = await getFirestore().collection("jizhangState").get();
for (const doc of snap.docs) {
  const x = doc.data() || {}, s = x.settings;
  if (!s) continue;
  const medId = (((s.cats && s.cats.e) || []).find(c => c.id === "med" || c.n === "醫療") || {}).id || "med";
  let net = 0, sav = 0, dep = 0, medNow = 0;
  for (const [mk, m] of Object.entries(x.months || {})) {
    if (mk > mkNow) continue;
    for (const e of Object.values(m || {})) {
      if (!e || !(Number(e.a) > 0)) continue;
      const a = Number(e.a);
      if (e.t === "i") net += a; else if (e.t === "e") net -= a;
      if (e.t === "s" && e.c === "dep") dep += a; else if (e.t === "s") sav += a;
      if (mk === mkNow && e.t === "e" && e.c === medId) medNow += a;
    }
  }
  const base = Number(s.base) || 0;
  const cash = base + net - sav - dep;                 // 和網頁 assetThrough 同一個算法
  const recorded = medNow >= DERM;
  const target = recorded ? BANK - DERM : BANK;
  await doc.ref.update(new FieldPath("settings", "base"), base + (target - cash), new FieldPath("settings", "baseSet"), 1);
  console.log("本月皮膚科已記在記帳台：", recorded ? "是" : "否", "；現金已校正");
}
