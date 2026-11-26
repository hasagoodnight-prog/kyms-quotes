// 暫時用：讀出記帳資料，用 Claude 這次對話的臨時公鑰加密後才印出（公開記錄上只有亂碼）
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Encrypter, armor } from "age-encryption";
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const snap = await getFirestore().collection("jizhangState").get();
const out = {};
for (const d of snap.docs) {
  const x = d.data() || {};
  const months = {};
  for (const mk of Object.keys(x.months || {}).sort().slice(-6)) months[mk] = x.months[mk];
  out[d.id.slice(0, 6)] = { settings: x.settings, months, quotes: x.quotes, plh: x.plh, divs: x.divs };
}
const e = new Encrypter(); e.addRecipient("age1uj08t6mtexc46awlvv5x2ga8xrchy92yww4kp5p7x7rdnygkr4asxxkzcs");
console.log(armor.encode(await e.encrypt(JSON.stringify(out))));
