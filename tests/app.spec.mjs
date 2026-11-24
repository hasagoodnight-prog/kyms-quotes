// 網頁功能測試：每一項都用假的雲端資料，跑在真的瀏覽器裡
import { test, expect } from "@playwright/test";
import { openApp, tab, cats, E } from "./helpers.mjs";

const MK = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);   // 這個月（台灣時間）
const prevMk = (mk, n = 1) => { const d = new Date(Date.UTC(+mk.slice(0, 4), +mk.slice(5) - 1 - n, 1)); return d.toISOString().slice(0, 7); };
const D = (mk, day = "05") => mk + "-" + day;

test("登入後正常顯示、沒有程式錯誤", async ({ page }) => {
  const errors = [];
  await openApp(page, { errors, state: { settings: { cats: cats() }, months: { [MK]: { a: E("e", "food", 300, D(MK)) } }, quotes: null } });
  await expect(page.locator("#statusTxt")).toHaveText("已同步到雲端");
  expect(errors).toEqual([]);
});

test("記一筆只送出那一筆（不整包覆蓋）", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await openApp(page, { state: { settings: { cats: cats() }, months: { [MK]: { old: E("e", "food", 100, D(MK)) } }, quotes: null } });
  await page.fill("#amt", "250");
  await page.fill("#note", "午餐");
  await page.click("#submit");
  await expect.poll(() => page.evaluate(() => window.__ops.length)).toBeGreaterThan(0);
  const ops = await page.evaluate(() => window.__ops);
  expect(ops.every(([path]) => path[0] === "months" && path.length === 3)).toBe(true);
  const server = await page.evaluate(() => window.__server.months);
  expect(Object.values(server[Object.keys(server).find(k => Object.keys(server[k]).length > 1)]).map(e => e.n).sort()).toEqual(["x", "午餐"]);
});

test("別台裝置的變更即時合併，本機還沒送出的不會不見", async ({ page }) => {
  await openApp(page, { state: { settings: { cats: cats() }, months: { [MK]: { a: E("e", "food", 100, D(MK)) } }, quotes: null } });
  await page.evaluate(mk => {
    const { S } = window.__t;
    S.months[mk].mine = { t: "e", c: "food", a: 50, d: mk + "-06", n: "本機", ts: 2 };   // 本機改了還沒存
    const remote = JSON.parse(JSON.stringify(window.__server));
    remote.months[mk].other = { t: "e", c: "trans", a: 30, d: mk + "-07", n: "別台", ts: 3 };
    remote.quotes = { px: { "00919": { p: 22.5, d: mk + "-07", src: "auto" } }, at: "" };
    window.__server = remote;   // 別台裝置／排程已經寫進雲端
    window.__push(remote);
  }, MK);
  const ids = await page.evaluate(mk => Object.keys(window.__t.S.months[mk]).sort(), MK);
  expect(ids).toEqual(["a", "mine", "other"]);
  await expect.poll(() => page.evaluate(mk => Object.keys(window.__server.months[mk]).sort(), MK)).toEqual(["a", "mine", "other"]);
  expect(await page.evaluate(() => window.__t.S.quotes.px["00919"].p)).toBe(22.5);
});

test("自動分類：規則優先，其次用過去紀錄；手動選了就不改", async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 1000 });
  await openApp(page, { state: {
    settings: { cats: cats(), ar: [{ k: "全聯", t: "e", c: "daily" }] },
    months: { [MK]: { a: E("e", "trans", 30, D(MK), "捷運"), b: E("e", "trans", 30, D(MK, "06"), "捷運") } }, quotes: null } });
  const cat = () => page.evaluate(() => document.querySelector("#chips input:checked").value);
  await page.fill("#note", "全聯 衛生紙");
  expect(await cat()).toBe("daily");
  await page.fill("#note", "捷運");
  expect(await cat()).toBe("trans");
  await page.check('#chips input[value="food"]', { force: true });
  await page.fill("#note", "全聯");
  expect(await cat()).toBe("food");
});

test("預算滾存：上個月沒花完的加到這個月", async ({ page }) => {
  const p1 = prevMk(MK);
  await openApp(page, { state: {
    settings: { cats: cats({ e: [{ id: "food", n: "伙食", b: 15000, ro: 1, ros: p1 }] }) },
    months: { [p1]: { a: E("e", "food", 12000, D(p1)) }, [MK]: { a: E("e", "food", 1000, D(MK)) } }, quotes: null } });
  await expect(page.locator("#ruleChk")).toContainText("1,000 / 18,000");
});

test("每月計畫：改金額後存到雲端，先存目標跟著變", async ({ page }) => {
  await openApp(page, { state: { settings: { cats: cats() }, months: {}, quotes: null } });
  await tab(page, "home");
  await page.click('[data-rs="plan"] .ptop');
  await page.click('[data-mp="edit"]');
  await page.fill('input[data-k="sav"][data-i="0"][data-f="a"]', "8000");
  await page.click('[data-mp="save"]');
  await expect.poll(() => page.evaluate(() => window.__server.settings.mp && window.__server.settings.mp.sav[0].a)).toBe(8000);
  await expect(page.locator(".rsave")).toContainText("11,000");
});

test("錢的流向圖畫得出來", async ({ page }) => {
  await openApp(page, { state: { settings: { cats: cats() },
    months: { [MK]: { a: E("i", "salary", 40000, D(MK)), b: E("e", "food", 9000, D(MK)), c: E("e", "rent", 5500, D(MK)), d: E("s", "dca", 3000, D(MK)) } }, quotes: null } });
  await tab(page, "stats");
  await page.locator("#flowPanel").scrollIntoViewIfNeeded();
  await expect(page.locator("#flowChart svg path").first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#flowNote")).toContainText("收入 NT$40,000");
});

test("持股走勢圖與即將入帳股息", async ({ page }) => {
  const d = [], c = [];
  for (let i = 0; i < 60; i++) { const t = new Date(Date.UTC(2026, 5, 1 + i)); d.push(t.toISOString().slice(0, 10)); c.push(+(20 + i * 0.03).toFixed(2)); }
  await openApp(page, { state: { settings: { cats: cats(), hold: [{ sym: "00919", n: "", sh: 1000, cost: 19 }] }, months: {},
    quotes: { px: { "00919": { p: 22, d: d[59], src: "auto" } }, at: "" }, ph: { "00919": { d, c } },
    divs: [{ sym: "00919", exd: "2099-12-16", pay: "2099-12-30", cps: 0.7, sh: 1000, gross: 700, net: 700 }] } });
  await tab(page, "stats");
  await page.locator("#hcBox").scrollIntoViewIfNeeded();
  await expect(page.locator("#hcChart canvas").first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#hDiv")).toContainText("約 NT$700");
});

test("離線時顯示「已存在這台裝置」，連線後同步", async ({ page, context }) => {
  await openApp(page, { state: { settings: { cats: cats() }, months: {}, quotes: null } });
  await page.evaluate(() => { const orig = window.cloudSync.patch; window.__hold = []; window.cloudSync.patch = ops => new Promise(r => window.__hold.push(() => orig(ops).then(r))); });
  await context.setOffline(true);
  await page.evaluate(mk => { const { S, saveLocal } = window.__t; S.months[mk] = { z: { t: "e", c: "food", a: 80, d: mk + "-03", n: "離線", ts: 1 } }; saveLocal(); }, MK);
  await expect(page.locator("#statusTxt")).toHaveText("離線：已存在這台裝置，連上網自動同步");
  await context.setOffline(false);
  await page.evaluate(() => window.__hold.forEach(f => f()));
  await expect(page.locator("#statusTxt")).toHaveText("已同步到雲端");
});
