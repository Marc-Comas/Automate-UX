// netlify/functions/projects-save.js  (CommonJS, Netlify-friendly)

const GITHUB_API = 'https://api.github.com';

function json(code, obj) {
  return {
    statusCode: code,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(obj),
  };
}

function corsPreflight(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  return null;
}

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'project-central-migrator',
  };
}

async function ghGetFileSha({ owner, repo, branch, path, token }) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (res.status === 200) {
    const data = await res.json();
    return data.sha || null;
  }
  // 404 = no existeix; la resta retornem null i ja provarem PUT sense sha
  return null;
}

async function ghPutFile({ owner, repo, branch, path, contentStr, token, message }) {
  const existingSha = await ghGetFileSha({ owner, repo, branch, path, token });
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(contentStr, 'utf-8').toString('base64'),
    branch,
  };
  if (existingSha) body.sha = existingSha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (res.status >= 400) {
    throw new Error(`GitHub PUT failed (${res.status}): ${out.message || 'unknown error'}`);
  }
  return { path, sha: out.content && out.content.sha };
}

function normalizeInput(body) {
  // Accepta { project } o { projects: [...] }
  if (body && body.project) return [body.project];
  if (body && Array.isArray(body.projects)) return body.projects;
  // Compatibilitat: { id, name, files, ... }
  if (body && body.id && body.files) return [body];
  return [];
}

exports.handler = async (event) => {
  // CORS preflight
  const pre = corsPreflight(event);
  if (pre) return pre;

  try {
    // 1) ENV requerides
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GH_DATA_OWNER;
    const repo = process.env.GH_DATA_REPO;
    const branch = process.env.GH_DATA_BRANCH || 'main';

    if (!token || !owner || !repo) {
      return json(400, {
        error: 'env_missing',
        details: 'Falten GITHUB_TOKEN, GH_DATA_OWNER o GH_DATA_REPO',
      });
    }

    // 2) Body
    if (!event.body) return json(400, { error: 'payload_missing' });
    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (e) {
      return json(400, { error: 'invalid_json', details: e.message });
    }

    const projects = normalizeInput(payload);
    if (!projects.length) {
      return json(400, { error: 'no_projects', details: 'No s’han trobat projectes al payload' });
    }

    // 3) Desa cada projecte en /projects/{id}/...
    const results = [];
    for (const p of projects) {
      const pid = p.id || `p-${Date.now()}`;
      const pname = p.name || 'project';
      const files = p.files || {};
      if (!Object.keys(files).length) {
        results.push({ id: pid, name: pname, skipped: true, reason: 'empty_files' });
        continue;
      }

      const root = `projects/${pid}`;
      const commits = [];

      for (const [relPath, contentStr] of Object.entries(files)) {
        const path = `${root}/${relPath}`;
        const message = `migrate(${pid}): ${pname} — update ${relPath}`;
        try {
          const r = await ghPutFile({ owner, repo, branch, path, contentStr, token, message });
          commits.push(r);
        } catch (err) {
          // Si un fitxer falla, capturem però seguim amb la resta
          commits.push({ path, error: err.message });
        }
      }

      results.push({ id: pid, name: pname, committed: commits });
    }

    return json(200, { ok: true, results });

  } catch (err) {
    return json(500, { error: 'server_error', details: err.message });
  }
};

