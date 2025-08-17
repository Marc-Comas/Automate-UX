
/**
 * GET /.netlify/functions/projects-get?id=...
 * Respuesta: { project: {...}, files: {...} }
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
  const token =
    process.env.GITHUB_DATA_TOKEN || process.env.GH_DATA_TOKEN ||
    process.env.GITHUB_TOKEN      || process.env.GH_TOKEN;
  if (!token) throw new Error('Missing GitHub token (DATA or fallback)');
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
    if (event.httpMethod !== 'GET') return bad('Use GET');
    const id = new URLSearchParams(event.queryStringParameters || {}).get('id');
    if (!id) return bad('Missing id');

    const metaPath = `pcentral/projects/${id}/meta.json`;
    const filesPath = `pcentral/projects/${id}/files.json`;

    const [rm, rf] = await Promise.all([ghGet(metaPath), ghGet(filesPath)]);
    if (rm.status === 404 || rf.status === 404) return json(404, { error: 'not_found' });
    if (rm.status >= 400) return json(rm.status, { error: 'github_error_meta', details: rm.data });
    if (rf.status >= 400) return json(rf.status, { error: 'github_error_files', details: rf.data });

    const metaTxt = decodeContent(rm.data) || '{}';
    const filesTxt = decodeContent(rf.data) || '{}';

    let project = {}; let files = {};
    try { project = JSON.parse(metaTxt); } catch {}
    try { files = JSON.parse(filesTxt); } catch {}

    return ok({ project, files });
  } catch (err) { return server(err); }
};

// des de query, accepta id o slug
const qp = new URLSearchParams(event.queryStringParameters || {});
const slug = qp.get('slug') || qp.get('id');
if (!slug) return bad('Missing slug');

// llegeix els fitxers existents al directori projects/<slug>
const base = `projects/${slug}`;
const list = await ghGet(`${base}`);      // GET contents/… del directori
if (list.status === 404) return json(404, { error: 'not_found' });
if (list.status >= 400) return json(list.status, { error: 'github_error_list', details: list.data });

const arr = Array.isArray(list.data) ? list.data : [];
const files = {};
for (const it of arr) {
  if (it.type === 'file') {
    const one = await ghGet(`${base}/${it.name}`);
    if (one.status < 400) files[it.name] = decodeContent(one.data) || '';
  }
}
return ok({ project: { id: slug, slug, name: slug }, files });

