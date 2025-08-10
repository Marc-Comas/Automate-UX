export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };
  try {
    const body = JSON.parse(event.body || '{}');
    const { mode = 'generate', prompt = '', name = 'sitio', files } = body;

    const key = process.env.OPENAI_API_KEY || event.headers['x-openai-key'] || event.headers['X-OpenAI-Key'];
    const asst = process.env.OPENAI_ASSISTANT_ID || event.headers['x-openai-asst'] || event.headers['X-OpenAI-Asst'];
    if (!key || !asst) return jsonResp(400, { error: 'Faltan credenciales de OpenAI (OPENAI_API_KEY y OPENAI_ASSISTANT_ID).' });

    const userBrief = prompt || 'Genera landing base responsive.';
    const contextHeader = `RESPETA EL FORMATO DE SALIDA.
STEP 4 – CODE GENERATION (Single HTML file)
- Semantic HTML5 con <header>, <nav>, <main>, <section>, <footer>
- CSS en <style> con variables --color-primary, --color-bg, --font-heading, --font-body
- JS vanilla en <script>
- Responsive, accesible (WCAG AA), sin CDNs
- SPA hash routing si procede
STEP 5 – OUTPUT FORMAT (SOLO JSON)
{
  "files": {
    "index.html": "<html>...</html>",
    "styles/style.css": "/* opcional */",
    "scripts/app.js": "// opcional"
  }
}`;

    const messages = [];
    if (mode === 'edit' && files && typeof files === 'object') {
      messages.push({ role: 'user', content: `Modifica el proyecto según el prompt.\nPROMPT:\n${userBrief}\n\nFILES (JSON):\n${JSON.stringify({ files })}` });
    } else {
      messages.push({ role: 'user', content: `Genera una landing para: ${name}\nPROMPT:\n${userBrief}` });
    }
    messages.unshift({ role: 'system', content: contextHeader });

    const thrRes = await fetch('https://api.openai.com/v1/threads', {
      method: 'POST',
      headers: openaiHeaders(key),
      body: JSON.stringify({ messages })
    });
    const thread = await thrRes.json();
    if (!thread.id) return jsonResp(502, { error: 'No se pudo crear el thread', details: thread });

    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: openaiHeaders(key),
      body: JSON.stringify({ assistant_id: asst })
    });
    const run = await runRes.json();
    if (!run.id) return jsonResp(502, { error: 'No se pudo iniciar el run', details: run });

    const deadline = Date.now() + 90000;
    let status = run.status;
    let snap = run;
    while (status === 'queued' || status === 'in_progress' || status === 'requires_action') {
      if (Date.now() > deadline) return jsonResp(504, { error: 'Timeout esperando al Assistant' });
      await sleep(1200);
      const rs = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        headers: openaiHeaders(key)
      });
      snap = await rs.json();
      status = snap.status;
    }
    if (status !== 'completed') return jsonResp(502, { error: 'Run no completado', details: snap });

    const msgsRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      headers: openaiHeaders(key)
    });
    const msgs = await msgsRes.json();
    const txt = extractText(msgs);
    if (!txt) return jsonResp(502, { error: 'Sin contenido del Assistant.' });

    let payload;
    try {
      const clean = txt.replace(/```json\s*([\s\S]*?)\s*```/gi, '$1').trim();
      payload = JSON.parse(clean);
    } catch (e) {
      return jsonResp(502, { error: 'Respuesta no es JSON válido', raw: txt });
    }
    if (!payload.files || !payload.files['index.html']) return jsonResp(502, { error: 'JSON sin files.index.html', payload });

    return jsonResp(200, payload);
  } catch (err) {
    return jsonResp(500, { error: 'Fallo interno', details: err.message || String(err) });
  }
};
function corsHeaders(){ return {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,x-openai-key,x-openai-asst'}; }
function jsonResp(code,obj){ return { statusCode: code, headers: { ...corsHeaders(), 'Content-Type':'application/json' }, body: JSON.stringify(obj) }; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function extractText(msgs){ try{ const data=msgs.data||[]; for(let i=data.length-1;i>=0;i--){const m=data[i]; if(m.role==='assistant'&&Array.isArray(m.content)){ for(const p of m.content){ if(p.type==='text'&&p.text&&p.text.value) return p.text.value; } } } return null; }catch{return null;} }
function openaiHeaders(key) {
  const h = {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2'
  };
  // Opcional si usas clave de PROYECTO (empieza por sk-proj-):
  if (process.env.OPENAI_PROJECT) h['OpenAI-Project'] = process.env.OPENAI_PROJECT;
  if (process.env.OPENAI_ORG_ID) h['OpenAI-Organization'] = process.env.OPENAI_ORG_ID;
  return h;
}
