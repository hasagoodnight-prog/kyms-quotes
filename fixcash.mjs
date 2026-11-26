// 暫時用：記帳台現金校正為 54,400（銀行 56,000，還有一次皮膚科 1,600 未扣；記帳台已記兩次共 3,200）
// 只調整起始資產（settings.base），不新增收支紀錄
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const BANK = 56000, PAID_IN_BANK = 1600;   // 銀行已扣一次皮膚科
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
  const cash = base + net - sav - dep;                         // 和網頁 assetThrough 同一個算法
  const target = BANK - Math.max(0, medNow - PAID_IN_BANK);    // 記帳台記了、銀行還沒扣的部分
  await doc.ref.update(new FieldPath("settings", "base"), base + (target - cash), new FieldPath("settings", "baseSet"), 1);
  console.log("校正完成：記帳台現金＝銀行存款扣掉未扣的皮膚科", medNow - PAID_IN_BANK === 1600 ? "（1,600）" : "（記帳台醫療紀錄與預期不同，請檢查）");
}
