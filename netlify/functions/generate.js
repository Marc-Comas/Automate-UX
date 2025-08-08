// /.netlify/functions/generate.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return resp(405, { error: "Method Not Allowed" });
    }
    const { prompt, name, assistantId = process.env.OPENAI_ASSISTANT_ID } = JSON.parse(event.body || "{}");
    if (!prompt) return resp(400, { error: "Falta prompt" });
    if (!assistantId) return resp(500, { error: "Falta OPENAI_ASSISTANT_ID" });
    if (!process.env.OPENAI_API_KEY) return resp(500, { error: "Falta OPENAI_API_KEY" });

    // 1) Thread + user message
    const thread = await client.beta.threads.create();
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: [
        { type: "text", text: `Proyecto: ${name || "proyecto"}\n\nBrief:\n${prompt}\n\nResponde SOLO JSON con este esquema:\n{\n  "files": { "index.html": "<html>...</html>", "styles/style.css": "...", "scripts/app.js": "..." }\n}\n` }
      ]
    });

    // 2) Run with Assistant
    const run = await client.beta.threads.runs.create(thread.id, { assistant_id: assistantId });

    // 3) Poll until completed (max ~120s)
    let status = run;
    const started = Date.now();
    while (status.status !== "completed") {
      if (["failed","cancelled","expired"].includes(status.status)) {
        return resp(500, { error: `Run ${status.status}` });
      }
      if (Date.now() - started > 120000) {
        return resp(504, { error: "Timeout esperando al Assistant" });
      }
      await sleep(1500);
      status = await client.beta.threads.runs.retrieve(thread.id, run.id);
    }

    // 4) Get last message, parse JSON (with codeblock fallback)
    const list = await client.beta.threads.messages.list(thread.id, { order: "desc", limit: 1 });
    const msg = list.data?.[0];
    const text = msg?.content?.find(p => p.type === "text")?.text?.value || "";
    let parsed = null;
    try { parsed = JSON.parse(text); } catch(e){}
    if (!parsed) {
      const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (m) { parsed = JSON.parse(m[1]); }
    }
    if (!parsed?.files?.["index.html"]) {
      return resp(422, { error: "Respuesta inválida del Assistant", raw: text.slice(0, 2000) });
    }

    return resp(200, { name, files: parsed.files });
  } catch (err) {
    return resp(500, { error: err.message });
  }
};

function resp(status, body){
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
