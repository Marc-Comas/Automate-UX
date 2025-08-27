// /netlify/functions/generate.js
// Funció Netlify per gerar/editar projectes amb OpenAI de forma robusta i ràpida.

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-openai-key,x-openai-asst',
};

// ---- Utilitats bàsiques ----------------------------------------------------

const nowIso = () => new Date().toISOString();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minifica contingut per fer la petició més lleugera */
function lightMinify(str = '') {
  if (!str) return '';
  // treu comentaris HTML/CSS/JS més comuns i espais sobrant
  return String(str)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

/** Retalla una cadena a N caràcters per no saturar l’IA */
function crop(str = '', max = 35000) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n<!-- [cropped ${str.length - max} chars] -->`;
}

/** Neteja el resultat: treu marques [IA] o el mateix prompt literal */
function sanitizeHtml(html = '', prompt = '') {
  let out = String(html || '');
  // elimina línies amb [IA] i similars
  out = out.replace(/\[[Ii][Aa]\][^\n]*\n?/g, '');
  // si per error l’IA ha enganxat el prompt literal, treu-lo
  if (prompt) {
    const escaped = prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '');
  }
  return out;
}

/** Assegura objecte files amb claus conegudes */
function normalizeFiles(files) {
  const safe = {};
  if (files && typeof files === 'object') {
    if (typeof files['index.html'] === 'string') safe['index.html'] = files['index.html'];
    if (typeof files['styles/style.css'] === 'string') safe['styles/style.css'] = files['styles/style.css'];
    if (typeof files['scripts/app.js'] === 'string') safe['scripts/app.js'] = files['scripts/app.js'];
  }
  return safe;
}

/** Construeix un missatge d’error amable però útil per consola de xarxa */
function errPayload(message, extra = {}) {
  return JSON.stringify({ ok: false, error: message, ...extra });
}

// ---- OpenAI (Responses API + JSON Schema strict) ---------------------------

const OPENAI_URL = 'https://api.openai.com/v1/responses';
// Model lleuger i barat, però solvent per edicions curtes
const OPENAI_MODEL = 'gpt-4o-mini';

function buildSchema() {
  return {
    name: 'files_schema',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: {
          type: 'object',
          additionalProperties: false,
          properties: {
            'index.html': { type: 'string' },
            'styles/style.css': { type: 'string' },
            'scripts/app.js': { type: 'string' },
          },
          required: ['index.html'],
        },
        note: { type: 'string' },
      },
      required: ['files'],
    },
  };
}

/** Crida OpenAI amb timeout curt i petits reintents per evitar 504 */
async function callOpenAIJsonStrict({ apiKey, system, user, maxOutputTokens = 2000 }) {
  const schema = buildSchema();

  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: schema },
    max_output_tokens: maxOutputTokens,
  };

  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    // talla dur a 9.5s perquè Netlify no arribi al timeout
    signal: AbortSignal.timeout(9500),
    body: JSON.stringify(body),
  };

  // Reintents amb backoff curt per 429/5xx/timeout
  const MAX_RETRIES = 2;
  let lastErr = null;

  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetch(OPENAI_URL, options);
      const status = res.status;
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // si és 4xx dur per format, no insistim gaire
        if (status >= 400 && status < 500) {
          return { ok: false, upstream_status: status, data };
        }
        // si és 5xx o 429/timeout, reintent
        lastErr = { status, data };
        if (i < MAX_RETRIES) await wait(300 + i * 300);
        continue;
      }

      // Responses API: la sortida JSON estricta ve a data.output[0].content[0].json
      try {
        const out = (((data || {}).output || [])[0] || {}).content || [];
        const jsonBlock = out.find((c) => c.type === 'output_text' || c.type === 'json') || out[0];
        // Alguns desplegaments mostren directament a data.output[0].content[0].text/json
        let parsed = null;
        if (jsonBlock?.json) parsed = jsonBlock.json;
        else if (jsonBlock?.text) parsed = JSON.parse(jsonBlock.text);

        if (!parsed || typeof parsed !== 'object') {
          return { ok: false, upstream_status: 400, data: { message: 'Malformed JSON from model' } };
        }
        return { ok: true, upstream_status: status, data: parsed };
      } catch (e) {
        return { ok: false, upstream_status: 400, data: { message: 'Invalid JSON payload', error: String(e) } };
      }
    } catch (e) {
      lastErr = { status: 'timeout', data: { message: String(e) } };
      if (i < MAX_RETRIES) await wait(300 + i * 300);
    }
  }
  return { ok: false, upstream_status: 504, data: lastErr?.data || { message: 'Timeout' } };
}

// ---- Handler Netlify -------------------------------------------------------

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const {
      mode = 'edit',            // 'generate' | 'edit'
      prompt = '',
      name = 'project',
      files = {},
    } = body || {};

    // Claus API
    const apiKey = req.headers.get('x-openai-key') || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(errPayload('Missing OPENAI_API_KEY'), { status: 400, headers: CORS });
    }

    // Entrada minimitzada
    const indexIn = crop(lightMinify(files['index.html'] || ''), 45000);
    const cssIn   = crop(lightMinify(files['styles/style.css'] || ''), 10000);
    const jsIn    = crop(lightMinify(files['scripts/app.js'] || ''), 8000);

    // Sistem i usuari
    const system = [
      'Ets un editor d’HTML/CSS/JS altament fiable.',
      'Retorna EXCLUSIVAMENT un JSON que compleixi el JSON Schema rebut.',
      'No repeteixis el prompt, no introdueixis comentaris ni marques alienes.',
      'Mantén tota la semàntica i accessibilitat; només aplica la modificació demanada.',
      'Si no és possible exactament, proposa un canvi mínim equivalent que sí sigui possible.',
    ].join(' ');

    const user = JSON.stringify({
      when: nowIso(),
      mode,
      prompt,
      files: {
        'index.html': indexIn,
        'styles/style.css': cssIn,
        'scripts/app.js': jsIn,
      },
    });

    const ai = await callOpenAIJsonStrict({
      apiKey,
      system,
      user,
      maxOutputTokens: 2200,
    });

    if (!ai.ok) {
      // Resposta controlada per no provocar 504 (tallem el camí ràpid)
      return new Response(
        JSON.stringify({
          ok: true,
          note: 'openai_error_fallback',
          upstream_status: ai.upstream_status,
          files: {
            'index.html': sanitizeHtml(indexIn, prompt),
            'styles/style.css': cssIn,
            'scripts/app.js': jsIn,
          },
        }),
        { status: 200, headers: CORS },
      );
    }

    // Normalitza i neteja
    const outFiles = normalizeFiles(ai.data.files);
    if (!outFiles['index.html']) outFiles['index.html'] = indexIn;
    outFiles['index.html'] = sanitizeHtml(outFiles['index.html'], prompt);

    return new Response(
      JSON.stringify({
        ok: true,
        files: outFiles,
        note: ai.data.note || null,
        upstream_status: ai.upstream_status,
      }),
      { status: 200, headers: CORS },
    );
  } catch (e) {
    return new Response(errPayload('Unhandled error', { detail: String(e) }), {
      status: 500,
      headers: CORS,
    });
  }
};
