// ──────────────────────────────────────────────────────────────────────────────
// File: netlify/functions/projects-list.js
// Purpose: List existing projects (folders) from the DATA repo
// Env vars (tries DATA-first, then fallbacks):
//   GITHUB_DATA_TOKEN | GH_DATA_TOKEN | GITHUB_TOKEN | GH_TOKEN
//   GH_DATA_OWNER | GITHUB_OWNER | GH_OWNER
//   GH_DATA_REPO  | GITHUB_DATA_REPO | GITHUB_REPO | GH_REPO
//   GH_DATA_BRANCH | GITHUB_DATA_BRANCH | GH_BRANCH  (default 'main')
// ──────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

function envPick() {
  const OWNER  = process.env.GH_DATA_OWNER  || process.env.GITHUB_OWNER || process.env.GH_OWNER;
  const REPO   = process.env.GH_DATA_REPO   || process.env.GITHUB_DATA_REPO || process.env.GITHUB_REPO || process.env.GH_REPO;
  const BRANCH = process.env.GH_DATA_BRANCH || process.env.GITHUB_DATA_BRANCH || process.env.GH_BRANCH || 'main';
  const TOKEN  = process.env.GITHUB_DATA_TOKEN || process.env.GH_DATA_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return { OWNER, REPO, BRANCH, TOKEN };
}

async function gh(path, { method = 'GET', body } = {}) {
  const { TOKEN } = envPick();
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'project-central-functions',
      ...(TOKEN ? { Authorization: `token ${TOKEN}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw:text }; }
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${res.status}`);
    err.status = res.status; err.data = data; throw err;
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const { OWNER, REPO, BRANCH, TOKEN } = envPick();
  const debug = /(^|&)debug=1(&|$)/.test(event.rawQuery || '');

  try {
    let projects = [];
    // List folder `projects/` at the repo root. If missing → empty list.
    try {
      const list = await gh(`/repos/${OWNER}/${REPO}/contents/projects?ref=${encodeURIComponent(BRANCH)}`);
      projects = Array.isArray(list)
        ? list.filter(x => x.type === 'dir').map(x => ({ name: x.name }))
        : [];
    } catch (e) {
      if (e.status !== 404) throw e; // 404 means no projects folder yet
      projects = [];
    }

    const body = {
      ok: true,
      projects,
      ...(debug ? { hasToken: !!TOKEN, owner: OWNER, repo: REPO, branch: BRANCH } : {})
    };
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  } catch (err) {
    const body = { ok: false, error: 'github_error', details: err.data || err.message };
    return { statusCode: 500, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
};

