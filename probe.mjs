// 暫時用：檢查 GitHub Models 各網址的回應
const H = { authorization: "Bearer " + process.env.GITHUB_TOKEN, "content-type": "application/json", accept: "application/json" };
const body = JSON.stringify({ model: "openai/gpt-4.1", messages: [{ role: "user", content: "say hi" }], max_tokens: 20 });
const tries = [
  ["GET", "https://models.github.ai/catalog/models"],
  ["POST", "https://models.github.ai/inference/chat/completions"],
  ["POST", "https://models.github.ai/v1/chat/completions"],
  ["POST", "https://models.inference.ai.azure.com/chat/completions"],
  ["GET", "https://api.github.com/models"],
];
for (const [m, u] of tries) {
  try {
    const r = await fetch(u, { method: m, headers: H, body: m === "POST" ? body : undefined, redirect: "manual" });
    console.log(m, u, r.status, r.headers.get("content-type"), r.headers.get("location") || "", (await r.text()).slice(0, 200).replace(/\s+/g, " "));
  } catch (e) { console.log(m, u, "ERR", e.message); }
}
