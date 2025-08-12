// Netlify Function: projects-save
// Guarda proyectos (archivos) en un repositorio de datos de GitHub
// Acepta varios formatos de entrada:
// 1) { project, files }
// 2) { project: { ..., files } }
// 3) { projects: [{ ..., files }, ...] }
// Escribe en: projects/<slug>/*

export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }

  try {
    if (event.httpMethod === 'GET') {
      // Diagnóstico sencillo
      const cfg = getCfg();
      return json(200, {
        ok: true,
        hasToken: !!cfg.token,
        owner: cfg.owner,
        repo: cfg.repo,
        branch: cfg.branch,
      });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'method_not_allowed' });
    }

    // --- Parse body ---
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, { error: 'invalid_json', details: String(e && e.message) });
    }

    // Normaliza a lista de proyectos
    const projects = normalizeProjects(body);
    if (!projects.length) {
      return json(400, { error: 'no_projects', details: 'Se esperaba { project, files } o { projects: [...] }' });
    }

    // Config GitHub
    const cfg = getCfg();
    if (!cfg.token || !cfg.owner || !cfg.repo) {
      return json(400, { error: 'github_config_missing', details: 'GITHUB_TOKEN, GH_DATA_OWNER, GH_DATA_REPO son requeridos' });
    }

    const results = [];
    for (const p of projects) {
      const slug = (p.slug && String(p.slug)) || slugify(p.name || 'site');
      const files = pickFiles(p, body);

      // Valida ficheros no vacíos
      const entries = Object.entries(files)
        .filter(([path, content]) => isValidPath(path) && typeof content === 'string' && content.trim().length > 0);

      if (!entries.length) {
        results.push({ id: p.id || slug, name: p.name || slug, skipped: true, reason: 'empty_files' });
        continue;
      }

      const perProject = [];
      for (const [relPath, content] of entries) {
        const fullPath = `projects/${slug}/${relPath}`.replace(/\\/g, '/');
        try {
          const put = await githubPut(cfg, fullPath, content, p.id || slug, p.name || slug);
          perProject.push({ path: fullPath, committed: true, sha: put.sha || null });
        } catch (e) {
          console.error('GitHub PUT fallo', { path: fullPath, error: e && e.message });
          perProject.push({ path: fullPath, committed: false, error: String(e && e.message) });
        }
      }

      results.push({ id: p.id || slug, name: p.name || slug, committed: perProject.every(x => x.committed), files: perProject });
    }

    return json(200, { ok: true, results });
  } catch (err) {
    console.error('projects-save fatal', err);
    return json(500, { error: 'internal_error', details: String(err && err.message) });
  }
};

// Helpers
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS,GET',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(statusCode, obj) {
  return { statusCode, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function getCfg() {
  const token = process.env.GITHUB_TOKEN;
  // Permite usar tanto GH_DATA_* como GH_*
  const owner = process.env.GH_DATA_OWNER || process.env.GH_OWNER;
  const repo = process.env.GH_DATA_REPO || process.env.GH_REPO;
  const branch = process.env.GH_DATA_BRANCH || process.env.GH_BRANCH || 'main';
  return { token, owner, repo, branch };
}

function normalizeProjects(body) {
  const out = [];
  if (body && typeof body === 'object') {
    if (Array.isArray(body.projects)) {
      for (const p of body.projects) if (p && typeof p === 'object') out.push(p);
    } else if (body.project && typeof body.project === 'object') {
      out.push(body.project);
    }
  }
  return out;
}

function pickFiles(project, body) {
  // Prioridad: project.files → body.files → {}
  const files = (project && project.files) || body.files || {};
  // Asegura estructura plana string→string
  const clean = {};
  if (files && typeof files === 'object') {
    for (const [k, v] of Object.entries(files)) {
      if (typeof v === 'string') clean[k] = v;
    }
  }
  return clean;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}+/gu, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'site';
}

function isValidPath(path) {
  if (typeof path !== 'string') return false;
  if (path.includes('..')) return false; // evita traversals
  if (path.startsWith('/')) return false;
  return true;
}

async function githubPut(cfg, path, content, id, name) {
  const api = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path)}`;

  // Busca SHA si el fichero existe (para update idempotent)
  let sha = undefined;
  const getRes = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: ghHeaders(cfg.token),
  });
  if (getRes.status === 200) {
    const info = await getRes.json();
    if (info && info.sha) sha = info.sha;
  }

  const message = `feat(projects): save ${id || ''} ${name || ''} -> ${path}`.trim();
  const putRes = await fetch(api, {
    method: 'PUT',
    headers: ghHeaders(cfg.token),
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: cfg.branch,
      sha,
    }),
  });

  if (putRes.status >= 400) {
    const err = await safeJson(putRes);
    throw new Error(`GitHub PUT ${putRes.status}: ${JSON.stringify(err)}`);
  }

  const out = await putRes.json();
  return { sha: out && out.content && out.content.sha };
}

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'project-central',
  };
}

async function safeJson(res) {
  try { return await res.json(); } catch { return await res.text(); }
}
