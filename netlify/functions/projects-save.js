// Netlify Function: projects-save
// Goal: save a project's generated files to a GitHub repo (data repo)
// Robust version: if direct push is blocked (branch protections),
// it creates a new branch and opens a Pull Request.
//
// Env vars expected (set in Netlify):
//   GH_TOKEN   - GitHub PAT (fine‑grained ok). Needs:
//                Contents: Read & write, Pull requests: Read & write, Metadata: Read‑only
//   GH_OWNER   - GitHub owner/user (e.g., "Marc-Comas")
//   GH_REPO    - Data repo (e.g., "project-central-data")
//   GH_BRANCH  - Base branch to merge into (default: "main")
//   GH_COMMIT_MODE - optional: "pr" (default) or "direct"
//
// Request body JSON:
//   { project: { id, name, slug }, files: { "index.html": "...", "styles/style.css": "...", "scripts/app.js": "..." } }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { project, files } = body;

    if (!project || !project.name) {
      return json(400, { ok: false, error: 'Missing project {id,name,slug}.' });
    }
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      return json(400, { ok: false, error: 'Missing files: expected an object with at least index.html.' });
    }

   // ── substituir el bloc on es llegeixen token/owner/repo ──
const pick = () => ({
  TOKEN:  process.env.GITHUB_DATA_TOKEN || process.env.GH_DATA_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  OWNER:  process.env.GH_DATA_OWNER     || process.env.GITHUB_OWNER  || process.env.GH_OWNER,
  REPO:   process.env.GH_DATA_REPO      || process.env.GITHUB_DATA_REPO || process.env.GITHUB_REPO || process.env.GH_REPO,
  BRANCH: process.env.GH_DATA_BRANCH    || process.env.GITHUB_DATA_BRANCH || process.env.GH_BRANCH || 'main',
  MODE:  (process.env.GH_COMMIT_MODE || 'pr').toLowerCase()
});

const { TOKEN, OWNER, REPO, BRANCH, MODE } = pick();
if (!TOKEN || !OWNER || !REPO) {
  return json(400, { ok:false, error:'Missing GH credentials (…DATA… or fallback tokens).' });
}
const apiBase = 'https://api.github.com';
const commitMode = MODE;           // 'pr' | 'direct'
const baseBranch = BRANCH;


    // 1) Resolve repo + base branch sha
    const repoInfo = await gh(`${apiBase}/repos/${owner}/${repo}`, token);
    if (!repoInfo.ok) return repoInfo;

    const base = baseBranch || repoInfo.data.default_branch || 'main';
    const refInfo = await gh(`${apiBase}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`, token);
    if (!refInfo.ok) return refInfo;
    const baseSha = refInfo.data.object.sha;

    const slug = (project.slug || project.name || 'site')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const targetDir = `projects/${slug}`;

    // decide target branch
    let workBranch = base;
    let createdBranch = false;

    if (commitMode !== 'direct') {
      workBranch = `pc-${slug}-${Date.now().toString(36)}`;
      const createRef = await gh(`${apiBase}/repos/${owner}/${repo}/git/refs`, token, {
        method: 'POST',
        body: {
          ref: `refs/heads/${workBranch}`,
          sha: baseSha,
        },
      });

      // If branch already exists (rare on retries), append a suffix and try again
      if (!createRef.ok) {
        if (createRef.status === 422 && /Reference already exists/i.test(createRef.message || '')) {
          workBranch = `${workBranch}-a`;
          const retryRef = await gh(`${apiBase}/repos/${owner}/${repo}/git/refs`, token, {
            method: 'POST',
            body: { ref: `refs/heads/${workBranch}`, sha: baseSha },
          });
          if (!retryRef.ok) return retryRef;
        } else {
          return createRef;
        }
      }
      createdBranch = true;
    }

    // 2) Write files to repo (on workBranch)
    const results = [];
    for (const [relative, content] of Object.entries(files)) {
      const path = `${targetDir}/${relative}`.replace(/\\/g, '/');
      const putRes = await gh(`${apiBase}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, token, {
        method: 'PUT',
        body: {
          message: `Project Central: save ${project.name} → ${path}`,
          content: b64(content),
          branch: workBranch,
        },
      });

      results.push({ path, committed: putRes.ok, status: putRes.status, error: putRes.ok ? undefined : putRes.message });

      // On 401/403, return a clear error immediately
      if (!putRes.ok && (putRes.status === 401 || putRes.status === 403)) {
        return json(200, {
          ok: false,
          reason: 'github_auth_or_permissions',
          hint: hintFor403(commitMode),
          owner,
          repo,
          branchTried: workBranch,
          status: putRes.status,
          message: putRes.message,
          results,
        });
      }

      if (!putRes.ok) return json(200, { ok: false, owner, repo, branchTried: workBranch, status: putRes.status, message: putRes.message, results });
    }

    // 3) If PR mode, open the PR
    let pr = null;
    if (commitMode !== 'direct') {
      const prRes = await gh(`${apiBase}/repos/${owner}/${repo}/pulls`, token, {
        method: 'POST',
        body: {
          title: `Project Central – ${project.name}`,
          head: workBranch,
          base: base,
          body: `Automated save from Project Central for project **${project.name}** (id: ${project.id || 'n/a'}).\n\nFiles: ${Object.keys(files).map(f => `${targetDir}/${f}`).join(', ')}`,
        },
      });
      if (!prRes.ok) return prRes;
      pr = { number: prRes.data.number, url: prRes.data.html_url };
    }

    return json(200, {
      ok: true,
      mode: commitMode,
      owner,
      repo,
      base,
      branch: workBranch,
      createdBranch,
      pr,
      results,
    });
  } catch (err) {
    return json(200, { ok: false, error: String(err && err.message || err) });
  }
};

// --- helpers ---------------------------------------------------------------
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS,GET',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

function json(statusCode, obj) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(obj) };
}

function b64(str) {
  return Buffer.from(String(str), 'utf8').toString('base64');
}

async function gh(url, token, init = {}) {
  const res = await fetch(url, {
    method: init.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* ignore */ }

  const ok = res.status >= 200 && res.status < 300;
  const message = ok ? undefined : (data && data.message) || text || `HTTP ${res.status}`;

  return { ok, status: res.status, data, message };
}

function hintFor403(mode) {
  return mode === 'direct'
    ? 'Branch protections or "Restrict who can push" may be enabled on the target branch. Disable them or switch GH_COMMIT_MODE to "pr".'
    : 'Your token must allow: Contents (Read & write) and Pull requests (Read & write). If it still fails, ensure the data repo is selected in the token and not restricted by organization policies.';
}

