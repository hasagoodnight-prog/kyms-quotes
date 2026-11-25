// 收支記帳台：台股即時報價中繼站（Cloudflare Workers，免費方案即可）
// 證交所即時行情不允許網頁直接讀取（沒有 CORS），由這裡代抓後回傳給你的網頁。
// 用法：GET https://<你的 worker>.workers.dev/?s=00919,T00   （T00＝台股加權指數）
// 只接受你的網站來源、只接受股票代號，10 秒內重複查詢直接用快取，不會一直打證交所。

const ALLOW_ORIGINS = ["https://hasagoodnight-prog.github.io"];
const MIS = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";

const num = v => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : NaN; };

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("origin") || "";
    const cors = {
      "access-control-allow-origin": ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0],
      "access-control-allow-methods": "GET, OPTIONS",
      "vary": "origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors });

    const url = new URL(req.url);
    const syms = [...new Set(String(url.searchParams.get("s") || "").toUpperCase().split(",").map(s => s.trim()).filter(s => /^[0-9A-Z]{1,8}$/.test(s)))].slice(0, 20).sort();
    if (!syms.length) return json({ error: "請用 ?s=代號,代號" }, 400, cors);

    const key = new Request("https://cache.local/?s=" + syms.join(","));
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...cors } });

    const ex = syms.flatMap(s => s === "T00" ? ["tse_t00.tw"] : [`tse_${s.toLowerCase()}.tw`, `otc_${s.toLowerCase()}.tw`]).join("|");
    let data;
    try {
      const r = await fetch(`${MIS}?ex_ch=${encodeURIComponent(ex)}&json=1&delay=0&_=${Date.now()}`, {
        headers: { "user-agent": "Mozilla/5.0", "referer": "https://mis.twse.com.tw/stock/index.jsp" },
      });
      data = await r.json();
    } catch (e) {
      return json({ error: "證交所暫時連不上" }, 502, cors);
    }
    const px = {};
    for (const m of data.msgArray || []) {
      const c = String(m.c || "").toUpperCase();
      if (!syms.includes(c)) continue;
      let p = num(m.z);
      if (!(p > 0)) p = num(String(m.b || "").split("_")[0]);   // 這幾秒沒成交：用最佳買價
      const y = num(m.y);
      if (p > 0) px[c] = { p, y: y > 0 ? y : null, t: String(m.t || ""), d: String(m.d || "") };
    }
    const res = json({ at: Date.now(), px }, 200, { ...cors, "cache-control": "public, max-age=10" });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },
};

function json(o, status, headers) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
