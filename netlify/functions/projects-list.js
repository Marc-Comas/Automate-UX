// netlify/functions/projects-list.js

const GITHUB_API = 'https://api.github.com';

function json(code, obj) {
  return {
    statusCode: code,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });

  const token  = process.env.GITHUB_TOKEN;
  const owner  = process.env.GH_DATA_OWNER;
  const repo   = process.env.GH_DATA_REPO;
  const branch = process.env.GH_DATA_BRANCH || 'main';

  if (!token || !owner || !repo) {
    return json(400, { error: 'env_missing', details: 'Falten GITHUB_TOKEN, GH_DATA_OWNER o GH_DATA_REPO' });
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'project-central-list',
  };

  try {
    // Llista el directori arrel on desem els projectes
    const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent('projects')}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers });

    if (res.status === 404) return json(200, { ok: true, projects: [] }); // encara no hi ha cap projecte
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return json(res.status, { error: 'github_error', details: t || res.statusText });
    }

    const listing = await res.json(); // array d'items
    const dirs = (Array.isArray(listing) ? listing : []).filter(x => x && x.type === 'dir');

    // Opcional: comprovar si hi ha index.html a cada projecte
    const projects = [];
    for (const d of dirs) {
      const id = d.name;
      // no ens cal fallar si no hi ha index, només informem
      let hasIndex = false;
      try {
        const iurl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(`projects/${id}/index.html`)}?ref=${encodeURIComponent(branch)}`;
        const ires = await fetch(iurl, { headers });
        hasIndex = ires.status === 200;
      } catch { /* ignore */ }

      projects.push({
        id,
        name: id,            // si en un futur hi ha meta.json, el podem llegir aquí
        hasIndex,
        path: `projects/${id}/`,
      });
    }

    return json(200, { ok: true, projects });
  } catch (err) {
    return json(500, { error: 'server_error', details: err.message });
  }
};

