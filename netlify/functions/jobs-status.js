// Netlify Function: jobs-status (robust proxy to Runner)
// GET /.netlify/functions/jobs-status?id=<jobId>
//
// Proxies to:   GET {RUNNER_URL}/jobs-status?id=<jobId>
// Auth header:  x-runner-secret: {RUNNER_SHARED_SECRET}
//
// Returns JSON: { status, result, error, logs }
// Status codes: 200 (ok), 404 (not found), 401 (unauth), 500/502 (runner unreachable)

const RUNNER_URL = process.env.RUNNER_URL || '';
const RUNNER_SHARED_SECRET = process.env.RUNNER_SHARED_SECRET || '';

function corsHeaders() {
  const allow = process.env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
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
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const id = (params.id || '').trim();
    if (!id) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing id' }) };
    }
    if (!RUNNER_URL || !RUNNER_SHARED_SECRET) {
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Runner not configured (env RUNNER_URL/RUNNER_SHARED_SECRET)' }) };
    }

    // Timeout-safe fetch
    const controller = new AbortController();
    const timeoutMs = Number(process.env.RUNNER_FETCH_TIMEOUT_MS || 10000);
    const to = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    async function tryFetch(url, init, attempts=3) {
      let lastErr, res;
      for (let i=0;i<attempts;i++) {
        try {
          res = await fetch(url, init);
          if (res.status >= 500) throw new Error('upstream ' + res.status);
          return res;
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 250 * Math.pow(2,i)));
        }
      }
      throw lastErr || new Error('fetch failed');
    }
    try {
      const url = `${RUNNER_URL.replace(/\/+$/,'')}/jobs-status?id=${encodeURIComponent(id)}`;
      response = await tryFetch(url, {
        method: 'GET',
        headers: { 'x-runner-secret': RUNNER_SHARED_SECRET },
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(to);
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'fetch failed', detail: String(e && e.message || e) }) };
    }
    clearTimeout(to);

    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    // Pass through 200/404/etc, normalize content-type/cors
    return { statusCode: response.status, headers: corsHeaders(), body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message || 'Internal error' }) };
  }
};
