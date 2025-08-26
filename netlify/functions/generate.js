// netlify/functions/generate.js
// ESM – Netlify Functions
export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const {
      mode = "edit",
      prompt = "",
      name = "project",
      files = {}
    } = safeParse(event.body);

    // Assegurem 3 fitxers clau sempre presents
    const current = normalizeFiles(files);

    // 1) Intent amb OpenAI si hi ha credencials
    const useOpenAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_ASSISTANT_ID);
    if (useOpenAI) {
      try {
        const ai = await tryOpenAIEdit({
          mode,
          prompt,
          name,
          files: current
        });
        if (isValidFiles(ai)) {
          // Tornem el resultat de l’AI si sembla vàlid
          return json(200, { ok: true, files: ai });
        }
      } catch (err) {
        // Continuem a fallback
        // console.error("OpenAI failed:", err);
      }
    }

    // 2) Fallback local: inserció segura a la secció probable
    const fallbackFiles = applyLocalEditFallback(current, prompt);

    return json(200, {
      ok: true,
      files: fallbackFiles,
      note: "openai_error_fallback",
      upstream_status: 400
    });
  } catch (err) {
    return json(500, { ok: false, error: err?.message || String(err) });
  }
};

/* ------------------------------ Helpers ------------------------------ */

function json(status, payload) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  };
}

function safeParse(body) {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

function normalizeFiles(input) {
  const out = { ...input };
  if (typeof out["index.html"] !== "string") {
    out["index.html"] = defaultIndex();
  }
  if (typeof out["styles/style.css"] !== "string") {
    out["styles/style.css"] = "/* css */";
  }
  if (typeof out["scripts/app.js"] !== "string") {
    out["scripts/app.js"] = "// js";
  }
  return out;
}

function isValidFiles(obj) {
  if (!obj || typeof obj !== "object") return false;
  const k = Object.keys(obj);
  if (!k.length) return false;
  // ha d’haver com a mínim l’index
  if (!("index.html" in obj)) return false;
  // han de ser strings
  return k.every((key) => typeof obj[key] === "string");
}

/* ------------------------------ OpenAI ------------------------------ */

async function tryOpenAIEdit({ mode, prompt, name, files }) {
  const API_KEY = process.env.OPENAI_API_KEY;
  const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
  const ORG = process.env.OPENAI_ORG_ID || undefined;
  const PROJ = process.env.OPENAI_PROJECT || undefined;

  const system = [
    "You are a meticulous code editor for small web projects.",
    "Return ONLY a strict JSON object with this shape:",
    `{"files":{"index.html":"...","styles/style.css":"...","scripts/app.js":"..."}}`,
    "Do not add markdown, code fences or explanations.",
    "If you cannot safely apply the requested change, return the original files unchanged, but still in the exact JSON format."
  ].join(" ");

  const content = [
    { type: "text", text: `MODE: ${mode}\nPROJECT: ${name}\nPROMPT:\n${prompt}` },
    { type: "input_text", text: files["index.html"], name: "index.html" },
    { type: "input_text", text: files["styles/style.css"], name: "styles/style.css" },
    { type: "input_text", text: files["scripts/app.js"], name: "scripts/app.js" }
  ];

  // Ús de Chat Completions en JSON
  const payload = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Here are the three project files as plain text. " +
              "Update them to apply my request. Return only a JSON with a 'files' object."
          }
        ]
      },
      { role: "user", content: content }
    ]
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`
  };
  if (ORG) headers["OpenAI-Organization"] = ORG;
  if (PROJ) headers["OpenAI-Project"] = PROJ;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("Empty AI response");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // quan el model no respecta JSON, no ho usem
    throw new Error("AI not JSON");
  }

  const filesObj = parsed?.files;
  if (!isValidFiles(filesObj)) {
    throw new Error("AI 'files' invalid");
  }
  return filesObj;
}

/* ---------------------------- Local fallback ---------------------------- */

function applyLocalEditFallback(files, promptRaw) {
  const prompt = String(promptRaw || "").toLowerCase();

  // 1) triem secció segons prompt
  const sectionId =
    findTargetSection(prompt) ||
    findExistingSection(files["index.html"]) ||
    "contact";

  // 2) generem bloc segur
  const safeText = sanitizeInline(promptRaw || "Canvi aplicat per IA.");
  const block = `
  <div class="ai-note">
    <strong>[IA]</strong> ${safeText}
  </div>`.trim();

  // 3) inserim al final de la secció triada (abans del </section>)
  let html = files["index.html"];
  const sectionClose = new RegExp(`(<section[^>]*id=["']${sectionId}["'][\\s\\S]*?)(</section>)`, "i");
  if (sectionClose.test(html)) {
    html = html.replace(sectionClose, (_m, body, close) => `${body}\n${block}\n${close}`);
  } else {
    // si no trobem secció, ho afegim a <main> o al final
    const mainClose = /(<main[^>]*>)([\s\S]*?)(<\/main>)/i;
    if (mainClose.test(html)) {
      html = html.replace(mainClose, (_m, open, content, close) => `${open}${content}\n${block}\n${close}`);
    } else {
      html = html.replace(/<\/body>/i, `${block}\n</body>`);
    }
  }

  // 4) assegurem css per .ai-note
  let css = files["styles/style.css"] || "/* css */";
  if (!/\.ai-note\s*\{/.test(css)) {
    css += `

/* IA note helper */
.ai-note{
  background:#fff8c5;
  border-left:4px solid #ff8c5c;
  padding:12px 14px;
  margin:12px 0;
  font-size:0.95rem;
  line-height:1.5;
}
`;
  }

  return {
    "index.html": html,
    "styles/style.css": css,
    "scripts/app.js": files["scripts/app.js"] || "// js"
  };
}

function sanitizeInline(s) {
  return String(s)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findTargetSection(prompt) {
  const map = [
    { id: "contact", keys: ["contacte", "contacto", "contact", "email", "tel"] },
    { id: "testimonials", keys: ["testimonis", "testimonios", "reviews", "reseña", "reseñas"] },
    { id: "faq", keys: ["faq", "preguntes", "preguntas", "frecuentes"] },
    { id: "pricing", keys: ["pricing", "precios", "preu", "planes", "planes"] },
    { id: "gallery", keys: ["galeria", "galería", "gallery", "imatges", "imagenes", "carrusel"] },
    { id: "about", keys: ["sobre", "about", "qui som", "quiénes"] },
    { id: "features", keys: ["característiques", "caracteristicas", "features", "beneficis", "beneficios"] },
    { id: "hero", keys: ["hero", "capçalera", "encabezado", "headline", "CTA"] }
  ];
  const p = prompt.toLowerCase();
  for (const item of map) {
    if (item.keys.some((k) => p.includes(k))) return item.id;
  }
  return null;
}

function findExistingSection(html) {
  // si a l’html només existeix una d’aquestes, usem-la
  const ids = ["contact", "testimonials", "faq", "pricing", "gallery", "about", "features", "hero"];
  const present = ids.filter((id) => new RegExp(`id=["']${id}["']`, "i").test(html));
  if (present.length === 1) return present[0];
  return null;
}

function defaultIndex() {
  return `<!doctype html><html lang="ca"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Project</title></head><body><main id="app"></main></body></html>`;
}
