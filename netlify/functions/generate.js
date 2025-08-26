// ESM compatible (package.json -> "type":"module")
// Netlify function: POST /.netlify/functions/generate
// Intenta OpenAI; si falla, aplica un editor local robust i retorna fitxers actualitzats.

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default async function handler(req) {
  try {
    if (req.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    const body = await req.json().catch(() => ({}));
    const {
      mode = "edit",
      prompt = "",
      files = {},
      project = {},
    } = body;

    // Normalitza claus mínimes
    const base = normalizeFiles(files);

    // 1) Intenta OpenAI si hi ha credencials i no forces local
    let aiResult = null;
    const canCallOpenAI =
      !!process.env.OPENAI_API_KEY &&
      !!process.env.OPENAI_ASSISTANT_ID &&
      !process.env.GENERATE_FORCE_LOCAL;

    if (canCallOpenAI) {
      try {
        aiResult = await callOpenAI({ mode, prompt, files: base, project });
        if (
          aiResult &&
          aiResult.ok &&
          aiResult.files &&
          Object.keys(aiResult.files).length
        ) {
          // OpenAI ha editat correctament
          return json({ ok: true, files: aiResult.files });
        }
      } catch (err) {
        console.error("openai_call_error:", err?.status || err?.message || err);
      }
    }

    // 2) Fallback local (robust i determinista)
    const edited = localEdit({ mode, prompt, files: base, project });
    if (edited.changed) {
      return json({
        ok: true,
        files: edited.files,
        note: "openai_error_fallback",
        upstream_status: aiResult?.status ?? 400,
      });
    }

    // Si no hem pogut aplicar res, retorna sense canvis i indica-ho
    return json({
      ok: true, // mantinc ok:true per no “trencar” la UI
      files: base,
      note: "openai_error_fallback_noop",
      upstream_status: aiResult?.status ?? 400,
    });
  } catch (err) {
    console.error("generate_unhandled_error:", err?.message || err);
    return json(
      { ok: false, error: "server_error", detail: `${err?.message || err}` },
      500
    );
  }
}

/* ----------------------------- OpenAI helper ----------------------------- */

async function callOpenAI({ mode, prompt, files, project }) {
  // Important: enviem només els fitxers necessaris per reduir risc de 400 per mida
  const payload = {
    mode,
    prompt,
    files: {
      "index.html": files["index.html"],
      // envia CSS/JS com a opcional curt per al context
      "styles/style.css": trimLong(files["styles/style.css"], 40_000),
      "scripts/app.js": trimLong(files["scripts/app.js"], 40_000),
    },
    project: {
      id: project?.id || "",
      name: project?.name || "",
      slug: project?.slug || "",
      status: project?.status || "",
    },
  };

  const resp = await fetch("https://api.openai.com/v1/assistants/runs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "X-OpenAI-Assistant-ID": process.env.OPENAI_ASSISTANT_ID,
      "OpenAI-Project": process.env.OPENAI_PROJECT || "",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    // 400/401/429/5xx: que gestioni el fallback
    return { ok: false, status: resp.status };
  }

  const data = await resp.json().catch(() => ({}));
  // Esperem { files: { "index.html": "...", ... } }
  if (data?.files && typeof data.files["index.html"] === "string") {
    return { ok: true, files: normalizeFiles(data.files), status: 200 };
  }
  return { ok: false, status: 422 };
}

/* ----------------------------- Local editor ------------------------------ */

function localEdit({ prompt = "", files }) {
  let html = files["index.html"] || "";
  let css = files["styles/style.css"] || "/* css */";
  let js = files["scripts/app.js"] || "// js";

  const p = toLowerNoDiacritics(prompt);

  let changed = false;

  // assegura classe per a notes
  if (!/\.ai-note\s*\{/.test(css)) {
    css += `
.ai-note{background:#fff8c5;border-left:4px solid #f2c200;padding:.75rem 1rem;margin:.5rem 0;border-radius:.25rem;font-size:.95rem}
.ai-badge{display:inline-block;font-weight:600;color:#7a5c00;margin-right:.5rem}
`;
    changed = true;
  }

  // Helpers
  const addToSection = (idRegex, fragment) => {
    const updated = injectInSection(html, idRegex, fragment);
    if (updated) {
      html = updated;
      return true;
    }
    // Si no trobem la secció, afegim a <main>
    const updatedMain = appendToMain(html, fragment);
    if (updatedMain) {
      html = updatedMain;
      return true;
    }
    return false;
  };

  // CONTACTE
  if (/(contacte|contacto|contact|contactar)/.test(p)) {
    const frag = `
<div class="ai-note"><span class="ai-badge">[IA]</span>
Informació afegida a la secció de contacte: si vols, escriu-nos a <a href="mailto:info@example.com">info@example.com</a>.
</div>`;
    changed = addToSection(/id\s*=\s*"(contact|contacte)"/i, frag) || changed;
  }

  // GALERIA / CARRUSEL
  if (/(galeria|gallery|carrusel|carousel)/.test(p)) {
    const frag = `
<figure class="ai-note" aria-label="Imatge afegida (IA)">
  <img src="https://picsum.photos/seed/ai-${Date.now()}/800/500" alt="Mòdul d'escalada — imatge de mostra" loading="lazy" decoding="async">
  <figcaption><span class="ai-badge">[IA]</span> Imatge de galeria afegida com a mostra.</figcaption>
</figure>`;
    changed = addToSection(/id\s*=\s*"(gallery|galeria)"/i, frag) || changed;
  }

  // PRICING / PREUS / PLANS
  if (/(pricing|preus?|tarifa|planes?)/.test(p)) {
    if (!/id\s*=\s*"(pricing|preus?)"/i.test(html)) {
      const pricing = `
<section id="pricing" aria-labelledby="pricing-title">
  <h2 id="pricing-title">Plans i preus</h2>
  <div class="pricing-grid">
    <article class="card"><h3>Starter</h3><p>Per a primers passos</p><p class="price">€19/m</p></article>
    <article class="card"><h3>Pro</h3><p>Per a gimnasos en creixement</p><p class="price">€49/m</p></article>
    <article class="card"><h3>Enterprise</h3><p>Solució completa</p><p class="price">A mida</p></article>
  </div>
</section>`;
      html = insertBeforeFooter(html, pricing) || appendToMain(html, pricing) || html;
      if (!/\.pricing-grid\s*\{/.test(css)) {
        css += `
.pricing-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:1rem 0}
.pricing-grid .card{background:#111;border:1px solid #222;border-radius:.75rem;padding:1rem}
.price{font-weight:700;font-size:1.25rem}
`;
      }
      changed = true;
    }
  }

  // FAQ / PREGUNTES
  if (/(faq|preguntes|preguntas)/.test(p)) {
    if (!/id\s*=\s*"(faq)"/i.test(html)) {
      const faq = `
<section id="faq" aria-labelledby="faq-title">
  <h2 id="faq-title">Preguntes freqüents</h2>
  <details><summary>Quina instal·lació requereix?</summary><div>La majoria d'espais només necessiten punts d'ancoratge estàndard.</div></details>
  <details><summary>Hi ha manteniment?</summary><div>Mínim. Components modulars fàcils de substituir.</div></details>
</section>`;
      html = insertBeforeFooter(html, faq) || appendToMain(html, faq) || html;
      changed = true;
    }
  }

  // Catch-all: si no ha encertat cap secció, deixa una nota al <main>
  if (!changed && prompt.trim()) {
    const note = `
<div class="ai-note"><span class="ai-badge">[IA]</span>
No s'ha pogut entendre el destí del canvi (“${escapeHtml(
      prompt.slice(0, 140)
    )}”). S'ha deixat aquesta nota com a traça segura.
</div>`;
    html = appendToMain(html, note) || html;
    changed = true;
  }

  return {
    changed,
    files: {
      "index.html": html,
      "styles/style.css": css,
      "scripts/app.js": js,
    },
  };
}

/* ------------------------------ HTML helpers ------------------------------ */

function normalizeFiles(obj = {}) {
  return {
    "index.html": String(obj["index.html"] || ""),
    "styles/style.css": String(obj["styles/style.css"] || "/* css */"),
    "scripts/app.js": String(obj["scripts/app.js"] || "// js"),
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function trimLong(str = "", max = 80000) {
  if (typeof str !== "string") return "";
  if (str.length <= max) return str;
  return str.slice(0, max);
}

function toLowerNoDiacritics(s = "") {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function escapeHtml(s = "") {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function injectInSection(html, idRegex, fragment) {
  const idMatch = html.match(idRegex);
  if (!idMatch) return null;

  const start = idMatch.index ?? -1;
  if (start < 0) return null;

  // Troba el tancament </section> següent
  const closeIdx = html.indexOf("</section>", start);
  if (closeIdx === -1) return null;

  const before = html.slice(0, closeIdx);
  const after = html.slice(closeIdx);
  return before + "\n" + fragment + "\n" + after;
}

function appendToMain(html, fragment) {
  const idx = html.lastIndexOf("</main>");
  if (idx === -1) return null;
  return html.slice(0, idx) + "\n" + fragment + "\n" + html.slice(idx);
}

function insertBeforeFooter(html, fragment) {
  const idx = html.indexOf("<footer");
  if (idx === -1) return null;
  return html.slice(0, idx) + "\n" + fragment + "\n" + html.slice(idx);
}
