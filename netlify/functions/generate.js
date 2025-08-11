
/**
 * Netlify Function: generate (Assistants v2, robust, CommonJS)
 * -----------------------------------------------------------
 * - CORS seguro para uso desde el frontend de Project Central
 * - Soporta credenciales desde variables de entorno o cabeceras:
 *     OPENAI_API_KEY            | header: x-openai-key
 *     OPENAI_ASSISTANT_ID       | header: x-openai-asst
 *     OPENAI_ORG_ID (opcional)  | header: OpenAI-Organization / x-openai-org
 *     OPENAI_PROJECT (opcional) | header: OpenAI-Project
 * - Flujo start → poll → fetch messages (timeout 90s)
 * - Fuerza response_format: { type: "json_object" } para que el Assistant devuelva JSON.
 * - Si el Assistant responde con <html>…</html> en texto, convertimos a { files: { "index.html": ... } }
 * - CommonJS (exports.handler) para evitar errores de `export` en el runtime de Netlify.
 */
exports.handler = async (event) => {
  // Preflight CORS
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors(), body: "" };

  try {
    const body = safeJSON(event.body);
    const {
      mode = "generate",            // "generate" | "edit"
      prompt = "",                  // brief o modificación
      name = "sitio",               // nombre del proyecto
      files = undefined             // { "index.html": "...", ... } (solo en modo edit)
    } = body || {};

    // ---- Credenciales ----
    const key  = process.env.OPENAI_API_KEY
              || event.headers["x-openai-key"]
              || event.headers["X-OpenAI-Key"];

    const asst = process.env.OPENAI_ASSISTANT_ID
              || event.headers["x-openai-asst"]
              || event.headers["X-OpenAI-Asst"];

    const org  = process.env.OPENAI_ORG_ID
              || process.env.OPENAI_ORGANIZATION
              || event.headers["openai-organization"]
              || event.headers["OpenAI-Organization"]
              || event.headers["x-openai-org"]
              || event.headers["X-OpenAI-Org"]
              || undefined;

    const project = process.env.OPENAI_PROJECT
                 || process.env.OPENAI_PROJECT_ID
                 || event.headers["openai-project"]
                 || event.headers["OpenAI-Project"]
                 || undefined;

    if (!key || !asst) {
      return j(400, { error: "Faltan credenciales de OpenAI (OPENAI_API_KEY y OPENAI_ASSISTANT_ID)." });
    }

    // ---- Cabeceras para Assistants v2 ----
    const headers = {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };
    if (org) headers["OpenAI-Organization"] = org;
    if (project) headers["OpenAI-Project"] = project;

    // ---- Reglas de salida (refuerzan el esquema esperado) ----
    const rules = `RESPETA EL FORMATO DE SALIDA.
STEP 4 – CODE GENERATION (Single HTML file)
- Semantic HTML5 con <header>, <nav>, <main>, <section>, <footer>
- CSS en <style> con variables --color-primary, --color-bg, --font-heading, --font-body
- JS vanilla en <script>
- Responsive y accesible (WCAG AA), sin CDNs
- SPA hash routing si procede
STEP 5 – OUTPUT FORMAT (SOLO JSON)
{
  "files": {
    "index.html": "<html>...</html>",
    "styles/style.css": "/* opcional */",
    "scripts/app.js": "// opcional"
  }
}`;

    // ---- Mensaje de usuario (único, rol "user" recomendado en v2) ----
    const userBrief = (mode === "edit" && files && typeof files === "object")
      ? `Modifica el proyecto según el prompt.\nPROMPT:\n${prompt}\n\nFILES (JSON):\n${JSON.stringify({ files })}`
      : `Genera una landing para: ${name}\nPROMPT:\n${prompt || "Genera landing base responsive."}`;

    const userMessage = `${rules}\n\n${userBrief}`;

    // ---- 1) Crear thread vacío ----
    const thread = await fetchJSON("https://api.openai.com/v1/threads", {
      method: "POST",
      headers,
      body: JSON.stringify({})
    });
    if (!thread || !thread.id) return j(502, { error: "No se pudo crear el thread", details: thread });

    // ---- 2) Publicar mensaje del usuario ----
    await fetchJSON(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "user", content: userMessage })
    });

    // ---- 3) Lanzar run con response_format json_object ----
    const run = await fetchJSON(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ assistant_id: asst, response_format: { type: "json_object" } })
    });
    if (!run || !run.id) return j(502, { error: "No se pudo iniciar el run", details: run });

    // ---- 4) Poll hasta completar (timeout 90s) ----
    const deadline = Date.now() + 90_000;
    let status = run.status;
    let snap   = run;

    while (status === "queued" || status === "in_progress" || status === "requires_action") {
      if (Date.now() > deadline) return j(504, { error: "Timeout esperando al Assistant" });
      await sleep(1200);
      snap = await fetchJSON(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, { headers });
      status = snap && snap.status;
    }
    if (status !== "completed") return j(502, { error: "Run no completado", details: snap });

    // ---- 5) Obtener mensajes y extraer payload ----
    const msgs = await fetchJSON(`https://api.openai.com/v1/threads/${thread.id}/messages`, { headers });
    const { payload, raw_text } = extractPayload(msgs);

    if (payload && payload.files && typeof payload.files["index.html"] === "string") {
      return j(200, payload);
    }
    return j(502, { error: "La función no devolvió archivos", raw_text: raw_text ? String(raw_text).slice(0, 500) : null });
  } catch (err) {
    return j(500, { error: "Fallo interno", details: err && err.message ? err.message : String(err) });
  }
};

/* ========================
   Helpers
   ======================== */
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-openai-key,x-openai-asst,OpenAI-Organization,OpenAI-Project",
    "Access-Control-Max-Age": "600"
  };
}
function j(code, obj) {
  return { statusCode: code, headers: { ...cors(), "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function safeJSON(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }
async function fetchJSON(url, init = {}) {
  const res = await fetch(url, init);
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { _raw: txt, status: res.status }; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Extrae { files:{...} } desde los mensajes de Assistants v2.
 * Soporta content parts tipo "output_text" y "text". Si no hay JSON válido,
 * intenta capturar un bloque <html>…</html> como fallback.
 */
function extractPayload(msgs) {
  try {
    const data = (msgs && msgs.data) || [];
    let rawText = null;

    for (let i = data.length - 1; i >= 0; i--) {
      const m = data[i];
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;

      for (const p of m.content) {
        let val = null;
        if (p.type === "output_text" && p.text && typeof p.text.value === "string") {
          val = p.text.value;
        } else if (p.type === "text" && p.text && typeof p.text.value === "string") {
          val = p.text.value;
        }
        if (!val) continue;

        rawText = val;

        // Intento 1: JSON puro (permite bloque ```json ... ```)
        const clean = val.replace(/```json\s*([\s\S]*?)\s*```/gi, "$1").trim();
        try {
          const obj = JSON.parse(clean);
          return { payload: obj, raw_text: rawText };
        } catch {}

        // Intento 2: HTML directo -> lo empaquetamos
        const matchHtml = val.match(/<html[\s\S]*<\/html>/i);
        if (matchHtml) {
          return { payload: { files: { "index.html": matchHtml[0] } }, raw_text: rawText };
        }
        
        // Sustituye tu regex actual por una más amplia
        let clean = val.trim();

        // Quitar bloques con ```json ... ``` o ``` ... ```
        clean = clean.replace(/```json\s*([\s\S]*?)\s*```/gi, '$1').trim();
        clean = clean.replace(/```\s*([\s\S]*?)\s*```/g, '$1').trim();
        
      }
    }
    return { payload: null, raw_text: rawText };
  } catch {
    return { payload: null, raw_text: null };
  }
}
