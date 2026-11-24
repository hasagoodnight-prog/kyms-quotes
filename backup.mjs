// 每週加密備份：把 Firebase 裡所有記帳資料（jizhangState）匯出成 JSON，用 age 公鑰加密後輸出。
// 公鑰放在 backup-recipient.txt（公鑰本來就可以公開）；私鑰只在你手上，GitHub 和這支程式都拿不到。
// 用法：node backup.mjs <輸出檔路徑>　環境變數：FIREBASE_SERVICE_ACCOUNT
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { Encrypter } from "age-encryption";

// 讀公鑰：一行一把，# 開頭是註解；可以放多把（例如手機一把、電腦一把，任一把都能解）
export function readRecipients(path = "backup-recipient.txt") {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
}

// Firestore 的時間型別轉成字串，其餘照原樣
const plain = v => JSON.parse(JSON.stringify(v, (k, x) => x instanceof Timestamp ? x.toDate().toISOString() : x));

export async function encryptJson(obj, recipients) {
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  return e.encrypt(JSON.stringify(obj));
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("請給輸出檔路徑");
  const recipients = readRecipients();
  if (!recipients.length) { console.log("還沒設定公鑰（backup-recipient.txt），這次不備份。"); return; }

  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const snap = await getFirestore().collection("jizhangState").get();
  const docs = {};
  snap.docs.forEach(d => { docs[d.id] = plain(d.data()); });
  const payload = { app: "收支記帳台", kind: "jizhangState-backup", v: 1, exportedAt: new Date().toISOString(), docs };

  const ct = await encryptJson(payload, recipients);
  writeFileSync(out, ct);
  // 公開 repo 的執行記錄任何人都看得到：只印筆數和大小，不印內容
  console.log(`已加密備份 ${snap.size} 個帳號，${(ct.length / 1024).toFixed(1)} KB，公鑰 ${recipients.length} 把`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
