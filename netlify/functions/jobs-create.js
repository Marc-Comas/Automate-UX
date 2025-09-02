// Netlify Function: jobs-create
// This function accepts a POST request containing a prompt, preset,
// files snapshot, and optional brand configuration. It forwards the
// request to the asynchronous runner service using a shared secret
// header for authentication. The runner then queues the job and
// returns a 202 response with a jobId.

const RUNNER_URL = process.env.RUNNER_URL || '';
const SHARED_SECRET = process.env.RUNNER_SHARED_SECRET || '';

/**
 * Build common CORS headers for responses. We allow any origin here to
 * simplify development. In production you can set ALLOWED_ORIGIN in
 * Netlify environment variables and update jobs-status.js similarly.
 */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    // Allow x-runner-secret for server-to-server auth; the browser does
    // not need to set it but including it here avoids CORS preflight
    // issues if ever forwarded through a browser proxy.
    'Access-Control-Allow-Headers': 'Content-Type,x-runner-secret',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

exports.handler = async function(event) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }
  // Parse the JSON body from the client. If parsing fails, return 400.
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }
  // Forward the request to the runner
  try {
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