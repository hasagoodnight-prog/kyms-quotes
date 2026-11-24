// 舊網站的離線快取在這裡移除：清掉快取、取消註冊，並把開著的分頁導到新網址
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: "window" })) c.navigate("https://hasagoodnight-prog.github.io/kyms-quotes/");
  })());
});
