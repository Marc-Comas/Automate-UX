// netlify/functions/projects-save.js
// ESM — compatible amb "type":"module" al package.json

import { Buffer } from 'node:buffer';

// Helpers bàsics --------------------------------------------------------------
const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
});
const ok = (body = {}) => ({
  statusCode: 200,
  headers: cors(),
  body: JSON.stringify(body)
});
const error = (code, msg) => ({
  statusCode: code,
  headers: cors(),
  body: JSON.stringify({ ok: false, error: msg })
});
const ghHeaders = (token) => ({
  'Authorization': `token ${token}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json'
});

// Encode segur de “segments” del path (sense escapar les /)
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// GitHub: PUT (crea/actualitza) un fitxer -------------------------------------
async function gitPutFile({ owner, repo, branch, token, path, content }) {
  try {
    const segs = encPath(path);

    // 1) agafa SHA si el fitxer existeix
    const getUrl =
      `https://api.github.com/repos/${owner}/${repo}/contents/${segs}?ref=${encodeURIComponent(branch)}`;
    const getRes = await fetch(getUrl, { headers: ghHeaders(token) });
    let sha;
    if (getRes.status === 200) {
      const data = await getRes.json();
      sha = data.sha;
    } else if (getRes.status !== 404) {
      const info = await getRes.text();
      return { ok: false, error: `GitHub GET ${getRes.status}: ${info}` };
    }

    // 2) PUT amb el contingut en base64
    const putUrl =
      `https://api.github.com/repos/${owner}/${repo}/contents/${segs}`;
    const body = {
      message: `chore: save ${path}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {})
    };
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: ghHeaders(token),
      body: JSON.stringify(body)
    });

    if (putRes.ok) return { ok: true };
    const err = await putRes.text();
    return { ok: false, error: `GitHub PUT ${putRes.status}: ${err}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Netlify Function (ESM) ------------------------------------------------------
export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return ok();

  try {
    const { project, files } = JSON.parse(event.body || '{}');

    // Llegeix credencials. Prioritzem variables DATA i proporcionem múltiples fallbacks per coherència amb altres funcions.
    const owner  = process.env.GH_DATA_OWNER   || process.env.GITHUB_OWNER  || process.env.GH_OWNER;
    const repo   = process.env.GH_DATA_REPO    || process.env.GITHUB_DATA_REPO || process.env.GITHUB_REPO || process.env.GH_REPO;
    const branch = process.env.GH_DATA_BRANCH  || process.env.GITHUB_DATA_BRANCH || process.env.GH_BRANCH || 'main';
    const token  = process.env.GITHUB_DATA_TOKEN || process.env.GH_DATA_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

    if (!owner || !repo || !token) {
      return error(400, 'Missing GitHub credentials (owner/repo/token)');
    }
    if (!project) return error(400, 'Missing project data');

    const slug = project.slug || project.id;
    if (!slug) return error(400, 'Project needs slug or id');

    const prefix = `projects/${slug}`;

    // Construïm l'array de fitxers a desar. Afegim meta.json amb les metadades del projecte
    const candidates = [];
    // index.html, css, js
    const indexFile = files?.['index.html'];
    const cssFile   = files?.['styles/style.css'];
    const jsFile    = files?.['scripts/app.js'];
    if (typeof indexFile === 'string' && indexFile.trim() !== '') candidates.push(['index.html', indexFile]);
    if (typeof cssFile   === 'string' && cssFile.trim()   !== '') candidates.push(['styles/style.css', cssFile]);
    if (typeof jsFile    === 'string' && jsFile.trim()    !== '') candidates.push(['scripts/app.js', jsFile]);

    // Afegeix meta.json per desar metadades mínimes del projecte
    const meta = { ...project };
    delete meta.files;
    // Si no hi ha camp id/slug, assigna el slug calculat per coherència
    if (!meta.id) meta.id = slug;
    if (!meta.slug) meta.slug = slug;
    const metaContent = JSON.stringify(meta, null, 2);
    candidates.push(['meta.json', metaContent]);

    // Si no hi ha cap fitxer, finalitza ràpid
    if (candidates.length === 0) {
      return ok({ ok: true, results: [{ id: project.id, name: project.name, skipped: true, reason: 'empty_files' }] });
    }

    const results = [];
    for (const [rel, content] of candidates) {
      const path = `${prefix}/${rel}`;
      const res = await gitPutFile({ owner, repo, branch, token, path, content });
      results.push({ path, committed: !!res.ok, error: res.ok ? undefined : res.error });
    }

    return ok({ ok: true, results });
  } catch (e) {
    return error(500, e?.message || String(e));
  }
}
