// /netlify/functions/generate.mjs
const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-openai-key,x-openai-asst',
};

export default async (req) => {
  // Suport preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { mode = 'new', name = 'Proyecto', prompt = '', files = {} } = body;

    // Claus (headers en local, variables en prod)
    const apiKey =
      req.headers.get('x-openai-key') || process.env.OPENAI_API_KEY || '';
    const openaiProject = process.env.OPENAI_PROJECT || '';
    const openaiOrg = process.env.OPENAI_ORG_ID || '';

    // Evitem 504 de Netlify: límit propi < 26s
    const timeoutMs = 23000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);

    // Si no hi ha clau → fallback immediat (mai 504)
    if (!apiKey) {
      clearTimeout(timer);
      const out =
        mode === 'edit'
          ? localEditServer(files, prompt)
          : generateServer(name, prompt);
      return json({ ok: true, files: out, note: 'no_api_key_fallback' });
    }

    // ---------- Crida a OpenAI (Responses API) ----------
    const system =
      'Eres un generador de sitios. Devuelve SOLO JSON con {"files":{"index.html":"...","styles/style.css":"...","scripts/app.js":"..."}}. No añadas explicaciones fuera del JSON.';

    const payload = {
      model: 'gpt-4.1-mini',
      input: `${system}\n\nUSER_PROMPT:\n${prompt}`,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    };

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (openaiProject) headers['OpenAI-Project'] = openaiProject;
    if (openaiOrg) headers['OpenAI-Organization'] = openaiOrg;

    let data = null;
    let status = 0;
    try {
      const resp = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      status = resp.status;
      const txt = await resp.text();
      try {
        data = txt ? JSON.parse(txt) : null;
      } catch {
        data = null;
      }
    } catch (e) {
      // Timeout/Abort o error de xarxa → data = null per fer fallback
      data = null;
    } finally {
      clearTimeout(timer);
    }

    // Intentem treure el JSON de "files" del que torni OpenAI
    const filesFromAI = extractFilesFromOpenAI(data);

    if (filesFromAI && filesFromAI['index.html']) {
      return json({ ok: true, files: filesFromAI });
    }

    // ---------- Fallback fiable ----------
    const out =
      mode === 'edit'
        ? localEditServer(files, prompt)
        : generateServer(name, prompt);

    return json({
      ok: true,
      files: out,
      note: filesFromAI ? 'missing_index_fallback' : 'openai_error_fallback',
      upstream_status: status || undefined,
    });
  } catch (err) {
    // Últim recurs: mai 504
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
};

// ---------- Helpers ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

/**
 * Intenta extreure {files:{...}} de diferents formats de la Responses API.
 */
function extractFilesFromOpenAI(data) {
  if (!data) return null;

  // 1) data.output_text (quan ve ja com a text)
  if (typeof data.output_text === 'string') {
    const obj = safeParseJson(data.output_text);
    if (obj?.files) return obj.files;
  }

  // 2) data.output (array) → parts amb {text} o {value}
  if (Array.isArray(data.output)) {
    for (const chunk of data.output) {
      // alguns models retornen {type:"message", content:[{type:"output_text", text:"{...}"}]}
      const parts = Array.isArray(chunk?.content) ? chunk.content : [];
      for (const p of parts) {
        const candidate =
          typeof p?.text === 'string'
            ? p.text
            : typeof p?.value === 'string'
            ? p.value
            : null;
        if (candidate) {
          const obj = safeParseJson(candidate);
          if (obj?.files) return obj.files;
        }
      }
    }
  }

  // 3) buscar JSON dins d'algun string general (backup)
  const raw = JSON.stringify(data);
  const match = raw.match(/\{(?:[^{}]|(?<rec>\{(?:[^{}]|\\k<rec>)*\}))*\}/g);
  if (match) {
    for (const block of match) {
      const obj = safeParseJson(block);
      if (obj?.files) return obj.files;
    }
  }
  return null;
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Genera un site mínim (per quan no tenim clau o OpenAI falla).
 */
function generateServer(name, prompt) {
  const title = String(name || 'Project Central').slice(0, 80);
  const desc = (prompt || 'Generat automàticament').slice(0, 200);

  const index = `<!doctype html>
<html lang="ca">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc)}" />
  <style>
    :root{
      --color-primary:#7aa2ff;
      --color-ink:#0b1220;
      --color-bg:#ffffff;
      --space: clamp(16px, 2vw, 24px);
    }
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--color-ink);background:var(--color-bg)}
    header{padding:calc(var(--space)*1.5) var(--space);border-bottom:1px solid #e6e8f0}
    h1{margin:0 0 var(--space) 0;font-size:clamp(20px,3vw,28px)}
    main{padding:var(--space)}
    .cta{display:inline-block;background:var(--color-primary);color:#fff;padding:.75rem 1rem;border-radius:10px;text-decoration:none}
    footer{margin-top:40px;padding:var(--space);border-top:1px solid #e6e8f0;color:#4a5568}
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(desc)}</p>
    <a class="cta" href="#contacte">Contacte</a>
  </header>
  <main id="content">
    <section id="about">
      <h2>Sobre el projecte</h2>
      <p>Plantilla base creada per continuar l'edició amb IA.</p>
      <!-- IA_EDIT -->
    </section>
    <section id="contacte">
      <h2>Contacte</h2>
      <form aria-label="Contacte" onsubmit="event.preventDefault();alert('Gràcies!');">
        <label>Nom <input required name="name"></label>
        <label>Email <input type="email" required name="email"></label>
        <label>Missatge <textarea required name="message"></textarea></label>
        <button>Enviar</button>
      </form>
    </section>
  </main>
  <footer>© ${new Date().getFullYear()} Project Central</footer>
  <script>
  // scroll suau
  document.querySelectorAll('a[href^="#"]').forEach(a=>{
    a.addEventListener('click',e=>{
      const id=a.getAttribute('href').slice(1);
      const el=document.getElementById(id);
      if(el){ e.preventDefault(); el.scrollIntoView({behavior:'smooth'}); }
    });
  });
  </script>
</body>
</html>`;

  const css = `/* styles/style.css: opcional. Mantingut buit per simplicitat */`;
  const js = `// scripts/app.js: opcional.`;

  return {
    'index.html': index,
    'styles/style.css': css,
    'scripts/app.js': js,
  };
}

/**
 * Edita l'index.html local de forma simple i segura (sense OpenAI).
 */
function localEditServer(files, prompt = '') {
  const out = { ...files };
  const html = String(out['index.html'] || '');
  if (!html) {
    // Si no hi ha index, generem base
    return generateServer('Projecte', 'fallback local edit');
  }

  let inject = '';
  const p = prompt.toLowerCase();

  if (p.includes('contacte') || p.includes('contact')) {
    inject =
      '<p class="ia-note">[IA] Informació afegida a la secció de contacte: si vols, escriu-nos a <a href="mailto:info@example.com">info@example.com</a>.</p>';
    out['index.html'] = injectIntoSection(html, 'contacte', inject);
  } else if (p.includes('preu') || p.includes('pricing') || p.includes('precios')) {
    inject =
      '<section id="pricing"><h2>Preus</h2><ul><li>Starter</li><li>Pro</li><li>Enterprise</li></ul></section>';
    out['index.html'] = injectAfterMarker(html, 'IA_EDIT', inject);
  } else {
    inject = `<p class="ia-note">[IA] Canvi simple aplicat: ${escapeHtml(
      prompt.slice(0, 120),
    )}</p>`;
    out['index.html'] = injectAfterMarker(html, 'IA_EDIT', inject);
  }

  // Reescrivim CSS/JS si no existeixen
  if (typeof out['styles/style.css'] !== 'string') out['styles/style.css'] = '/* css */';
  if (typeof out['scripts/app.js'] !== 'string') out['scripts/app.js'] = '// js';

  return out;
}

function injectIntoSection(html, sectionId, fragment) {
  const re = new RegExp(`(<section[^>]+id=["']${sectionId}["'][^>]*>)`, 'i');
  if (re.test(html)) return html.replace(re, `$1\n${fragment}\n`);
  return injectAfterMarker(html, 'IA_EDIT', fragment);
}

function injectAfterMarker(html, marker, fragment) {
  const m = `<!-- ${marker} -->`;
  if (html.includes(m)) return html.replace(m, `${m}\n${fragment}\n`);
  // si no hi ha marcador, l'afegim abans del tancament de main
  return html.replace(/<\/main>/i, `${fragment}\n</main>`);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

