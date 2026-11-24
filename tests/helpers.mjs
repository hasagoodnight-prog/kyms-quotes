// 測試共用：從 repo 檔案提供網頁、注入測試掛鉤、用假的雲端（cloudSync）取代 Firebase
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LIBS = [
  [/lightweight-charts@[\d.]+\/dist\/lightweight-charts\.standalone\.production\.js/, "node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js"],
  [/echarts@[\d.]+\/dist\/echarts\.min\.js/, "node_modules/echarts/dist/echarts.min.js"],
];

export async function openApp(page, { state, privacy = false, errors } = {}) {
  if (errors) page.on("pageerror", e => errors.push(e.message));
  await page.route(/gstatic\.com|googleapis\.com/, r => r.abort());
  await page.route(/cdn\.jsdelivr\.net/, r => {
    const hit = LIBS.find(([re]) => re.test(r.request().url()));
    return hit ? r.fulfill({ contentType: "application/javascript", body: readFileSync(join(ROOT, hit[1])) }) : r.abort();
  });
  await page.route("https://app.test/**", r => {
    let f = new URL(r.request().url()).pathname.replace(/^\//, "") || "index.html";
    const p = join(ROOT, f);
    if (!existsSync(p)) return r.fulfill({ status: 404, body: "" });
    if (f === "index.html") {
      let s = readFileSync(p, "utf8");
      const i = s.lastIndexOf("})();");
      s = s.slice(0, i) + "window.__t={S,saveLocal,renderAll};\n" + s.slice(i);
      return r.fulfill({ contentType: "text/html", body: s });
    }
    return r.fulfill({ body: readFileSync(p) });
  });
  await page.goto("https://app.test/");
  await page.evaluate(p => { try { localStorage.setItem("ledger-priv", p ? "1" : "0"); } catch (e) {} }, privacy);
  await page.reload();
  await page.waitForFunction(() => window.__t);
  if (state) await login(page, state);
}

// 假雲端：存在頁面裡的 window.__server；patch 會套用到它並通知監聽者
export async function login(page, state) {
  await page.evaluate(async st => {
    const apply = (t, ops) => { for (const [path, val] of ops) { let o = t; for (let i = 0; i < path.length - 1; i++) { if (!o[path[i]] || typeof o[path[i]] !== "object") o[path[i]] = {}; o = o[path[i]]; } const k = path[path.length - 1]; if (val === null) delete o[k]; else o[k] = JSON.parse(JSON.stringify(val)); } };
    window.__server = JSON.parse(JSON.stringify(st));
    window.__ops = [];
    window.cloudSync = {
      uid: "test",
      getState: async () => JSON.parse(JSON.stringify(window.__server)),
      setState: async d => { window.__server = JSON.parse(JSON.stringify(d)); },
      patch: async ops => { window.__ops.push(...ops); apply(window.__server, ops); },
      watch: cb => { window.__push = d => cb(JSON.parse(JSON.stringify(d))); return () => {}; },
    };
    document.getElementById("login-overlay").style.display = "none";
    document.getElementById("app-root").style.display = "";
    window.dispatchEvent(new CustomEvent("cloud-user-ready"));
    await new Promise(r => setTimeout(r, 300));
  }, state);
}

export const tab = (page, t) => page.evaluate(t => { document.body.setAttribute("data-tab", t); window.dispatchEvent(new Event("resize")); }, t);

export function cats(extra = {}) {
  return {
    e: [{ id: "food", n: "伙食", b: 15000 }, { id: "daily", n: "日用品", b: 1000 }, { id: "trans", n: "交通", b: 700 }, { id: "rent", n: "房租", b: 5500 }],
    i: [{ id: "salary", n: "薪資" }, { id: "yield", n: "投資收益" }],
    s: [{ id: "dca", n: "定期定額" }, { id: "deposit", n: "儲蓄存款" }],
    ...extra,
  };
}
export const E = (t, c, a, d, n = "x") => ({ t, c, a, d, n, ts: 1 });
