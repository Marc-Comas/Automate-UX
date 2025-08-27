// netlify/functions/generate.js
// ESM – Netlify Functions

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const { mode = "edit", prompt = "", name = "project", files = {} } = safeParse(event.body);

    // Assegurem fitxers base
    const current = normalizeFiles(files);

    // 1) Intentem amb OpenAI (si hi ha credencials)
    const useOpenAI = !!(process.env.OPENAI_API_KEY && (process.env.OPENAI_ASSISTANT_ID || process.env.OPENAI_MODEL));
    if (useOpenAI) {
      try {
        const ai = await tryOpenAIEdit({ mode, prompt, name, files: current });
        if (isValidFiles(ai)) return json(200, { ok: true, files: ai });
      } catch {
        // seguim a fallback
      }
    }

    // 2) Fallback local amb contingut "intel·ligent" (sense eco del prompt)
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
  if (typeof out["index.html"] !== "string") out["index.html"] = defaultIndex();
  if (typeof out["styles/style.css"] !== "string") out["styles/style.css"] = "/* css */";
  if (typeof out["scripts/app.js"] !== "string") out["scripts/app.js"] = "// js";
  return out;
}

function isValidFiles(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (!("index.html" in obj)) return false;
  return Object.keys(obj).every((k) => typeof obj[k] === "string");
}

/* ------------------------------ OpenAI ------------------------------ */

async function tryOpenAIEdit({ mode, prompt, name, files }) {
  const API_KEY = process.env.OPENAI_API_KEY;
  const ORG = process.env.OPENAI_ORG_ID || undefined;
  const PROJ = process.env.OPENAI_PROJECT || undefined;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system = [
    "You are a meticulous code editor for small web projects.",
    'Return ONLY a strict JSON object exactly like: {"files":{"index.html":"...","styles/style.css":"...","scripts/app.js":"..."}}',
    "Do not add markdown, code fences, or explanations.",
    "If in doubt, keep structure/accessibility and return valid HTML/CSS/JS.",
  ].join(" ");

  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: `MODE: ${mode}\nPROJECT: ${name}\nPROMPT:\n${prompt}` },
      { role: "user", content: `index.html:\n${files["index.html"]}` },
      { role: "user", content: `styles/style.css:\n${files["styles/style.css"]}` },
      { role: "user", content: `scripts/app.js:\n${files["scripts/app.js"]}` },
    ],
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };
  if (ORG) headers["OpenAI-Organization"] = ORG;
  if (PROJ) headers["OpenAI-Project"] = PROJ;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("Empty AI response");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI not JSON");
  }

  const filesObj = parsed?.files;
  if (!isValidFiles(filesObj)) throw new Error("AI 'files' invalid");
  return filesObj;
}

/* ---------------------------- Local fallback ---------------------------- */

function applyLocalEditFallback(files, promptRaw) {
  const prompt = String(promptRaw || "");
  const html0 = files["index.html"];
  const lang = detectLang(html0); // 'ca' | 'es'
  const sectionId = findTargetSection(prompt) || findSingleSectionInHTML(html0) || "contact";
  const email = extractEmail(html0) || "info@example.com";

  // Generem contingut segons secció (NO el prompt literal)
  const block = buildSectionBlock(sectionId, lang, prompt, email);

  // Inserim al final de la secció trobada
  let html = insertIntoSection(html0, sectionId, block, prompt);

  // Estils per als blocs generats
  let css = files["styles/style.css"] || "/* css */";
  css = ensureAIStyles(css);

  return {
    "index.html": html,
    "styles/style.css": css,
    "scripts/app.js": files["scripts/app.js"] || "// js"
  };
}

function detectLang(html) {
  const m = /<html[^>]*\blang=["']([^"']+)["']/i.exec(html);
  const code = (m?.[1] || "").toLowerCase();
  if (code.startsWith("ca")) return "ca";
  if (code.startsWith("es")) return "es";
  return "es";
}

function extractEmail(html) {
  const m1 = /mailto:([^\s"'<>]+)/i.exec(html);
  if (m1) return m1[1];
  const m2 = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.exec(html);
  if (m2) return m2[1];
  return null;
}

function findTargetSection(prompt) {
  const p = prompt.toLowerCase();
  const map = [
    { id: "testimonials", keys: ["testimon", "reseña", "review"] },
    { id: "contact", keys: ["contact", "contacte", "contacto", "email", "tel"] },
    { id: "faq", keys: ["faq", "preguntes", "preguntas", "frecuentes"] },
    { id: "pricing", keys: ["pricing", "precio", "preu", "planes", "plan"] },
    { id: "gallery", keys: ["galeria", "galería", "gallery", "carrusel", "imagenes", "imatges"] },
    { id: "about", keys: ["sobre", "about", "qui som", "quiénes"] },
    { id: "features", keys: ["caracter", "feature", "benefici", "beneficio"] },
    { id: "hero", keys: ["hero", "encabezado", "capçalera", "headline", "cta"] },
  ];
  for (const item of map) {
    if (item.keys.some((k) => p.includes(k))) return item.id;
  }
  return null;
}

function findSingleSectionInHTML(html) {
  const ids = ["contact", "testimonials", "faq", "pricing", "gallery", "about", "features", "hero"];
  const present = ids.filter((id) => new RegExp(`id=["']${id}["']`, "i").test(html));
  if (present.length === 1) return present[0];
  return null;
}

function insertIntoSection(html, sectionId, block, prompt) {
  const comment = `<!-- ai: inserted section="${sectionId}" prompt="${sanitizeAttr(prompt.slice(0, 160))}${prompt.length>160?"…":""}" -->`;
  const sectionClose = new RegExp(`(<section[^>]*id=["']${sectionId}["'][\\s\\S]*?)(</section>)`, "i");
  if (sectionClose.test(html)) {
    return html.replace(sectionClose, (_m, body, close) => `${body}\n${comment}\n${block}\n${close}`);
  }
  const mainClose = /(<main[^>]*>)([\s\S]*?)(<\/main>)/i;
  if (mainClose.test(html)) {
    return html.replace(mainClose, (_m, open, content, close) => `${open}${content}\n${comment}\n${block}\n${close}`);
  }
  return html.replace(/<\/body>/i, `${comment}\n${block}\n</body>`);
}

function sanitizeAttr(s) {
  return String(s).replace(/[<>"']/g, "");
}

/* ---------- Generadors de contingut per secció (CA/ES) ---------- */

function buildSectionBlock(sectionId, lang, prompt, email) {
  switch (sectionId) {
    case "testimonials":
      return testimonialBlock(lang);
    case "contact":
      return contactBlock(lang, email);
    case "faq":
      return faqBlock(lang, prompt);
    case "pricing":
      return pricingBlock(lang);
    case "gallery":
      return galleryBlock(lang, prompt);
    case "about":
      return aboutBlock(lang);
    case "features":
      return featuresBlock(lang);
    case "hero":
      return heroBlock(lang);
    default:
      return genericNote(lang);
  }
}

function testimonialBlock(lang) {
  const t = (lang === "ca")
    ? {
        quote: "“Mai havia experimentat una tecnologia tan immersiva en l’esport.”",
        name: "Laura P.",
        role: "Entrenadora de boulder"
      }
    : {
        quote: "“Nunca había vivido una tecnología tan inmersiva en el deporte.”",
        name: "Laura P.",
        role: "Entrenadora de boulder"
      };

  return `
  <figure class="ai-block ai-testimonial" aria-label="${lang==='ca'?'Testimoni':'Testimonio'}">
    <div class="ai-stars" aria-hidden="true">★★★★★</div>
    <blockquote>${t.quote}</blockquote>
    <figcaption>— ${t.name}, <span class="role">${t.role}</span></figcaption>
  </figure>`.trim();
}

function contactBlock(lang, email) {
  const t = (lang === "ca")
    ? {
        title: "Més informació",
        line1: `Escriu-nos a <a href="mailto:${email}">${email}</a> i t’assessorarem.`,
        line2: "També podem programar una trucada per resoldre dubtes."
      }
    : {
        title: "Más información",
        line1: `Escríbenos a <a href="mailto:${email}">${email}</a> y te asesoramos.`,
        line2: "También podemos programar una llamada para resolver dudas."
      };

  return `
  <div class="ai-block ai-contact">
    <h3>${t.title}</h3>
    <p>${t.line1}<br>${t.line2}</p>
  </div>`.trim();
}

function faqBlock(lang, prompt) {
  const topic = guessTopic(prompt, lang);
  const t = (lang === "ca")
    ? { q: `Com funciona ${topic}?`, a: "Resum ràpid: és modular, segur i s’instal·la sense obres complexes." }
    : { q: `¿Cómo funciona ${topic}?`, a: "Resumen rápido: es modular, seguro y se instala sin obras complejas." };

  return `
  <div class="ai-block ai-faq">
    <details>
      <summary>${t.q}</summary>
      <p>${t.a}</p>
    </details>
  </div>`.trim();
}

function pricingBlock(lang) {
  const t = (lang === "ca")
    ? { title: "Pla Pro", price: "49 €/mes", btn: "Comença ara" }
    : { title: "Plan Pro", price: "49 €/mes", btn: "Empieza ahora" };

  return `
  <div class="ai-block ai-pricing" role="region" aria-label="${lang==='ca'?'Preus':'Precios'}">
    <div class="tier">
      <h3>${t.title}</h3>
      <p class="price">${t.price}</p>
      <ul>
        <li>Suport prioritari</li>
        <li>Actualitzacions incloses</li>
        <li>Configuració flexible</li>
      </ul>
      <a class="btn" href="#contact">${t.btn}</a>
    </div>
  </div>`.trim();
}

function galleryBlock(lang, prompt) {
  const alt = (lang === "ca") ? `Imatge de projecte` : `Imagen de proyecto`;
  const caption = (lang === "ca") ? `Nou muntatge en acció` : `Nuevo montaje en acción`;
  const seed = encodeURIComponent(guessTopic(prompt, lang) || "projecte");
  return `
  <figure class="ai-block ai-gallery">
    <img src="https://picsum.photos/seed/${seed}/800/450" alt="${alt}" loading="lazy" decoding="async">
    <figcaption>${caption}</figcaption>
  </figure>`.trim();
}

function aboutBlock(lang) {
  const text = (lang === "ca")
    ? "Dissenyem murs d’escalada modulars i gamificats amb un enfocament sostenible i escalable."
    : "Diseñamos muros de escalada modulares y gamificados con un enfoque sostenible y escalable.";
  return `<p class="ai-block ai-about">${text}</p>`;
}

function featuresBlock(lang) {
  const t = (lang === "ca")
    ? ["Mòduls connectables", "Sensors de moviment", "Aplicació d’anàlisi inclosa"]
    : ["Módulos conectables", "Sensores de movimiento", "App de análisis incluida"];
  return `
  <ul class="ai-block ai-features">
    <li>${t[0]}</li>
    <li>${t[1]}</li>
    <li>${t[2]}</li>
  </ul>`.trim();
}

function heroBlock(lang) {
  const sub = (lang === "ca")
    ? "Experiència urbana, energia de comunitat."
    : "Experiencia urbana, energía de comunidad.";
  return `<p class="ai-block ai-hero-sub">${sub}</p>`;
}

function genericNote(lang) {
  const t = (lang === "ca")
    ? "Contingut actualitzat automàticament."
    : "Contenido actualizado automáticamente.";
  return `<p class="ai-block">${t}</p>`;
}

function guessTopic(prompt, lang) {
  const p = (prompt || "").trim();
  if (!p) return (lang === "ca") ? "el sistema" : "el sistema";
  // Agafem algunes paraules “netes” del prompt per fer de tema, sense eco literal
  const just = p
    .replace(/["«»“”]/g, "")
    .replace(/\b(afeg(eix|ir)|añade|agrega|add|más|més|sección|seccio|section|testimoni(?:s)?|reseña(?:s)?|review(?:s)?|contacte|contacto|faq|pricing|precios|galeria|galería|gallery)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!just) return (lang === "ca") ? "el sistema" : "el sistema";
  return just.slice(0, 40);
}

function ensureAIStyles(css) {
  if (/\.ai-block\b/.test(css)) return css;
  return css + `

/* === AI blocks (fallback) === */
.ai-block{margin:12px 0}
.ai-testimonial blockquote{font-style:italic;margin:8px 0}
.ai-testimonial .ai-stars{color:#f6b700;letter-spacing:2px}
.ai-testimonial figcaption{opacity:.8}
.ai-pricing .tier{border:1px solid #e5e7eb;border-radius:12px;padding:16px;max-width:320px}
.ai-pricing .price{font-size:1.25rem;font-weight:700;margin:4px 0 8px}
.ai-pricing .btn{display:inline-block;padding:8px 12px;border-radius:8px;background:#ffb000;color:#000;text-decoration:none}
.ai-gallery img{display:block;width:100%;height:auto;border-radius:8px}
.ai-faq details{border-left:3px solid #ffb000;padding:8px 12px;background:#fffaf0;border-radius:8px}
.ai-hero-sub{opacity:.9}
`;
}

function defaultIndex() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Project</title></head><body><main id="app"></main></body></html>`;
}
