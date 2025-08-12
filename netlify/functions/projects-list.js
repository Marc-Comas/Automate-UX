// netlify/functions/projects-list.js
export const handler = async (event) => {
  try {
    const token  = (process.env.GITHUB_TOKEN || '').trim();
    const owner  = (process.env.GH_DATA_OWNER || process.env.GH_OWNER || '').trim();
    const repo   = (process.env.GH_DATA_REPO  || process.env.GH_REPO  || '').trim();
    const branch = (process.env.GH_DATA_BRANCH || process.env.GH_BRANCH || 'main').trim();

    // DEBUG: comprovar variables sense exposar el token
    if (event.queryStringParameters?.debug === '1') {
      return json(200, {
        ok: true,
        hasToken: Boolean(token),
        owner, repo, branch
      });
    }

    if (!token || !owner || !repo) {
      return json(400, { error: 'config_error', details: 'Falten GITHUB_TOKEN / OWNER / REPO' });
    }

    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/projects?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `token ${token}`,            // <- clau
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'project-central-list'
      }
    });

    // Si no existeix la carpeta "projects", tornem llista buida (no és un error greu)
    if (res.status === 404) return json(200, { ok: true, projects: [] });

    if (!res.ok) {
      const err = await safeJson(res);
      return json(res.status, { error: 'github_error', details: err || res.statusText });
    }

    const items = await res.json(); // array de fitxers/directoris
    const projects = (Array.isArray(items) ? items : [])
      .filter(i => i && (i.type === 'file' || i.type === 'dir'))
      .map(i => ({
        name: i.name.replace(/\.json$/,''),
        path: i.path,
        type: i.type,
        size: i.size ?? null
      }));

    return json(200, { ok: true, projects });
  } catch (e) {
    return json(500, { error: 'internal_error', details: e.message || String(e) });
  }
};

function json(code, obj){
  return {
    statusCode: code,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(obj)
  };
}

async function safeJson(res){
  try { return await res.json(); } catch { return null; }
}
