// /netlify/functions/generate.mjs

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-openai-key,x-openai-asst',
  'Cache-Control': 'no-cache',
};

export default async (req) => {
  // Preflight
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { mode = 'edit', name = 'project', prompt = '', files = {} } = body;

    // Claus (header en local o var d’entorn en prod)
    const apiKey =
      req.headers.get('x-openai-key') || process.env.OPENAI_API_KEY || '';
    const openaiProject = process.env.OPENAI_PROJECT || '';
    const openaiOrg = process.env.OPENAI_ORG_ID || '';
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // Assegura fitxers
    const current = normalizeFiles(files);

    // ----- Anti-504: timeout curt (Netlify talla ~26s) -----
    const timeoutMs = 23000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

    let upstreamStatus = 0;
    let filesFromAI = null;

    if (apiKey) {
      // ---------- OpenAI /chat/completions amb JSON estricte ----------
      const system = [
        'You are a meticulous code editor for small web projects.',
        'Return ONLY a strict JSON object exactly like: {"files":{"index.html":"...","styles/style.css":"...","scripts/app.js":"..."}}',
        'No markdown, no code fences, no commentary. Valid HTML/CSS/JS only.',
      ].join(' ');

      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: `MODE: ${mode}\nPROJECT: ${name}\nPROMPT:\n${prompt}` },
        { role: 'user', content: `index.html:\n${current['index.html']}` },
        { role: 'user', content: `styles/style.css:\n${current['styles/style.css']}` },
        { role: 'user', content: `scripts/app.js:\n${current['scripts/app.js']}` },
      ];

      const payload = {
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages,
      };

      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
      if (openaiProject) headers['OpenAI-Project'] = openaiProject;
      if (openaiOrg) headers['OpenAI-Organization'] = openaiOrg;

      try {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        upstreamStatus = resp.status;

        const data = await resp.json().catch(() => null);
        const content = data?.choices?.[0]?.message?.content || '';
        const parsed = safeParseJson(content);
        if (parsed?.files) filesFromAI = parsed.files;
      } catch {
        // timeout o xarxa → seguirem amb fallback
        filesFromAI = null;
      } finally {
        clearTimeout(timer);
      }
    } else {
      clearTimeout(timer);
    }

    // Si l’IA ha tornat fitxers vàlids, endavant
    if (isValidFiles(filesFromAI)) {
      return json({ ok: true, files: filesFromAI });
    }

    // ---------- Fallback “intel·ligent” amb accions bàsiques ----------
    const fallbackFiles = applyLocalEditFallback(current, prompt);

    return json({
      ok: true,
      files: fallbackFiles,
      note: filesFromAI ? 'missing_index_fallback' : 'openai_error_fallback',
      upstream_status: upstreamStatus || undefined,
    });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
};

/* ------------------------------ Utils base ------------------------------ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

function normalizeFiles(input) {
  const out = { ...input };
  if (typeof out['index.html'] !== 'string') out['index.html'] = defaultIndex();
  if (typeof out['styles/style.css'] !== 'string') out['styles/style.css'] = '/* css */';
  if (typeof out['scripts/app.js'] !== 'string') out['scripts/app.js'] = '// js';
  return out;
}

function isValidFiles(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!('index.html' in obj)) return false;
  return Object.keys(obj).every((k) => typeof obj[k] === 'string');
}

function safeParseJson(str) { try { return JSON.parse(str); } catch { return null; } }

/* ---------------------- Fallback local ampliat ---------------------- */

function applyLocalEditFallback(files, promptRaw) {
  const prompt = String(promptRaw || '');
  const html0 = files['index.html'];
  const lang = detectLang(html0); // 'ca' | 'es'
  const email = extractEmail(html0) || 'info@example.com';

  // Detecta acció i secció (simple)
  const { action, sectionId } = detectActionAndSection(prompt) ?? { action: 'add', sectionId: findSingleSectionInHTML(html0) || 'contact' };

  let html = html0;
  let css = files['styles/style.css'] || '/* css */';

  if (sectionId === 'testimonials') {
    if (action === 'remove') {
      html = removeLastTestimonial(html);
    } else if (action === 'replace') {
      html = removeLastTestimonial(html);
      html = insertIntoSection(html, 'testimonials', testimonialBlock(lang), prompt);
    } else {
      html = insertIntoSection(html, 'testimonials', testimonialBlock(lang), prompt);
    }
  } else if (sectionId === 'contact') {
    if (action === 'remove') {
      html = stripAIBlocks(html, 'ai-contact');
    } else {
      html = insertIntoSection(html, 'contact', contactBlock(lang, email), prompt);
    }
  } else if (sectionId === 'faq') {
    if (action === 'remove') {
      html = stripAIBlocks(html, 'ai-faq');
    } else {
      html = insertIntoSection(html, 'faq', faqBlock(lang, prompt), prompt);
    }
  } else if (sectionId === 'pricing') {
    if (action === 'remove') {
      html = stripAIBlocks(html, 'ai-pricing');
    } else {
      html = insertIntoSection(html, 'pricing', pricingBlock(lang), prompt);
    }
  } else {
    // genèric: afegeix bloc informatiu
    html = insertIntoSection(html, sectionId, genericNote(lang), prompt);
  }

  css = ensureAIStyles(css);

  return {
    'index.html': html,
    'styles/style.css': css,
    'scripts/app.js': files['scripts/app.js'] || '// js',
  };
}

function detectLang(html) {
  const m = /<html[^>]*\blang=["']([^"']+)["']/i.exec(html);
  const code = (m?.[1] || '').toLowerCase();
  if (code.startsWith('ca')) return 'ca';
  if (code.startsWith('es')) return 'es';
  return 'es';
}
function extractEmail(html) {
  const m1 = /mailto:([^\s"'<>]+)/i.exec(html);
  if (m1) return m1[1];
  const m2 = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/.exec(html);
  if (m2) return m2[1];
  return null;
}

function detectActionAndSection(promptRaw) {
  const p = String(promptRaw || '').toLowerCase();
  if (!p) return null;

  const sectionMap = [
    { id: 'testimonials', keys: ['testimon', 'reseña', 'review'] },
    { id: 'contact', keys: ['contact', 'contacte', 'contacto', 'email', 'tel'] },
    { id: 'faq', keys: ['faq', 'preguntes', 'preguntas', 'frecuentes'] },
    { id: 'pricing', keys: ['pricing', 'precio', 'preu', 'planes', 'plan'] },
    { id: 'gallery', keys: ['galeria', 'galería', 'gallery'] },
    { id: 'about', keys: ['sobre', 'about', 'qui som', 'quiénes'] },
    { id: 'features', keys: ['caracter', 'feature', 'benefici', 'beneficio'] },
    { id: 'hero', keys: ['hero', 'encabezado', 'capçalera', 'headline', 'cta'] },
  ];
  const actionMap = [
    { id: 'remove', keys: ['elimina', 'remove', 'borra', 'suprimeix', 'quita', 'delete'] },
    { id: 'replace', keys: ['reemplaza', 'replace', 'substitueix', 'sustituye'] },
    { id: 'add', keys: ['añade', 'afegeix', 'agrega', 'add'] },
  ];

  let sectionId = null;
  for (const s of sectionMap) if (s.keys.some(k => p.includes(k))) { sectionId = s.id; break; }
  if (!sectionId) return null;

  let action = 'add';
  for (const a of actionMap) if (a.keys.some(k => p.includes(k))) { action = a.id; break; }

  return { action, sectionId };
}

function findSingleSectionInHTML(html) {
  const ids = ['contact', 'testimonials', 'faq', 'pricing', 'gallery', 'about', 'features', 'hero'];
  const present = ids.filter((id) => new RegExp(`id=["']${id}["']`, 'i').test(html));
  if (present.length === 1) return present[0];
  return null;
}

function sanitizeAttr(s) { return String(s).replace(/[<>"']/g, ''); }
function insertIntoSection(html, sectionId, block, prompt) {
  const comment = `<!-- ai: inserted section="${sectionId}" prompt="${sanitizeAttr(String(prompt).slice(0,160))}${String(prompt).length>160?'…':''}" -->`;
  const sectionClose = new RegExp(`(<section[^>]*id=["']${sectionId}["'][\\s\\S]*?)(</section>)`, 'i');
  if (sectionClose.test(html)) {
    return html.replace(sectionClose, (_m, body, close) => `${body}\n${comment}\n${block}\n${close}`);
  }
  const mainClose = /(<main[^>]*>)([\s\S]*?)(<\/main>)/i;
  if (mainClose.test(html)) {
    return html.replace(mainClose, (_m, open, content, close) => `${open}${content}\n${comment}\n${block}\n${close}`);
  }
  return html.replace(/<\/body>/i, `${comment}\n${block}\n</body>`);
}

function stripAIBlocks(html, klass) {
  const re = new RegExp(
    `<(?:div|p|figure|ul|details)[^>]*class=["'][^"']*\\b${klass}\\b[^"']*["'][\\s\\S]*?<\\/(?:div|p|figure|ul|details)>`,
    'ig'
  );
  return html.replace(re, '');
}

function removeLastTestimonial(html) {
  // Busca l’últim bloc testimonial (AI o existent) dins la secció testimonis
  const sectionRe = /(<section[^>]*id=["']testimonials["'][\s\S]*?<\/section>)/i;
  const match = html.match(sectionRe);
  if (!match) return html;

  const sec = match[1];
  const figs = [...sec.matchAll(/<figure[^>]*class=["'][^"']*testimon[^"']*["'][\s\S]*?<\/figure>/ig)];
  if (!figs.length) return html;

  const last = figs[figs.length - 1][0];
  const secNew = sec.replace(last, '');
  return html.replace(sectionRe, secNew);
}

function testimonialBlock(lang) {
  const t = (lang === 'ca')
    ? { quote: '“Mai havia experimentat una tecnologia tan immersiva en l’esport.”', name: 'Laura P.', role: 'Entrenadora de boulder' }
    : { quote: '“Nunca había vivido una tecnología tan inmersiva en el deporte.”', name: 'Laura P.', role: 'Entrenadora de boulder' };
  return `
  <figure class="ai-block ai-testimonial" aria-label="${lang==='ca'?'Testimoni':'Testimonio'}">
    <div class="ai-stars" aria-hidden="true">★★★★★</div>
    <blockquote>${t.quote}</blockquote>
    <figcaption>— ${t.name}, <span class="role">${t.role}</span></figcaption>
  </figure>`.trim();
}

function contactBlock(lang, email) {
  const t = (lang === 'ca')
    ? { title: 'Més informació', line1: `Escriu-nos a <a href="mailto:${email}">${email}</a> i t’assessorarem.`, line2: 'També podem programar una trucada per resoldre dubtes.' }
    : { title: 'Más información', line1: `Escríbenos a <a href="mailto:${email}">${email}</a> y te asesoramos.`, line2: 'También podemos programar una llamada para resolver dudas.' };
  return `
  <div class="ai-block ai-contact">
    <h3>${t.title}</h3>
    <p>${t.line1}<br>${t.line2}</p>
  </div>`.trim();
}

function faqBlock(lang, prompt) {
  const topic = guessTopic(prompt, lang);
  const t = (lang === 'ca')
    ? { q: `Com funciona ${topic}?`, a: 'Resum ràpid: és modular, segur i s’instal·la sense obres complexes.' }
    : { q: `¿Cómo funciona ${topic}?`, a: 'Resumen rápido: es modular, seguro y se instala sin obras complejas.' };
  return `
  <div class="ai-block ai-faq">
    <details>
      <summary>${t.q}</summary>
      <p>${t.a}</p>
    </details>
  </div>`.trim();
}

function pricingBlock(lang) {
  const t = (lang === 'ca')
    ? { title: 'Pla Pro', price: '49 €/mes', btn: 'Comença ara' }
    : { title: 'Plan Pro', price: '49 €/mes', btn: 'Empieza ahora' };
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

function genericNote(lang) {
  const t = (lang === 'ca') ? 'Contingut actualitzat automàticament.' : 'Contenido actualizado automáticamente.';
  return `<p class="ai-block">${t}</p>`;
}

function guessTopic(prompt, lang) {
  const p = (prompt || '').trim();
  if (!p) return (lang === 'ca') ? 'el sistema' : 'el sistema';
  const just = p
    .replace(/["«»“”]/g, '')
    .replace(/\b(afeg(eix|ir)|añade|agrega|add|más|més|sección|seccio|section|testimoni(?:s)?|reseña(?:s)?|review(?:s)?|contacte|contacto|faq|pricing|precios|galeria|galería|gallery|elimina|remove|borra|suprimeix|quita|reemplaza|replace|sustituye|substitueix)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!just) return (lang === 'ca') ? 'el sistema' : 'el sistema';
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
