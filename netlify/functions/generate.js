
// netlify/functions/generate.js
// Project Central — OpenAI Assistants v2 generator (JSON-first)

export const handler = async (event) => {
  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  try {
    // ==== Input ====
    const body = safeJson(event.body);
    const { mode = 'generate', prompt = '', name = 'sitio', files } = body;

    // ==== Credentials ====
    const key  =
      process.env.OPENAI_API_KEY ||
      event.headers['x-openai-key'] ||
      event.headers['X-OpenAI-Key'];
    const asst =
      process.env.OPENAI_ASSISTANT_ID ||
      event.headers['x-openai-asst'] ||
      event.headers['X-OpenAI-Asst'];

    if (!key || !asst) {
      return jsonResp(400, {
        error:
          'Faltan credenciales de OpenAI (OPENAI_API_KEY y OPENAI_ASSISTANT_ID).',
      });
    }

    // Opcionales (muy recomendables si tu key es sk-proj-...):
    const org     = process.env.OPENAI_ORG_ID || '';
    const project = process.env.OPENAI_PROJECT || process.env.OPENAI_PROJECT_ID || '';

    // ==== Headers v2 obligatorios ====
    const oaHeaders = () => {
      const h = {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2',
      };
      if (org) h['OpenAI-Organization'] = org;
      if (project) h['OpenAI-Project'] = project;
      return h;
    };

    // ==== Prompt engineering (sin "system" en threads v2) ====
    const rules = `RESPETA EL FORMATO DE SALIDA.

STEP 4 – CODE GENERATION (Single HTML file)
- Semantic HTML5 con <header>, <nav>, <main>, <section>, <footer>
- CSS en <style> con variables: --color-primary, --color-bg, --font-heading, --font-body
- JS vanilla en <script>; responsive; accesible (WCAG AA); sin CDNs externos
- SPA hash routing si procede

STEP 5 – OUTPUT FORMAT (SOLO JSON):
{
  "files": {
    "index.html": "<html>...</html>",
    "styles/style.css": "/* opcional */",
    "scripts/app.js": "// opcional"
  }
}`;

    const userBrief =
      mode === 'edit' && files && typeof files === 'object'
        ? `Modifica el proyecto según el prompt.\nPROMPT:\n${prompt}\n\nFILES (JSON):\n${JSON.stringify(
            { files },
            null,
            2
          )}`
        : `Genera una landing para: ${name}\nPROMPT:\n${
            prompt || 'Genera landing base responsive.'
          }`;

    const userMessage = `${rules}\n\n${userBrief}`;

    // ==== 1) Crear thread vacío ====
    const thrRes = await fetch('https://api.openai.com/v1/threads', {
      method: 'POST',
      headers: oaHeaders(),
      body: JSON.stringify({}),
    });
    const thread = await thrRes.json();
    if (!thrRes.ok || !thread?.id) {
      return jsonResp(thrRes.status || 502, {
        error: 'No se pudo crear el thread',
        details: thread,
      });
    }

    // ==== 2) Añadir mensaje (solo role:user en v2) ====
    const msgRes = await fetch(
      `https://api.openai.com/v1/threads/${thread.id}/messages`,
      {
        method: 'POST',
        headers: oaHeaders(),
        body: JSON.stringify({
          role: 'user',
          // En v2, el contenido recomendado es array con type:text
          content: [{ type: 'text', text: userMessage }],
        }),
      }
    );
    const msgJson = await msgRes.json();
    if (!msgRes.ok) {
      return jsonResp(msgRes.status || 502, {
        error: 'No se pudo añadir el mensaje al thread',
        details: msgJson,
      });
    }

    // ==== 3) Lanzar run ====
    const runRes = await fetch(
      `https://api.openai.com/v1/threads/${thread.id}/runs`,
      {
        method: 'POST',
        headers: oaHeaders(),
        body: JSON.stringify({
          assistant_id: asst,
          // Forzamos JSON válido siempre, aunque el assistant ya lo tenga configurado
          response_format: { type: 'json_object' },
        }),
      }
    );
    const run = await runRes.json();
    if (!runRes.ok || !run?.id) {
      return jsonResp(runRes.status || 502, {
        error: 'No se pudo iniciar el run',
        details: run,
      });
    }

    // ==== 4) Polling hasta "completed" ====
    const deadline = Date.now() + 90_000;
    let status = run.status;
    let snap = run;

    while (
      status === 'queued' ||
      status === 'in_progress' ||
      status === 'requires_action'
    ) {
      if (Date.now() > deadline) {
        return jsonResp(504, { error: 'Timeout esperando al Assistant' });
      }
      await sleep(1200);

      const rs = await fetch(
        `https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`,
        { headers: oaHeaders() }
      );
      snap = await rs.json();
      status = snap?.status;
    }

    if (status !== 'completed') {
      return jsonResp(502, { error: 'Run no completado', details: snap });
    }

    // ==== 5) Leer mensajes del assistant ====
    const msgsRes = await fetch(
      `https://api.openai.com/v1/threads/${thread.id}/messages?order=desc&limit=12`,
      { headers: oaHeaders() }
    );
    const msgs = await msgsRes.json();
    const txt = extractAssistantText(msgs);
    if (!txt) {
      return jsonResp(502, { error: 'Sin contenido del Assistant.', raw: msgs });
    }

    // ==== 6) Parseo robusto (JSON-first + normalización + fallback HTML) ====
    const raw = String(txt).trim();
    const clean = raw.replace(/```json\s*([\s\S]*?)\s*```/i, '$1').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Fallback: ¿vino HTML puro?
      const html = extractHtml(raw);
      if (html) {
        return jsonResp(200, {
          files: {
            'index.html': html,
            'styles/style.css': '/* opcional */',
            'scripts/app.js': '// opcional',
          },
        });
      }
      return jsonResp(502, { error: 'Respuesta no es JSON válido', raw });
    }

    // Acepta tanto { files: {...} } como {"index.html":"..."} y lo normaliza
    const maybeFiles =
      (parsed && parsed.files && typeof parsed.files === 'object' && parsed.files) ||
      (parsed && typeof parsed === 'object' ? parsed : null);

    if (!maybeFiles || !maybeFiles['index.html']) {
      return jsonResp(502, {
        error: 'JSON sin files.index.html',
        payload: parsed,
      });
    }

    return jsonResp(200, { files: maybeFiles });
  } catch (err) {
    return jsonResp(500, {
      error: 'Fallo interno',
      details: err?.message || String(err),
    });
  }
};

/* ===================== Helpers ===================== */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,x-openai-key,x-openai-asst',
    'Access-Control-Max-Age': '600',
  };
}

function jsonResp(code, obj) {
  return {
    statusCode: code,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractAssistantText(msgs) {
  try {
    const data = msgs?.data || [];
    for (const m of data) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const c of m.content) {
          // v2 suele traer { type:'text', text:{ value:'...' } }
          if (c.type === 'text' && c.text?.value) return c.text.value;
          // algunos tenants devuelven 'output_text'
          if (c.type === 'output_text' && typeof c.text === 'string') return c.text;
        }
      }
    }
  } catch {}
  return null;
}

function extractHtml(s) {
  const m = String(s).match(/<\s*html[\s\S]*<\/\s*html\s*>/i);
  return m ? m[0] : null;
}
