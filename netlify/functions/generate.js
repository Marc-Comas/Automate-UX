
// netlify/functions/generate.js (CommonJS)

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { mode = 'generate', prompt = '', name = 'sitio', files } = body;

    // === CREDENCIALES ===
    const key = process.env.OPENAI_API_KEY || event.headers['x-openai-key'] || event.headers['X-OpenAI-Key'];
    const asst = process.env.OPENAI_ASSISTANT_ID || event.headers['x-openai-asst'] || event.headers['X-OpenAI-Asst'];
    if (!key || !asst) return jsonResp(400, { error: 'Faltan credenciales de OpenAI (OPENAI_API_KEY y OPENAI_ASSISTANT_ID).' });

    // Opcionales (útiles con claves sk-proj-...):
    const org = process.env.OPENAI_ORG_ID;
    const project = process.env.OPENAI_PROJECT || process.env.OPENAI_PROJECT_ID;

    // === HEADERS V2 (OBLIGATORIO EL BETA) ===
    const h = {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2'
    };
    if (org) h['OpenAI-Organization'] = org;
    if (project) h['OpenAI-Project'] = project;

    // === CONTENIDO DEL MENSAJE (SOLO ROLE: "user") ===
    // En v2, no uses role "system" en los mensajes del thread.
    // Las reglas de salida mejor dejarlas en las instrucciones del Assistant; si
    // quieres forzarlas aquí, las anteponemos al brief en el mensaje user.
    const rules = `RESPETA EL FORMATO DE SALIDA.

STEP 4 – CODE GENERATION (Single HTML file)
- Semantic HTML5 con <header>, <nav>, <main>, <section>, <footer>
- CSS en <style> con --color-primary, --color-bg, --font-heading, --font-body
- JS vanilla en <script>; responsive + accesible (WCAG AA); sin CDNs
- SPA hash routing si procede
STEP 5 – OUTPUT FORMAT (SOLO JSON)
{
  "files": {
    "index.html": "<html>...</html>",
    "styles/style.css": "/* opcional */",
    "scripts/app.js": "// opcional"
  }
}`;

    const userBrief =
      mode === 'edit' && files && typeof files === 'object'
        ? `Modifica el proyecto según el prompt.\nPROMPT:\n${prompt}\n\nFILES (JSON):\n${JSON.stringify({ files })}`
        : `Genera una landing para: ${name}\nPROMPT:\n${prompt || 'Genera landing base responsive.'}`;

    const userMessage = `${rules}\n\n${userBrief}`;

    // === 1) CREAR THREAD VACÍO ===
    const thrRes = await fetch('https://api.openai.com/v1/threads', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({})
    });
    const thread = await thrRes.json();
    if (!thrRes.ok || !thread.id) {
      return jsonResp(thrRes.status || 502, { error: 'No se pudo crear el thread', details: thread });
    }

    // === 2) AÑADIR MENSAJE USER ===
    const msgRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ role: 'user', content: userMessage })
    });
    const msgJson = await msgRes.json();
    if (!msgRes.ok) {
      return jsonResp(msgRes.status || 502, { error: 'No se pudo añadir el mensaje al thread', details: msgJson });
    }

    // === 3) CREAR RUN ===
    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({
    assistant_id: asst,
    response_format: { type: 'json_object' } // <- fuerza JSON válido
  })
});


    // === 4) POLL DE ESTADO ===
    const deadline = Date.now() + 90000;
    let status = run.status, snap = run;
    while (status === 'queued' || status === 'in_progress' || status === 'requires_action') {
      if (Date.now() > deadline) return jsonResp(504, { error: 'Timeout esperando al Assistant' });
      await sleep(1200);
      const rs = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, { headers: h });
      snap = await rs.json();
      status = snap.status;
    }
    if (status !== 'completed') {
      return jsonResp(502, { error: 'Run no completado', details: snap });
    }

    // === 5) LEER MENSAJES Y EXTRAER TEXTO ===
    const msgsRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, { headers: h });
    const msgs = await msgsRes.json();
    const txt = extractText(msgs);
    const raw = txt.trim();
    let payload;
    try {
  // intenta parsear tal cual; si viniera con ```json ... ``` tu regex actual ya lo limpia
  const clean = raw.replace(/```json\s*([\s\S]*?)\s*```/i, '$1').trim();
  payload = JSON.parse(clean);
} catch {
  return jsonResp(502, { error: 'Respuesta no es JSON válido', raw });
}

// acepta { files: {...} } o directamente { "index.html": ... }
const maybeFiles = payload.files || payload;
if (!maybeFiles || typeof maybeFiles !== 'object' || !maybeFiles['index.html']) {
  return jsonResp(502, { error: 'JSON sin files.index.html', payload });
}
return jsonResp(200, { files: maybeFiles });


    // === 6) PARSEAR JSON DE ARCHIVOS ===
    let payload;
    try {
      const clean = txt.replace(/```json\\s*([\\s\\S]*?)\\s*```/gi, '$1').trim();
      payload = JSON.parse(clean);
    } catch (e) {
      return jsonResp(502, { error: 'Respuesta no es JSON válido', raw: txt });
    }
    if (!payload.files || !payload.files['index.html']) {
      return jsonResp(502, { error: 'JSON sin files.index.html', payload });
    }

    return jsonResp(200, payload);

  } catch (err) {
    return jsonResp(500, { error: 'Fallo interno', details: err.message || String(err) });
  }
};

function corsHeaders(){ return {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,x-openai-key,x-openai-asst'}; }
function jsonResp(code,obj){ return { statusCode: code, headers: { ...corsHeaders(), 'Content-Type':'application/json' }, body: JSON.stringify(obj) }; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function extractText(msgs){
  try{
    const data = msgs.data || [];
    for (let i = data.length - 1; i >= 0; i--) {
      const m = data[i];
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const p of m.content) {
          // v2 puede usar 'text' o 'output_text'
          if ((p.type === 'text' || p.type === 'output_text') && p.text?.value) return p.text.value;
        }
      }
    }
    return null;
  } catch { return null; }
}




    const messages = [{ role:'system', content: contextHeader }];
    if (mode === 'edit' && files && typeof files === 'object'){
      messages.push({ role:'user', content: `Modifica el proyecto según el prompt.\nPROMPT:\n${prompt}\n\nFILES (JSON):\n${JSON.stringify({ files })}` });
    } else {
      messages.push({ role:'user', content: `Genera una landing para: ${name}\nPROMPT:\n${prompt || 'Genera landing base responsive.'}` });
    }

    // 1) thread
    const thread = await fetchJSON('https://api.openai.com/v1/threads', {
      method:'POST', headers:oaiHeaders(key, org), body: JSON.stringify({ messages })
    });
    if (!thread?.id) return j(502, { error:'No se pudo crear el thread', details: thread });

    // 2) run
    const run = await fetchJSON(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method:'POST', headers:oaiHeaders(key, org), body: JSON.stringify({ assistant_id: asst })
    });
    if (!run?.id) return j(502, { error:'No se pudo iniciar el run', details: run });

    return j(200, { pending:true, thread_id: thread.id, run_id: run.id, status: run.status });

  } catch (err) {
    return j(500, { error:'Fallo interno', details: err?.message || String(err) });
  }
};

function oaiHeaders(key, org){
  const h = { 'Authorization':`Bearer ${key}`, 'Content-Type':'application/json', 'OpenAI-Beta':'assistants=v2' };
  if (org) h['OpenAI-Organization'] = org;
  return h;
}
function cors(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-openai-key,x-openai-asst,OpenAI-Organization,OpenAI-Project',
    'Access-Control-Max-Age': '600'
  };
}
function j(code,obj){ return { statusCode:code, headers:{...cors(), 'Content-Type':'application/json'}, body: JSON.stringify(obj) }; }
function safeJSON(s){ try{ return JSON.parse(s||'{}'); }catch{ return {}; } }
async function fetchJSON(url, init={}){
  const res = await fetch(url, init);
  const text = await res.text();
  try{ return JSON.parse(text); }catch{ return { _raw:text, status: res.status }; }
}
function extractPayload(msgs){
  try{
    const data = msgs?.data || [];
    for (let i = data.length - 1; i >= 0; i--){
      const m = data[i];
      if (m.role === 'assistant' && Array.isArray(m.content)){
        for (const p of m.content){
          if (p.type === 'text' && p.text?.value){
            const clean = p.text.value.replace(/```json\s*([\s\S]*?)\s*```/gi,'$1').trim();
            try { return JSON.parse(clean); } catch {}
            // alternativa: si el assistant devolvió HTML suelto, empaquetarlo
            if (/<html[\s\S]*<\/html>/i.test(p.text.value)){
              const html = p.text.value.match(/<html[\s\S]*<\/html>/i)[0];
              return { files: { 'index.html': html } };
            }
          }
        }
      }
    }
    return null;
  }catch{ return null; }
}
function sampleText(msgs){
  try{
    const data = msgs?.data || [];
    for (let i = data.length - 1; i >= 0; i--){
      const m = data[i];
      if (m.role === 'assistant'){
        const t = m.content?.find(c=>c.type==='text')?.text?.value || '';
        return t.slice(0,500);
      }
    }
  }catch{}
  return null;
}
