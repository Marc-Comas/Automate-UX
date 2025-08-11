
/**
 * POST /.netlify/functions/projects-save
 * Body: { project: {...}, files: {...} }
 * - UPSERT: actualiza meta.json y files.json
 * - Actualiza pcentral/projects.json
 */

/** Shared helpers for GitHub Content API */
function env(k, fallback) {
  return process.env[k] || fallback || '';
}
function dataOwner() { return env('GH_DATA_OWNER', env('GH_OWNER')); }
function dataRepo()  { return env('GH_DATA_REPO',  env('GH_REPO')); }
function dataBranch(){ return env('GH_DATA_BRANCH', env('GH_BRANCH', 'main')); }

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600'
  };
}
function json(code, obj) {
  return { statusCode: code, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function ok(obj){ return json(200, obj); }
function bad(msg){ return json(400, { error: msg }); }
function server(err){ return json(500, { error: 'server_error', details: (err?.message || String(err)) }); }

function ghHeaders() {
  const token = env('GITHUB_TOKEN');
  if (!token) throw new Error('Missing GITHUB_TOKEN');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'project-central-cloud'
  };
}
async function ghGet(path) {
  const url = `https://api.github.com/repos/${dataOwner()}/${dataRepo()}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(dataBranch())}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return { status: 404, data: null };
  const data = await res.json();
  return { status: res.status, data };
}
async function ghPut(path, contentStr, message, sha) {
  const url = `https://api.github.com/repos/${dataOwner()}/${dataRepo()}/contents/${encodeURIComponent(path)}`;
  const b64 = Buffer.from(contentStr, 'utf-8').toString('base64');
  const body = { message, content: b64, branch: dataBranch() };
  if (sha) body.sha = sha;
  const res = await fetch(url, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  const data = await res.json();
  return { status: res.status, data };
}
async function ghDelete(path, message, sha) {
  const url = `https://api.github.com/repos/${dataOwner()}/${dataRepo()}/contents/${encodeURIComponent(path)}`;
  const body = { message, sha, branch: dataBranch() };
  const res = await fetch(url, { method: 'DELETE', headers: ghHeaders(), body: JSON.stringify(body) });
  const data = await res.json().catch(()=> ({}));
  return { status: res.status, data };
}
function decodeContent(obj) {
  if (!obj || !obj.content) return null;
  try { return Buffer.from(obj.content, 'base64').toString('utf-8'); } catch { return null; }
}
function now(){ return Date.now(); }
function ensureProjectMeta(p){
  // Keep only safe metadata fields for index
  return {
    id: p.id, name: p.name, slug: p.slug, desc: p.desc || '',
    status: p.status || 'local', repo: p.repo || null, netlifyUrl: p.netlifyUrl || null,
    updatedAt: p.updatedAt || now(), createdAt: p.createdAt || now()
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  try {
    if (event.httpMethod !== 'POST') return bad('Use POST');
    const body = JSON.parse(event.body || '{}');
    const project = body.project || {};
    const files = body.files || {};

    if (!project.id) return bad('project.id requerido');
    if (!files || typeof files !== 'object') return bad('files inválido');

    project.updatedAt = now();
    project.createdAt = project.createdAt || now();

    const metaPath  = `pcentral/projects/${project.id}/meta.json`;
    const filesPath = `pcentral/projects/${project.id}/files.json`;
    const idxPath   = 'pcentral/projects.json';

    // 1) Escribir files.json
    const curFiles = await ghGet(filesPath);
    const putFiles = await ghPut(filesPath, JSON.stringify(files, null, 2), `feat(${project.id}): update files.json`, curFiles.status === 404 ? undefined : curFiles.data.sha);
    if (putFiles.status >= 400) return json(putFiles.status, { error: 'github_put_files_error', details: putFiles.data });

    // 2) Escribir meta.json
    const curMeta = await ghGet(metaPath);
    const putMeta = await ghPut(metaPath, JSON.stringify(project, null, 2), `feat(${project.id}): update meta.json`, curMeta.status === 404 ? undefined : curMeta.data.sha);
    if (putMeta.status >= 400) return json(putMeta.status, { error: 'github_put_meta_error', details: putMeta.data });

    // 3) Actualizar projects.json (índex)
    const curIdx = await ghGet(idxPath);
    let indexArr = [];
    let idxSha = undefined;
    if (curIdx.status === 404) {
      indexArr = [];
    } else if (curIdx.status < 400) {
      idxSha = curIdx.data.sha;
      try { indexArr = JSON.parse(decodeContent(curIdx.data) || '[]'); } catch { indexArr = []; }
    } else {
      return json(curIdx.status, { error: 'github_get_index_error', details: curIdx.data });
    }

    const metaMin = ensureProjectMeta(project);
    const map = new Map(indexArr.map(p => [p.id, p]));
    map.set(project.id, { ...(map.get(project.id) || {}), ...metaMin });

    const nextArr = Array.from(map.values()).sort((a,b)=> (b.updatedAt||0)-(a.updatedAt||0));
    const putIdx = await ghPut(idxPath, JSON.stringify(nextArr, null, 2), `chore: upsert index for ${project.id}`, idxSha);
    if (putIdx.status >= 400) return json(putIdx.status, { error: 'github_put_index_error', details: putIdx.data });

    return ok({ ok: true, id: project.id });
  } catch (err) { return server(err); }
};
