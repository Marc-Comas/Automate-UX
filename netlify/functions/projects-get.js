// netlify/functions/projects-get.js
// GET  /.netlify/functions/projects-get?slug=…  (o ?id=…)
// Retorna: { project: {...}, files: { "index.html": "...", "styles/style.css": "..." } }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

// Llegeix variables d’entorn (prioritza les *DATA*, després generiques)
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
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function decodeBase64(content) {
  try { return Buffer.from(content || '', 'base64').toString('utf8'); } catch { return ''; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Use GET' }) };
    }

    const qp = new URLSearchParams(event.queryStringParameters || {});
    const slug = (qp.get('slug') || qp.get('id') || '').trim();
    if (!slug) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing slug' }) };
    }

    const { OWNER, REPO, BRANCH } = envPick();
    const base = `projects/${slug}`;

    // 1) Llista del directori projects/<slug>
    const list = await gh(`/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(base)}?ref=${encodeURIComponent(BRANCH)}`);
    if (list.status === 404) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'not_found' }) };
    }
    if (!list.ok || !Array.isArray(list.data)) {
      return { statusCode: list.status || 500, headers: CORS, body: JSON.stringify({ error: 'github_error_list', details: list.data }) };
    }

    // 2) Baixa cada fitxer del directori
    const files = {};
    let project = { id: slug, slug, name: slug }; // mínim viable

    for (const it of list.data) {
      if (it.type !== 'file') continue;

      const one = await gh(`/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(`${base}/${it.name}`)}?ref=${encodeURIComponent(BRANCH)}`);
      if (!one.ok || !one.data) continue;

      // Si trobem un meta.json, el parsegem per completar el project
      if (it.name === 'meta.json') {
        const txt = decodeBase64(one.data.content);
        try {
          const meta = JSON.parse(txt);
          project = {
            id: meta.id || slug,
            slug: meta.slug || slug,
            name: meta.name || slug,
            desc: meta.desc || '',
            status: meta.status || 'cloud',
            repo: meta.repo || null,
            updatedAt: meta.updatedAt || Date.now(),
            createdAt: meta.createdAt || Date.now()
          };
        } catch { /* ignore */ }
      } else {
        files[it.name] = decodeBase64(one.data.content);
      }
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, files })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'server_error', details: String(err && err.message || err) })
    };
  }
};

