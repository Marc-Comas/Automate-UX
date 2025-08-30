// netlify/functions/projects-delete.js
// DELETE a GitHub (repo DATA) tot el directori projects/<slug>
// Admet: POST amb { id } o { slug }  (també GET ?id= o ?slug= per proves)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

// Prioritza variables DATA; si no hi són, cau a les genèriques
function envPick() {
  const OWNER  = process.env.GH_DATA_OWNER   || process.env.GITHUB_OWNER || process.env.GH_OWNER;
  const REPO   = process.env.GH_DATA_REPO    || process.env.GITHUB_DATA_REPO || process.env.GITHUB_REPO || process.env.GH_REPO;
  const BRANCH = process.env.GH_DATA_BRANCH  || process.env.GITHUB_DATA_BRANCH || process.env.GH_BRANCH || "main";
  const TOKEN  = process.env.GITHUB_DATA_TOKEN || process.env.GH_DATA_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return { OWNER, REPO, BRANCH, TOKEN };
}

function json(status, payload) {
  return { statusCode: status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}
const ok  = (p) => json(200, p);
const bad = (m) => json(400, { error: m || "bad_request" });

// Headers GitHub (amb token si n’hi ha)
function ghHeaders() {
  const { TOKEN } = envPick();
  return {
    "Accept": "application/vnd.github+json",
    "User-Agent": "project-central-functions",
    ...(TOKEN ? { "Authorization": `token ${TOKEN}` } : {})
  };
}

async function gh(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: ghHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

const ghList = (p, ref) => gh(`/repos/${envPick().OWNER}/${envPick().REPO}/contents/${encodeURIComponent(p)}?ref=${encodeURIComponent(ref)}`);
const ghDeleteFile = (p, message, sha, branch) =>
  gh(`/repos/${envPick().OWNER}/${envPick().REPO}/contents/${encodeURIComponent(p)}`, {
    method: "DELETE",
    body: { message, sha, branch }
  });

// Llista recursivament tots els fitxers sota un path (ignora directoris)
async function listRecursive(base, branch) {
  const out = [];
  const stack = [base];

  while (stack.length) {
    const cur = stack.pop();
    const res = await ghList(cur, branch);

    // Si el path no existeix -> 404
    if (res.status === 404) continue;
    if (!res.ok || !Array.isArray(res.data)) {
      throw new Error(`github_list_error@${cur}`);
    }

    for (const it of res.data) {
      if (it.type === "file") {
        out.push({ path: it.path, sha: it.sha });
      } else if (it.type === "dir") {
        stack.push(it.path);
      }
    }
  }

  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  try {
    if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
      return json(405, { error: "use POST (or GET per proves)" });
    }

    const { OWNER, REPO, BRANCH, TOKEN } = envPick();
    if (!OWNER || !REPO || !TOKEN) {
      return json(400, { error: "missing_github_env", details: { OWNER, REPO, hasToken: !!TOKEN } });
    }

    const qp = new URLSearchParams(event.queryStringParameters || {});
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }

    const slug = (body.slug || body.id || qp.get("slug") || qp.get("id") || "").trim();
    if (!slug) return bad("id/slug requerido");

    const base = `projects/${slug}`;

    // 1) Llista tots els fitxers
    const listing = await ghList(base, BRANCH);
    if (listing.status === 404) {
      // Ja no existeix; retornem ok
      return ok({ ok: true, id: slug, deleted: 0, info: "not_found" });
    }
    if (!listing.ok || !Array.isArray(listing.data)) {
      return json(listing.status || 500, { error: "github_list_error", details: listing.data });
    }

    const files = await listRecursive(base, BRANCH);
    if (files.length === 0) return ok({ ok: true, id: slug, deleted: 0 });

    // 2) Esborra fitxer a fitxer (GitHub esborra carpetes quan queden buides)
    let deleted = 0;
    const results = [];

    for (const f of files) {
      const msg = `chore(${slug}): delete ${f.path}`;
      const del = await ghDeleteFile(f.path, msg, f.sha, BRANCH);
      results.push({ path: f.path, ok: del.ok, status: del.status, error: del.ok ? null : del.data });
      if (del.ok) deleted++;
      // Si GitHub limita, podríem introduir un petit delay:
      // await new Promise(r => setTimeout(r, 120));
    }

    return ok({ ok: true, id: slug, deleted, results });
  } catch (err) {
    // Any runtime errors will be returned as a structured JSON error
    return json(500, { error: "server_error", details: String((err && err.message) || err) });
  }
};

