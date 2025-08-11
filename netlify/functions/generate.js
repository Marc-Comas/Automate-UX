
// netlify/functions/generate.js (CommonJS)
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  try {
    const body = safeJSON(event.body);
    const { mode='generate', prompt='', name='sitio', files, poll=false, thread_id, run_id } = body;

    const key  = process.env.OPENAI_API_KEY  || event.headers['x-openai-key']  || event.headers['X-OpenAI-Key'];
    const asst = process.env.OPENAI_ASSISTANT_ID || event.headers['x-openai-asst'] || event.headers['X-OpenAI-Asst'];
    const org  = process.env.OPENAI_ORG_ID || process.env.OPENAI_ORGANIZATION || event.headers['x-openai-org'] || event.headers['X-OpenAI-Org'];
    if (!key || !asst) return j(400, { error:'Faltan credenciales de OpenAI (OPENAI_API_KEY y OPENAI_ASSISTANT_ID).' });

    // --- POLL
    if (poll && thread_id && run_id){
      const snap = await fetchJSON(`https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`, { headers:oaiHeaders(key, org) });
      const status = snap.status;
      if (status === 'completed'){
        const msgs = await fetchJSON(`https://api.openai.com/v1/threads/${thread_id}/messages`, { headers:oaiHeaders(key, org) });
        const payload = extractPayload(msgs);
        if (payload?.files?.['index.html']) return j(200, payload);
        return j(502, { error:'La respuesta no contiene files.index.html', raw: sampleText(msgs) });
      }
      return j(200, { pending:true, status });
    }

    // --- START
    const contextHeader = `RESPETA EL FORMATO DE SALIDA.
STEP 4 – CODE GENERATION (Single HTML file)
- Semantic HTML5 con <header>, <nav>, <main>, <section>, <footer>
- CSS en <style> con variables --color-primary, --color-bg, --font-heading, --font-body
- JS vanilla en <script>
- Responsive, WCAG AA, sin CDNs
- SPA hash routing si procede
STEP 5 – OUTPUT FORMAT (SOLO JSON)
{
  "files": {
    "index.html": "<html>...</html>",
    "styles/style.css": "/* opcional */",
    "scripts/app.js": "// opcional"
  }
}`;

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
