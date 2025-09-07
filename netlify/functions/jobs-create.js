// Netlify Function: jobs-create (proxy to Runner)
// POST /.netlify/functions/jobs-create
//
// Body: { preset, prompt, name, files, brand }
// Proxies to: POST {RUNNER_URL}/jobs-create  (x-runner-secret header)
// Returns: 202 { jobId } or error JSON

const RUNNER_URL = process.env.RUNNER_URL || '';
const RUNNER_SHARED_SECRET = process.env.RUNNER_SHARED_SECRET || '';

function corsHeaders() {
  const allow = process.env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { preset = '', prompt = '', name = '', files = {}, brand = null } = payload || {};
  if (!files || typeof files !== 'object') {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'files must be provided' }) };
  }
  if (!RUNNER_URL || !RUNNER_SHARED_SECRET) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Runner not configured (env RUNNER_URL/RUNNER_SHARED_SECRET)' }) };
  }

  try {
    const controller = new AbortController();
    const timeoutMs = Number(process.env.RUNNER_FETCH_TIMEOUT_MS || 10000);
    const to = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${RUNNER_URL.replace(/\/+$/,'')}/jobs-create`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-runner-secret': RUNNER_SHARED_SECRET,
      },
      body: JSON.stringify({ preset, prompt, name, files, brand }),
      signal: controller.signal
    }).catch((e) => ({ ok:false, status: 502, json: async () => ({ error: 'fetch failed', detail: String(e && e.message || e) }) }));

    clearTimeout(to);

    const data = await res.json().catch(() => ({}));
    return { statusCode: res.status || 502, headers: corsHeaders(), body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message || 'Internal error' }) };
  }
};
