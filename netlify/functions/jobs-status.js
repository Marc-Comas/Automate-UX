// Netlify Function: jobs-status
// This serverless function queries the long‑running job runner for the
// current status of a job. It requires the job ID as a query string
// parameter and uses a shared secret to authenticate with the runner.

const RUNNER_URL = process.env.RUNNER_URL || '';
const SHARED_SECRET = process.env.RUNNER_SHARED_SECRET || '';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    // Allow x-runner-secret header for authenticated requests. The client
    // does not need to set this header; it is used internally by the
    // Netlify function when calling the runner. Including it here avoids
    // CORS preflight issues if ever forwarded through a browser.
    'Access-Control-Allow-Headers': 'Content-Type,x-runner-secret',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

exports.handler = async function(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  // Only allow GET
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const id = (event.queryStringParameters && event.queryStringParameters.id) || null;
  if (!id) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing job id' }) };
  }
  try {
    const url = `${RUNNER_URL}/jobs-status?id=${encodeURIComponent(id)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-runner-secret': SHARED_SECRET,
      },
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