// netlify/functions/generate.js
// ÚNICA implementación. Formato Netlify Functions (ESM) con "type":"module".
// Política: NUNCA hacer cambios silenciosos si la IA falla. Si falla => 502.
// Para “crear” puedes permitir fallback enviando allowFallback:true.

const TIMEOUT_MS = 22000;

export const handler = async (event) => {
  // CORS
  if (event.httpMethod === 'OPTIONS') return j(204, {});
  if (event.httpMethod !== 'POST') return j(405, { ok: false, error: 'Method not allowed' });

  try {
    const body = safeJson(event.body);
    const {
      mode = 'edit',                  // 'edit' | 'create'
      name = 'project',
      prompt = '',
      files = {},
      allowFallback = mode === 'create' // por defecto SOLO en creación
    } = body;

    const headers = event.headers || {};
    const apiKey = headers['x-openai-key'] || headers['X-OpenAI-Key'] || process.env.OPENAI_API_KEY || '';
    const openaiOrg = process.env.OPENAI_ORG_ID || '';
    const openaiProject = process.env.OPENAI_PROJECT || '';
    const model = process.env.OPENAI_MODEL || 'gpt-4o';

    // Asegura estructura mínima
    const current = normalizeFiles(files);

    // Timeout duro (Netlify corta ~26s)
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort('timeout'), TIMEOUT_MS);

    let aiFiles = null, upstream = 0, aiError = '';

    if (apiKey) {
      try {
        // IMPORTANT: JSON Schema estricto y válido para response_format
        // - strict:true => el validador exige "required" que contenga TODAS las keys de "properties" en cada objeto que tenga "properties".
        // - Para el objeto "files", enumeramos propiedades explícitas y ponemos additionalProperties:false.
        const schema = {
          name: 'files_payload',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              files: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  "index.html": { type: "string" },
                  "styles/style.css": { type: "string" },
                  "scripts/app.js": { type: "string" }
                },
                // Solo exigimos index.html; los demás pueden omitirse
                required: ["index.html"]
              }
            },
            required: ['files']
          }
        };

        const system = [
          'You are a meticulous web code editor for small static sites.',
          'Return ONLY the JSON defined by the schema (no prose, no markdown).',
          'Keep structure and accessibility. Avoid external scripts or remote CSS.'
        ].join(' ');

        const messages = [
          { role: 'system', content: system },
          {
            role: 'user',
            content: JSON.stringify({
              mode, name, prompt,
              files: {
                'index.html': current['index.html'],
                'styles/style.css': current['styles/style.css'],
                'scripts/app.js': current['scripts/app.js']
              }
            })
          }
        ];

        const reqHeaders = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        };
        if (openaiOrg) reqHeaders['OpenAI-Organization'] = openaiOrg;
        if (openaiProject) reqHeaders['OpenAI-Project'] = openaiProject;

        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          signal: ctrl.signal,
          headers: reqHeaders,
          body: JSON.stringify({
            model,
            temperature: 0.2,
            response_format: { type: 'json_schema', json_schema: schema },
            messages
          })
        });
        upstream = resp.status;

        const text = await resp.text();
        let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
        const msg = data?.choices?.[0]?.message?.content;

        if (!resp.ok) {
          aiError = data?.error?.message || `openai_${resp.status}`;
        } else if (!msg) {
          aiError = 'ai_no_message';
        } else {
          let parsed = null; try { parsed = JSON.parse(msg); } catch { aiError = 'ai_inner_not_json'; }
          const out = parsed?.files;
          if (isFiles(out)) aiFiles = sanitizeFiles(out);
          else aiError = 'ai_files_invalid';
        }
      } catch (e) {
        aiError = String(e?.message || e);
      } finally {
        clearTimeout(to);
      }
    } else {
      clearTimeout(to);
      aiError = 'missing_api_key';
    }

    // Éxito IA
    if (isFiles(aiFiles)) return j(200, { ok: true, files: aiFiles });

    // Sin IA válida → o devolvemos error (edit) o fallback (create si allowFallback)
    if (!allowFallback || mode === 'edit') {
      return j(502, { ok: false, error: 'ai_failed', details: aiError, upstream_status: upstream });
    }

    // Fallback sólo si está permitido
    const fb = applyLocalEditFallback(current, prompt);
    return j(200, { ok: true, files: fb, note: 'openai_error_fallback', upstream_status: upstream });

  } catch (err) {
    return j(500, { ok: false, error: err?.message || String(err) });
  }
};

/* ---------------- Helpers básicos ---------------- */
function j(status, payload) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-openai-key,x-openai-asst'
    },
    body: JSON.stringify(payload)
  };
}
function safeJson(x){ try{ return JSON.parse(x || '{}'); }catch{ return {}; } }
function isFiles(obj){ return !!obj && typeof obj==='object' && 'index.html' in obj && Object.values(obj).every(v=>typeof v==='string'); }
function normalizeFiles(input){
  const out = { ...(input||{}) };
  if (typeof out['index.html'] !== 'string') out['index.html'] = defaultIndex();
  if (typeof out['styles/style.css'] !== 'string') out['styles/style.css'] = '/* css */';
  if (typeof out['scripts/app.js'] !== 'string') out['scripts/app.js'] = '// js';
  return out;
}
function sanitizeFiles(files){
  const out = {};
  for (const [k,v] of Object.entries(files)){
    let s = String(v||'');
    // sin scripts o CSS remotos
    s = s.replace(/<script[^>]*\s+src=["'][^"']+["'][^>]*>\s*<\/script>/gi,');
    s = s.replace(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']http[^"']+["'][^>]*>/gi,');
    out[k] = s;
  }
  return out;
}
function defaultIndex(){
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proyecto</title></head><body><main id="app"></main></body></html>`;
}

/* ---------------- Fallback local (no IA) ----------------
   *Mantengo tu lógica base: añadir/editar secciones simples en HTML.*
*/
function applyLocalEditFallback(files, promptRaw){
  const prompt = String(promptRaw||'');
  let html = files['index.html'];
  let css  = files['styles/style.css'] || '/* css */';

  // ejemplo mínimo — extender según tus bloques
  if (/testimon/i.test(prompt) && /(remove|elimina|borra|quita)/i.test(prompt)) {
    html = html.replace(/<section[^>]*id=["']?testimon[^>]*>[\\s\\S]*?<\\/section>/i,'');
  } else if (/oscuro|dark/i.test(prompt)) {
    html = html.replace('<head>', '<head><style>body{background:#0b0f1c;color:#f2f4ff}</style>');
  } else {
    html = html.replace('</body>', `<section style="padding:24px;border-top:1px solid #ddd"><h3>Cambio aplicado</h3><p>${escape(prompt)}</p></section></body>`);
  }

  return { 'index.html': html, 'styles/style.css': css, 'scripts/app.js': files['scripts/app.js'] || '// js' };
}
function escape(s=''){ return s.replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[m])); }
