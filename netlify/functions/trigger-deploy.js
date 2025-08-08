export const handler = async () => {
  try {
    const hook = process.env.NETLIFY_BUILD_HOOK;
    if (!hook) return j(400, { error: 'Falta NETLIFY_BUILD_HOOK en variables de entorno' });
    const res = await fetch(hook, { method: 'POST' });
    if (!res.ok) return j(502, { error: 'Netlify hook respondió error', status: res.status });
    return j(200, { ok: true });
  } catch (err) {
    return j(500, { error: 'Fallo al llamar build hook', details: err.message || String(err) });
  }
};
function j(code,obj){ return { statusCode: code, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) }; }
