export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  try {
    const { id, name, files } = JSON.parse(event.body || '{}');
    if (!files || typeof files !== 'object') return j(400, { error: 'Faltan files' });

    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GH_OWNER;
    const repo = process.env.GH_REPO;
    const branch = process.env.GH_BRANCH || 'main';
    if (!token || !owner || !repo) return j(400, { error: 'Config GitHub incompleta (GITHUB_TOKEN, GH_OWNER, GH_REPO)' });

    const results = [];
    for (const [path, content] of Object.entries(files)) {
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      let sha = undefined;
      const getRes = await fetch(apiUrl+`?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(token) });
      if (getRes.status === 200) { const info = await getRes.json(); sha = info.sha; }
      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: ghHeaders(token),
        body: JSON.stringify({
          message: `chore(${id}): update ${path} for ${name}`,
          content: Buffer.from(content, 'utf-8').toString('base64'),
          branch,
          sha
        })
      });
      const out = await putRes.json();
      if (putRes.status >= 400) return j(502, { error: 'GitHub PUT falló', details: out });
      results.push({ path, sha: out.content && out.content.sha });
    }
    return j(200, { ok: true, committed: results });
  } catch (err) {
    return j(500, { error: 'Fallo push', details: err.message || String(err) });
  }
};
function ghHeaders(token){ return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json', 'User-Agent': 'project-central' }; }
function cors(){ return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }; }
function j(code,obj){ return { statusCode: code, headers: { ...cors(), 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }
