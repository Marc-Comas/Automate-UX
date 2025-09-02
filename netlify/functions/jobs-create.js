// Netlify Function: jobs-create
// This serverless function proxies job creation requests to the long‑running
// job runner service. It receives a job payload from the client, forwards
// it to the runner with a shared secret for authentication, and returns
// whatever response the runner sends back. This design keeps the Netlify
// function fast (it merely creates the job) and delegates all AI work to
// the dedicated runner.

const RUNNER_URL = process.env.RUNNER_URL || '';
const SHARED_SECRET = process.env.RUNNER_SHARED_SECRET || '';

/**
 * Build a standard CORS header block for JSON responses. In production you
 * should restrict `Access-Control-Allow-Origin` to your own domains.
 */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    // Allow x-runner-secret in case the client needs to forward the
    // shared secret from an authenticated context. Netlify itself uses
    // this header when proxying to the runner.
    'Access-Control-Allow-Headers': 'Content-Type,x-runner-secret',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

exports.handler = async function(event) {
  // Support CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  try {
    const body = JSON.parse(event.body || '{}');
    // Forward the payload to the runner
    const response = await fetch(`${RUNNER_URL}/jobs-create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-runner-secret': SHARED_SECRET,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return {
      statusCode: response.status,
      headers: corsHeaders(),
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message || 'Internal error' }),
    };
  }
};