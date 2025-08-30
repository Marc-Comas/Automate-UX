// netlify/functions/generate.js
// ESM — Netlify Functions (package.json té "type":"module")

// Config
const OPENAI_TIMEOUT_MS = Number(process.env.GEN_AI_TIMEOUT_MS || 9000);

// ----------------------------- Handler --------------------------------------
export async function handler(event) {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return json(204, {});
    }
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'Method not allowed' });
    }

    const { mode = 'edit', prompt = '', name = 'project', files = {} } = safeParse(event.body);
    const current = normalizeFiles(files);

    // 1) Prova OpenAI amb límit curt i resposta estricta JSON
    const canAI = !!(process.env.OPENAI_API_KEY && (process.env.OPENAI_ASSISTANT_ID || process.env.OPENAI_MODEL));
    if (canAI) {
      try {
        const aiFiles = await tryOpenAIEdit({ mode, prompt, name, files: current });
        if (isFiles(aiFiles)) return json(200, { ok: true, files: aiFiles });
      } catch {
        // seguim a fallback
      }
    }

    // 2) Fallback local ràpid i semàntic
    const fb = applyLocalEditFallback(current, prompt);
    return json(200, { ok: true, files: fb, note: 'openai_error_fallback', upstream_status: 400 });
  } catch (err) {
    return json(500, { ok: false, error: err?.message || String(err) });
  }
}

// --------------------------- Helpers bàsics ----------------------------------
function json(status, payload) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    },
    body: JSON.stringify(payload)
  };
}
function safeParse(x) { try { return JSON.parse(x || '{}'); } catch { return {}; } }
function isFiles(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!('index.html' in obj)) return false;
  return Object.keys(obj).every(k => typeof obj[k] === 'string');
}
function normalizeFiles(input) {
  const out = { ...input };
  if (typeof out['index.html'] !== 'string') out['index.html'] = defaultIndex();
  if (typeof out['styles/style.css'] !== 'string') out['styles/style.css'] = '/* css */';
  if (typeof out['scripts/app.js'] !== 'string') out['scripts/app.js'] = '// js';
  return out;
}
function defaultIndex() {
  return `<!doctype html><html lang="ca"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nou projecte</title><link rel="stylesheet" href="styles/style.css"></head>
<body><header><h1>Nou projecte</h1></header>
<main>
  <section id="hero"><h2>Benvingut/da</h2></section>
  <section id="sobre"><h2>Sobre</h2><p>Secció d’exemple.</p></section>
  <section id="galeria"><h2>Galeria</h2></section>
  <section id="testimonis"><h2>Testimonis</h2></section>
  <section id="contacte"><h2>Contacte</h2></section>
</main>
<script src="scripts/app.js"></script></body></html>`;
}

// ------------------------------ OpenAI --------------------------------------
async function tryOpenAIEdit({ mode, prompt, name, files }) {
  const API = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  // Missatges i format estrictes
  const system = [
    'You are a meticulous web code editor.',
    'Return ONLY a JSON object exactly like {"files":{"index.html":"...","styles/style.css":"...","scripts/app.js":"..."}}.',
    'No markdown, no explanations, no extra keys. Keep structure and accessibility.'
  ].join(' ');

  const user = {
    mode, name, prompt,
    files: {
      'index.html': files['index.html'],
      'styles/style.css': files['styles/style.css'],
      'scripts/app.js': files['scripts/app.js']
    }
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort('timeout'), OPENAI_TIMEOUT_MS);

  // Chat Completions amb response_format JSON
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: ctrl.signal,
    headers: {
      'Authorization': `Bearer ${API}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) }
      ]
    })
  }).finally(() => clearTimeout(t));

  const text = await res.text();
  // Si la passarel·la d’OpenAI falla o torna buit → que salti al fallback
  if (!text) throw new Error('empty_ai_response');

  let data; try { data = JSON.parse(text); } catch { throw new Error('ai_not_json'); }

  const msg = data?.choices?.[0]?.message?.content;
  if (!msg) throw new Error('ai_no_content');

  let parsed; try { parsed = JSON.parse(msg); } catch { throw new Error('ai_inner_not_json'); }
  const out = parsed?.files;
  if (!isFiles(out)) throw new Error('ai_files_invalid');

  return out;
}

// -------------------------- Fallback intel·ligent ----------------------------
function applyLocalEditFallback(files, promptRaw) {
  const filesOut = { ...files };
  const html = filesOut['index.html'] || defaultIndex();
  const css  = filesOut['styles/style.css'] || '';
  const js   = filesOut['scripts/app.js'] || '';

  const prompt = normalize(promptRaw);

  let nextHTML = html;

  // Intents bàsics: add/remove/replace + seccions conegudes
  const isAdd      = /(^|\s)(afegeix|añad(e|ir)|agrega|add)\b/.test(prompt);
  const isRemove   = /(^|\s)(elimina|borra|suprimeix|remove)\b/.test(prompt);
  const isReplace  = /(^|\s)(reemplaza|substitueix|sustituye|replace)\b/.test(prompt);

  const targetTestimonials = /(testimonis|testimonios|testimonials)\b/.test(prompt);
  const targetContact      = /(contacte|contacto)\b/.test(prompt);

  if (targetTestimonials) {
    if (isRemove) {
      nextHTML = removeLastTestimonial(nextHTML);
    } else if (isReplace) {
      nextHTML = replaceLastTestimonial(nextHTML, sampleTestimonial());
    } else {
      nextHTML = addTestimonial(nextHTML, sampleTestimonial());
    }
  } else if (targetContact && (isAdd || isReplace)) {
    nextHTML = addContactNote(nextHTML);
  } else {
    // Si no entenem la intenció, fem una anotació discreta sense eco del prompt
    nextHTML = ensureAINote(nextHTML, 'S’ha aplicat un canvi simple (fallback). Revisa-ho i concreta més el prompt si cal.');
  }

  filesOut['index.html'] = nextHTML;
  filesOut['styles/style.css'] = ensureAINoteCSS(css);
  filesOut['scripts/app.js'] = js;
  return filesOut;
}

// Utils fallback ---------------------------------------------------------------
function normalize(s) {
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // treu accents
    .replace(/\s+/g,' ').trim();
}
function ensureAINoteCSS(css) {
  if (/\.ai-note\b/.test(css)) return css;
  return css + `
.ai-note{background:#fff8c5;border-left:4px solid #e6b800;padding:8px 10px;margin:10px 0;border-radius:6px;font-size:.95rem}
.ai-note small{opacity:.8}
`;
}
function getSection(html, idRe) {
  const re = new RegExp(`<section[^>]*id=["']${idRe}["'][\\s\\S]*?<\\/section>`, 'i');
  const m = html.match(re);
  return m ? { match: m[0], re } : null;
}
function addTestimonial(html, { quote, author, stars }) {
  const sec = getSection(html, '(testimonis|testimonios)');
  const block = `
<figure class="testimonial">
  <div aria-label="${stars} estrelles" title="${stars}★">${'★'.repeat(stars)}</div>
  <blockquote>“${quote.replace(/"/g,'&quot;')}”</blockquote>
  <figcaption>— ${author}</figcaption>
</figure>`;
  if (sec) return html.replace(sec.re, s => s.replace('</section>', block + '\n</section>'));
  return html.replace('</main>', `<section id="testimonis"><h2>Testimonis</h2>${block}</section></main>`);
}
function removeLastTestimonial(html) {
  const sec = getSection(html, '(testimonis|testimonios)');
  if (!sec) return html;
  const newSec = sec.match.replace(/<figure class="testimonial">[\s\S]*?<\/figure>(?![\s\S]*<figure class="testimonial">)/i, '');
  return html.replace(sec.re, newSec);
}
function replaceLastTestimonial(html, t) {
  const sec = getSection(html, '(testimonis|testimonios)');
  if (!sec) return addTestimonial(html, t);
  const block = `
<figure class="testimonial">
  <div aria-label="${t.stars} estrelles" title="${t.stars}★">${'★'.repeat(t.stars)}</div>
  <blockquote>“${t.quote.replace(/"/g,'&quot;')}”</blockquote>
  <figcaption>— ${t.author}</figcaption>
</figure>`;
  const newSec = sec.match.replace(/<figure class="testimonial">[\s\S]*?<\/figure>(?![\s\S]*<figure class="testimonial">)/i, block);
  return html.replace(sec.re, newSec);
}
function addContactNote(html) {
  const sec = getSection(html, '(contacte|contacto)');
  const note = `<p class="ai-note"><strong>Info:</strong> Per a més informació escriu-nos a <a href="mailto:info@example.com">info@example.com</a>.</p>`;
  if (sec) return html.replace(sec.re, s => s.replace('</section>', note + '\n</section>'));
  return html.replace('</main>', `<section id="contacte"><h2>Contacte</h2>${note}</section></main>`);
}
function ensureAINote(html, text) {
  const p = `<p class="ai-note"><small>${text}</small></p>`;
  const sec = getSection(html, '(sobre|hero|galeria|testimonis|contacte|inicio|inici)');
  if (sec) return html.replace(sec.re, s => s.replace('</section>', p + '\n</section>'));
  return html.replace('</main>', `${p}</main>`);
}
function sampleTestimonial() {
  const samples = [
    { quote: 'Una experiència immersiva genial. Els nostres clients han notat el canvi.', author: 'Carla S., Responsable de fitness', stars: 5 },
    { quote: 'Instal·lació ràpida i impacte immediat a la comunitat esportiva.', author: 'Joan M., Gestor de centre', stars: 5 },
    { quote: 'Disseny i tecnologies en harmonia; la gent repeteix.', author: 'Laura P., Entrenadora', stars: 5 }
  ];
  return samples[Math.floor(Math.random()*samples.length)];
}
